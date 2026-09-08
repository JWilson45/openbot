import type {
  RuntimePromptRequest,
  RuntimeProvider,
  RuntimeSession,
  RuntimeSessionRequest,
} from "@openbot/application";
import {
  RunnerUnavailable,
  type EnsureHarnessRequest,
  type LiveWorkEvent,
  type PromptResult,
  type RunnerSession,
} from "@openbot/compute-protocol";
import {
  ApplicationError,
  accountIdSchema,
  agentIdSchema,
  jsonObjectSchema,
  messageSchema,
  publicMetadataSchema,
  runIdSchema,
  runtimeAuthStateSchema,
  runtimeCapabilitiesSchema,
  runtimeEventDraftSchema,
  runtimeModelDescriptorSchema,
  runtimeProviderConfigSchema,
  runtimeProviderDescriptorSchema,
  stableNameSchema,
  taskIdSchema,
  type JsonValue,
  type RuntimeEventDraft,
  type RuntimeProviderConfig,
} from "@openbot/core";
import { GrokLiveEventMapper } from "./mapper.ts";
import { composeGrokPrompt } from "./prompt.ts";
import {
  DEFAULT_MAXIMUM_GROK_PROMPT_BYTES,
  type GrokRuntimeHost,
  type GrokRuntimeProviderOptions,
  type GrokRuntimeReleaseOutcome,
  type PreparedGrokRunner,
} from "./types.ts";

const activeRunners = new WeakSet<RunnerSession>();

export class GrokRuntimeProvider implements RuntimeProvider {
  readonly id: string;
  readonly #host: GrokRuntimeHost;
  readonly #maximumPromptBytes: number;
  readonly #turns = new GrokTurnRegistry();

  constructor(host: GrokRuntimeHost, options: GrokRuntimeProviderOptions = {}) {
    this.#host = host;
    this.id = stableNameSchema.parse(options.id ?? "grok");
    this.#maximumPromptBytes = options.maximumPromptBytes ?? DEFAULT_MAXIMUM_GROK_PROMPT_BYTES;
    if (!Number.isSafeInteger(this.#maximumPromptBytes) || this.#maximumPromptBytes <= 0) {
      throw new ApplicationError("invalid_argument", "maximumPromptBytes must be a positive integer");
    }
  }

  async describe(accountIdValue: RuntimeSessionRequest["accountId"]) {
    const accountId = accountIdSchema.parse(accountIdValue);
    const descriptor = runtimeProviderDescriptorSchema.parse(await this.#host.describe(accountId));
    if (descriptor.id !== this.id) {
      throw new ApplicationError("internal", "Grok host returned a descriptor for another provider");
    }
    return descriptor;
  }

  async listModels(accountIdValue: RuntimeSessionRequest["accountId"]) {
    const accountId = accountIdSchema.parse(accountIdValue);
    const values = await this.#host.listModels(accountId);
    if (!Array.isArray(values)) throw new ApplicationError("internal", "Grok host returned an invalid model catalog");
    const models = values.map((value) => runtimeModelDescriptorSchema.parse(value));
    if (new Set(models.map((model) => model.id)).size !== models.length) {
      throw new ApplicationError("internal", "Grok host returned duplicate model identifiers");
    }
    return models;
  }

  async resolveCapabilities(
    accountIdValue: RuntimeSessionRequest["accountId"],
    configValue: RuntimeProviderConfig,
  ) {
    const accountId = accountIdSchema.parse(accountIdValue);
    const config = this.validateConfig(configValue);
    return runtimeCapabilitiesSchema.parse(await this.#host.resolveCapabilities(accountId, config));
  }

  validateConfig(configValue: RuntimeProviderConfig): RuntimeProviderConfig {
    const config = runtimeProviderConfigSchema.parse(configValue);
    if (config.providerId !== this.id) {
      throw new ApplicationError(
        "invalid_argument",
        `runtime configuration selects '${config.providerId}', expected '${this.id}'`,
      );
    }
    const keys = Object.keys(config.options);
    const unknown = keys.find((key) => key !== "reasoningEffort");
    if (unknown !== undefined) {
      throw new ApplicationError("invalid_argument", `unsupported Grok runtime option: ${unknown}`);
    }
    const reasoningEffort = config.options.reasoningEffort;
    if (
      reasoningEffort !== undefined &&
      (typeof reasoningEffort !== "string" ||
        reasoningEffort.trim().length < 1 ||
        reasoningEffort.trim().length > 64)
    ) {
      throw new ApplicationError(
        "invalid_argument",
        "Grok reasoningEffort must be a non-empty JSON string",
      );
    }
    return {
      ...config,
      options: reasoningEffort === undefined
        ? {}
        : { reasoningEffort: reasoningEffort.trim() },
    };
  }

  async authState(accountIdValue: RuntimeSessionRequest["accountId"]) {
    const accountId = accountIdSchema.parse(accountIdValue);
    return runtimeAuthStateSchema.parse(await this.#host.authState(accountId));
  }

  async createSession(requestValue: RuntimeSessionRequest, signal?: AbortSignal): Promise<RuntimeSession> {
    assertSignal(signal);
    const request = normalizeSessionRequest(requestValue, this);
    let prepared: PreparedGrokRunner | undefined;
    try {
      prepared = validatePrepared(await this.#host.prepare(request, signal));
      assertSignal(signal);
      const ensureRequest = withResumeSession(prepared.ensureHarnessRequest, request.resumeSessionRef);
      const result = await prepared.runner.ensureHarness(ensureRequest);
      if (!result || typeof result !== "object" || typeof result.resumed !== "boolean") {
        throw new ApplicationError("provider_error", "Grok runner returned an invalid harness result");
      }
      assertSignal(signal);
      const sessionRef = result.acpSessionId ?? request.resumeSessionRef ?? null;
      if (sessionRef !== null && (typeof sessionRef !== "string" || sessionRef.length < 1 || sessionRef.length > 512)) {
        throw new ApplicationError("provider_error", "Grok runner returned an invalid session reference");
      }
      return new GrokRuntimeSession(
        prepared.runner,
        ensureRequest,
        sessionRef,
        this.#maximumPromptBytes,
        this.#turns,
        request.resumeSessionRef === undefined
          ? undefined
          : this.#turns.find(
              prepared.runner,
              ensureRequest.botId,
              request.resumeSessionRef,
            ),
        this.#host.release === undefined
          ? undefined
          : (outcome) => this.#host.release!(request, outcome),
      );
    } catch (error) {
      if (prepared !== undefined && this.#host.release !== undefined) {
        await this.#host.release(request, {
          status: "failed",
          code: "session_initialization_failed",
          retryable: error instanceof RunnerUnavailable,
        });
      }
      throw error;
    }
  }
}

class GrokTurnRegistry {
  readonly #turns = new WeakMap<RunnerSession, Map<string, GrokTurn>>();

  create(
    runner: RunnerSession,
    ensureRequest: EnsureHarnessRequest,
    providerSessionRef: string | null,
  ): GrokTurn {
    if (activeRunners.has(runner)) {
      throw new ApplicationError("conflict", "Grok runner already owns an active runtime turn");
    }
    const byBot = this.#turns.get(runner) ?? new Map<string, GrokTurn>();
    if (byBot.has(ensureRequest.botId)) {
      throw new ApplicationError("conflict", "Grok bot already owns an active runtime turn");
    }
    let turn!: GrokTurn;
    turn = new GrokTurn(runner, ensureRequest, providerSessionRef, () => {
      if (byBot.get(ensureRequest.botId) === turn) byBot.delete(ensureRequest.botId);
      if (byBot.size === 0) this.#turns.delete(runner);
      activeRunners.delete(runner);
    });
    byBot.set(ensureRequest.botId, turn);
    this.#turns.set(runner, byBot);
    activeRunners.add(runner);
    return turn;
  }

  find(runner: RunnerSession, botId: string, providerSessionRef: string): GrokTurn | undefined {
    const turn = this.#turns.get(runner)?.get(botId);
    return turn?.canResume(providerSessionRef) ? turn : undefined;
  }
}

type GrokTurnState = "streaming" | "paused" | "terminal";

class GrokTurn {
  readonly #runner: RunnerSession;
  readonly #ensureRequest: EnsureHarnessRequest;
  readonly #providerSessionRef: string | null;
  readonly #mapper = new GrokLiveEventMapper();
  readonly #previousListener: RunnerSession["onLiveWork"];
  readonly #onDone: () => void;
  readonly #listener: (event: LiveWorkEvent, botId?: string) => void;
  #queue = new DraftQueue();
  #queueClaimed = false;
  #state: GrokTurnState = "streaming";
  #pendingInterruptRef?: string;
  #started = false;
  #cleaned = false;
  #cancelWork?: Promise<void>;

  constructor(
    runner: RunnerSession,
    ensureRequest: EnsureHarnessRequest,
    providerSessionRef: string | null,
    onDone: () => void,
  ) {
    this.#runner = runner;
    this.#ensureRequest = ensureRequest;
    this.#providerSessionRef = providerSessionRef;
    this.#onDone = onDone;
    this.#previousListener = runner.onLiveWork;
    this.#listener = (event, botId) => {
      const owner = botId ?? event.botId;
      if (owner !== undefined && owner !== this.#ensureRequest.botId) {
        try {
          this.#previousListener?.(event, botId);
        } catch {
          // Infrastructure diagnostics cannot corrupt this provider stream.
        }
        return;
      }
      if (this.#state !== "streaming") {
        try {
          if (this.#mapper.map(event).length === 0) return;
        } catch {
          // The failure below deliberately replaces provider-specific detail.
        }
        this.#terminateFailure(
          "malformed_provider_event",
          "Grok emitted an event while waiting for an interrupt response",
          false,
        );
        void this.#cancelRunner().catch(() => undefined);
        return;
      }
      try {
        const drafts = this.#mapper.map(event);
        for (const draft of drafts) {
          this.#queue.push(draft);
          if (draft.type === "interrupt.requested") {
            this.#pendingInterruptRef = draft.data.providerRequestRef;
            this.#state = "paused";
            this.#queue.close();
          }
        }
      } catch {
        this.#terminateFailure(
          "malformed_provider_event",
          "Grok emitted a malformed live-work event",
          false,
        );
        void this.#cancelRunner().catch(() => undefined);
      }
    };
  }

  get state(): GrokTurnState {
    return this.#state;
  }

  canResume(providerSessionRef: string): boolean {
    return (
      this.#state !== "terminal" &&
      this.#providerSessionRef !== null &&
      this.#providerSessionRef === providerSessionRef
    );
  }

  start(prompt: string): void {
    if (this.#started) throw new ApplicationError("conflict", "Grok turn already started");
    this.#started = true;
    this.#runner.onLiveWork = this.#listener;
    void Promise.resolve()
      .then(() => this.#runner.prompt(prompt, this.#ensureRequest.botId))
      .then((result) => {
        if (this.#mapper.terminal) return;
        if (this.#state === "paused") {
          this.#terminateFailure(
            "malformed_provider_result",
            "Grok completed while an interrupt response was pending",
            false,
          );
          return;
        }
        try {
          const drafts = terminalFromPrompt(this.#mapper, result);
          for (const draft of drafts) this.#queue.push(draft);
          this.#state = "terminal";
          this.#queue.close();
          this.#cleanup();
        } catch {
          this.#terminateFailure(
            "malformed_provider_result",
            "Grok returned a malformed prompt result",
            false,
          );
        }
      })
      .catch((error: unknown) => {
        this.#terminateFailure(
          error instanceof RunnerUnavailable ? "provider_unavailable" : "provider_error",
          error instanceof RunnerUnavailable ? "Grok runner is unavailable" : "Grok runtime failed",
          error instanceof RunnerUnavailable,
        );
      });
  }

  claimSegment(): AsyncIterable<RuntimeEventDraft> {
    if (this.#queueClaimed) {
      throw new ApplicationError(
        "conflict",
        this.#state === "paused"
          ? "Grok interrupt must be answered before the turn can continue"
          : "Grok runtime segment already has a consumer",
      );
    }
    this.#queueClaimed = true;
    return this.#queue;
  }

  async respond(interruptRef: string, allow: boolean, signal?: AbortSignal): Promise<void> {
    if (this.#state !== "paused" || this.#pendingInterruptRef !== interruptRef) {
      throw new ApplicationError("not_found", "Grok permission request is no longer pending");
    }
    if (this.#runner.onLiveWork !== this.#listener) {
      throw new ApplicationError(
        "conflict",
        "Grok runner live-work ownership changed while the turn was paused",
      );
    }
    assertSignal(signal);
    this.#queue = new DraftQueue();
    this.#queueClaimed = false;
    this.#state = "streaming";
    this.#pendingInterruptRef = undefined;
    let accepted: boolean;
    try {
      accepted = await this.#runner.respondPermission(interruptRef, allow);
    } catch (cause) {
      this.#terminateFailure("provider_error", "Grok permission response failed", false);
      throw new ApplicationError("provider_error", "Grok permission response failed", { cause });
    }
    if (!accepted) {
      this.#terminateFailure(
        "permission_not_found",
        "Grok permission request is no longer pending",
        false,
      );
      throw new ApplicationError("not_found", "Grok permission request is no longer pending");
    }
    assertSignal(signal);
  }

  async cancel(reason?: string): Promise<void> {
    if (this.#state !== "terminal") {
      this.#terminateFailure("canceled", "Grok runtime run was canceled", false);
    }
    await this.#cancelRunner();
    void reason;
  }

  #terminateFailure(code: string, message: string, retryable: boolean): void {
    if (this.#mapper.terminal) {
      this.#queue.close();
      this.#state = "terminal";
      this.#cleanup();
      return;
    }
    try {
      for (const draft of this.#mapper.fail(code, message, retryable)) this.#queue.push(draft);
      this.#queue.close();
    } catch (error) {
      this.#queue.fail(error);
    } finally {
      this.#state = "terminal";
      this.#cleanup();
    }
  }

  #cancelRunner(): Promise<void> {
    this.#cancelWork ??= Promise.resolve().then(() => this.#runner.cancel(this.#ensureRequest.botId));
    return this.#cancelWork;
  }

  #cleanup(): void {
    if (this.#cleaned) return;
    this.#cleaned = true;
    if (this.#runner.onLiveWork === this.#listener) {
      this.#runner.onLiveWork = this.#previousListener;
    }
    this.#onDone();
  }
}

class GrokRuntimeSession implements RuntimeSession {
  readonly providerSessionRef: string | null;
  readonly #runner: RunnerSession;
  readonly #ensureRequest: EnsureHarnessRequest;
  readonly #maximumPromptBytes: number;
  readonly #turns: GrokTurnRegistry;
  readonly #release?: (outcome?: GrokRuntimeReleaseOutcome) => PromiseLike<void> | void;
  #turn?: GrokTurn;
  #closed = false;
  #released = false;
  #running = false;
  #hasRun = false;
  #resumed = false;
  #outcome?: GrokRuntimeReleaseOutcome;

  constructor(
    runner: RunnerSession,
    ensureRequest: EnsureHarnessRequest,
    providerSessionRef: string | null,
    maximumPromptBytes = DEFAULT_MAXIMUM_GROK_PROMPT_BYTES,
    turns = new GrokTurnRegistry(),
    turn?: GrokTurn,
    release?: (outcome?: GrokRuntimeReleaseOutcome) => PromiseLike<void> | void,
  ) {
    this.#runner = runner;
    this.#ensureRequest = ensureRequest;
    this.providerSessionRef = providerSessionRef;
    this.#maximumPromptBytes = maximumPromptBytes;
    this.#turns = turns;
    this.#turn = turn;
    this.#release = release;
  }

  run(requestValue: RuntimePromptRequest, signal?: AbortSignal): AsyncIterable<RuntimeEventDraft> {
    return this.#run(requestValue, signal);
  }

  async *#run(requestValue: RuntimePromptRequest, signal?: AbortSignal): AsyncIterable<RuntimeEventDraft> {
    if (this.#closed) throw new ApplicationError("conflict", "Grok runtime session is closed");
    if (this.#running || this.#hasRun) {
      throw new ApplicationError("conflict", "Grok runtime session can stream only one segment");
    }
    assertSignal(signal);
    const request = normalizePromptRequest(requestValue);
    const prompt = composeGrokPrompt(request, this.#maximumPromptBytes);
    let turn = this.#turn;
    if (turn === undefined) {
      turn = this.#turns.create(this.#runner, this.#ensureRequest, this.providerSessionRef);
      this.#turn = turn;
      turn.start(prompt);
    } else if (!this.#resumed) {
      throw new ApplicationError("conflict", "Grok interrupt must be answered before the turn can continue");
    }
    this.#hasRun = true;
    this.#running = true;
    const segment = turn.claimSegment();
    const abort = (): void => {
      this.#outcome = { status: "canceled" };
      void turn.cancel("abort signal").catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for await (const rawDraft of segment) {
        const draft = runtimeEventDraftSchema.parse(rawDraft);
        this.#recordBoundary(draft);
        yield draft;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      this.#running = false;
      if (turn.state === "streaming") {
        this.#outcome = { status: "canceled", reason: "runtime consumer detached" };
        await turn.cancel("runtime consumer detached").catch(() => undefined);
      }
    }
  }

  async respond(
    interruptRef: string,
    response: { status: "resolved"; value: JsonValue } | { status: "canceled" },
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#closed) throw new ApplicationError("conflict", "Grok runtime session is closed");
    if (typeof interruptRef !== "string" || !interruptRef || interruptRef.length > 512) {
      throw new ApplicationError("invalid_argument", "invalid Grok permission reference");
    }
    assertSignal(signal);
    let allow = false;
    if (response.status === "resolved") {
      if (typeof response.value !== "boolean") {
        throw new ApplicationError("invalid_argument", "Grok permission response must be boolean");
      }
      allow = response.value;
    }
    if (this.#turn !== undefined) {
      await this.#turn.respond(interruptRef, allow, signal);
      this.#resumed = true;
      return;
    }
    throw new ApplicationError(
      "conflict",
      "Grok cannot resume a permission without its in-memory paused turn",
    );
  }

  async cancel(reason?: string): Promise<void> {
    this.#outcome = {
      status: "canceled",
      ...(reason === undefined ? {} : { reason: reason.slice(0, 2_000) }),
    };
    if (this.#turn !== undefined) {
      await this.#turn.cancel(reason);
      return;
    }
    await this.#runner.cancel(this.#ensureRequest.botId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    let failure: unknown;
    try {
      if (this.#running || (this.#resumed && this.#turn?.state === "streaming")) {
        await this.cancel("session closed");
      }
    } catch (error) {
      failure = error;
    } finally {
      this.#closed = true;
      if (!this.#released) {
        this.#released = true;
        try {
          await this.#release?.(this.#outcome);
        } catch (error) {
          failure ??= error;
        }
      }
    }
    if (failure !== undefined) throw failure;
  }

  #recordBoundary(draft: RuntimeEventDraft): void {
    if (draft.type === "completed") {
      this.#outcome = {
        status: "completed",
        ...(draft.data.stopReason === undefined ? {} : { stopReason: draft.data.stopReason }),
      };
      return;
    }
    if (draft.type !== "failed") return;
    this.#outcome = draft.data.code === "canceled"
      ? this.#outcome?.status === "canceled"
        ? this.#outcome
        : { status: "canceled" }
      : { status: "failed", code: draft.data.code, retryable: draft.data.retryable };
  }
}

class DraftQueue implements AsyncIterable<RuntimeEventDraft> {
  #values: RuntimeEventDraft[] = [];
  #waiters: Array<{
    resolve: (result: IteratorResult<RuntimeEventDraft>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #error?: unknown;

  push(value: RuntimeEventDraft): void {
    if (this.#closed) return;
    const parsed = runtimeEventDraftSchema.parse(value);
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter.resolve({ done: false, value: parsed });
    else this.#values.push(parsed);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeEventDraft> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#error !== undefined) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<RuntimeEventDraft>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function normalizeSessionRequest(
  value: RuntimeSessionRequest,
  provider: GrokRuntimeProvider,
): RuntimeSessionRequest {
  if (!value || typeof value !== "object") {
    throw new ApplicationError("invalid_argument", "runtime session request is required");
  }
  const resumeSessionRef = value.resumeSessionRef;
  if (
    resumeSessionRef !== undefined &&
    (typeof resumeSessionRef !== "string" || resumeSessionRef.length < 1 || resumeSessionRef.length > 512)
  ) {
    throw new ApplicationError("invalid_argument", "invalid resume session reference");
  }
  if (!Array.isArray(value.capabilities)) {
    throw new ApplicationError("invalid_argument", "runtime capabilities must be an array");
  }
  const capabilities = value.capabilities.map((capability) => {
    if (
      !capability ||
      capability.kind !== "workspace" ||
      typeof capability.ref !== "string" ||
      !capability.ref ||
      capability.ref.length > 512
    ) {
      throw new ApplicationError("invalid_argument", "invalid runtime capability reference");
    }
    return { kind: "workspace" as const, ref: capability.ref };
  });
  return {
    accountId: accountIdSchema.parse(value.accountId),
    agentId: agentIdSchema.parse(value.agentId),
    taskId: taskIdSchema.parse(value.taskId),
    runId: runIdSchema.parse(value.runId),
    config: provider.validateConfig(value.config),
    capabilities,
    metadata: publicMetadataSchema.parse(value.metadata),
    ...(resumeSessionRef === undefined ? {} : { resumeSessionRef }),
  };
}

function normalizePromptRequest(value: RuntimePromptRequest): RuntimePromptRequest {
  if (!value || typeof value !== "object" || !Array.isArray(value.messages) || !Array.isArray(value.actions)) {
    throw new ApplicationError("invalid_argument", "runtime prompt request is invalid");
  }
  const messages = value.messages.map((message) => messageSchema.parse(message));
  const actions = value.actions.map((action) => {
    if (!action || typeof action.name !== "string" || !action.name || action.name.length > 512) {
      throw new ApplicationError("invalid_argument", "runtime action name is invalid");
    }
    if (action.description !== undefined && (typeof action.description !== "string" || action.description.length > 4_000)) {
      throw new ApplicationError("invalid_argument", "runtime action description is invalid");
    }
    return {
      name: action.name,
      ...(action.description === undefined ? {} : { description: action.description }),
      inputSchema: jsonObjectSchema.parse(action.inputSchema),
      ...(action.outputSchema === undefined
        ? {}
        : { outputSchema: jsonObjectSchema.parse(action.outputSchema) }),
    };
  });
  return { messages, actions, metadata: publicMetadataSchema.parse(value.metadata) };
}

function validatePrepared(value: PreparedGrokRunner): PreparedGrokRunner {
  if (!value || typeof value !== "object" || !value.runner || !value.ensureHarnessRequest) {
    throw new ApplicationError("internal", "Grok host returned an invalid prepared runner");
  }
  const request = value.ensureHarnessRequest;
  if (typeof request.botId !== "string" || !request.botId || request.botId.length > 512) {
    throw new ApplicationError("internal", "Grok host returned an invalid bot identifier");
  }
  for (const method of ["ensureHarness", "prompt", "respondPermission", "cancel"] as const) {
    if (typeof value.runner[method] !== "function") {
      throw new ApplicationError("internal", `Grok runner does not implement ${method}`);
    }
  }
  return value;
}

function withResumeSession(
  request: EnsureHarnessRequest,
  resumeSessionRef?: string,
): EnsureHarnessRequest {
  const { resumeSessionId: _hostResume, ...base } = request;
  return {
    ...base,
    env: { ...request.env },
    ...(resumeSessionRef === undefined ? {} : { resumeSessionId: resumeSessionRef }),
  };
}

function terminalFromPrompt(
  mapper: GrokLiveEventMapper,
  value: PromptResult,
): RuntimeEventDraft[] {
  if (!value || typeof value !== "object" || typeof value.stopReason !== "string" || value.stopReason.length > 256) {
    throw new Error("invalid prompt result");
  }
  // PromptResult.assistantText intentionally is never consumed: the legacy
  // runner aggregates thought chunks into it, while only public message chunks
  // may cross the provider boundary.
  const stop = value.stopReason.toLowerCase();
  if (/cancel/.test(stop)) return mapper.fail("canceled", "Grok runtime run was canceled", false);
  if (/error|fail|crash/.test(stop)) return mapper.fail("provider_error", "Grok runtime failed", false);
  return mapper.complete(value.stopReason);
}

function assertSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ApplicationError("canceled", "operation canceled");
}

export * from "./mapper.ts";
export * from "./prompt.ts";
export * from "./types.ts";
