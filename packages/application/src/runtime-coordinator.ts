import {
  ApplicationError,
  agentSchema,
  canonicalEventSchema,
  interruptSchema,
  jsonObjectSchema,
  messageSchema,
  runSchema,
  runtimeCapabilitiesSchema,
  runtimeEventDraftSchema,
  runtimeProviderConfigSchema,
  taskEventEnvelopeSchema,
  taskSchema,
  type AccountId,
  type Agent,
  type CanonicalEvent,
  type Interrupt,
  type JsonObject,
  type JsonValue,
  type Message,
  type Run,
  type RuntimeEventDraft,
  type RuntimeCapabilities,
  type RuntimeProviderConfig,
  type Task,
  type TaskEventEnvelope,
} from "@openbot/core";
import { assertRunTransition, assertTaskTransition } from "./state-machine.ts";
import type {
  ActionDescriptor,
  ActionPort,
  ApplicationTransaction,
  Clock,
  IdGenerator,
  ProtocolPrincipal,
  RunQueuePort,
  RuntimeCapabilityRef,
  RuntimeInterruptCorrelation,
  RuntimeProvider,
  RuntimeProviderRegistry,
  RuntimeSession,
  RunWorkItem,
  UnitOfWork,
} from "./ports.ts";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_CLAIM_LIMIT = 10;
const DEFAULT_HISTORY_LIMIT = 200;
const DEFAULT_MAX_STREAM_EVENTS = 100_000;
const MAX_TRACKED_MESSAGES = 1_000;
const MAX_TRACKED_ACTIONS = 1_000;
const MAX_TRACKED_INTERRUPTS = 256;
const MAX_ACCUMULATED_TEXT = 1_000_000;

type MaybePromise<T> = T | Promise<T>;

export type RuntimePrincipalResolver = (work: RunWorkItem) => MaybePromise<ProtocolPrincipal>;

export type RuntimeCoordinatorDependencies = {
  unitOfWork: UnitOfWork;
  providers: RuntimeProviderRegistry;
  actions: ActionPort;
  queue: RunQueuePort;
  clock: Clock;
  ids: IdGenerator;
};

export type RuntimeCoordinatorOptions = {
  workerId: string;
  leaseMs?: number;
  leaseRenewalIntervalMs?: number;
  retryDelayMs?: number;
  claimLimit?: number;
  historyLimit?: number;
  maxStreamEvents?: number;
  capabilities?: readonly RuntimeCapabilityRef[];
  principalForWork?: RuntimePrincipalResolver;
};

export type RuntimeWorkDisposition = "acknowledged" | "retried";

export type RuntimeCoordinatorBatchResult = {
  claimed: number;
  acknowledged: number;
  retried: number;
};

type ExecuteWork = Extract<RunWorkItem, { kind: "execute" }>;
type CancelWork = Extract<RunWorkItem, { kind: "cancel" }>;

type ContinuationResponse = {
  correlation: RuntimeInterruptCorrelation;
  response: { status: "resolved"; value: JsonValue } | { status: "canceled" };
};

type ResolvedProvider = {
  provider: RuntimeProvider;
  config: RuntimeProviderConfig;
  capabilities: RuntimeCapabilities;
};

type ExecutionContext = {
  task: Task;
  run: Run;
  agent: Agent;
  history: readonly Message[];
  resumeSessionRef?: string;
  continuations: readonly ContinuationResponse[];
};

type PreparedExecution =
  | { disposition: "skip" }
  | { disposition: "execute"; context: ExecutionContext };

type MessageTracker = {
  id: Message["id"];
  role: "agent" | "tool";
  providerRef: string;
  text: string;
  createdAt: number;
  finished: boolean;
};

type ActionTracker = {
  id: string;
  providerRef: string;
  name: string;
  finished: boolean;
};

type StreamState = {
  messages: Map<string, MessageTracker>;
  actions: Map<string, ActionTracker>;
  interruptRefs: Set<string>;
  interruptKinds: Interrupt["kind"][];
  terminal: Extract<RuntimeEventDraft, { type: "completed" | "failed" }> | null;
  eventCount: number;
};

type FinalOutcome =
  | { kind: "completed"; stopReason?: string }
  | { kind: "failed"; code: string; message: string; retryable: boolean }
  | { kind: "interrupted"; taskStatus: "input_required" | "auth_required" };

class RuntimeStreamError extends ApplicationError {
  constructor(message: string, cause?: unknown) {
    super("provider_error", message, { retryable: false, cause });
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new ApplicationError("invalid_argument", `${label} must be a positive safe integer`);
  }
  return resolved;
}

function cleanString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value || value.length > maximum) {
    throw new ApplicationError("invalid_argument", `${label} is invalid`);
  }
  return value;
}

function safeReason(error: unknown): string {
  if (error instanceof ApplicationError) return `${error.code}: runtime operation failed`.slice(0, 2_000);
  return "provider_error: runtime operation failed";
}

function retryable(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!(error instanceof ApplicationError)) return false;
  return error.retryable || ["unavailable", "rate_limited", "deadline_exceeded", "canceled"].includes(error.code);
}

function parseCore<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { message: string }[] } } },
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new RuntimeStreamError(`${label} is invalid: ${parsed.error.issues[0]?.message ?? "schema validation failed"}`);
}

function requireStored<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { message: string }[] } } },
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ApplicationError("internal", `${label} is invalid`, { cause: parsed.error });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function activeRunStatus(status: Run["status"]): status is "queued" | "running" | "interrupted" {
  return status === "queued" || status === "running" || status === "interrupted";
}

function terminalTaskStatus(status: Task["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled" || status === "rejected";
}

function providerSessionRef(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    throw new RuntimeStreamError("provider returned an invalid session reference");
  }
  return value;
}

function workKey(accountId: AccountId, runId: Run["id"]): string {
  return `${accountId}:${runId}`;
}

function linkedController(signals: readonly (AbortSignal | undefined)[]): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const subscriptions: { signal: AbortSignal; listener: () => void }[] = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    subscriptions.push({ signal, listener });
  }
  return {
    controller,
    dispose() {
      for (const subscription of subscriptions) {
        subscription.signal.removeEventListener("abort", subscription.listener);
      }
    },
  };
}

/**
 * Claims durable run work and translates provider sessions into canonical state.
 * The class owns no timers; composition roots decide whether to call processOnce
 */
export class RuntimeCoordinator {
  readonly #unitOfWork: UnitOfWork;
  readonly #providers: RuntimeProviderRegistry;
  readonly #actions: ActionPort;
  readonly #queue: RunQueuePort;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #workerId: string;
  readonly #leaseMs: number;
  readonly #leaseRenewalIntervalMs: number;
  readonly #retryDelayMs: number;
  readonly #claimLimit: number;
  readonly #historyLimit: number;
  readonly #maxStreamEvents: number;
  readonly #capabilities: readonly RuntimeCapabilityRef[];
  readonly #principalForWork: RuntimePrincipalResolver;
  readonly #active = new Map<string, { session: RuntimeSession; controller: AbortController }>();

  constructor(dependencies: RuntimeCoordinatorDependencies, options: RuntimeCoordinatorOptions) {
    this.#unitOfWork = dependencies.unitOfWork;
    this.#providers = dependencies.providers;
    this.#actions = dependencies.actions;
    this.#queue = dependencies.queue;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#workerId = cleanString(options.workerId, "workerId", 256);
    this.#leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS, "leaseMs");
    if (this.#leaseMs < 3) throw new ApplicationError("invalid_argument", "leaseMs must be at least 3 milliseconds");
    this.#leaseRenewalIntervalMs = positiveInteger(
      options.leaseRenewalIntervalMs,
      Math.max(1, Math.floor(this.#leaseMs / 3)),
      "leaseRenewalIntervalMs",
    );
    if (this.#leaseRenewalIntervalMs >= this.#leaseMs) {
      throw new ApplicationError("invalid_argument", "leaseRenewalIntervalMs must be shorter than leaseMs");
    }
    this.#retryDelayMs = positiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, "retryDelayMs");
    this.#claimLimit = positiveInteger(options.claimLimit, DEFAULT_CLAIM_LIMIT, "claimLimit", 100);
    this.#historyLimit = positiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT, "historyLimit", 10_000);
    this.#maxStreamEvents = positiveInteger(
      options.maxStreamEvents,
      DEFAULT_MAX_STREAM_EVENTS,
      "maxStreamEvents",
      1_000_000,
    );
    this.#capabilities = (options.capabilities ?? []).map((capability) => {
      if (capability.kind !== "workspace") throw new ApplicationError("invalid_argument", "unsupported runtime capability");
      return { kind: "workspace", ref: cleanString(capability.ref, "capability ref", 512) };
    });
    this.#principalForWork = options.principalForWork ?? ((work) => ({
      accountId: work.accountId,
      subjectId: `runtime:${this.#workerId}`,
      kind: "service",
      scopes: ["*"],
    }));
  }

  async processOnce(signal?: AbortSignal): Promise<RuntimeCoordinatorBatchResult> {
    if (signal?.aborted) throw new ApplicationError("canceled", "runtime worker was canceled", { cause: signal.reason });
    const now = this.#clock.now();
    const leaseUntil = now + this.#leaseMs;
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leaseUntil)) {
      throw new ApplicationError("internal", "clock returned an invalid lease time");
    }
    const items = await this.#queue.claim(this.#workerId, now, leaseUntil, this.#claimLimit);
    const dispositions = await Promise.all(items.map((item) => this.processWorkItem(item, signal)));
    return {
      claimed: items.length,
      acknowledged: dispositions.filter((value) => value === "acknowledged").length,
      retried: dispositions.filter((value) => value === "retried").length,
    };
  }

  async processWorkItem(work: RunWorkItem, signal?: AbortSignal): Promise<RuntimeWorkDisposition> {
    const linked = linkedController([signal]);
    const heartbeat = this.#startLeaseHeartbeat(work.outboxId, linked.controller);
    try {
      if (work.kind === "cancel") return await this.#processCancel(work, linked.controller.signal);
      return await this.#processExecute(work, linked.controller.signal);
    } finally {
      await heartbeat.stop();
      linked.dispose();
    }
  }

  async shutdown(reason = "runtime coordinator shutdown"): Promise<void> {
    const active = [...this.#active.values()];
    for (const value of active) value.controller.abort(reason);
    await Promise.allSettled(active.map((value) => value.session.cancel(reason)));
  }

  async #processExecute(work: ExecuteWork, signal?: AbortSignal): Promise<RuntimeWorkDisposition> {
    let streamState: StreamState | null = null;
    let session: RuntimeSession | null = null;
    let linked: ReturnType<typeof linkedController> | null = null;
    try {
      const prepared = this.#prepareExecution(work);
      if (prepared.disposition === "skip") return this.#acknowledge(work.outboxId);
      const context = prepared.context;
      const { provider, config, capabilities } = await this.#resolveProvider(context.agent);
      this.#requireCapability(capabilities, "streaming");
      if (context.resumeSessionRef !== undefined) this.#requireCapability(capabilities, "resume");
      if (context.continuations.length > 0) this.#requireCapability(capabilities, "interrupts");
      if (
        context.history.some((message) => message.parts.some((part) => part.kind === "file"))
      ) {
        this.#requireCapability(capabilities, "attachments");
      }
      const principal = await this.#runtimePrincipal(work);
      const actions = capabilities.supported.includes("actions")
        ? this.#validateActions(await this.#actions.list(principal))
        : [];
      linked = linkedController([signal]);
      session = await provider.createSession({
        accountId: context.task.accountId,
        agentId: context.task.agentId,
        taskId: context.task.id,
        runId: context.run.id,
        config,
        ...(context.resumeSessionRef === undefined ? {} : { resumeSessionRef: context.resumeSessionRef }),
        capabilities: this.#capabilities,
        metadata: context.run.metadata,
      }, linked.controller.signal);
      this.#persistProviderSessionRef(work, providerSessionRef(session.providerSessionRef));
      this.#active.set(workKey(work.accountId, work.runId), { session, controller: linked.controller });

      for (const continuation of context.continuations) {
        await session.respond(
          continuation.correlation.providerRequestRef,
          continuation.response,
          linked.controller.signal,
        );
      }

      streamState = {
        messages: new Map(),
        actions: new Map(),
        interruptRefs: new Set(),
        interruptKinds: [],
        terminal: null,
        eventCount: 0,
      };
      for await (const rawDraft of session.run({
        messages: context.history,
        actions,
        metadata: context.task.metadata,
      }, linked.controller.signal)) {
        if (linked.controller.signal.aborted) {
          throw new ApplicationError("canceled", "runtime execution was canceled", {
            retryable: true,
            cause: linked.controller.signal.reason,
          });
        }
        streamState.eventCount += 1;
        if (streamState.eventCount > this.#maxStreamEvents) {
          throw new RuntimeStreamError("runtime stream exceeded its event limit");
        }
        const draft = parseCore(runtimeEventDraftSchema, rawDraft, "runtime event");
        await this.#applyDraft(work, context, capabilities, streamState, draft);
      }
      this.#throwIfAborted(linked.controller.signal, "runtime execution lost its lease");
      const finalRef = providerSessionRef(session.providerSessionRef);
      this.#persistProviderSessionRef(work, finalRef);
      const outcome = this.#streamOutcome(streamState);
      this.#finishExecution(work, outcome);
      return this.#acknowledge(work.outboxId);
    } catch (error) {
      if (session && (signal?.aborted || this.#runHasStopped(work))) {
        await Promise.allSettled([session.cancel(signal?.aborted ? "runtime worker canceled" : "canonical run stopped")]);
      }
      if (streamState) this.#closeAbandonedTrackers(work, streamState);
      if (this.#runHasStopped(work)) return this.#acknowledge(work.outboxId);
      if (retryable(error, signal)) return this.#retry(work.outboxId, error);
      try {
        this.#failExecution(work, error);
      } catch (failure) {
        return this.#retry(work.outboxId, failure);
      }
      return this.#acknowledge(work.outboxId);
    } finally {
      this.#active.delete(workKey(work.accountId, work.runId));
      linked?.dispose();
      if (session) await Promise.allSettled([session.close()]);
    }
  }

  async #processCancel(work: CancelWork, signal?: AbortSignal): Promise<RuntimeWorkDisposition> {
    try {
      const context = this.#prepareCancellation(work);
      if (!context) return this.#acknowledge(work.outboxId);
      const active = this.#active.get(workKey(work.accountId, work.runId));
      if (active) {
        active.controller.abort(work.reason ?? "run canceled");
        await active.session.cancel(work.reason);
        this.#throwIfAborted(signal, "runtime cancellation lost its lease");
        return this.#acknowledge(work.outboxId);
      }
      if (!context.run.providerSessionRef) return this.#acknowledge(work.outboxId);
      if (signal?.aborted) throw new ApplicationError("canceled", "runtime worker was canceled", { retryable: true });
      const { provider, config } = await this.#resolveProvider(context.agent);
      const session = await provider.createSession({
        accountId: context.task.accountId,
        agentId: context.task.agentId,
        taskId: context.task.id,
        runId: context.run.id,
        config,
        resumeSessionRef: context.run.providerSessionRef,
        capabilities: this.#capabilities,
        metadata: context.run.metadata,
      }, signal);
      try {
        await session.cancel(work.reason);
        this.#throwIfAborted(signal, "runtime cancellation lost its lease");
      } finally {
        await Promise.allSettled([session.close()]);
      }
      return this.#acknowledge(work.outboxId);
    } catch (error) {
      if (retryable(error, signal)) return this.#retry(work.outboxId, error);
      return this.#acknowledge(work.outboxId);
    }
  }

  #prepareExecution(work: ExecuteWork): PreparedExecution {
    return this.#unitOfWork.transaction((tx) => {
      const run = this.#runForWork(tx, work);
      const task = this.#taskForWork(tx, work, run);
      const agent = this.#agentForWork(tx, work, run);
      if (run.status === "completed" || run.status === "failed" || run.status === "canceled" || run.status === "interrupted") {
        return { disposition: "skip" };
      }
      if (terminalTaskStatus(task.status)) {
        if (run.status === "queued" || run.status === "running") {
          assertRunTransition(run.status, "canceled");
          const canceled = requireStored(runSchema, {
            ...run,
            status: "canceled",
            finishedAt: this.#clock.now(),
          }, "canceled stale run");
          tx.runs.update(canceled);
          this.#appendEvent(tx, task, canceled.id, {
            type: "run.status.changed",
            data: { from: run.status, to: "canceled", reason: `task already ${task.status}` },
          });
        }
        return { disposition: "skip" };
      }
      if (task.status !== "submitted" && task.status !== "working") {
        throw new RuntimeStreamError(`queued run belongs to task in state ${task.status}`);
      }

      let workingTask = task;
      const now = this.#clock.now();
      if (task.status === "submitted") {
        assertTaskTransition(task.status, "working");
        workingTask = requireStored(taskSchema, tx.tasks.transition(
          task.accountId,
          task.id,
          "submitted",
          "working",
          now,
        ), "working task");
        this.#assertTaskIdentity(workingTask, work);
        this.#appendEvent(tx, workingTask, null, {
          type: "task.status.changed",
          data: { from: "submitted", to: "working" },
        });
      }

      let runningRun = run;
      if (run.status === "queued") {
        assertRunTransition(run.status, "running");
        runningRun = requireStored(runSchema, {
          ...run,
          status: "running",
          startedAt: run.startedAt ?? now,
          finishedAt: null,
        }, "running run");
        const stored = requireStored(runSchema, tx.runs.update(runningRun), "stored running run");
        this.#assertRunIdentity(stored, work);
        runningRun = stored;
        this.#appendEvent(tx, workingTask, runningRun.id, {
          type: "run.status.changed",
          data: { from: "queued", to: "running" },
        });
      }

      const allRuns = tx.runs.listForTask(work.accountId, work.taskId).map((value) => requireStored(runSchema, value, "stored run"));
      const continuations = this.#continuations(tx, work, allRuns);
      let resumeSessionRef = runningRun.providerSessionRef ?? undefined;
      if (!resumeSessionRef && continuations.length > 0) {
        const references = new Set(continuations.map((continuation) => {
          const prior = allRuns.find((candidate) => candidate.id === continuation.correlation.runId);
          if (!prior?.providerSessionRef) throw new RuntimeStreamError("continuation has no resumable provider session");
          return prior.providerSessionRef;
        }));
        if (references.size !== 1) throw new RuntimeStreamError("continuations span multiple provider sessions");
        resumeSessionRef = [...references][0];
      }
      if (!resumeSessionRef && runningRun.attempt > 1) {
        resumeSessionRef = allRuns
          .filter((candidate) => candidate.attempt < runningRun.attempt && candidate.providerSessionRef)
          .sort((left, right) => right.attempt - left.attempt)[0]?.providerSessionRef ?? undefined;
      }
      const history = this.#history(tx, workingTask);
      return {
        disposition: "execute",
        context: {
          task: workingTask,
          run: runningRun,
          agent,
          history,
          ...(resumeSessionRef === undefined ? {} : { resumeSessionRef }),
          continuations,
        },
      };
    });
  }

  #prepareCancellation(work: CancelWork): { task: Task; run: Run; agent: Agent } | null {
    return this.#unitOfWork.transaction((tx) => {
      let run = this.#runForWork(tx, work);
      let task = this.#taskForWork(tx, work, run);
      const agent = this.#agentForWork(tx, work, run);
      if (run.status === "completed" || run.status === "failed") return null;
      const now = this.#clock.now();
      this.#cancelOpenInterrupts(tx, task, now);
      if (activeRunStatus(run.status)) {
        assertRunTransition(run.status, "canceled");
        const previous = run.status;
        run = requireStored(runSchema, tx.runs.update({
          ...run,
          status: "canceled",
          finishedAt: now,
        }), "canceled run");
        this.#assertRunIdentity(run, work);
        this.#appendEvent(tx, task, run.id, {
          type: "run.status.changed",
          data: { from: previous, to: "canceled", ...(work.reason === undefined ? {} : { reason: work.reason.slice(0, 2_000) }) },
        });
      }
      if (!terminalTaskStatus(task.status)) {
        assertTaskTransition(task.status, "canceled");
        const previous = task.status;
        task = requireStored(taskSchema, tx.tasks.transition(
          task.accountId,
          task.id,
          previous,
          "canceled",
          now,
        ), "canceled task");
        this.#assertTaskIdentity(task, work);
        this.#appendEvent(tx, task, null, {
          type: "task.status.changed",
          data: { from: previous, to: "canceled", ...(work.reason === undefined ? {} : { reason: work.reason.slice(0, 2_000) }) },
        });
      }
      return { task, run, agent };
    });
  }

  #runForWork(tx: ApplicationTransaction, work: RunWorkItem): Run {
    const value = tx.runs.get(work.accountId, work.runId);
    if (!value) throw new ApplicationError("not_found", "queued run not found");
    const run = requireStored(runSchema, value, "queued run");
    this.#assertRunIdentity(run, work);
    if (work.kind === "execute") {
      if (run.threadId !== work.threadId || run.agentId !== work.agentId || run.attempt !== work.attempt) {
        throw new ApplicationError("internal", "run queue identity does not match stored run");
      }
    }
    return run;
  }

  #taskForWork(tx: ApplicationTransaction, work: RunWorkItem, run: Run): Task {
    const value = tx.tasks.get(work.accountId, work.taskId);
    if (!value) throw new ApplicationError("not_found", "queued task not found");
    const task = requireStored(taskSchema, value, "queued task");
    this.#assertTaskIdentity(task, work);
    if (run.taskId !== task.id || run.threadId !== task.threadId || run.agentId !== task.agentId) {
      throw new ApplicationError("internal", "queued run does not belong to its task");
    }
    return task;
  }

  #agentForWork(tx: ApplicationTransaction, work: RunWorkItem, run: Run): Agent {
    const value = tx.agents.get(work.accountId, run.agentId);
    if (!value) throw new ApplicationError("not_found", "runtime agent not found");
    const agent = requireStored(agentSchema, value, "runtime agent");
    if (agent.accountId !== work.accountId || agent.id !== run.agentId) {
      throw new ApplicationError("internal", "runtime agent tenancy invariant failed");
    }
    return agent;
  }

  #assertRunIdentity(run: Run, work: RunWorkItem): void {
    if (run.accountId !== work.accountId || run.taskId !== work.taskId || run.id !== work.runId) {
      throw new ApplicationError("internal", "run queue aggregate identity is inconsistent");
    }
  }

  #assertTaskIdentity(task: Task, work: RunWorkItem): void {
    if (task.accountId !== work.accountId || task.id !== work.taskId) {
      throw new ApplicationError("internal", "task queue aggregate identity is inconsistent");
    }
  }

  #history(tx: ApplicationTransaction, task: Task): readonly Message[] {
    const values = tx.messages.list(task.accountId, task.threadId).map((value) => {
      const message = requireStored(messageSchema, value, "canonical history message");
      if (message.accountId !== task.accountId || message.threadId !== task.threadId) {
        throw new ApplicationError("internal", "history message tenancy invariant failed");
      }
      return message;
    });
    values.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    return values.slice(-this.#historyLimit);
  }

  #continuations(
    tx: ApplicationTransaction,
    work: ExecuteWork,
    runs: readonly Run[],
  ): readonly ContinuationResponse[] {
    const seen = new Set<string>();
    return work.continuationInterruptIds.map((interruptId) => {
      if (seen.has(interruptId)) throw new RuntimeStreamError("queued continuation contains a duplicate interrupt ID");
      seen.add(interruptId);
      const value = tx.interrupts.get(work.accountId, interruptId);
      if (!value) throw new RuntimeStreamError("queued continuation interrupt is missing");
      const interrupt = requireStored(interruptSchema, value, "continuation interrupt");
      if (interrupt.accountId !== work.accountId || interrupt.taskId !== work.taskId || interrupt.id !== interruptId) {
        throw new ApplicationError("internal", "continuation interrupt tenancy invariant failed");
      }
      if (interrupt.status !== "resolved" && interrupt.status !== "canceled") {
        throw new RuntimeStreamError(`queued continuation interrupt is ${interrupt.status}`);
      }
      const correlation = tx.runtimeCorrelations.getInterrupt(work.accountId, interrupt.id);
      if (!correlation) throw new RuntimeStreamError("queued continuation correlation is missing");
      if (
        correlation.accountId !== work.accountId || correlation.taskId !== work.taskId ||
        correlation.interruptId !== interrupt.id || !runs.some((run) => run.id === correlation.runId)
      ) {
        throw new ApplicationError("internal", "runtime interrupt correlation identity is inconsistent");
      }
      cleanString(correlation.providerRequestRef, "provider request reference", 512);
      if (interrupt.status === "canceled") return { correlation, response: { status: "canceled" } };
      if (interrupt.response === undefined) throw new RuntimeStreamError("resolved continuation has no response value");
      return { correlation, response: { status: "resolved", value: interrupt.response } };
    });
  }

  async #resolveProvider(agent: Agent): Promise<ResolvedProvider> {
    const provider = this.#providers.get(agent.runtime.providerId);
    if (!provider || provider.id !== agent.runtime.providerId) {
      throw new ApplicationError("provider_error", "runtime provider registry returned the wrong provider");
    }
    const config = requireStored(
      runtimeProviderConfigSchema,
      provider.validateConfig(agent.runtime),
      "validated runtime configuration",
    );
    if (config.providerId !== agent.runtime.providerId) {
      throw new ApplicationError("provider_error", "runtime provider changed its provider ID");
    }
    const capabilities = requireStored(
      runtimeCapabilitiesSchema,
      await provider.resolveCapabilities(agent.accountId, config),
      "runtime capabilities",
    );
    return { provider, config, capabilities };
  }

  async #runtimePrincipal(work: RunWorkItem): Promise<ProtocolPrincipal> {
    const principal = await this.#principalForWork(work);
    if (!principal || principal.accountId !== work.accountId) {
      throw new ApplicationError("forbidden", "runtime principal does not own the queued account");
    }
    if (
      typeof principal.subjectId !== "string" || principal.subjectId.length < 1 ||
      !["user", "agent", "service"].includes(principal.kind) || !Array.isArray(principal.scopes)
    ) {
      throw new ApplicationError("unauthenticated", "runtime principal is invalid");
    }
    return principal;
  }

  #throwIfAborted(signal: AbortSignal | undefined, message: string): void {
    if (!signal?.aborted) return;
    if (signal.reason instanceof ApplicationError) throw signal.reason;
    throw new ApplicationError("canceled", message, { retryable: true, cause: signal.reason });
  }

  #requireCapability(
    capabilities: RuntimeCapabilities,
    capability: RuntimeCapabilities["supported"][number],
  ): void {
    if (!capabilities.supported.includes(capability)) {
      throw new ApplicationError("provider_error", `runtime provider does not support ${capability}`);
    }
  }

  #startLeaseHeartbeat(outboxId: string, workController: AbortController): { stop(): Promise<void> } {
    const stopController = new AbortController();
    const done = (async () => {
      while (!stopController.signal.aborted && !workController.signal.aborted) {
        await this.#waitForHeartbeat(this.#leaseRenewalIntervalMs, stopController.signal);
        if (stopController.signal.aborted || workController.signal.aborted) break;
        try {
          const now = this.#clock.now();
          const leaseUntil = now + this.#leaseMs;
          if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leaseUntil)) {
            throw new ApplicationError("internal", "clock returned an invalid lease renewal time");
          }
          const renewed = await this.#queue.renew(this.#workerId, outboxId, now, leaseUntil);
          if (!renewed) {
            workController.abort(new ApplicationError("conflict", "runtime work lease was lost", { retryable: true }));
            break;
          }
        } catch (error) {
          workController.abort(new ApplicationError("unavailable", "runtime work lease renewal failed", {
            retryable: true,
            cause: error,
          }));
          break;
        }
      }
    })();
    return {
      async stop(): Promise<void> {
        stopController.abort();
        await done;
      },
    };
  }

  #waitForHeartbeat(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(finish, delayMs);
      const abort = () => finish();
      signal.addEventListener("abort", abort, { once: true });
      function finish(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve();
      }
    });
  }

  #validateActions(values: readonly ActionDescriptor[]): readonly ActionDescriptor[] {
    if (!Array.isArray(values) || values.length > 1_000) {
      throw new ApplicationError("internal", "action catalog is invalid");
    }
    const names = new Set<string>();
    return values.map((value) => {
      const name = cleanString(value?.name, "action name", 512);
      if (names.has(name)) throw new ApplicationError("internal", `duplicate action name: ${name}`);
      names.add(name);
      if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 4_000)) {
        throw new ApplicationError("internal", `action ${name} has an invalid description`);
      }
      const inputSchema = requireStored(jsonObjectSchema, value.inputSchema, `action ${name} input schema`);
      const outputSchema = value.outputSchema === undefined
        ? undefined
        : requireStored(jsonObjectSchema, value.outputSchema, `action ${name} output schema`);
      return {
        name,
        ...(value.description === undefined ? {} : { description: value.description }),
        inputSchema,
        ...(outputSchema === undefined ? {} : { outputSchema }),
      };
    });
  }

  async #applyDraft(
    work: ExecuteWork,
    context: ExecutionContext,
    capabilities: RuntimeCapabilities,
    state: StreamState,
    draft: RuntimeEventDraft,
  ): Promise<void> {
    if (state.terminal) throw new RuntimeStreamError("runtime emitted an event after its terminal event");
    if (state.interruptKinds.length > 0 && draft.type !== "interrupt.requested") {
      throw new RuntimeStreamError("runtime emitted an event after requesting an interrupt");
    }
    switch (draft.type) {
      case "message.started": {
        if (state.messages.size >= MAX_TRACKED_MESSAGES) throw new RuntimeStreamError("runtime emitted too many messages");
        if (state.messages.has(draft.data.providerMessageRef)) {
          throw new RuntimeStreamError("runtime reused a provider message reference");
        }
        const createdAt = this.#clock.now();
        const tracker: MessageTracker = {
          id: this.#ids.messageId(),
          role: draft.data.role,
          providerRef: draft.data.providerMessageRef,
          text: "",
          createdAt,
          finished: false,
        };
        state.messages.set(tracker.providerRef, tracker);
        const reserved = parseCore(messageSchema, {
          id: tracker.id,
          accountId: context.task.accountId,
          threadId: context.task.threadId,
          taskId: context.task.id,
          runId: context.run.id,
          role: tracker.role,
          parts: [{ kind: "text", text: "" }],
          createdAt,
          metadata: {},
        }, "reserved runtime message");
        this.#unitOfWork.transaction((tx) => {
          this.#requireRunning(tx, work);
          tx.messages.append(reserved);
          this.#appendEvent(tx, context.task, context.run.id, {
            type: "message.started",
            data: { messageId: tracker.id, role: tracker.role },
          });
        });
        return;
      }
      case "message.text.delta": {
        const tracker = this.#openMessage(state, draft.data.providerMessageRef);
        if (tracker.text.length + draft.data.delta.length > MAX_ACCUMULATED_TEXT) {
          throw new RuntimeStreamError("runtime message text exceeded its aggregate limit");
        }
        this.#appendForRun(work, {
          type: "message.text.delta",
          data: { messageId: tracker.id, delta: draft.data.delta },
        });
        tracker.text += draft.data.delta;
        return;
      }
      case "message.finished": {
        if (draft.data.parts.some((part) => part.kind === "file")) {
          this.#requireCapability(capabilities, "attachments");
        }
        const tracker = this.#openMessage(state, draft.data.providerMessageRef);
        const message = parseCore(messageSchema, {
          id: tracker.id,
          accountId: context.task.accountId,
          threadId: context.task.threadId,
          taskId: context.task.id,
          runId: context.run.id,
          role: tracker.role,
          parts: draft.data.parts,
          createdAt: tracker.createdAt,
          metadata: {},
        }, "runtime message");
        this.#unitOfWork.transaction((tx) => {
          this.#requireRunning(tx, work);
          for (const part of message.parts) {
            if (part.kind !== "file") continue;
            const stored = tx.attachments.get(message.accountId, part.attachment.id);
            if (!stored || !sameJson(stored, part.attachment)) {
              throw new RuntimeStreamError("runtime message references an unavailable attachment");
            }
          }
          tx.messages.append(message);
          this.#appendEvent(tx, context.task, context.run.id, {
            type: "message.finished",
            data: { messageId: message.id, parts: message.parts },
          });
        });
        tracker.finished = true;
        return;
      }
      case "reasoning.summary.delta": {
        this.#requireCapability(capabilities, "reasoning_summaries");
        const messageId = draft.data.providerMessageRef === undefined
          ? undefined
          : this.#knownMessage(state, draft.data.providerMessageRef).id;
        this.#appendForRun(work, {
          type: "reasoning.summary.delta",
          data: { ...(messageId === undefined ? {} : { messageId }), delta: draft.data.delta },
        });
        return;
      }
      case "action.started": {
        this.#requireCapability(capabilities, "actions");
        if (state.actions.size >= MAX_TRACKED_ACTIONS) throw new RuntimeStreamError("runtime emitted too many actions");
        if (state.actions.has(draft.data.providerCallRef)) {
          throw new RuntimeStreamError("runtime reused a provider action reference");
        }
        const tracker: ActionTracker = {
          id: String(this.#ids.eventId()),
          providerRef: draft.data.providerCallRef,
          name: draft.data.name,
          finished: false,
        };
        state.actions.set(tracker.providerRef, tracker);
        this.#appendForRun(work, {
          type: "action.started",
          data: { actionCallId: tracker.id, name: tracker.name },
        });
        return;
      }
      case "action.arguments.delta": {
        this.#requireCapability(capabilities, "actions");
        const tracker = this.#openAction(state, draft.data.providerCallRef);
        this.#appendForRun(work, {
          type: "action.arguments.delta",
          data: { actionCallId: tracker.id, delta: draft.data.delta },
        });
        return;
      }
      case "action.finished": {
        this.#requireCapability(capabilities, "actions");
        const tracker = this.#openAction(state, draft.data.providerCallRef);
        this.#appendForRun(work, {
          type: "action.finished",
          data: {
            actionCallId: tracker.id,
            outcome: draft.data.outcome,
            ...(draft.data.output === undefined ? {} : { output: draft.data.output }),
          },
        });
        tracker.finished = true;
        return;
      }
      case "interrupt.requested": {
        this.#requireCapability(capabilities, "interrupts");
        if (
          [...state.messages.values()].some((tracker) => !tracker.finished) ||
          [...state.actions.values()].some((tracker) => !tracker.finished)
        ) {
          throw new RuntimeStreamError("runtime requested an interrupt with an open message or action");
        }
        if (state.interruptRefs.size >= MAX_TRACKED_INTERRUPTS) throw new RuntimeStreamError("runtime emitted too many interrupts");
        if (state.interruptRefs.has(draft.data.providerRequestRef)) {
          throw new RuntimeStreamError("runtime reused a provider interrupt reference");
        }
        const interrupt = parseCore(interruptSchema, {
          id: this.#ids.interruptId(),
          accountId: context.task.accountId,
          taskId: context.task.id,
          runId: context.run.id,
          kind: draft.data.kind,
          prompt: draft.data.prompt,
          responseSchema: draft.data.responseSchema,
          status: "open",
          createdAt: this.#clock.now(),
          expiresAt: null,
          resolvedAt: null,
          metadata: {},
        }, "runtime interrupt");
        const correlation: RuntimeInterruptCorrelation = {
          accountId: interrupt.accountId,
          taskId: interrupt.taskId,
          runId: interrupt.runId,
          interruptId: interrupt.id,
          providerRequestRef: draft.data.providerRequestRef,
        };
        this.#unitOfWork.transaction((tx) => {
          this.#requireRunning(tx, work);
          tx.interrupts.put(interrupt);
          tx.runtimeCorrelations.bindInterrupt(correlation);
          this.#appendEvent(tx, context.task, context.run.id, {
            type: "interrupt.requested",
            data: { interrupt },
          });
        });
        state.interruptRefs.add(draft.data.providerRequestRef);
        state.interruptKinds.push(interrupt.kind);
        return;
      }
      case "activity.updated":
        this.#appendForRun(work, { type: "activity.updated", data: draft.data });
        return;
      case "completed":
      case "failed":
        if (state.interruptKinds.length > 0) {
          throw new RuntimeStreamError("runtime emitted a terminal event after requesting an interrupt");
        }
        state.terminal = draft;
        return;
    }
  }

  #openMessage(state: StreamState, providerRef: string): MessageTracker {
    const tracker = state.messages.get(providerRef);
    if (!tracker) throw new RuntimeStreamError("runtime referenced a message before it started");
    if (tracker.finished) throw new RuntimeStreamError("runtime referenced a message after it finished");
    return tracker;
  }

  #knownMessage(state: StreamState, providerRef: string): MessageTracker {
    const tracker = state.messages.get(providerRef);
    if (!tracker) throw new RuntimeStreamError("runtime reasoning referenced an unknown message");
    return tracker;
  }

  #openAction(state: StreamState, providerRef: string): ActionTracker {
    const tracker = state.actions.get(providerRef);
    if (!tracker) throw new RuntimeStreamError("runtime referenced an action before it started");
    if (tracker.finished) throw new RuntimeStreamError("runtime referenced an action after it finished");
    return tracker;
  }

  #streamOutcome(state: StreamState): FinalOutcome {
    if ([...state.messages.values()].some((tracker) => !tracker.finished)) {
      throw new RuntimeStreamError("runtime stream ended with an open message");
    }
    if ([...state.actions.values()].some((tracker) => !tracker.finished)) {
      throw new RuntimeStreamError("runtime stream ended with an open action");
    }
    if (state.interruptKinds.length > 0) {
      if (state.terminal) throw new RuntimeStreamError("runtime stream has multiple terminal outcomes");
      return {
        kind: "interrupted",
        taskStatus: state.interruptKinds.includes("auth") ? "auth_required" : "input_required",
      };
    }
    if (!state.terminal) throw new RuntimeStreamError("runtime stream ended without a terminal event");
    if (state.terminal.type === "completed") {
      return {
        kind: "completed",
        ...(state.terminal.data.stopReason === undefined ? {} : { stopReason: state.terminal.data.stopReason }),
      };
    }
    return {
      kind: "failed",
      code: state.terminal.data.code,
      message: state.terminal.data.message,
      retryable: state.terminal.data.retryable,
    };
  }

  #finishExecution(work: ExecuteWork, outcome: FinalOutcome): void {
    this.#unitOfWork.transaction((tx) => {
      const currentRun = this.#runForWork(tx, work);
      const currentTask = this.#taskForWork(tx, work, currentRun);
      if (currentRun.status === "canceled" || currentTask.status === "canceled") return;
      if (currentRun.status !== "running" || currentTask.status !== "working") {
        throw new RuntimeStreamError("runtime terminal outcome does not match active canonical state");
      }
      const now = this.#clock.now();
      if (outcome.kind === "interrupted") {
        assertRunTransition(currentRun.status, "interrupted");
        const interrupted = requireStored(runSchema, tx.runs.update({
          ...currentRun,
          status: "interrupted",
        }), "interrupted run");
        this.#appendEvent(tx, currentTask, interrupted.id, {
          type: "run.status.changed",
          data: { from: "running", to: "interrupted" },
        });
        assertTaskTransition(currentTask.status, outcome.taskStatus);
        const waiting = requireStored(taskSchema, tx.tasks.transition(
          currentTask.accountId,
          currentTask.id,
          "working",
          outcome.taskStatus,
          now,
        ), "waiting task");
        this.#assertTaskIdentity(waiting, work);
        this.#appendEvent(tx, waiting, null, {
          type: "task.status.changed",
          data: { from: "working", to: outcome.taskStatus },
        });
        return;
      }

      const next = outcome.kind === "completed" ? "completed" : "failed";
      this.#cancelOpenInterrupts(tx, currentTask, now);
      assertRunTransition(currentRun.status, next);
      const finished = requireStored(runSchema, tx.runs.update({
        ...currentRun,
        status: next,
        finishedAt: now,
      }), "finished run");
      this.#assertRunIdentity(finished, work);
      this.#appendEvent(tx, currentTask, finished.id, outcome.kind === "completed" ? {
        type: "run.status.changed",
        data: {
          from: "running",
          to: "completed",
          ...(outcome.stopReason === undefined ? {} : { reason: outcome.stopReason }),
        },
      } : {
        type: "run.status.changed",
        data: {
          from: "running",
          to: "failed",
          error: { code: outcome.code, message: outcome.message, retryable: outcome.retryable },
        },
      });
      assertTaskTransition(currentTask.status, next);
      const finishedTask = requireStored(taskSchema, tx.tasks.transition(
        currentTask.accountId,
        currentTask.id,
        "working",
        next,
        now,
      ), "finished task");
      this.#assertTaskIdentity(finishedTask, work);
      this.#appendEvent(tx, finishedTask, null, {
        type: "task.status.changed",
        data: {
          from: "working",
          to: next,
          ...(outcome.kind === "failed"
            ? { reason: outcome.message.slice(0, 2_000) }
            : outcome.stopReason === undefined ? {} : { reason: outcome.stopReason }),
        },
      });
    });
  }

  #failExecution(work: ExecuteWork, error: unknown): void {
    const code = error instanceof RuntimeStreamError ? "invalid_runtime_stream" : "runtime_provider_error";
    const message = error instanceof RuntimeStreamError ? error.message.slice(0, 8_000) : "runtime provider failed";
    this.#unitOfWork.transaction((tx) => {
      const run = this.#runForWork(tx, work);
      const task = this.#taskForWork(tx, work, run);
      if (run.status === "failed" || run.status === "completed" || run.status === "canceled" || run.status === "interrupted") return;
      const now = this.#clock.now();
      this.#cancelOpenInterrupts(tx, task, now);
      let currentTask = task;
      if (task.status === "submitted") {
        assertTaskTransition("submitted", "working");
        currentTask = requireStored(taskSchema, tx.tasks.transition(
          task.accountId,
          task.id,
          "submitted",
          "working",
          now,
        ), "working failed task");
        this.#assertTaskIdentity(currentTask, work);
        this.#appendEvent(tx, currentTask, null, {
          type: "task.status.changed",
          data: { from: "submitted", to: "working" },
        });
      }
      if (run.status === "queued") {
        assertRunTransition("queued", "running");
        const running = requireStored(runSchema, tx.runs.update({ ...run, status: "running", startedAt: now }), "running failed run");
        this.#assertRunIdentity(running, work);
        this.#appendEvent(tx, currentTask, running.id, {
          type: "run.status.changed",
          data: { from: "queued", to: "running" },
        });
      }
      const current = requireStored(runSchema, tx.runs.get(work.accountId, work.runId), "failed run");
      assertRunTransition(current.status, "failed");
      const failedRun = requireStored(runSchema, tx.runs.update({ ...current, status: "failed", finishedAt: now }), "stored failed run");
      this.#assertRunIdentity(failedRun, work);
      this.#appendEvent(tx, currentTask, failedRun.id, {
        type: "run.status.changed",
        data: { from: current.status, to: "failed", error: { code, message, retryable: false } },
      });
      if (!terminalTaskStatus(currentTask.status)) {
        if (["working", "input_required", "auth_required"].includes(currentTask.status)) {
          const previous = currentTask.status;
          assertTaskTransition(previous, "failed");
          const failedTask = requireStored(taskSchema, tx.tasks.transition(
            currentTask.accountId,
            currentTask.id,
            previous,
            "failed",
            now,
          ), "failed task");
          this.#assertTaskIdentity(failedTask, work);
          this.#appendEvent(tx, failedTask, null, {
            type: "task.status.changed",
            data: { from: previous, to: "failed", reason: message.slice(0, 2_000) },
          });
        }
      }
    });
  }

  #closeAbandonedTrackers(work: ExecuteWork, state: StreamState): void {
    try {
      this.#unitOfWork.transaction((tx) => {
        const run = this.#runForWork(tx, work);
        const task = this.#taskForWork(tx, work, run);
        if (run.status !== "running" || task.status !== "working") return;
        for (const tracker of state.messages.values()) {
          if (tracker.finished) continue;
          const message = requireStored(messageSchema, {
            id: tracker.id,
            accountId: task.accountId,
            threadId: task.threadId,
            taskId: task.id,
            runId: run.id,
            role: tracker.role,
            parts: [{ kind: "text", text: tracker.text.slice(0, MAX_ACCUMULATED_TEXT) }],
            createdAt: tracker.createdAt,
            metadata: {},
          }, "abandoned runtime message");
          tx.messages.append(message);
          this.#appendEvent(tx, task, run.id, {
            type: "message.finished",
            data: { messageId: message.id, parts: message.parts },
          });
          tracker.finished = true;
        }
        for (const tracker of state.actions.values()) {
          if (tracker.finished) continue;
          this.#appendEvent(tx, task, run.id, {
            type: "action.finished",
            data: { actionCallId: tracker.id, outcome: "failure" },
          });
          tracker.finished = true;
        }
      });
    } catch {
      // A concurrent cancel may have made the run terminal; its state is authoritative.
    }
  }

  #cancelOpenInterrupts(tx: ApplicationTransaction, task: Task, resolvedAt: number): void {
    const interrupts = tx.interrupts.listForTask(task.accountId, task.id).map((value) => {
      const interrupt = requireStored(interruptSchema, value, "stored interrupt");
      if (interrupt.accountId !== task.accountId || interrupt.taskId !== task.id) {
        throw new ApplicationError("internal", "interrupt task identity invariant failed");
      }
      return interrupt;
    });
    for (const interrupt of interrupts) {
      if (interrupt.status !== "open") continue;
      const canceled = requireStored(interruptSchema, {
        ...interrupt,
        status: "canceled",
        response: undefined,
        resolvedAt,
      }, "canceled interrupt");
      tx.interrupts.put(canceled);
      this.#appendEvent(tx, task, canceled.runId, {
        type: "interrupt.resolved",
        data: { interruptId: canceled.id, status: "canceled" },
      });
    }
  }

  #appendForRun(work: ExecuteWork, event: CanonicalEvent): void {
    this.#unitOfWork.transaction((tx) => {
      const run = this.#requireRunning(tx, work);
      const task = this.#taskForWork(tx, work, run);
      this.#appendEvent(tx, task, run.id, event);
    });
  }

  #requireRunning(tx: ApplicationTransaction, work: ExecuteWork): Run {
    const run = this.#runForWork(tx, work);
    if (run.status !== "running") throw new ApplicationError("conflict", `run is ${run.status}`);
    return run;
  }

  #appendEvent(
    tx: ApplicationTransaction,
    taskValue: Task,
    runId: Run["id"] | null,
    eventValue: CanonicalEvent,
  ): TaskEventEnvelope {
    const task = requireStored(taskSchema, taskValue, "event task");
    const event = requireStored(canonicalEventSchema, eventValue, "canonical event");
    const previous = tx.events.lastSeq(task.accountId, task.id);
    const envelope = requireStored(taskEventEnvelopeSchema, tx.events.append({
      accountId: task.accountId,
      taskId: task.id,
      runId,
      agentId: task.agentId,
      threadId: task.threadId,
      event,
      metadata: {},
    }), "canonical event envelope");
    if (
      envelope.accountId !== task.accountId || envelope.taskId !== task.id || envelope.runId !== runId ||
      envelope.agentId !== task.agentId || envelope.threadId !== task.threadId || envelope.seq !== previous + 1 ||
      !sameJson({ type: envelope.type, data: envelope.data }, event)
    ) {
      throw new ApplicationError("internal", "event appender violated the canonical envelope contract");
    }
    return envelope;
  }

  #persistProviderSessionRef(work: ExecuteWork, reference: string | null): void {
    if (reference === null) return;
    this.#unitOfWork.transaction((tx) => {
      const run = this.#runForWork(tx, work);
      if (run.status !== "running") return;
      const stored = requireStored(runSchema, tx.runs.update({ ...run, providerSessionRef: reference }), "session-bound run");
      this.#assertRunIdentity(stored, work);
    });
  }

  #runHasStopped(work: ExecuteWork): boolean {
    try {
      return this.#unitOfWork.transaction((tx) => {
        const value = tx.runs.get(work.accountId, work.runId);
        if (!value) return true;
        const run = requireStored(runSchema, value, "runtime run");
        return run.status === "completed" || run.status === "failed" || run.status === "canceled" || run.status === "interrupted";
      });
    } catch {
      return false;
    }
  }

  async #acknowledge(outboxId: string): Promise<RuntimeWorkDisposition> {
    await this.#queue.acknowledge(this.#workerId, outboxId, this.#clock.now());
    return "acknowledged";
  }

  async #retry(outboxId: string, error: unknown): Promise<RuntimeWorkDisposition> {
    const availableAt = this.#clock.now() + this.#retryDelayMs;
    if (!Number.isSafeInteger(availableAt)) throw new ApplicationError("internal", "clock returned an invalid retry time");
    await this.#queue.retry(this.#workerId, outboxId, availableAt, safeReason(error));
    return "retried";
  }
}
