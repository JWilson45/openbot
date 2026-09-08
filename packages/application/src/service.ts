import {
  ApplicationError,
  CONTENT_PARTS_MAX,
  accountIdSchema,
  agentIdSchema,
  agentSchema,
  artifactIdSchema,
  artifactSchema,
  attachmentIdSchema,
  attachmentRefSchema,
  canonicalEventSchema,
  contentPartSchema,
  conversationSchema,
  externalIdSchema,
  interruptIdSchema,
  interruptSchema,
  jsonValueSchema,
  messageIdSchema,
  messageSchema,
  publicMetadataSchema,
  runIdSchema,
  runSchema,
  taskEventEnvelopeSchema,
  taskIdSchema,
  taskSchema,
  taskStatusSchema,
  threadIdSchema,
  type AccountId,
  type AgentId,
  type Artifact,
  type CanonicalEvent,
  type ContentPart,
  type Conversation,
  type Interrupt,
  type JsonObject,
  type JsonValue,
  type Message,
  type Run,
  type Task,
  type TaskEventEnvelope,
  type TaskId,
  type ThreadId,
} from "@openbot/core";
import { assertRunTransition, assertTaskTransition } from "./state-machine.ts";
import type {
  AgentTaskPort,
  ApplicationTransaction,
  Clock,
  ConversationMessagePort,
  ContinueTaskCommand,
  EnsureConversationCommand,
  ExternalEntityRef,
  ExternalIdentityBinding,
  ExternalIdentityPort,
  ExternalIdentityTarget,
  EventLog,
  IdGenerator,
  InterruptRef,
  ListTasksQuery,
  Page,
  ProtocolPrincipal,
  PublishAgentMessageCommand,
  ResumeTaskCommand,
  SubmitTaskCommand,
  SubmissionExternalRefs,
  TaskCoordinatorPort,
  TaskInputMessage,
  TaskRef,
  TaskView,
  TaskViewOptions,
  UnitOfWork,
} from "./ports.ts";

export const TASKS_READ_SCOPE = "tasks:read";
export const TASKS_WRITE_SCOPE = "tasks:write";
export const RUN_QUEUED_OUTBOX_TOPIC = "run.queued";
export const RUN_CANCEL_OUTBOX_TOPIC = "run.cancel";

export const DEFAULT_TASK_HISTORY_LENGTH = 50;
export const MAX_TASK_HISTORY_LENGTH = 200;
export const MAX_TASK_VIEW_RUNS = 100;
export const MAX_TASK_VIEW_ARTIFACTS = 100;
export const MAX_TASK_VIEW_INTERRUPTS = 100;
export const MAX_TASK_PAGE_SIZE = 100;
export const HUMAN_CONVERSATION_CHANNEL = "human";
export const HUMAN_CONVERSATION_CHANNEL_METADATA_KEY = "openbot.channel";
export const HUMAN_CONVERSATION_AGENT_METADATA_KEY = "openbot.agent-id";

const IDEMPOTENCY_KEY_MAX = 512;
const EXTERNAL_PROTOCOL_MAX = 128;
const EXTERNAL_NAMESPACE_MAX = 2_048;
const ACTION_CALL_ID_MAX = 512;
export const TOOL_ACTION_CALL_METADATA_KEY = "action_call_id";

type Schema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { message: string; path: readonly PropertyKey[] }[] } };
};

export interface JsonSchemaValidator {
  validate(schema: JsonObject, value: JsonValue): boolean;
}

export type DefaultApplicationServiceDependencies = {
  unitOfWork: UnitOfWork;
  eventLog: EventLog;
  ids: IdGenerator;
  clock: Clock;
  responseValidator: JsonSchemaValidator;
};

type NormalizedPrincipal = ProtocolPrincipal & { accountId: AccountId };
type ExternalIdentityScope = Pick<NormalizedPrincipal, "accountId" | "subjectId">;

type NormalizedSubmit = Omit<SubmitTaskCommand, "principal" | "agentId" | "threadId" | "externalRefs" | "message" | "metadata"> & {
  principal: NormalizedPrincipal;
  agentId: AgentId;
  threadId?: ThreadId;
  externalRefs?: SubmissionExternalRefs;
  message: TaskInputMessage;
  metadata: JsonObject;
};

type NormalizedResume = Omit<ResumeTaskCommand, "principal" | "task" | "responses" | "message"> & {
  principal: NormalizedPrincipal;
  task: TaskRef;
  responses: readonly {
    interrupt: InterruptRef;
    status: "resolved" | "canceled";
    response?: JsonValue;
  }[];
  message?: TaskInputMessage;
};

type NormalizedContinue = Omit<ContinueTaskCommand, "principal" | "task" | "message"> & {
  principal: NormalizedPrincipal;
  task: TaskRef;
  message: TaskInputMessage;
};

type EventIdentity = {
  accountId: AccountId;
  taskId: TaskId;
  runId: Run["id"] | null;
  agentId: AgentId;
  threadId: ThreadId;
};

type IdempotencyResult = {
  version: 1;
  fingerprint: string;
  taskId: TaskId;
};

function applicationError(
  code: ConstructorParameters<typeof ApplicationError>[0],
  message: string,
  cause?: unknown,
): ApplicationError {
  return new ApplicationError(code, message, cause === undefined ? {} : { cause });
}

function parse<T>(schema: Schema<T>, value: unknown, label: string, code: "invalid_argument" | "internal" = "invalid_argument"): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? ` at ${issue.path.map(String).join(".")}` : "";
  throw applicationError(code, `${label} is invalid${path}: ${issue?.message ?? "schema validation failed"}`);
}

function stableStringify(value: unknown): string {
  const seen = new Set<object>();
  const visit = (current: unknown): string => {
    if (current === null) return "null";
    if (typeof current === "string") return JSON.stringify(current);
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw applicationError("invalid_argument", "non-finite values are not supported");
      return Object.is(current, -0) ? "0" : String(current);
    }
    if (typeof current === "boolean") return current ? "true" : "false";
    if (typeof current === "undefined") return "undefined";
    if (Array.isArray(current)) {
      if (seen.has(current)) throw applicationError("invalid_argument", "cyclic values are not supported");
      seen.add(current);
      const result = `[${current.map((item) => visit(item)).join(",")}]`;
      seen.delete(current);
      return result;
    }
    if (typeof current === "object") {
      if (seen.has(current)) throw applicationError("invalid_argument", "cyclic values are not supported");
      seen.add(current);
      const record = current as Record<string, unknown>;
      const entries = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${visit(record[key])}`);
      seen.delete(current);
      return `{${entries.join(",")}}`;
    }
    throw applicationError("invalid_argument", `unsupported ${typeof current} value`);
  };
  return visit(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function assertSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw applicationError("canceled", "operation was canceled", signal.reason);
}

function validatePrincipal(principal: ProtocolPrincipal): NormalizedPrincipal {
  if (!principal || typeof principal !== "object") {
    throw applicationError("unauthenticated", "authenticated principal is required");
  }
  const accountId = parse(accountIdSchema, principal.accountId, "principal accountId");
  if (typeof principal.subjectId !== "string" || principal.subjectId.trim().length === 0 || principal.subjectId.length > 512) {
    throw applicationError("unauthenticated", "principal subjectId is invalid");
  }
  if (!(["user", "agent", "service"] as const).includes(principal.kind)) {
    throw applicationError("unauthenticated", "principal kind is invalid");
  }
  if (!Array.isArray(principal.scopes) || principal.scopes.some((scope) => typeof scope !== "string" || scope.length === 0)) {
    throw applicationError("unauthenticated", "principal scopes are invalid");
  }
  return { ...principal, accountId, scopes: [...principal.scopes] };
}

function requireScope(principal: ProtocolPrincipal, required: typeof TASKS_READ_SCOPE | typeof TASKS_WRITE_SCOPE): NormalizedPrincipal {
  const validated = validatePrincipal(principal);
  const scopes = new Set(validated.scopes);
  if (!scopes.has("*") && !scopes.has("tasks:*") && !scopes.has(required)) {
    throw applicationError("forbidden", `missing required scope: ${required}`);
  }
  return validated;
}

function requireAgentPrincipal(principal: NormalizedPrincipal, agentId: AgentId): void {
  if (principal.kind !== "agent" || !principal.subjectId.startsWith(`agent:${agentId}:`)) {
    throw applicationError("forbidden", "agent principal does not match the publishing agent");
  }
}

function assertConversationMetadataCanMerge(current: JsonObject, incoming: JsonObject): void {
  for (const key of [HUMAN_CONVERSATION_CHANNEL_METADATA_KEY, HUMAN_CONVERSATION_AGENT_METADATA_KEY]) {
    if (current[key] !== undefined && incoming[key] !== undefined && current[key] !== incoming[key]) {
      throw applicationError("conflict", `conversation metadata cannot rebind ${key}`);
    }
  }
}

function requireHumanConversation(conversation: Conversation, agentId: AgentId): void {
  if (
    conversation.metadata[HUMAN_CONVERSATION_CHANNEL_METADATA_KEY] !== HUMAN_CONVERSATION_CHANNEL ||
    conversation.metadata[HUMAN_CONVERSATION_AGENT_METADATA_KEY] !== agentId
  ) {
    throw applicationError("forbidden", "conversation is not the publishing agent's human channel");
  }
}

function normalizeString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value) {
    throw applicationError("invalid_argument", `${label} must be a non-empty, trimmed string of at most ${max} characters`);
  }
  return value;
}

function normalizeText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length > max) {
    throw applicationError("invalid_argument", `${label} must be a string of at most ${max} characters`);
  }
  return value;
}

const externalKinds = new Set<ExternalEntityRef["kind"]>([
  "thread",
  "task",
  "run",
  "message",
  "artifact",
  "attachment",
  "interrupt",
]);

function normalizeExternalRef(value: ExternalEntityRef, expectedKind?: ExternalEntityRef["kind"]): ExternalEntityRef {
  if (!value || typeof value !== "object") throw applicationError("invalid_argument", "external reference is required");
  const protocol = normalizeString(value.protocol, "external protocol", EXTERNAL_PROTOCOL_MAX);
  const namespace = normalizeString(value.namespace, "external namespace", EXTERNAL_NAMESPACE_MAX);
  if (!externalKinds.has(value.kind)) throw applicationError("invalid_argument", "external reference kind is invalid");
  if (expectedKind && value.kind !== expectedKind) {
    throw applicationError("invalid_argument", `external reference must have kind ${expectedKind}`);
  }
  return {
    protocol,
    namespace,
    kind: value.kind,
    externalId: parse(externalIdSchema, value.externalId, "external ID"),
  };
}

function normalizeTaskRef(value: TaskRef): TaskRef {
  if (!value || typeof value !== "object") throw applicationError("invalid_argument", "task reference is required");
  const hasTaskId = "taskId" in value;
  const hasRunId = "runId" in value;
  const hasExternalRef = "externalRef" in value;
  if (Number(hasTaskId) + Number(hasRunId) + Number(hasExternalRef) !== 1) {
    throw applicationError("invalid_argument", "task reference must select exactly one identity");
  }
  if (hasTaskId) return { taskId: parse(taskIdSchema, value.taskId, "task ID") };
  if (hasRunId) return { runId: parse(runIdSchema, value.runId, "run ID") };
  const externalRef = normalizeExternalRef(value.externalRef);
  if (externalRef.kind !== "task" && externalRef.kind !== "run") {
    throw applicationError("invalid_argument", "external task reference must have kind task or run");
  }
  return { externalRef: externalRef as ExternalEntityRef & { kind: "task" | "run" } };
}

function normalizeInterruptRef(value: InterruptRef): InterruptRef {
  if (!value || typeof value !== "object") throw applicationError("invalid_argument", "interrupt reference is required");
  const hasInterruptId = "interruptId" in value;
  const hasExternalRef = "externalRef" in value;
  if (hasInterruptId === hasExternalRef) {
    throw applicationError("invalid_argument", "interrupt reference must select exactly one identity");
  }
  if (hasInterruptId) return { interruptId: parse(interruptIdSchema, value.interruptId, "interrupt ID") };
  return { externalRef: normalizeExternalRef(value.externalRef, "interrupt") };
}

function normalizeInputMessage(value: TaskInputMessage, label = "message"): TaskInputMessage {
  if (!value || typeof value !== "object") throw applicationError("invalid_argument", `${label} is required`);
  if (value.role !== "user" && value.role !== "tool") {
    throw applicationError("invalid_argument", `${label} role must be user or tool`);
  }
  if (!Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > CONTENT_PARTS_MAX) {
    throw applicationError("invalid_argument", `${label} must contain between 1 and ${CONTENT_PARTS_MAX} parts`);
  }
  const parts = value.parts.map((part, index) => parse(contentPartSchema, part, `${label} part ${index}`));
  const metadata = parse(publicMetadataSchema, value.metadata ?? {}, `${label} metadata`);
  if (value.role === "tool") {
    const actionCallId = normalizeString(value.actionCallId, `${label} actionCallId`, ACTION_CALL_ID_MAX);
    const existing = metadata[TOOL_ACTION_CALL_METADATA_KEY];
    if (existing !== undefined && existing !== actionCallId) {
      throw applicationError("invalid_argument", `${label} metadata conflicts with its actionCallId`);
    }
    const correlatedMetadata = parse(
      publicMetadataSchema,
      { ...metadata, [TOOL_ACTION_CALL_METADATA_KEY]: actionCallId },
      `${label} metadata`,
    );
    return { role: "tool", actionCallId, parts, metadata: correlatedMetadata };
  }
  return { role: "user", parts, metadata };
}

function normalizeSubmissionExternalRefs(value?: SubmissionExternalRefs): SubmissionExternalRefs | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw applicationError("invalid_argument", "externalRefs must be an object");
  const normalized: SubmissionExternalRefs = {};
  if (value.thread !== undefined) normalized.thread = normalizeExternalRef(value.thread, "thread") as ExternalEntityRef & { kind: "thread" };
  if (value.task !== undefined) normalized.task = normalizeExternalRef(value.task, "task") as ExternalEntityRef & { kind: "task" };
  if (value.run !== undefined) normalized.run = normalizeExternalRef(value.run, "run") as ExternalEntityRef & { kind: "run" };
  if (value.message !== undefined) normalized.message = normalizeExternalRef(value.message, "message") as ExternalEntityRef & { kind: "message" };
  return normalized;
}

function normalizeIdempotencyKey(key?: string): string | undefined {
  if (key === undefined) return undefined;
  return normalizeString(key, "idempotency key", IDEMPOTENCY_KEY_MAX);
}

function normalizeSubmit(command: SubmitTaskCommand): NormalizedSubmit {
  if (!command || typeof command !== "object") throw applicationError("invalid_argument", "submit command is required");
  return {
    principal: requireScope(command.principal, TASKS_WRITE_SCOPE),
    agentId: parse(agentIdSchema, command.agentId, "agent ID"),
    ...(command.threadId === undefined ? {} : { threadId: parse(threadIdSchema, command.threadId, "thread ID") }),
    ...(command.externalRefs === undefined ? {} : { externalRefs: normalizeSubmissionExternalRefs(command.externalRefs) }),
    message: normalizeInputMessage(command.message),
    idempotencyKey: normalizeIdempotencyKey(command.idempotencyKey),
    metadata: parse(publicMetadataSchema, command.metadata ?? {}, "task metadata"),
  };
}

function normalizeResume(command: ResumeTaskCommand): NormalizedResume {
  if (!command || typeof command !== "object") throw applicationError("invalid_argument", "resume command is required");
  if (!Array.isArray(command.responses)) throw applicationError("invalid_argument", "resume responses must be an array");
  const responses = command.responses.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw applicationError("invalid_argument", `resume response ${index} is invalid`);
    if (entry.status !== "resolved" && entry.status !== "canceled") {
      throw applicationError("invalid_argument", `resume response ${index} status is invalid`);
    }
    if (entry.status === "resolved" && (!("response" in entry) || entry.response === undefined)) {
      throw applicationError("invalid_argument", `resume response ${index} requires a response`);
    }
    if (entry.status === "canceled" && entry.response !== undefined) {
      throw applicationError("invalid_argument", `canceled resume response ${index} cannot contain a response`);
    }
    return {
      interrupt: normalizeInterruptRef(entry.interrupt),
      status: entry.status,
      ...(entry.response === undefined ? {} : { response: parse(jsonValueSchema, entry.response, `resume response ${index} value`) }),
    };
  });
  const externalRun = command.externalRun === undefined
    ? undefined
    : normalizeExternalRef(command.externalRun, "run") as ResumeTaskCommand["externalRun"];
  const externalMessage = command.externalMessage === undefined
    ? undefined
    : normalizeExternalRef(command.externalMessage, "message") as ResumeTaskCommand["externalMessage"];
  if (externalMessage && !command.message) {
    throw applicationError("invalid_argument", "externalMessage requires a resumed input message");
  }
  return {
    principal: requireScope(command.principal, TASKS_WRITE_SCOPE),
    task: normalizeTaskRef(command.task),
    ...(externalRun === undefined ? {} : { externalRun }),
    ...(externalMessage === undefined ? {} : { externalMessage }),
    responses,
    ...(command.message === undefined ? {} : { message: normalizeInputMessage(command.message, "resume message") }),
    idempotencyKey: normalizeIdempotencyKey(command.idempotencyKey),
  };
}

function normalizeContinue(command: ContinueTaskCommand): NormalizedContinue {
  if (!command || typeof command !== "object") throw applicationError("invalid_argument", "continue command is required");
  const externalRun = command.externalRun === undefined
    ? undefined
    : normalizeExternalRef(command.externalRun, "run") as ContinueTaskCommand["externalRun"];
  const externalMessage = command.externalMessage === undefined
    ? undefined
    : normalizeExternalRef(command.externalMessage, "message") as ContinueTaskCommand["externalMessage"];
  return {
    principal: requireScope(command.principal, TASKS_WRITE_SCOPE),
    task: normalizeTaskRef(command.task),
    ...(externalRun === undefined ? {} : { externalRun }),
    ...(externalMessage === undefined ? {} : { externalMessage }),
    message: normalizeInputMessage(command.message, "continuation message"),
    idempotencyKey: normalizeIdempotencyKey(command.idempotencyKey),
  };
}

function principalRepositorySubject(principal: ProtocolPrincipal): string {
  return `${principal.kind}:${principal.subjectId}`;
}

function idempotencyResult(value: JsonValue): IdempotencyResult {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw applicationError("internal", "stored idempotency result is invalid");
  }
  const record = value as Record<string, JsonValue>;
  if (record.version !== 1 || typeof record.fingerprint !== "string") {
    throw applicationError("internal", "stored idempotency result is invalid");
  }
  return {
    version: 1,
    fingerprint: record.fingerprint,
    taskId: parse(taskIdSchema, record.taskId, "stored idempotency task ID", "internal"),
  };
}

function sortNewestBounded<T>(
  values: readonly T[],
  maximum: number,
  time: (value: T) => number,
  identity: (value: T) => string,
): T[] {
  const sorted = [...values].sort((left, right) => time(left) - time(right) || identity(left).localeCompare(identity(right)));
  return maximum === 0 ? [] : sorted.slice(-maximum);
}

export class DefaultApplicationService implements AgentTaskPort, ConversationMessagePort, TaskCoordinatorPort, ExternalIdentityPort {
  readonly #unitOfWork: UnitOfWork;
  readonly #eventLog: EventLog;
  readonly #ids: IdGenerator;
  readonly #clock: Clock;
  readonly #responseValidator: JsonSchemaValidator;

  constructor(dependencies: DefaultApplicationServiceDependencies) {
    this.#unitOfWork = dependencies.unitOfWork;
    this.#eventLog = dependencies.eventLog;
    this.#ids = dependencies.ids;
    this.#clock = dependencies.clock;
    this.#responseValidator = dependencies.responseValidator;
  }

  async submit(command: SubmitTaskCommand, signal?: AbortSignal): Promise<TaskView> {
    assertSignal(signal);
    const normalized = normalizeSubmit(command);
    const accountId = normalized.principal.accountId;
    const fingerprint = stableStringify({
      agentId: normalized.agentId,
      threadId: normalized.threadId,
      externalRefs: normalized.externalRefs,
      message: normalized.message,
      metadata: normalized.metadata,
    });

    return this.#unitOfWork.transaction((tx) => {
      assertSignal(signal);
      const replay = this.#idempotencyReplay(tx, normalized.principal, "task.submit", normalized.idempotencyKey, fingerprint);
      if (replay) return this.#taskView(tx, accountId, replay.taskId);

      const agent = tx.agents.get(accountId, normalized.agentId);
      if (!agent) throw applicationError("not_found", "agent not found");
      const parsedAgent = parse(agentSchema, agent, "stored agent", "internal");
      if (parsedAgent.accountId !== accountId) throw applicationError("internal", "agent tenancy invariant failed");

      const now = this.#clock.now();
      const conversation = this.#submissionConversation(tx, normalized, now);
      const task = parse(taskSchema, {
        id: this.#ids.taskId(),
        accountId,
        threadId: conversation.id,
        agentId: normalized.agentId,
        status: "submitted",
        createdAt: now,
        updatedAt: now,
        metadata: normalized.metadata,
      }, "generated task", "internal");
      const run = parse(runSchema, {
        id: this.#ids.runId(),
        accountId,
        taskId: task.id,
        threadId: task.threadId,
        agentId: task.agentId,
        attempt: 1,
        status: "queued",
        providerSessionRef: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        metadata: {},
      }, "generated run", "internal");
      const message = this.#createInputMessage(normalized.message, task, run, now);

      this.#verifyAttachmentParts(tx, accountId, message.parts);
      this.#ensureSubmissionRefsAvailable(tx, normalized.principal, normalized.externalRefs);
      tx.tasks.create(task);
      tx.runs.create(run);
      tx.messages.append(message);
      this.#bindSubmissionRefs(tx, normalized.principal, normalized.externalRefs, task.id, run.id, message.id);

      this.#appendEvent(tx, { ...task, taskId: task.id, runId: null }, {
        type: "task.status.changed",
        data: { from: null, to: "submitted" },
      });
      this.#appendEvent(tx, { ...task, taskId: task.id, runId: run.id }, {
        type: "run.status.changed",
        data: { from: null, to: "queued" },
      });
      this.#appendMessageEvents(tx, task, run, message);
      this.#enqueueRun(tx, run, now);

      this.#storeIdempotency(tx, normalized.principal, "task.submit", normalized.idempotencyKey, fingerprint, task.id);
      return this.#taskView(tx, accountId, task.id);
    });
  }

  async ensureConversation(command: EnsureConversationCommand): Promise<Conversation> {
    if (!command || typeof command !== "object") throw applicationError("invalid_argument", "conversation command is required");
    const principal = requireScope(command.principal, TASKS_WRITE_SCOPE);
    const threadId = parse(threadIdSchema, command.threadId, "thread ID");
    const title = command.title === undefined || command.title === null
      ? null
      : normalizeText(command.title, "conversation title", 200);
    const metadata = parse(publicMetadataSchema, command.metadata ?? {}, "conversation metadata");
    return this.#unitOfWork.transaction((tx) => {
      const existing = tx.conversations.get(principal.accountId, threadId);
      if (existing) {
        const stored = this.#storedConversation(existing, principal.accountId, threadId);
        assertConversationMetadataCanMerge(stored.metadata, metadata);
        const merged = parse(
          publicMetadataSchema,
          { ...stored.metadata, ...metadata },
          "merged conversation metadata",
          "internal",
        );
        if (jsonEqual(stored.metadata, merged)) return stored;
        const updated = parse(conversationSchema, {
          ...stored,
          metadata: merged,
          updatedAt: Math.max(stored.updatedAt, this.#clock.now()),
        }, "updated conversation", "internal");
        return this.#storedConversation(
          tx.conversations.update(updated),
          principal.accountId,
          threadId,
        );
      }
      const now = this.#clock.now();
      const conversation = parse(conversationSchema, {
        id: threadId,
        accountId: principal.accountId,
        title,
        metadata,
        createdAt: now,
        updatedAt: now,
      }, "generated conversation", "internal");
      return this.#storedConversation(
        tx.conversations.create(conversation),
        principal.accountId,
        threadId,
      );
    });
  }

  async publishAgentMessage(command: PublishAgentMessageCommand, signal?: AbortSignal): Promise<Message> {
    assertSignal(signal);
    if (!command || typeof command !== "object") throw applicationError("invalid_argument", "message command is required");
    const principal = requireScope(command.principal, TASKS_WRITE_SCOPE);
    const agentId = parse(agentIdSchema, command.agentId, "agent ID");
    requireAgentPrincipal(principal, agentId);
    const threadId = parse(threadIdSchema, command.threadId, "thread ID");
    const messageId = command.messageId === undefined
      ? this.#ids.messageId()
      : parse(messageIdSchema, command.messageId, "message ID");
    const createdAt = command.createdAt;
    if (createdAt !== undefined && (!Number.isSafeInteger(createdAt) || createdAt < 0)) {
      throw applicationError("invalid_argument", "message createdAt must be a non-negative safe integer");
    }
    if (!Array.isArray(command.parts) || command.parts.length < 1 || command.parts.length > CONTENT_PARTS_MAX) {
      throw applicationError("invalid_argument", `message must contain between 1 and ${CONTENT_PARTS_MAX} parts`);
    }
    const parts = command.parts.map((part, index) => parse(contentPartSchema, part, `message part ${index}`));
    const metadata = parse(publicMetadataSchema, command.metadata ?? {}, "message metadata");
    return this.#unitOfWork.transaction((tx) => {
      assertSignal(signal);
      const agent = tx.agents.get(principal.accountId, agentId);
      if (!agent) throw applicationError("not_found", "agent not found");
      const parsedAgent = parse(agentSchema, agent, "stored agent", "internal");
      if (parsedAgent.accountId !== principal.accountId) throw applicationError("internal", "agent tenancy invariant failed");
      const conversation = tx.conversations.get(principal.accountId, threadId);
      if (!conversation) throw applicationError("not_found", "conversation not found");
      const storedConversation = this.#storedConversation(conversation, principal.accountId, threadId);
      requireHumanConversation(storedConversation, agentId);
      this.#verifyAttachmentParts(tx, principal.accountId, parts);
      const existing = tx.messages.get(principal.accountId, messageId);
      if (existing) {
        const stored = parse(messageSchema, existing, "stored message", "internal");
        if (
          stored.threadId === threadId && stored.taskId === null && stored.runId === null &&
          stored.role === "agent" && (createdAt === undefined || stored.createdAt === createdAt) &&
          jsonEqual(stored.parts, parts) && jsonEqual(stored.metadata, metadata)
        ) return stored;
        throw applicationError("conflict", "message identity is already owned by another delivery");
      }
      const message = parse(messageSchema, {
        id: messageId,
        accountId: principal.accountId,
        threadId,
        taskId: null,
        runId: null,
        role: "agent",
        parts,
        metadata,
        createdAt: createdAt ?? this.#clock.now(),
      }, "generated message", "internal");
      return parse(messageSchema, tx.messages.append(message), "stored message", "internal");
    });
  }

  async listConversationMessages(
    principal: ProtocolPrincipal,
    rawThreadId: ThreadId,
    rawLimit = 500,
  ): Promise<readonly Message[]> {
    const authorized = requireScope(principal, TASKS_READ_SCOPE);
    const threadId = parse(threadIdSchema, rawThreadId, "thread ID");
    if (!Number.isInteger(rawLimit) || rawLimit < 1) throw applicationError("invalid_argument", "message limit must be positive");
    const limit = Math.min(rawLimit, 500);
    return this.#unitOfWork.transaction((tx) => {
      const conversation = tx.conversations.get(authorized.accountId, threadId);
      if (!conversation) throw applicationError("not_found", "conversation not found");
      this.#storedConversation(conversation, authorized.accountId, threadId);
      const messages = tx.messages.list(authorized.accountId, threadId).map((value) => {
        const message = parse(messageSchema, value, "stored message", "internal");
        if (message.accountId !== authorized.accountId || message.threadId !== threadId) {
          throw applicationError("internal", "message conversation invariant failed");
        }
        return message;
      });
      return sortNewestBounded(messages, limit, (message) => message.createdAt, (message) => message.id);
    });
  }

  async get(principal: ProtocolPrincipal, task: TaskRef, options?: TaskViewOptions): Promise<TaskView | null> {
    const authorized = requireScope(principal, TASKS_READ_SCOPE);
    const reference = normalizeTaskRef(task);
    const historyLength = this.#historyLength(options);
    return this.#unitOfWork.transaction((tx) => {
      const resolved = this.#resolveTask(tx, authorized, reference);
      return resolved ? this.#taskView(tx, authorized.accountId, resolved.id, historyLength) : null;
    });
  }

  async list(query: ListTasksQuery): Promise<Page<Task>> {
    if (!query || typeof query !== "object") throw applicationError("invalid_argument", "list query is required");
    const principal = requireScope(query.principal, TASKS_READ_SCOPE);
    if (!Number.isInteger(query.limit) || query.limit < 1) {
      throw applicationError("invalid_argument", "list limit must be a positive integer");
    }
    const limit = Math.min(query.limit, MAX_TASK_PAGE_SIZE);
    const cursor = query.cursor === undefined ? undefined : normalizeString(query.cursor, "list cursor", 2_048);
    const agentId = query.agentId === undefined ? undefined : parse(agentIdSchema, query.agentId, "agent ID");
    const threadId = query.threadId === undefined ? undefined : parse(threadIdSchema, query.threadId, "thread ID");
    const updatedAfter = query.updatedAfter === undefined ? undefined : query.updatedAfter;
    if (updatedAfter !== undefined && (!Number.isSafeInteger(updatedAfter) || updatedAfter < 0)) {
      throw applicationError("invalid_argument", "updatedAfter must be a non-negative safe integer");
    }
    const statuses = query.statuses === undefined
      ? undefined
      : query.statuses.map((status, index) => parse(taskStatusSchema, status, `task status ${index}`));
    return this.#unitOfWork.transaction((tx) => {
      const page = tx.tasks.list(principal.accountId, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(agentId === undefined ? {} : { agentId }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(statuses === undefined ? {} : { statuses }),
        ...(updatedAfter === undefined ? {} : { updatedAfter }),
      });
      if (!page || !Array.isArray(page.items)) throw applicationError("internal", "task repository returned an invalid page");
      const items = page.items.slice(0, limit).map((item) => {
        const task = parse(taskSchema, item, "stored task", "internal");
        if (task.accountId !== principal.accountId) throw applicationError("internal", "task tenancy invariant failed");
        if (agentId !== undefined && task.agentId !== agentId) {
          throw applicationError("internal", "task repository ignored the agent filter");
        }
        if (threadId !== undefined && task.threadId !== threadId) {
          throw applicationError("internal", "task repository ignored the thread filter");
        }
        if (statuses !== undefined && !statuses.includes(task.status)) {
          throw applicationError("internal", "task repository ignored the status filter");
        }
        if (updatedAfter !== undefined && task.updatedAt <= updatedAfter) {
          throw applicationError("internal", "task repository ignored the updatedAfter filter");
        }
        return task;
      });
      if (!Number.isSafeInteger(page.totalSize) || page.totalSize < items.length) {
        throw applicationError("internal", "task repository returned an invalid totalSize");
      }
      if (page.nextCursor !== undefined && (typeof page.nextCursor !== "string" || page.nextCursor.length === 0)) {
        throw applicationError("internal", "task repository returned an invalid cursor");
      }
      return { items, totalSize: page.totalSize, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
    });
  }

  async cancel(principal: ProtocolPrincipal, task: TaskRef, reason?: string): Promise<TaskView> {
    const authorized = requireScope(principal, TASKS_WRITE_SCOPE);
    const reference = normalizeTaskRef(task);
    const normalizedReason = reason === undefined ? undefined : normalizeText(reason, "cancellation reason", 2_000);
    return this.#unitOfWork.transaction((tx) => {
      const current = this.#resolveTask(tx, authorized, reference);
      if (!current) throw applicationError("not_found", "task not found");
      if (current.status === "canceled") return this.#taskView(tx, authorized.accountId, current.id);
      if (["completed", "failed", "rejected"].includes(current.status)) {
        throw applicationError("conflict", `terminal task in state ${current.status} cannot be canceled`);
      }
      assertTaskTransition(current.status, "canceled");
      const now = this.#clock.now();
      const runs = this.#taskRuns(tx, current);
      const selectedRun = this.#selectedRun(tx, authorized, reference);
      if (selectedRun) {
        const active = runs
          .filter((run) => ["queued", "running", "interrupted"].includes(run.status))
          .sort((left, right) => right.attempt - left.attempt || right.createdAt - left.createdAt || right.id.localeCompare(left.id));
        if (active.length === 0 || active[0]!.id !== selectedRun.id) {
          throw applicationError("conflict", "selected run is not the task's latest active run");
        }
      }
      const interrupts = tx.interrupts.listForTask(current.accountId, current.id).map((value) => {
        const interrupt = parse(interruptSchema, value, "stored interrupt", "internal");
        if (interrupt.accountId !== current.accountId || interrupt.taskId !== current.id) {
          throw applicationError("internal", "interrupt task identity invariant failed");
        }
        return interrupt;
      });
      for (const interrupt of interrupts) {
        if (interrupt.status !== "open") continue;
        const canceled = parse(interruptSchema, {
          ...interrupt,
          status: "canceled",
          response: undefined,
          resolvedAt: now,
        }, "canceled interrupt", "internal");
        tx.interrupts.put(canceled);
        this.#appendEvent(tx, { ...current, taskId: current.id, runId: canceled.runId }, {
          type: "interrupt.resolved",
          data: { interruptId: canceled.id, status: "canceled" },
        });
      }
      for (const run of runs) {
        if (!["queued", "running", "interrupted"].includes(run.status)) continue;
        assertRunTransition(run.status, "canceled");
        const canceled = parse(runSchema, { ...run, status: "canceled", finishedAt: now }, "canceled run", "internal");
        tx.runs.update(canceled);
        this.#appendEvent(tx, { ...current, taskId: current.id, runId: run.id }, {
          type: "run.status.changed",
          data: { from: run.status, to: "canceled", ...(normalizedReason === undefined ? {} : { reason: normalizedReason }) },
        });
        tx.outbox.enqueue({
          id: `run-cancel:${run.id}`,
          accountId: current.accountId,
          topic: RUN_CANCEL_OUTBOX_TOPIC,
          payload: { taskId: current.id, runId: run.id, ...(normalizedReason === undefined ? {} : { reason: normalizedReason }) },
          createdAt: now,
        });
      }
      const canceledTask = parse(taskSchema, tx.tasks.transition(
        current.accountId,
        current.id,
        current.status,
        "canceled",
        now,
      ), "transitioned task", "internal");
      this.#assertTaskIdentity(canceledTask, current.accountId, current.id);
      this.#appendEvent(tx, { ...canceledTask, taskId: canceledTask.id, runId: null }, {
        type: "task.status.changed",
        data: { from: current.status, to: "canceled", ...(normalizedReason === undefined ? {} : { reason: normalizedReason }) },
      });
      return this.#taskView(tx, authorized.accountId, current.id);
    });
  }

  async continue(command: ContinueTaskCommand, signal?: AbortSignal): Promise<TaskView> {
    assertSignal(signal);
    const normalized = normalizeContinue(command);
    const fingerprint = stableStringify({
      task: normalized.task,
      externalRun: normalized.externalRun,
      externalMessage: normalized.externalMessage,
      message: normalized.message,
    });
    return this.#unitOfWork.transaction((tx) => {
      assertSignal(signal);
      const replay = this.#idempotencyReplay(
        tx,
        normalized.principal,
        "task.continue",
        normalized.idempotencyKey,
        fingerprint,
      );
      if (replay) return this.#taskView(tx, normalized.principal.accountId, replay.taskId);

      const task = this.#resolveTask(tx, normalized.principal, normalized.task);
      if (!task) throw applicationError("not_found", "task not found");
      if (task.status !== "input_required") {
        throw applicationError("conflict", `task in state ${task.status} cannot accept a continuation`);
      }
      assertTaskTransition(task.status, "working");
      if (normalized.externalRun) this.#ensureExternalAvailable(tx, normalized.principal, normalized.externalRun);
      if (normalized.externalMessage) this.#ensureExternalAvailable(tx, normalized.principal, normalized.externalMessage);

      const now = this.#clock.now();
      const existingRuns = this.#taskRuns(tx, task);
      const attempt = existingRuns.reduce((maximum, run) => Math.max(maximum, run.attempt), 0) + 1;
      const run = parse(runSchema, {
        id: this.#ids.runId(),
        accountId: task.accountId,
        taskId: task.id,
        threadId: task.threadId,
        agentId: task.agentId,
        attempt,
        status: "queued",
        providerSessionRef: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        metadata: {},
      }, "generated continuation run", "internal");
      const message = this.#createInputMessage(normalized.message, task, run, now);
      this.#verifyAttachmentParts(tx, task.accountId, message.parts);

      const interrupts = tx.interrupts.listForTask(task.accountId, task.id).map((value) => {
        const interrupt = parse(interruptSchema, value, "stored interrupt", "internal");
        if (interrupt.accountId !== task.accountId || interrupt.taskId !== task.id) {
          throw applicationError("internal", "interrupt task identity invariant failed");
        }
        return interrupt;
      });
      const continuationInterruptIds: Interrupt["id"][] = [];
      for (const interrupt of interrupts) {
        if (interrupt.status !== "open" || interrupt.kind !== "input") continue;
        const canceled = parse(interruptSchema, {
          ...interrupt,
          status: "canceled",
          response: undefined,
          resolvedAt: now,
        }, "canceled input interrupt", "internal");
        tx.interrupts.put(canceled);
        continuationInterruptIds.push(canceled.id);
        this.#appendEvent(tx, { ...task, taskId: task.id, runId: canceled.runId }, {
          type: "interrupt.resolved",
          data: { interruptId: canceled.id, status: "canceled" },
        });
      }

      const working = parse(taskSchema, tx.tasks.transition(
        task.accountId,
        task.id,
        task.status,
        "working",
        now,
      ), "continued task", "internal");
      this.#assertTaskIdentity(working, task.accountId, task.id);
      tx.runs.create(run);
      tx.messages.append(message);
      if (normalized.externalRun) this.#bind(tx, normalized.principal, normalized.externalRun, run.id);
      if (normalized.externalMessage) this.#bind(tx, normalized.principal, normalized.externalMessage, message.id);

      this.#appendEvent(tx, { ...working, taskId: working.id, runId: null }, {
        type: "task.status.changed",
        data: { from: "input_required", to: "working" },
      });
      this.#appendEvent(tx, { ...working, taskId: working.id, runId: run.id }, {
        type: "run.status.changed",
        data: { from: null, to: "queued" },
      });
      this.#appendMessageEvents(tx, working, run, message);
      this.#enqueueRun(tx, run, now, continuationInterruptIds);
      this.#storeIdempotency(
        tx,
        normalized.principal,
        "task.continue",
        normalized.idempotencyKey,
        fingerprint,
        task.id,
      );
      return this.#taskView(tx, task.accountId, task.id);
    });
  }

  async resume(command: ResumeTaskCommand, signal?: AbortSignal): Promise<TaskView> {
    assertSignal(signal);
    const normalized = normalizeResume(command);
    const fingerprint = stableStringify({
      task: normalized.task,
      externalRun: normalized.externalRun,
      externalMessage: normalized.externalMessage,
      responses: normalized.responses,
      message: normalized.message,
    });
    return this.#unitOfWork.transaction((tx) => {
      assertSignal(signal);
      const replay = this.#idempotencyReplay(
        tx,
        normalized.principal,
        "task.resume",
        normalized.idempotencyKey,
        fingerprint,
      );
      if (replay) return this.#taskView(tx, normalized.principal.accountId, replay.taskId);

      const task = this.#resolveTask(tx, normalized.principal, normalized.task);
      if (!task) throw applicationError("not_found", "task not found");
      if (task.status !== "input_required" && task.status !== "auth_required") {
        throw applicationError("conflict", `task in state ${task.status} cannot be resumed`);
      }
      assertTaskTransition(task.status, "working");
      if (normalized.externalRun) this.#ensureExternalAvailable(tx, normalized.principal, normalized.externalRun);
      if (normalized.externalMessage) this.#ensureExternalAvailable(tx, normalized.principal, normalized.externalMessage);

      const now = this.#clock.now();
      const interrupts = tx.interrupts.listForTask(task.accountId, task.id).map((value) => {
        const interrupt = parse(interruptSchema, value, "stored interrupt", "internal");
        if (interrupt.accountId !== task.accountId || interrupt.taskId !== task.id) {
          throw applicationError("internal", "interrupt task identity invariant failed");
        }
        return interrupt;
      });
      const open = interrupts.filter((interrupt) => interrupt.status === "open");
      if (open.length === 0) throw applicationError("conflict", "task has no open interrupts to resume");
      if (open.some((interrupt) => interrupt.expiresAt !== null && interrupt.expiresAt <= now)) {
        throw applicationError("conflict", "an open interrupt has expired");
      }

      const resolutions = new Map<string, { interrupt: Interrupt; status: "resolved" | "canceled"; response?: JsonValue }>();
      for (const response of normalized.responses) {
        const interrupt = this.#resolveInterruptRef(tx, normalized.principal, response.interrupt);
        if (!interrupt) throw applicationError("not_found", "interrupt not found");
        if (interrupt.taskId !== task.id) throw applicationError("conflict", "interrupt does not belong to the resumed task");
        if (interrupt.status !== "open") throw applicationError("conflict", `interrupt is already ${interrupt.status}`);
        if (resolutions.has(interrupt.id)) throw applicationError("invalid_argument", "resume contains a duplicate interrupt response");
        if (response.status === "resolved") this.#validateInterruptResponse(interrupt, response.response as JsonValue);
        resolutions.set(interrupt.id, { interrupt, status: response.status, ...(response.response === undefined ? {} : { response: response.response }) });
      }
      if (resolutions.size !== open.length || open.some((interrupt) => !resolutions.has(interrupt.id))) {
        throw applicationError("conflict", "resume must resolve every open interrupt exactly once");
      }

      const existingRuns = this.#taskRuns(tx, task);
      const attempt = existingRuns.reduce((maximum, run) => Math.max(maximum, run.attempt), 0) + 1;
      const run = parse(runSchema, {
        id: this.#ids.runId(),
        accountId: task.accountId,
        taskId: task.id,
        threadId: task.threadId,
        agentId: task.agentId,
        attempt,
        status: "queued",
        providerSessionRef: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        metadata: {},
      }, "generated resumed run", "internal");
      const message = normalized.message ? this.#createInputMessage(normalized.message, task, run, now) : undefined;
      if (message) this.#verifyAttachmentParts(tx, task.accountId, message.parts);

      const continuationInterruptIds: Interrupt["id"][] = [];
      for (const resolution of resolutions.values()) {
        const updated = parse(interruptSchema, {
          ...resolution.interrupt,
          status: resolution.status,
          resolvedAt: now,
          ...(resolution.status === "resolved" ? { response: resolution.response } : { response: undefined }),
        }, "resolved interrupt", "internal");
        tx.interrupts.put(updated);
        continuationInterruptIds.push(updated.id);
        this.#appendEvent(tx, { ...task, taskId: task.id, runId: updated.runId }, {
          type: "interrupt.resolved",
          data: {
            interruptId: updated.id,
            status: resolution.status,
            ...(updated.response === undefined ? {} : { response: updated.response }),
          },
        });
      }

      const working = parse(taskSchema, tx.tasks.transition(
        task.accountId,
        task.id,
        task.status,
        "working",
        now,
      ), "resumed task", "internal");
      this.#assertTaskIdentity(working, task.accountId, task.id);
      tx.runs.create(run);
      if (message) tx.messages.append(message);
      if (normalized.externalRun) this.#bind(tx, normalized.principal, normalized.externalRun, run.id);
      if (normalized.externalMessage && message) this.#bind(tx, normalized.principal, normalized.externalMessage, message.id);

      this.#appendEvent(tx, { ...working, taskId: working.id, runId: null }, {
        type: "task.status.changed",
        data: { from: task.status, to: "working" },
      });
      this.#appendEvent(tx, { ...working, taskId: working.id, runId: run.id }, {
        type: "run.status.changed",
        data: { from: null, to: "queued" },
      });
      if (message) this.#appendMessageEvents(tx, working, run, message);
      this.#enqueueRun(tx, run, now, continuationInterruptIds);
      this.#storeIdempotency(
        tx,
        normalized.principal,
        "task.resume",
        normalized.idempotencyKey,
        fingerprint,
        task.id,
      );
      return this.#taskView(tx, task.accountId, task.id);
    });
  }

  async resolveInterrupt(
    principal: ProtocolPrincipal,
    interrupt: InterruptRef,
    response: JsonValue,
  ): Promise<Interrupt> {
    const authorized = requireScope(principal, TASKS_WRITE_SCOPE);
    const reference = normalizeInterruptRef(interrupt);
    const normalizedResponse = parse(jsonValueSchema, response, "interrupt response");
    return this.#unitOfWork.transaction((tx) => {
      const current = this.#resolveInterruptRef(tx, authorized, reference);
      if (!current) throw applicationError("not_found", "interrupt not found");
      if (current.status === "resolved") {
        if (jsonEqual(current.response, normalizedResponse)) return current;
        throw applicationError("conflict", "interrupt was resolved with a different response");
      }
      if (current.status !== "open") throw applicationError("conflict", `interrupt is already ${current.status}`);
      const now = this.#clock.now();
      if (current.expiresAt !== null && current.expiresAt <= now) {
        throw applicationError("conflict", "interrupt has expired");
      }
      this.#validateInterruptResponse(current, normalizedResponse);
      const task = this.#storedTask(tx, current.accountId, current.taskId);
      if (["completed", "failed", "canceled", "rejected"].includes(task.status)) {
        throw applicationError("conflict", `interrupt cannot be resolved after task became ${task.status}`);
      }
      const updated = parse(interruptSchema, {
        ...current,
        status: "resolved",
        response: normalizedResponse,
        resolvedAt: now,
      }, "resolved interrupt", "internal");
      tx.interrupts.put(updated);
      this.#appendEvent(tx, { ...task, taskId: task.id, runId: current.runId }, {
        type: "interrupt.resolved",
        data: { interruptId: current.id, status: "resolved", response: normalizedResponse },
      });
      return updated;
    });
  }

  subscribe(
    principal: ProtocolPrincipal,
    task: TaskRef,
    afterSeq = 0,
    signal?: AbortSignal,
  ): AsyncIterable<TaskEventEnvelope> {
    const authorized = requireScope(principal, TASKS_READ_SCOPE);
    const reference = normalizeTaskRef(task);
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw applicationError("invalid_argument", "afterSeq must be a non-negative integer");
    }
    assertSignal(signal);
    const resolved = this.#unitOfWork.transaction((tx) => this.#resolveTask(tx, authorized, reference));
    if (!resolved) throw applicationError("not_found", "task not found");
    return this.#validatedStream(resolved, afterSeq, signal);
  }

  async transition(
    accountIdValue: AccountId,
    taskIdValue: TaskId,
    expected: Task["status"],
    next: Task["status"],
    reason?: string,
  ): Promise<Task> {
    const accountId = parse(accountIdSchema, accountIdValue, "account ID");
    const taskId = parse(taskIdSchema, taskIdValue, "task ID");
    const expectedStatus = parse(taskStatusSchema, expected, "expected task status");
    const nextStatus = parse(taskStatusSchema, next, "next task status");
    const normalizedReason = reason === undefined ? undefined : normalizeText(reason, "transition reason", 2_000);
    return this.#unitOfWork.transaction((tx) => {
      const current = this.#storedTask(tx, accountId, taskId);
      if (current.status === nextStatus) return current;
      if (current.status !== expectedStatus) {
        throw applicationError("conflict", `expected task state ${expectedStatus}, found ${current.status}`);
      }
      assertTaskTransition(current.status, nextStatus);
      const updated = parse(taskSchema, tx.tasks.transition(
        accountId,
        taskId,
        current.status,
        nextStatus,
        this.#clock.now(),
      ), "transitioned task", "internal");
      this.#assertTaskIdentity(updated, accountId, taskId);
      this.#appendEvent(tx, { ...updated, taskId: updated.id, runId: null }, {
        type: "task.status.changed",
        data: { from: current.status, to: nextStatus, ...(normalizedReason === undefined ? {} : { reason: normalizedReason }) },
      });
      return updated;
    });
  }

  async addArtifact(value: Artifact): Promise<Artifact> {
    const artifact = parse(artifactSchema, value, "artifact");
    return this.#unitOfWork.transaction((tx) => {
      const task = this.#storedTask(tx, artifact.accountId, artifact.taskId);
      if (["completed", "failed", "canceled", "rejected"].includes(task.status)) {
        throw applicationError("conflict", `artifact cannot be changed after task became ${task.status}`);
      }
      this.#verifyAttachmentParts(tx, artifact.accountId, artifact.parts);
      const stored = parse(artifactSchema, tx.artifacts.put(artifact), "stored artifact", "internal");
      if (stored.accountId !== artifact.accountId || stored.taskId !== artifact.taskId || stored.id !== artifact.id) {
        throw applicationError("internal", "artifact repository changed aggregate identity");
      }
      this.#appendEvent(tx, { ...task, taskId: task.id, runId: null }, {
        type: "artifact.updated",
        data: { artifact: stored },
      });
      return stored;
    });
  }

  async resolve(principal: ProtocolPrincipal, ref: ExternalEntityRef): Promise<ExternalIdentityBinding | null> {
    const authorized = requireScope(principal, TASKS_READ_SCOPE);
    const externalRef = normalizeExternalRef(ref);
    return this.#unitOfWork.transaction((tx) => {
      const binding = tx.externalIdentities.resolve(
        authorized.accountId,
        authorized.subjectId,
        externalRef,
      );
      if (!binding) return null;
      this.#assertBinding(binding, externalRef);
      this.#assertTargetExists(tx, authorized.accountId, this.#bindingTarget(binding));
      return binding;
    });
  }

  async getOrCreate(
    principal: ProtocolPrincipal,
    target: ExternalIdentityTarget,
  ): Promise<ExternalIdentityBinding> {
    const authorized = requireScope(principal, TASKS_WRITE_SCOPE);
    const normalized = this.#normalizeTarget(target);
    return this.#unitOfWork.transaction((tx) => {
      this.#assertTargetExists(tx, authorized.accountId, normalized);
      const existing = tx.externalIdentities.findByInternal(
        authorized.accountId,
        authorized.subjectId,
        normalized,
      );
      if (existing) {
        this.#assertBindingTarget(existing, normalized);
        return existing;
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const externalId = parse(externalIdSchema, this.#ids.externalId(), "generated external ID", "internal");
        const ref = { protocol: normalized.protocol, namespace: normalized.namespace, kind: normalized.kind, externalId } as ExternalEntityRef;
        if (tx.externalIdentities.resolve(
          authorized.accountId,
          authorized.subjectId,
          ref,
        )) continue;
        const binding = this.#makeBinding(normalized, ref);
        tx.externalIdentities.bind(authorized.accountId, authorized.subjectId, binding);
        return binding;
      }
      throw applicationError("unavailable", "could not allocate a unique external identity");
    });
  }

  #submissionConversation(tx: ApplicationTransaction, command: NormalizedSubmit, now: number): Conversation {
    const accountId = command.principal.accountId;
    const externalThread = command.externalRefs?.thread;
    if (externalThread) {
      const binding = tx.externalIdentities.resolve(
        accountId,
        command.principal.subjectId,
        externalThread,
      );
      if (binding) {
        this.#assertBinding(binding, externalThread);
        if (binding.ref.kind !== "thread") throw applicationError("internal", "thread binding kind invariant failed");
        if (command.threadId !== undefined && command.threadId !== binding.internalId) {
          throw applicationError("conflict", "threadId conflicts with the external thread binding");
        }
        const threadBinding = binding as Extract<ExternalIdentityBinding, { ref: { kind: "thread" } }>;
        const conversation = tx.conversations.get(accountId, threadBinding.internalId);
        if (!conversation) throw applicationError("internal", "external thread binding points to a missing conversation");
        return this.#storedConversation(conversation, accountId, threadBinding.internalId);
      }
    }

    if (command.threadId !== undefined) {
      const conversation = tx.conversations.get(accountId, command.threadId);
      if (!conversation) throw applicationError("not_found", "conversation not found");
      const stored = this.#storedConversation(conversation, accountId, command.threadId);
      if (externalThread) this.#bind(tx, command.principal, externalThread, stored.id);
      return stored;
    }

    const conversation = parse(conversationSchema, {
      id: this.#ids.threadId(),
      accountId,
      title: null,
      createdAt: now,
      updatedAt: now,
      metadata: {},
    }, "generated conversation", "internal");
    const stored = parse(conversationSchema, tx.conversations.create(conversation), "stored conversation", "internal");
    this.#storedConversation(stored, accountId, conversation.id);
    if (externalThread) this.#bind(tx, command.principal, externalThread, stored.id);
    return stored;
  }

  #ensureSubmissionRefsAvailable(
    tx: ApplicationTransaction,
    scope: ExternalIdentityScope,
    refs?: SubmissionExternalRefs,
  ): void {
    if (!refs) return;
    if (refs.task) this.#ensureExternalAvailable(tx, scope, refs.task);
    if (refs.run) this.#ensureExternalAvailable(tx, scope, refs.run);
    if (refs.message) this.#ensureExternalAvailable(tx, scope, refs.message);
  }

  #ensureExternalAvailable(
    tx: ApplicationTransaction,
    scope: ExternalIdentityScope,
    ref: ExternalEntityRef,
  ): void {
    if (tx.externalIdentities.resolve(scope.accountId, scope.subjectId, ref)) {
      throw applicationError("conflict", `external ${ref.kind} identity is already bound`);
    }
  }

  #bindSubmissionRefs(
    tx: ApplicationTransaction,
    scope: ExternalIdentityScope,
    refs: SubmissionExternalRefs | undefined,
    taskId: TaskId,
    runId: Run["id"],
    messageId: Message["id"],
  ): void {
    if (!refs) return;
    // A thread binding is created while resolving/creating the conversation.
    if (refs.task) this.#bind(tx, scope, refs.task, taskId);
    if (refs.run) this.#bind(tx, scope, refs.run, runId);
    if (refs.message) this.#bind(tx, scope, refs.message, messageId);
  }

  #bind(
    tx: ApplicationTransaction,
    scope: ExternalIdentityScope,
    ref: ExternalEntityRef,
    internalId: ThreadId | TaskId | Run["id"] | Message["id"],
  ): void {
    let binding: ExternalIdentityBinding;
    switch (ref.kind) {
      case "thread": binding = { ref: { ...ref, kind: "thread" }, internalId: internalId as ThreadId }; break;
      case "task": binding = { ref: { ...ref, kind: "task" }, internalId: internalId as TaskId }; break;
      case "run": binding = { ref: { ...ref, kind: "run" }, internalId: internalId as Run["id"] }; break;
      case "message": binding = { ref: { ...ref, kind: "message" }, internalId: internalId as Message["id"] }; break;
      default: throw applicationError("internal", `unsupported submission binding kind ${ref.kind}`);
    }
    tx.externalIdentities.bind(scope.accountId, scope.subjectId, binding);
  }

  #createInputMessage(input: TaskInputMessage, task: Task, run: Run, now: number): Message {
    const metadata: JsonObject = input.role === "tool"
      ? { ...(input.metadata ?? {}), [TOOL_ACTION_CALL_METADATA_KEY]: input.actionCallId }
      : { ...(input.metadata ?? {}) };
    return parse(messageSchema, {
      id: this.#ids.messageId(),
      accountId: task.accountId,
      threadId: task.threadId,
      taskId: task.id,
      runId: run.id,
      role: input.role,
      parts: input.parts,
      createdAt: now,
      metadata,
    }, "generated input message", "internal");
  }

  #appendMessageEvents(tx: ApplicationTransaction, task: Task, run: Run, message: Message): void {
    this.#appendEvent(tx, { ...task, taskId: task.id, runId: run.id }, {
      type: "message.started",
      data: { messageId: message.id, role: message.role },
    });
    this.#appendEvent(tx, { ...task, taskId: task.id, runId: run.id }, {
      type: "message.finished",
      data: { messageId: message.id, parts: message.parts },
    });
  }

  #appendEvent(tx: ApplicationTransaction, identity: EventIdentity, value: CanonicalEvent): TaskEventEnvelope {
    const event = parse(canonicalEventSchema, value, "canonical event", "internal");
    const previous = tx.events.lastSeq(identity.accountId, identity.taskId);
    const envelope = parse(taskEventEnvelopeSchema, tx.events.append({
      accountId: identity.accountId,
      taskId: identity.taskId,
      runId: identity.runId,
      agentId: identity.agentId,
      threadId: identity.threadId,
      event,
      metadata: {},
    }), "appended event", "internal");
    if (
      envelope.accountId !== identity.accountId ||
      envelope.taskId !== identity.taskId ||
      envelope.runId !== identity.runId ||
      envelope.agentId !== identity.agentId ||
      envelope.threadId !== identity.threadId ||
      envelope.seq !== previous + 1 ||
      !jsonEqual({ type: envelope.type, data: envelope.data }, event)
    ) {
      throw applicationError("internal", "event appender violated the canonical envelope contract");
    }
    return envelope;
  }

  #enqueueRun(
    tx: ApplicationTransaction,
    run: Run,
    now: number,
    continuationInterruptIds: readonly Interrupt["id"][] = [],
  ): void {
    tx.outbox.enqueue({
      id: `run-queued:${run.id}`,
      accountId: run.accountId,
      topic: RUN_QUEUED_OUTBOX_TOPIC,
      payload: {
        accountId: run.accountId,
        taskId: run.taskId,
        runId: run.id,
        threadId: run.threadId,
        agentId: run.agentId,
        attempt: run.attempt,
        continuationInterruptIds: [...continuationInterruptIds],
      },
      createdAt: now,
    });
  }

  #taskView(
    tx: ApplicationTransaction,
    accountId: AccountId,
    taskId: TaskId,
    historyLength = DEFAULT_TASK_HISTORY_LENGTH,
  ): TaskView {
    const task = this.#storedTask(tx, accountId, taskId);
    const runs = sortNewestBounded(this.#taskRuns(tx, task), MAX_TASK_VIEW_RUNS, (run) => run.createdAt, (run) => run.id);
    const messages = tx.messages.list(task.accountId, task.threadId, task.id).map((value) => {
      const message = parse(messageSchema, value, "stored message", "internal");
      if (message.accountId !== task.accountId || message.threadId !== task.threadId || message.taskId !== task.id) {
        throw applicationError("internal", "message task identity invariant failed");
      }
      return message;
    });
    const artifacts = tx.artifacts.list(task.accountId, task.id).map((value) => {
      const artifact = parse(artifactSchema, value, "stored artifact", "internal");
      if (artifact.accountId !== task.accountId || artifact.taskId !== task.id) {
        throw applicationError("internal", "artifact task identity invariant failed");
      }
      return artifact;
    });
    const interrupts = tx.interrupts.listForTask(task.accountId, task.id).map((value) => {
      const interrupt = parse(interruptSchema, value, "stored interrupt", "internal");
      if (interrupt.accountId !== task.accountId || interrupt.taskId !== task.id) {
        throw applicationError("internal", "interrupt task identity invariant failed");
      }
      return interrupt;
    });
    const lastSeq = tx.events.lastSeq(task.accountId, task.id);
    if (!Number.isInteger(lastSeq) || lastSeq < 0) throw applicationError("internal", "event appender returned an invalid last sequence");
    return {
      task,
      runs,
      messages: sortNewestBounded(messages, historyLength, (message) => message.createdAt, (message) => message.id),
      artifacts: sortNewestBounded(artifacts, MAX_TASK_VIEW_ARTIFACTS, (artifact) => artifact.updatedAt, (artifact) => artifact.id),
      interrupts: sortNewestBounded(interrupts, MAX_TASK_VIEW_INTERRUPTS, (interrupt) => interrupt.createdAt, (interrupt) => interrupt.id),
      lastSeq,
    };
  }

  #storedTask(tx: ApplicationTransaction, accountId: AccountId, taskId: TaskId): Task {
    const value = tx.tasks.get(accountId, taskId);
    if (!value) throw applicationError("not_found", "task not found");
    const task = parse(taskSchema, value, "stored task", "internal");
    this.#assertTaskIdentity(task, accountId, taskId);
    return task;
  }

  #assertTaskIdentity(task: Task, accountId: AccountId, taskId: TaskId): void {
    if (task.accountId !== accountId || task.id !== taskId) throw applicationError("internal", "task tenancy invariant failed");
  }

  #storedConversation(value: Conversation, accountId: AccountId, threadId: ThreadId): Conversation {
    const conversation = parse(conversationSchema, value, "stored conversation", "internal");
    if (conversation.accountId !== accountId || conversation.id !== threadId) {
      throw applicationError("internal", "conversation tenancy invariant failed");
    }
    return conversation;
  }

  #taskRuns(tx: ApplicationTransaction, task: Task): Run[] {
    return tx.runs.listForTask(task.accountId, task.id).map((value) => {
      const run = parse(runSchema, value, "stored run", "internal");
      if (
        run.accountId !== task.accountId || run.taskId !== task.id || run.threadId !== task.threadId || run.agentId !== task.agentId
      ) {
        throw applicationError("internal", "run task identity invariant failed");
      }
      return run;
    });
  }

  #resolveTask(tx: ApplicationTransaction, scope: ExternalIdentityScope, reference: TaskRef): Task | null {
    const { accountId } = scope;
    if ("taskId" in reference) {
      const value = tx.tasks.get(accountId, reference.taskId);
      if (!value) return null;
      const task = parse(taskSchema, value, "stored task", "internal");
      this.#assertTaskIdentity(task, accountId, reference.taskId);
      return task;
    }
    if ("runId" in reference) {
      const run = tx.runs.get(accountId, reference.runId);
      if (!run) return null;
      const parsedRun = parse(runSchema, run, "stored run", "internal");
      if (parsedRun.accountId !== accountId || parsedRun.id !== reference.runId) {
        throw applicationError("internal", "run tenancy invariant failed");
      }
      return this.#storedTask(tx, accountId, parsedRun.taskId);
    }
    const binding = tx.externalIdentities.resolve(
      accountId,
      scope.subjectId,
      reference.externalRef,
    );
    if (!binding) return null;
    this.#assertBinding(binding, reference.externalRef);
    let taskId: TaskId;
    switch (binding.ref.kind) {
      case "task": taskId = (binding as Extract<ExternalIdentityBinding, { ref: { kind: "task" } }>).internalId; break;
      case "run": {
        const runId = (binding as Extract<ExternalIdentityBinding, { ref: { kind: "run" } }>).internalId;
        const run = tx.runs.get(accountId, runId);
        if (!run) throw applicationError("internal", "external run binding points to a missing run");
        const parsedRun = parse(runSchema, run, "stored run", "internal");
        if (parsedRun.accountId !== accountId || parsedRun.id !== runId) {
          throw applicationError("internal", "run tenancy invariant failed");
        }
        taskId = parsedRun.taskId;
        break;
      }
      default:
        throw applicationError("internal", `task reference resolved to an invalid ${binding.ref.kind} binding`);
    }
    return this.#storedTask(tx, accountId, taskId);
  }

  #selectedRun(tx: ApplicationTransaction, scope: ExternalIdentityScope, reference: TaskRef): Run | null {
    const { accountId } = scope;
    let runId: Run["id"] | null = null;
    if ("runId" in reference) {
      runId = reference.runId;
    } else if ("externalRef" in reference && reference.externalRef.kind === "run") {
      const binding = tx.externalIdentities.resolve(
        accountId,
        scope.subjectId,
        reference.externalRef,
      );
      if (!binding) return null;
      this.#assertBinding(binding, reference.externalRef);
      if (binding.ref.kind !== "run") throw applicationError("internal", "run binding kind invariant failed");
      runId = (binding as Extract<ExternalIdentityBinding, { ref: { kind: "run" } }>).internalId;
    }
    if (!runId) return null;
    const value = tx.runs.get(accountId, runId);
    if (!value) return null;
    const run = parse(runSchema, value, "stored run", "internal");
    if (run.accountId !== accountId || run.id !== runId) {
      throw applicationError("internal", "run tenancy invariant failed");
    }
    return run;
  }

  #resolveInterruptRef(
    tx: ApplicationTransaction,
    scope: ExternalIdentityScope,
    reference: InterruptRef,
  ): Interrupt | null {
    const { accountId } = scope;
    let interruptId;
    if ("interruptId" in reference) {
      interruptId = reference.interruptId;
    } else {
      const binding = tx.externalIdentities.resolve(
        accountId,
        scope.subjectId,
        reference.externalRef,
      );
      if (!binding) return null;
      this.#assertBinding(binding, reference.externalRef);
      if (binding.ref.kind !== "interrupt") throw applicationError("internal", "interrupt binding kind invariant failed");
      interruptId = (binding as Extract<ExternalIdentityBinding, { ref: { kind: "interrupt" } }>).internalId;
    }
    const value = tx.interrupts.get(accountId, interruptId);
    if (!value) return null;
    const interrupt = parse(interruptSchema, value, "stored interrupt", "internal");
    if (interrupt.accountId !== accountId || interrupt.id !== interruptId) {
      throw applicationError("internal", "interrupt tenancy invariant failed");
    }
    return interrupt;
  }

  #historyLength(options?: TaskViewOptions): number {
    if (options?.historyLength === undefined) return DEFAULT_TASK_HISTORY_LENGTH;
    if (!Number.isInteger(options.historyLength) || options.historyLength < 0) {
      throw applicationError("invalid_argument", "historyLength must be a non-negative integer");
    }
    return Math.min(options.historyLength, MAX_TASK_HISTORY_LENGTH);
  }

  #idempotencyReplay(
    tx: ApplicationTransaction,
    principal: ProtocolPrincipal,
    operation: string,
    key: string | undefined,
    fingerprint: string,
  ): IdempotencyResult | null {
    if (!key) return null;
    const value = tx.idempotency.get(principal.accountId, principalRepositorySubject(principal), operation, key);
    if (value === null) return null;
    const result = idempotencyResult(value);
    if (result.fingerprint !== fingerprint) throw applicationError("conflict", "idempotency key was reused with a different command");
    return result;
  }

  #storeIdempotency(
    tx: ApplicationTransaction,
    principal: ProtocolPrincipal,
    operation: string,
    key: string | undefined,
    fingerprint: string,
    taskId: TaskId,
  ): void {
    if (!key) return;
    tx.idempotency.put(principal.accountId, principalRepositorySubject(principal), operation, key, {
      version: 1,
      fingerprint,
      taskId,
    });
  }

  #verifyAttachmentParts(tx: ApplicationTransaction, accountId: AccountId, parts: readonly ContentPart[]): void {
    for (const part of parts) {
      if (part.kind !== "file") continue;
      const stored = tx.attachments.get(accountId, part.attachment.id);
      if (!stored) throw applicationError("not_found", "attachment not found");
      const attachment = parse(attachmentRefSchema, stored, "stored attachment", "internal");
      if (!jsonEqual(attachment, part.attachment)) {
        throw applicationError("conflict", "attachment reference does not match stored attachment metadata");
      }
    }
  }

  #validateInterruptResponse(interrupt: Interrupt, response: JsonValue): void {
    let valid: boolean;
    try {
      valid = this.#responseValidator.validate(interrupt.responseSchema, response);
    } catch (cause) {
      throw applicationError("internal", "interrupt response validator failed", cause);
    }
    if (typeof valid !== "boolean") throw applicationError("internal", "interrupt response validator returned a non-boolean result");
    if (!valid) throw applicationError("invalid_argument", "interrupt response does not match its schema");
  }

  async *#validatedStream(task: Task, afterSeq: number, signal?: AbortSignal): AsyncIterable<TaskEventEnvelope> {
    let expected = afterSeq + 1;
    for await (const value of this.#eventLog.stream(task.accountId, task.id, afterSeq, signal)) {
      assertSignal(signal);
      const event = parse(taskEventEnvelopeSchema, value, "stored event", "internal");
      if (
        event.accountId !== task.accountId || event.taskId !== task.id || event.agentId !== task.agentId ||
        event.threadId !== task.threadId
      ) {
        throw applicationError("internal", "event stream task identity invariant failed");
      }
      if (event.seq !== expected) throw applicationError("internal", `event stream sequence gap: expected ${expected}, found ${event.seq}`);
      expected += 1;
      yield event;
    }
  }

  #normalizeTarget(target: ExternalIdentityTarget): ExternalIdentityTarget {
    if (!target || typeof target !== "object") throw applicationError("invalid_argument", "external identity target is required");
    const protocol = normalizeString(target.protocol, "external protocol", EXTERNAL_PROTOCOL_MAX);
    const namespace = normalizeString(target.namespace, "external namespace", EXTERNAL_NAMESPACE_MAX);
    switch (target.kind) {
      case "thread": return { protocol, namespace, kind: "thread", internalId: parse(threadIdSchema, target.internalId, "thread ID") };
      case "task": return { protocol, namespace, kind: "task", internalId: parse(taskIdSchema, target.internalId, "task ID") };
      case "run": return { protocol, namespace, kind: "run", internalId: parse(runIdSchema, target.internalId, "run ID") };
      case "message": return { protocol, namespace, kind: "message", internalId: parse(messageIdSchema, target.internalId, "message ID") };
      case "artifact": return { protocol, namespace, kind: "artifact", internalId: parse(artifactIdSchema, target.internalId, "artifact ID") };
      case "attachment": return { protocol, namespace, kind: "attachment", internalId: parse(attachmentIdSchema, target.internalId, "attachment ID") };
      case "interrupt": return { protocol, namespace, kind: "interrupt", internalId: parse(interruptIdSchema, target.internalId, "interrupt ID") };
      default: throw applicationError("invalid_argument", "external identity target kind is invalid");
    }
  }

  #assertTargetExists(tx: ApplicationTransaction, accountId: AccountId, target: ExternalIdentityTarget): void {
    switch (target.kind) {
      case "thread": {
        const value = tx.conversations.get(accountId, target.internalId);
        if (!value) throw applicationError("not_found", "thread not found");
        this.#storedConversation(value, accountId, target.internalId);
        return;
      }
      case "task": {
        this.#storedTask(tx, accountId, target.internalId);
        return;
      }
      case "run": {
        const value = tx.runs.get(accountId, target.internalId);
        if (!value) throw applicationError("not_found", "run not found");
        const run = parse(runSchema, value, "stored run", "internal");
        if (run.accountId !== accountId || run.id !== target.internalId) {
          throw applicationError("internal", "run tenancy invariant failed");
        }
        return;
      }
      case "message": {
        const value = tx.messages.get(accountId, target.internalId);
        if (!value) throw applicationError("not_found", "message not found");
        const message = parse(messageSchema, value, "stored message", "internal");
        if (message.accountId !== accountId || message.id !== target.internalId) {
          throw applicationError("internal", "message tenancy invariant failed");
        }
        return;
      }
      case "artifact": {
        const value = tx.artifacts.get(accountId, target.internalId);
        if (!value) throw applicationError("not_found", "artifact not found");
        const artifact = parse(artifactSchema, value, "stored artifact", "internal");
        if (artifact.accountId !== accountId || artifact.id !== target.internalId) {
          throw applicationError("internal", "artifact tenancy invariant failed");
        }
        return;
      }
      case "attachment": {
        const value = tx.attachments.get(accountId, target.internalId);
        if (!value) throw applicationError("not_found", "attachment not found");
        const attachment = parse(attachmentRefSchema, value, "stored attachment", "internal");
        if (attachment.id !== target.internalId) throw applicationError("internal", "attachment identity invariant failed");
        return;
      }
      case "interrupt": {
        const value = tx.interrupts.get(accountId, target.internalId);
        if (!value) throw applicationError("not_found", "interrupt not found");
        const interrupt = parse(interruptSchema, value, "stored interrupt", "internal");
        if (interrupt.accountId !== accountId || interrupt.id !== target.internalId) {
          throw applicationError("internal", "interrupt tenancy invariant failed");
        }
        return;
      }
    }
  }

  #bindingTarget(binding: ExternalIdentityBinding): ExternalIdentityTarget {
    return {
      protocol: binding.ref.protocol,
      namespace: binding.ref.namespace,
      kind: binding.ref.kind,
      internalId: binding.internalId,
    } as ExternalIdentityTarget;
  }

  #assertBinding(binding: ExternalIdentityBinding, ref: ExternalEntityRef): void {
    if (
      binding.ref.protocol !== ref.protocol || binding.ref.namespace !== ref.namespace ||
      binding.ref.kind !== ref.kind || binding.ref.externalId !== ref.externalId
    ) {
      throw applicationError("internal", "external identity repository returned the wrong binding");
    }
  }

  #assertBindingTarget(binding: ExternalIdentityBinding, target: ExternalIdentityTarget): void {
    if (
      binding.ref.protocol !== target.protocol || binding.ref.namespace !== target.namespace ||
      binding.ref.kind !== target.kind || binding.internalId !== target.internalId
    ) {
      throw applicationError("internal", "external identity repository returned the wrong target binding");
    }
  }

  #makeBinding(target: ExternalIdentityTarget, ref: ExternalEntityRef): ExternalIdentityBinding {
    switch (target.kind) {
      case "thread": return { ref: { ...ref, kind: "thread" }, internalId: target.internalId };
      case "task": return { ref: { ...ref, kind: "task" }, internalId: target.internalId };
      case "run": return { ref: { ...ref, kind: "run" }, internalId: target.internalId };
      case "message": return { ref: { ...ref, kind: "message" }, internalId: target.internalId };
      case "artifact": return { ref: { ...ref, kind: "artifact" }, internalId: target.internalId };
      case "attachment": return { ref: { ...ref, kind: "attachment" }, internalId: target.internalId };
      case "interrupt": return { ref: { ...ref, kind: "interrupt" }, internalId: target.internalId };
    }
  }
}

export { DefaultApplicationService as TaskApplicationService };
