import { describe, expect, test } from "bun:test";
import {
  ApplicationError,
  accountIdSchema,
  agentIdSchema,
  artifactIdSchema,
  attachmentIdSchema,
  eventIdSchema,
  externalIdSchema,
  interruptIdSchema,
  messageIdSchema,
  runIdSchema,
  taskEventEnvelopeSchema,
  taskIdSchema,
  threadIdSchema,
  type AccountId,
  type Agent,
  type Artifact,
  type AttachmentRef,
  type Conversation,
  type EventId,
  type ExternalId,
  type Interrupt,
  type InterruptId,
  type JsonObject,
  type JsonValue,
  type Message,
  type MessageId,
  type Run,
  type RunId,
  type RuntimeEventDraft,
  type RuntimeCapabilities,
  type RuntimeModelDescriptor,
  type RuntimeProviderConfig,
  type RuntimeProviderDescriptor,
  type Task,
  type TaskEventEnvelope,
  type TaskId,
  type ThreadId,
} from "../packages/core/src/index.ts";
import {
  RuntimeCoordinator,
  type RuntimeCoordinatorOptions,
} from "../packages/application/src/runtime-coordinator.ts";
import type {
  ActionDescriptor,
  ActionPort,
  ApplicationTransaction,
  ExternalEntityRef,
  ExternalIdentityBinding,
  ExternalIdentityTarget,
  OutboxRecord,
  Page,
  ProtocolPrincipal,
  RunQueuePort,
  RuntimeInterruptCorrelation,
  RuntimePromptRequest,
  RuntimeProvider,
  RuntimeProviderRegistry,
  RuntimeSession,
  RuntimeSessionRequest,
  RunWorkItem,
  UnitOfWork,
} from "../packages/application/src/ports.ts";

const TASK_EVENT_TOPIC = "task.event";

type MemoryState = {
  agents: Map<string, Agent>;
  conversations: Map<string, Conversation>;
  tasks: Map<string, Task>;
  runs: Map<string, Run>;
  messages: Map<string, Message>;
  artifacts: Map<string, Artifact>;
  attachments: Map<string, AttachmentRef>;
  interrupts: Map<string, Interrupt>;
  runtimeCorrelations: Map<string, RuntimeInterruptCorrelation>;
  external: Map<string, ExternalIdentityBinding>;
  externalReverse: Map<string, ExternalIdentityBinding>;
  idempotency: Map<string, JsonValue>;
  events: Map<string, TaskEventEnvelope[]>;
  outbox: OutboxRecord[];
};

function emptyState(): MemoryState {
  return {
    agents: new Map(),
    conversations: new Map(),
    tasks: new Map(),
    runs: new Map(),
    messages: new Map(),
    artifacts: new Map(),
    attachments: new Map(),
    interrupts: new Map(),
    runtimeCorrelations: new Map(),
    external: new Map(),
    externalReverse: new Map(),
    idempotency: new Map(),
    events: new Map(),
    outbox: [],
  };
}

const entityKey = (accountId: AccountId, id: string) => JSON.stringify([accountId, id]);
const eventKey = (accountId: AccountId, taskId: TaskId) => entityKey(accountId, taskId);
const externalKey = (accountId: AccountId, subjectId: string, ref: ExternalEntityRef) =>
  JSON.stringify([accountId, subjectId, ref.protocol, ref.namespace, ref.kind, ref.externalId]);
const reverseKey = (accountId: AccountId, subjectId: string, target: ExternalIdentityTarget) =>
  JSON.stringify([accountId, subjectId, target.protocol, target.namespace, target.kind, target.internalId]);
const idemKey = (accountId: AccountId, subjectId: string, operation: string, key: string) =>
  JSON.stringify([accountId, subjectId, operation, key]);

class MemoryHarness implements UnitOfWork {
  state = emptyState();
  #nextId = 1;
  #time = 1_900_000_000_000;

  now(): number { return this.#time++; }

  #uuid(): string {
    return `00000000-0000-4000-8000-${String(this.#nextId++).padStart(12, "0")}`;
  }

  accountId(): AccountId { return accountIdSchema.parse(this.#uuid()); }
  agentId() { return agentIdSchema.parse(this.#uuid()); }
  threadId(): ThreadId { return threadIdSchema.parse(this.#uuid()); }
  taskId(): TaskId { return taskIdSchema.parse(this.#uuid()); }
  runId(): RunId { return runIdSchema.parse(this.#uuid()); }
  messageId(): MessageId { return messageIdSchema.parse(this.#uuid()); }
  artifactId() { return artifactIdSchema.parse(this.#uuid()); }
  attachmentId() { return attachmentIdSchema.parse(this.#uuid()); }
  interruptId(): InterruptId { return interruptIdSchema.parse(this.#uuid()); }
  eventId(): EventId { return eventIdSchema.parse(this.#uuid()); }
  externalId(): ExternalId { return externalIdSchema.parse(`external-${this.#nextId++}`); }

  transaction<T>(operation: (tx: ApplicationTransaction) => T): T {
    const snapshot = structuredClone(this.state);
    try {
      return operation(this.#transaction());
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  #transaction(): ApplicationTransaction {
    const memory = this;
    return {
      agents: {
        get(accountId, agentId) {
          return memory.state.agents.get(entityKey(accountId, agentId)) ?? null;
        },
      },
      conversations: {
        create(conversation) {
          const key = entityKey(conversation.accountId, conversation.id);
          if (memory.state.conversations.has(key)) throw new ApplicationError("conflict", "conversation exists");
          memory.state.conversations.set(key, conversation);
          return conversation;
        },
        get(accountId, threadId) {
          return memory.state.conversations.get(entityKey(accountId, threadId)) ?? null;
        },
        update(conversation) {
          const key = entityKey(conversation.accountId, conversation.id);
          const existing = memory.state.conversations.get(key);
          if (!existing) throw new ApplicationError("not_found", "conversation not found");
          if (existing.createdAt !== conversation.createdAt) {
            throw new ApplicationError("conflict", "conversation identity changed");
          }
          memory.state.conversations.set(key, conversation);
          return conversation;
        },
      },
      tasks: {
        create(task) {
          const key = entityKey(task.accountId, task.id);
          if (memory.state.tasks.has(key)) throw new ApplicationError("conflict", "task exists");
          memory.state.tasks.set(key, task);
          return task;
        },
        get(accountId, taskId) {
          return memory.state.tasks.get(entityKey(accountId, taskId)) ?? null;
        },
        list(accountId, query): Page<Task> {
          let values = [...memory.state.tasks.values()].filter((task) => task.accountId === accountId);
          if (query.agentId) values = values.filter((task) => task.agentId === query.agentId);
          if (query.threadId) values = values.filter((task) => task.threadId === query.threadId);
          if (query.statuses) values = values.filter((task) => query.statuses!.includes(task.status));
          if (query.updatedAfter !== undefined) values = values.filter((task) => task.updatedAt > query.updatedAfter!);
          return { items: values.slice(0, query.limit), totalSize: values.length };
        },
        transition(accountId, taskId, expected, next, updatedAt) {
          const key = entityKey(accountId, taskId);
          const current = memory.state.tasks.get(key);
          if (!current) throw new ApplicationError("not_found", "task not found");
          if (current.status !== expected) throw new ApplicationError("conflict", "stale task state");
          const updated: Task = { ...current, status: next, updatedAt };
          memory.state.tasks.set(key, updated);
          return updated;
        },
      },
      runs: {
        create(run) {
          const key = entityKey(run.accountId, run.id);
          if (memory.state.runs.has(key)) throw new ApplicationError("conflict", "run exists");
          memory.state.runs.set(key, run);
          return run;
        },
        get(accountId, runId) {
          return memory.state.runs.get(entityKey(accountId, runId)) ?? null;
        },
        listForTask(accountId, taskId) {
          return [...memory.state.runs.values()].filter((run) => run.accountId === accountId && run.taskId === taskId);
        },
        update(run) {
          const key = entityKey(run.accountId, run.id);
          if (!memory.state.runs.has(key)) throw new ApplicationError("not_found", "run not found");
          memory.state.runs.set(key, run);
          return run;
        },
      },
      messages: {
        append(message) {
          const key = entityKey(message.accountId, message.id);
          const existing = memory.state.messages.get(key);
          if (existing && (
            existing.threadId !== message.threadId || existing.taskId !== message.taskId ||
            existing.runId !== message.runId || existing.role !== message.role ||
            existing.createdAt !== message.createdAt
          )) throw new ApplicationError("conflict", "message identity changed");
          memory.state.messages.set(key, message);
          return message;
        },
        get(accountId, messageId) {
          return memory.state.messages.get(entityKey(accountId, messageId)) ?? null;
        },
        list(accountId, threadId, taskId) {
          return [...memory.state.messages.values()].filter((message) =>
            message.accountId === accountId && message.threadId === threadId &&
            (taskId === undefined || message.taskId === taskId));
        },
      },
      artifacts: {
        put(artifact) {
          memory.state.artifacts.set(entityKey(artifact.accountId, artifact.id), artifact);
          return artifact;
        },
        get(accountId, artifactId) {
          return memory.state.artifacts.get(entityKey(accountId, artifactId)) ?? null;
        },
        list(accountId, taskId) {
          return [...memory.state.artifacts.values()].filter((artifact) =>
            artifact.accountId === accountId && artifact.taskId === taskId);
        },
      },
      attachments: {
        get(accountId, attachmentId) {
          return memory.state.attachments.get(entityKey(accountId, attachmentId)) ?? null;
        },
      },
      interrupts: {
        put(interrupt) {
          memory.state.interrupts.set(entityKey(interrupt.accountId, interrupt.id), interrupt);
          return interrupt;
        },
        get(accountId, interruptId) {
          return memory.state.interrupts.get(entityKey(accountId, interruptId)) ?? null;
        },
        listForTask(accountId, taskId) {
          return [...memory.state.interrupts.values()].filter((interrupt) =>
            interrupt.accountId === accountId && interrupt.taskId === taskId);
        },
      },
      runtimeCorrelations: {
        bindInterrupt(correlation) {
          const key = entityKey(correlation.accountId, correlation.interruptId);
          if (memory.state.runtimeCorrelations.has(key)) throw new ApplicationError("conflict", "correlation exists");
          memory.state.runtimeCorrelations.set(key, correlation);
        },
        getInterrupt(accountId, interruptId) {
          return memory.state.runtimeCorrelations.get(entityKey(accountId, interruptId)) ?? null;
        },
      },
      externalIdentities: {
        resolve(accountId, subjectId, ref) {
          return memory.state.external.get(externalKey(accountId, subjectId, ref)) ?? null;
        },
        findByInternal(accountId, subjectId, target) {
          return memory.state.externalReverse.get(reverseKey(accountId, subjectId, target)) ?? null;
        },
        bind(accountId, subjectId, binding) {
          const target = {
            protocol: binding.ref.protocol,
            namespace: binding.ref.namespace,
            kind: binding.ref.kind,
            internalId: binding.internalId,
          } as ExternalIdentityTarget;
          memory.state.external.set(externalKey(accountId, subjectId, binding.ref), binding);
          memory.state.externalReverse.set(reverseKey(accountId, subjectId, target), binding);
        },
      },
      idempotency: {
        get(accountId, subjectId, operation, key) {
          return memory.state.idempotency.get(idemKey(accountId, subjectId, operation, key)) ?? null;
        },
        put(accountId, subjectId, operation, key, result) {
          memory.state.idempotency.set(idemKey(accountId, subjectId, operation, key), result);
        },
      },
      events: {
        append(request) {
          const key = eventKey(request.accountId, request.taskId);
          const values = memory.state.events.get(key) ?? [];
          const envelope = taskEventEnvelopeSchema.parse({
            version: 1,
            eventId: memory.eventId(),
            accountId: request.accountId,
            taskId: request.taskId,
            runId: request.runId,
            agentId: request.agentId,
            threadId: request.threadId,
            seq: values.length + 1,
            time: memory.now(),
            type: request.event.type,
            data: request.event.data,
            metadata: request.metadata ?? {},
          });
          memory.state.events.set(key, [...values, envelope]);
          memory.state.outbox.push({
            id: `event:${envelope.eventId}`,
            accountId: envelope.accountId,
            topic: TASK_EVENT_TOPIC,
            payload: structuredClone(envelope) as unknown as JsonObject,
            createdAt: envelope.time,
          });
          return envelope;
        },
        lastSeq(accountId, taskId) {
          return memory.state.events.get(eventKey(accountId, taskId))?.length ?? 0;
        },
      },
      outbox: {
        enqueue(record) {
          memory.state.outbox.push(record);
        },
      },
    };
  }
}

class FakeQueue implements RunQueuePort {
  pending: RunWorkItem[] = [];
  claims: { workerId: string; now: number; leaseUntil: number; limit: number }[] = [];
  acknowledgments: { workerId: string; outboxId: string; deliveredAt: number }[] = [];
  retries: { workerId: string; outboxId: string; availableAt: number; reason: string }[] = [];
  renewals: { workerId: string; outboxId: string; now: number; leaseUntil: number }[] = [];
  renewalResults: (boolean | Error)[] = [];

  async claim(workerId: string, now: number, leaseUntil: number, limit: number): Promise<readonly RunWorkItem[]> {
    this.claims.push({ workerId, now, leaseUntil, limit });
    return this.pending.splice(0, limit);
  }

  async acknowledge(workerId: string, outboxId: string, deliveredAt: number): Promise<void> {
    this.acknowledgments.push({ workerId, outboxId, deliveredAt });
  }

  async renew(workerId: string, outboxId: string, now: number, leaseUntil: number): Promise<boolean> {
    this.renewals.push({ workerId, outboxId, now, leaseUntil });
    const result = this.renewalResults.shift() ?? true;
    if (result instanceof Error) throw result;
    return result;
  }

  async retry(workerId: string, outboxId: string, availableAt: number, reason: string): Promise<void> {
    this.retries.push({ workerId, outboxId, availableAt, reason });
  }
}

type FakeSessionScript = {
  providerSessionRef?: string | null;
  drafts?: readonly unknown[];
  runError?: unknown;
  createError?: unknown;
  waitForAbort?: boolean;
};

class FakeSession implements RuntimeSession {
  readonly providerSessionRef: string | null;
  readonly drafts: readonly unknown[];
  readonly runError?: unknown;
  readonly waitForAbort: boolean;
  prompts: RuntimePromptRequest[] = [];
  responses: { interruptRef: string; response: { status: "resolved"; value: JsonValue } | { status: "canceled" } }[] = [];
  cancelReasons: (string | undefined)[] = [];
  closed = 0;
  callOrder: string[] = [];

  constructor(script: FakeSessionScript) {
    this.providerSessionRef = script.providerSessionRef ?? "provider-session";
    this.drafts = script.drafts ?? [];
    this.runError = script.runError;
    this.waitForAbort = script.waitForAbort ?? false;
  }

  async *run(request: RuntimePromptRequest, signal?: AbortSignal): AsyncIterable<RuntimeEventDraft> {
    this.callOrder.push("run");
    this.prompts.push(request);
    if (this.waitForAbort) {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new ApplicationError("canceled", "fake run lost its lease", { retryable: true });
    }
    for (const draft of this.drafts) {
      if (signal?.aborted) throw new ApplicationError("canceled", "fake session canceled", { retryable: true });
      yield draft as RuntimeEventDraft;
    }
    if (this.runError !== undefined) throw this.runError;
  }

  async respond(
    interruptRef: string,
    response: { status: "resolved"; value: JsonValue } | { status: "canceled" },
  ): Promise<void> {
    this.callOrder.push("respond");
    this.responses.push({ interruptRef, response });
  }

  async cancel(reason?: string): Promise<void> {
    this.cancelReasons.push(reason);
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

class FakeProvider implements RuntimeProvider {
  readonly id = "fake-runtime";
  supported: RuntimeCapabilities["supported"] = [
    "streaming",
    "resume",
    "cancellation",
    "actions",
    "interrupts",
    "reasoning_summaries",
    "attachments",
  ];
  scripts: FakeSessionScript[] = [];
  sessions: FakeSession[] = [];
  createRequests: RuntimeSessionRequest[] = [];
  capabilityConfigs: RuntimeProviderConfig[] = [];

  async describe(_accountId: AccountId): Promise<RuntimeProviderDescriptor> {
    return { id: this.id, label: "Fake", authMethods: [{ id: "none", label: "None", kind: "none" }] };
  }

  async listModels(_accountId: AccountId): Promise<readonly RuntimeModelDescriptor[]> {
    return [{ id: "fake-model", label: "Fake model", reasoningEfforts: [] }];
  }

  async resolveCapabilities(_accountId: AccountId, config: RuntimeProviderConfig): Promise<RuntimeCapabilities> {
    this.capabilityConfigs.push(config);
    return {
      supported: [...this.supported],
      extensions: [],
    };
  }

  validateConfig(config: RuntimeProviderConfig): RuntimeProviderConfig {
    return { ...config, options: { ...config.options, validated: true } };
  }

  async authState() {
    return { status: "ready" as const };
  }

  async createSession(request: RuntimeSessionRequest): Promise<RuntimeSession> {
    this.createRequests.push(request);
    const script = this.scripts.shift() ?? {};
    if (script.createError !== undefined) throw script.createError;
    const session = new FakeSession(script);
    this.sessions.push(session);
    return session;
  }
}

class FakeRegistry implements RuntimeProviderRegistry {
  constructor(readonly provider: FakeProvider) {}
  get(providerId: string): RuntimeProvider {
    if (providerId !== this.provider.id) throw new ApplicationError("not_found", "provider not found");
    return this.provider;
  }
  async list(accountId: AccountId): Promise<readonly RuntimeProviderDescriptor[]> {
    return [await this.provider.describe(accountId)];
  }
}

class FakeActions implements ActionPort {
  readonly descriptors: readonly ActionDescriptor[] = [{
    name: "search",
    description: "Search a test corpus",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  }];
  principals: ProtocolPrincipal[] = [];

  async list(principal: ProtocolPrincipal): Promise<readonly ActionDescriptor[]> {
    this.principals.push(principal);
    return this.descriptors;
  }

  async invoke(): Promise<never> {
    throw new Error("not used by the runtime event boundary");
  }
}

type Seed = {
  accountId: AccountId;
  agent: Agent;
  task: Task;
  run: Run;
  input: Message;
  work: Extract<RunWorkItem, { kind: "execute" }>;
};

function seedExecution(memory: MemoryHarness, overrides: {
  taskStatus?: Task["status"];
  runStatus?: Run["status"];
  attempt?: number;
  providerSessionRef?: string | null;
} = {}): Seed {
  const accountId = memory.accountId();
  const agentId = memory.agentId();
  const threadId = memory.threadId();
  const taskId = memory.taskId();
  const runId = memory.runId();
  const now = memory.now();
  const agent: Agent = {
    id: agentId,
    accountId,
    name: "Fake agent",
    description: "Runtime coordinator test agent",
    runtime: { providerId: "fake-runtime", modelId: "fake-model", options: { original: true } },
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
  const conversation: Conversation = {
    id: threadId,
    accountId,
    title: null,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
  const task: Task = {
    id: taskId,
    accountId,
    threadId,
    agentId,
    status: overrides.taskStatus ?? "submitted",
    createdAt: now,
    updatedAt: now,
    metadata: { source: "runtime-test" },
  };
  const run: Run = {
    id: runId,
    accountId,
    taskId,
    threadId,
    agentId,
    attempt: overrides.attempt ?? 1,
    status: overrides.runStatus ?? "queued",
    providerSessionRef: overrides.providerSessionRef ?? null,
    createdAt: now,
    startedAt: overrides.runStatus === "running" ? now : null,
    finishedAt: overrides.runStatus === "completed" || overrides.runStatus === "failed" || overrides.runStatus === "canceled"
      ? now
      : null,
    metadata: { trace: "public-only" },
  };
  const input: Message = {
    id: memory.messageId(),
    accountId,
    threadId,
    taskId,
    runId: null,
    role: "user",
    parts: [{ kind: "text", text: "Hello runtime" }],
    createdAt: now,
    metadata: {},
  };
  memory.state.agents.set(entityKey(accountId, agentId), agent);
  memory.state.conversations.set(entityKey(accountId, threadId), conversation);
  memory.state.tasks.set(entityKey(accountId, taskId), task);
  memory.state.runs.set(entityKey(accountId, runId), run);
  memory.state.messages.set(entityKey(accountId, input.id), input);
  return {
    accountId,
    agent,
    task,
    run,
    input,
    work: {
      kind: "execute",
      outboxId: `execute:${run.id}`,
      accountId,
      taskId,
      runId,
      threadId,
      agentId,
      attempt: run.attempt,
      continuationInterruptIds: [],
    },
  };
}

function setup(options: Partial<RuntimeCoordinatorOptions> = {}) {
  const memory = new MemoryHarness();
  const provider = new FakeProvider();
  const queue = new FakeQueue();
  const actions = new FakeActions();
  const coordinator = new RuntimeCoordinator({
    unitOfWork: memory,
    providers: new FakeRegistry(provider),
    actions,
    queue,
    clock: memory,
    ids: memory,
  }, {
    workerId: "runtime-worker",
    leaseMs: 30_000,
    retryDelayMs: 2_000,
    ...options,
  });
  return { memory, provider, queue, actions, coordinator };
}

function eventsFor(memory: MemoryHarness, seed: Pick<Seed, "accountId" | "task">): TaskEventEnvelope[] {
  return memory.state.events.get(eventKey(seed.accountId, seed.task.id)) ?? [];
}

function publicRuntimeJson(memory: MemoryHarness): string {
  return JSON.stringify({
    events: [...memory.state.events.values()].flat(),
    eventOutbox: memory.state.outbox.filter((record) => record.topic === TASK_EVENT_TOPIC),
    messages: [...memory.state.messages.values()],
  });
}

describe("provider-neutral runtime coordinator", () => {
  test("claims a successful run, emits balanced canonical events, and commits exactly one terminal outcome", async () => {
    const { memory, provider, queue, actions, coordinator } = setup({
      capabilities: [{ kind: "workspace", ref: "workspace-capability" }],
    });
    const seed = seedExecution(memory);
    provider.scripts.push({
      providerSessionRef: "private-session-success",
      drafts: [
        { type: "message.started", data: { providerMessageRef: "provider-message", role: "agent" } },
        { type: "message.text.delta", data: { providerMessageRef: "provider-message", delta: "Hello" } },
        { type: "reasoning.summary.delta", data: { providerMessageRef: "provider-message", delta: "A concise summary" } },
        { type: "message.finished", data: { providerMessageRef: "provider-message", parts: [{ kind: "text", text: "Hello" }] } },
        { type: "action.started", data: { providerCallRef: "provider-call", name: "search" } },
        { type: "action.arguments.delta", data: { providerCallRef: "provider-call", delta: "{\"q\":\"hello\"}" } },
        { type: "action.finished", data: { providerCallRef: "provider-call", outcome: "success", output: { hits: 1 } } },
        { type: "activity.updated", data: { label: "Finishing", progress: 1 } },
        { type: "completed", data: { stopReason: "done" } },
      ],
    });
    queue.pending.push(seed.work);

    await expect(coordinator.processOnce()).resolves.toEqual({ claimed: 1, acknowledged: 1, retried: 0 });

    const storedTask = memory.state.tasks.get(entityKey(seed.accountId, seed.task.id));
    const storedRun = memory.state.runs.get(entityKey(seed.accountId, seed.run.id));
    expect(storedTask?.status).toBe("completed");
    expect(storedRun?.status).toBe("completed");
    expect(storedRun?.providerSessionRef).toBe("private-session-success");
    expect(storedRun?.startedAt).not.toBeNull();
    expect(storedRun?.finishedAt).not.toBeNull();

    expect(provider.createRequests).toHaveLength(1);
    expect(provider.createRequests[0]?.config.options).toEqual({ original: true, validated: true });
    expect(provider.createRequests[0]?.capabilities).toEqual([{ kind: "workspace", ref: "workspace-capability" }]);
    expect(provider.sessions[0]?.prompts[0]?.messages).toEqual([seed.input]);
    expect(provider.sessions[0]?.prompts[0]?.actions).toEqual(actions.descriptors);
    expect(actions.principals[0]).toMatchObject({ accountId: seed.accountId, kind: "service", scopes: ["*"] });

    const events = eventsFor(memory, seed);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.map((event) => event.type)).toEqual([
      "task.status.changed",
      "run.status.changed",
      "message.started",
      "message.text.delta",
      "reasoning.summary.delta",
      "message.finished",
      "action.started",
      "action.arguments.delta",
      "action.finished",
      "activity.updated",
      "run.status.changed",
      "task.status.changed",
    ]);
    expect(events.filter((event) => event.type === "message.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "message.finished")).toHaveLength(1);
    expect(events.filter((event) => event.type === "action.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "action.finished")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.status.changed" && ["completed", "failed", "canceled"].includes(event.data.to))).toHaveLength(1);
    expect(memory.state.outbox.filter((record) => record.topic === TASK_EVENT_TOPIC)).toHaveLength(events.length);
    expect(queue.acknowledgments.map((value) => value.outboxId)).toEqual([seed.work.outboxId]);
    expect(queue.retries).toHaveLength(0);

    const publicJson = publicRuntimeJson(memory);
    expect(publicJson).not.toContain("provider-message");
    expect(publicJson).not.toContain("provider-call");
    expect(publicJson).not.toContain("private-session-success");
  });

  test("persists an interrupt and private correlation, then responds before running a resumed session", async () => {
    const { memory, provider, queue, coordinator } = setup();
    const seed = seedExecution(memory);
    provider.scripts.push({
      providerSessionRef: "private-session-interrupt",
      drafts: [{
        type: "interrupt.requested",
        data: {
          providerRequestRef: "private-request-ref",
          kind: "input",
          prompt: "Choose a value",
          responseSchema: { type: ["string", "null"] },
        },
      }],
    });

    await expect(coordinator.processWorkItem(seed.work)).resolves.toBe("acknowledged");
    expect(memory.state.tasks.get(entityKey(seed.accountId, seed.task.id))?.status).toBe("input_required");
    expect(memory.state.runs.get(entityKey(seed.accountId, seed.run.id))?.status).toBe("interrupted");
    const interrupt = [...memory.state.interrupts.values()][0];
    expect(interrupt).toBeDefined();
    const correlation = memory.state.runtimeCorrelations.get(entityKey(seed.accountId, interrupt!.id));
    expect(correlation).toEqual({
      accountId: seed.accountId,
      taskId: seed.task.id,
      runId: seed.run.id,
      interruptId: interrupt!.id,
      providerRequestRef: "private-request-ref",
    });
    expect(publicRuntimeJson(memory)).not.toContain("private-request-ref");

    memory.state.interrupts.set(entityKey(seed.accountId, interrupt!.id), {
      ...interrupt!,
      status: "resolved",
      response: null,
      resolvedAt: memory.now(),
    });
    memory.state.tasks.set(entityKey(seed.accountId, seed.task.id), {
      ...memory.state.tasks.get(entityKey(seed.accountId, seed.task.id))!,
      status: "working",
      updatedAt: memory.now(),
    });
    const resumedRun: Run = {
      ...seed.run,
      id: memory.runId(),
      attempt: 2,
      status: "queued",
      providerSessionRef: null,
      createdAt: memory.now(),
      startedAt: null,
      finishedAt: null,
    };
    memory.state.runs.set(entityKey(seed.accountId, resumedRun.id), resumedRun);
    const resumedWork: Extract<RunWorkItem, { kind: "execute" }> = {
      ...seed.work,
      outboxId: `execute:${resumedRun.id}`,
      runId: resumedRun.id,
      attempt: resumedRun.attempt,
      continuationInterruptIds: [interrupt!.id],
    };
    provider.scripts.push({
      providerSessionRef: "private-session-interrupt",
      drafts: [{ type: "completed", data: {} }],
    });

    await expect(coordinator.processWorkItem(resumedWork)).resolves.toBe("acknowledged");
    expect(provider.createRequests[1]?.resumeSessionRef).toBe("private-session-interrupt");
    expect(provider.sessions[1]?.responses).toEqual([{
      interruptRef: "private-request-ref",
      response: { status: "resolved", value: null },
    }]);
    expect(provider.sessions[1]?.callOrder).toEqual(["respond", "run"]);
    expect(memory.state.tasks.get(entityKey(seed.accountId, seed.task.id))?.status).toBe("completed");
    expect(memory.state.runs.get(entityKey(seed.accountId, resumedRun.id))?.status).toBe("completed");
    expect(publicRuntimeJson(memory)).not.toContain("private-request-ref");
  });

  test.each([
    ["unbalanced message", [
      { type: "message.started", data: { providerMessageRef: "open-message", role: "agent" } },
      { type: "completed", data: {} },
    ]],
    ["unbalanced action", [
      { type: "action.started", data: { providerCallRef: "open-action", name: "search" } },
      { type: "completed", data: {} },
    ]],
    ["duplicate terminal", [
      { type: "completed", data: {} },
      { type: "completed", data: {} },
    ]],
    ["invalid draft", [
      { type: "message.started", data: { providerMessageRef: "", role: "agent" } },
    ]],
    ["missing terminal", []],
  ] as const)("fails a malformed stream: %s", async (_label, drafts) => {
    const { memory, provider, queue, coordinator } = setup();
    const seed = seedExecution(memory);
    provider.scripts.push({ drafts });

    await expect(coordinator.processWorkItem(seed.work)).resolves.toBe("acknowledged");

    expect(memory.state.tasks.get(entityKey(seed.accountId, seed.task.id))?.status).toBe("failed");
    expect(memory.state.runs.get(entityKey(seed.accountId, seed.run.id))?.status).toBe("failed");
    const events = eventsFor(memory, seed);
    const startedMessages = events.filter((event) => event.type === "message.started");
    const finishedMessages = events.filter((event) => event.type === "message.finished");
    expect(finishedMessages).toHaveLength(startedMessages.length);
    const startedActions = events.filter((event) => event.type === "action.started");
    const finishedActions = events.filter((event) => event.type === "action.finished");
    expect(finishedActions).toHaveLength(startedActions.length);
    const terminalRunEvents = events.filter((event) =>
      event.type === "run.status.changed" && ["completed", "failed", "canceled"].includes(event.data.to));
    expect(terminalRunEvents).toHaveLength(1);
    expect(terminalRunEvents[0]).toMatchObject({ data: { to: "failed", error: { code: "invalid_runtime_stream" } } });
    expect(queue.acknowledgments).toHaveLength(1);
    expect(queue.retries).toHaveLength(0);
  });

  test("fails closed before session creation when a provider lacks required streaming capability", async () => {
    const { memory, provider, queue, coordinator } = setup();
    const seed = seedExecution(memory);
    provider.supported = [];

    await expect(coordinator.processWorkItem(seed.work)).resolves.toBe("acknowledged");

    expect(provider.createRequests).toHaveLength(0);
    expect(memory.state.runs.get(entityKey(seed.accountId, seed.run.id))?.status).toBe("failed");
    expect(memory.state.tasks.get(entityKey(seed.accountId, seed.task.id))?.status).toBe("failed");
    expect(queue.retries).toHaveLength(0);
  });

  test("rejects a provider file part unless its attachment belongs to the task account", async () => {
    const { memory, provider, coordinator } = setup();
    const seed = seedExecution(memory);
    const foreignAccount = memory.accountId();
    const attachment: AttachmentRef = {
      id: memory.attachmentId(),
      name: "foreign.txt",
      mediaType: "text/plain",
      size: 4,
      sha256: "a".repeat(64),
    };
    memory.state.attachments.set(entityKey(foreignAccount, attachment.id), attachment);
    provider.scripts.push({ drafts: [
      { type: "message.started", data: { providerMessageRef: "file-message", role: "agent" } },
      { type: "message.finished", data: { providerMessageRef: "file-message", parts: [{ kind: "file", attachment }] } },
      { type: "completed", data: {} },
    ] });

    await expect(coordinator.processWorkItem(seed.work)).resolves.toBe("acknowledged");

    expect(memory.state.runs.get(entityKey(seed.accountId, seed.run.id))?.status).toBe("failed");
    expect([...memory.state.messages.values()].some((message) =>
      message.accountId === seed.accountId && message.parts.some((part) => part.kind === "file"))).toBe(false);
    expect(eventsFor(memory, seed).some((event) =>
      event.type === "run.status.changed" && event.data.error?.code === "invalid_runtime_stream")).toBe(true);
  });

  test("cancels canonical state and a resumable provider session", async () => {
    const { memory, provider, coordinator } = setup();
    const seed = seedExecution(memory, {
      taskStatus: "working",
      runStatus: "running",
      providerSessionRef: "private-session-cancel",
    });
    provider.scripts.push({ providerSessionRef: "private-session-cancel" });
    const interrupt: Interrupt = {
      id: memory.interruptId(),
      accountId: seed.accountId,
      taskId: seed.task.id,
      runId: seed.run.id,
      kind: "input",
      prompt: "Pending input",
      responseSchema: { type: "string" },
      status: "open",
      createdAt: memory.now(),
      expiresAt: null,
      resolvedAt: null,
      metadata: {},
    };
    memory.state.interrupts.set(entityKey(seed.accountId, interrupt.id), interrupt);
    const work: Extract<RunWorkItem, { kind: "cancel" }> = {
      kind: "cancel",
      outboxId: `cancel:${seed.run.id}`,
      accountId: seed.accountId,
      taskId: seed.task.id,
      runId: seed.run.id,
      reason: "user requested cancellation",
    };

    await expect(coordinator.processWorkItem(work)).resolves.toBe("acknowledged");

    expect(memory.state.runs.get(entityKey(seed.accountId, seed.run.id))?.status).toBe("canceled");
    expect(memory.state.tasks.get(entityKey(seed.accountId, seed.task.id))?.status).toBe("canceled");
    expect(provider.createRequests[0]?.resumeSessionRef).toBe("private-session-cancel");
    expect(provider.sessions[0]?.cancelReasons).toEqual(["user requested cancellation"]);
    expect(provider.sessions[0]?.closed).toBe(1);
    expect(memory.state.interrupts.get(entityKey(seed.accountId, interrupt.id))).toMatchObject({
      status: "canceled",
      resolvedAt: expect.any(Number),
    });
    expect(eventsFor(memory, seed).map((event) => event.type)).toEqual([
      "interrupt.resolved",
      "run.status.changed",
      "task.status.changed",
    ]);
    const terminalRuns = eventsFor(memory, seed).filter((event) =>
      event.type === "run.status.changed" && event.data.to === "canceled");
    expect(terminalRuns).toHaveLength(1);
  });

  test("an in-flight cancel aborts the locally active provider and both leased work items settle", async () => {
    const { memory, provider, queue, coordinator } = setup();
    const seed = seedExecution(memory);
    provider.scripts.push({ providerSessionRef: "private-active-session", waitForAbort: true });
    const execute = coordinator.processWorkItem(seed.work);
    for (let index = 0; provider.sessions[0]?.prompts.length !== 1; index += 1) {
      if (index >= 100) throw new Error("fake provider did not start");
      await Bun.sleep(1);
    }
    const cancelWork: Extract<RunWorkItem, { kind: "cancel" }> = {
      kind: "cancel",
      outboxId: `cancel:${seed.run.id}`,
      accountId: seed.accountId,
      taskId: seed.task.id,
      runId: seed.run.id,
      reason: "stop active work",
    };

    const cancel = coordinator.processWorkItem(cancelWork);
    await expect(Promise.all([execute, cancel])).resolves.toEqual(["acknowledged", "acknowledged"]);

    expect(memory.state.runs.get(entityKey(seed.accountId, seed.run.id))?.status).toBe("canceled");
    expect(memory.state.tasks.get(entityKey(seed.accountId, seed.task.id))?.status).toBe("canceled");
    expect(provider.sessions).toHaveLength(1);
    expect(provider.sessions[0]?.cancelReasons).toEqual(expect.arrayContaining(["stop active work", "canonical run stopped"]));
    expect(provider.sessions[0]?.closed).toBe(1);
    expect(queue.acknowledgments.map((value) => value.outboxId).sort()).toEqual([
      cancelWork.outboxId,
      seed.work.outboxId,
    ].sort());
  });

  test("repairs stale open interrupts on an already-canceled run without duplicating canonical events", async () => {
    const { memory, provider, coordinator } = setup();
    const seed = seedExecution(memory, {
      taskStatus: "canceled",
      runStatus: "canceled",
      providerSessionRef: "private-session-stale-cancel",
    });
    const interrupt: Interrupt = {
      id: memory.interruptId(),
      accountId: seed.accountId,
      taskId: seed.task.id,
      runId: seed.run.id,
      kind: "permission",
      prompt: "Stale permission",
      responseSchema: { type: "boolean" },
      status: "open",
      createdAt: memory.now(),
      expiresAt: null,
      resolvedAt: null,
      metadata: {},
    };
    memory.state.interrupts.set(entityKey(seed.accountId, interrupt.id), interrupt);
    provider.scripts.push(
      { providerSessionRef: "private-session-stale-cancel" },
      { providerSessionRef: "private-session-stale-cancel" },
    );
    const work: Extract<RunWorkItem, { kind: "cancel" }> = {
      kind: "cancel",
      outboxId: `cancel:${seed.run.id}`,
      accountId: seed.accountId,
      taskId: seed.task.id,
      runId: seed.run.id,
    };

    await expect(coordinator.processWorkItem(work)).resolves.toBe("acknowledged");
    expect(eventsFor(memory, seed).map((event) => event.type)).toEqual(["interrupt.resolved"]);
    expect(memory.state.interrupts.get(entityKey(seed.accountId, interrupt.id))?.status).toBe("canceled");

    const eventCount = eventsFor(memory, seed).length;
    await expect(coordinator.processWorkItem(work)).resolves.toBe("acknowledged");
    expect(eventsFor(memory, seed)).toHaveLength(eventCount);
    expect(provider.sessions).toHaveLength(2);
    expect(provider.sessions.every((session) => session.cancelReasons.length === 1)).toBe(true);
  });

  test("retries transient infrastructure failure without duplicating start transitions", async () => {
    const { memory, provider, queue, coordinator } = setup();
    const seed = seedExecution(memory);
    provider.scripts.push({
      createError: new ApplicationError("unavailable", "provider unavailable", { retryable: true }),
    });

    await expect(coordinator.processWorkItem(seed.work)).resolves.toBe("retried");
    expect(memory.state.tasks.get(entityKey(seed.accountId, seed.task.id))?.status).toBe("working");
    expect(memory.state.runs.get(entityKey(seed.accountId, seed.run.id))?.status).toBe("running");
    expect(queue.retries).toHaveLength(1);
    expect(queue.retries[0]?.outboxId).toBe(seed.work.outboxId);
    expect(queue.acknowledgments).toHaveLength(0);

    provider.scripts.push({ drafts: [{ type: "completed", data: {} }] });
    await expect(coordinator.processWorkItem(seed.work)).resolves.toBe("acknowledged");

    const events = eventsFor(memory, seed);
    expect(events.filter((event) => event.type === "task.status.changed" && event.data.to === "working")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.status.changed" && event.data.to === "running")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.status.changed" && event.data.to === "completed")).toHaveLength(1);
    expect(queue.acknowledgments).toHaveLength(1);
  });

  test("renews a live lease and aborts the provider without leaking a heartbeat when ownership is lost", async () => {
    const { memory, provider, queue, coordinator } = setup({
      leaseMs: 30,
      leaseRenewalIntervalMs: 1,
    });
    const seed = seedExecution(memory);
    queue.renewalResults.push(false);
    provider.scripts.push({ waitForAbort: true });

    await expect(coordinator.processWorkItem(seed.work)).resolves.toBe("retried");

    expect(queue.renewals).toHaveLength(1);
    expect(queue.renewals[0]).toMatchObject({
      workerId: "runtime-worker",
      outboxId: seed.work.outboxId,
    });
    expect(queue.renewals[0]!.leaseUntil - queue.renewals[0]!.now).toBe(30);
    expect(provider.sessions[0]?.cancelReasons).toEqual(["runtime worker canceled"]);
    expect(provider.sessions[0]?.closed).toBe(1);
    expect(queue.retries).toHaveLength(1);
    expect(queue.acknowledgments).toHaveLength(0);

    const renewalCount = queue.renewals.length;
    await Bun.sleep(5);
    expect(queue.renewals).toHaveLength(renewalCount);
  });
});
