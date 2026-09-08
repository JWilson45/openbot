import type {
  AccountId,
  Agent,
  AgentId,
  Artifact,
  ArtifactId,
  AttachmentRef,
  AttachmentId,
  CanonicalEvent,
  Conversation,
  ContentPart,
  EventId,
  ExternalId,
  Interrupt,
  InterruptId,
  JsonObject,
  JsonValue,
  Message,
  MessageId,
  Run,
  RunId,
  RuntimeAuthState,
  RuntimeCapabilities,
  RuntimeEventDraft,
  RuntimeModelDescriptor,
  RuntimeProviderConfig,
  RuntimeProviderDescriptor,
  Task,
  TaskEventEnvelope,
  TaskId,
  TaskStatus,
  ThreadId,
} from "@openbot/core";

export type ProtocolPrincipal = {
  accountId: AccountId;
  subjectId: string;
  kind: "user" | "agent" | "service";
  scopes: readonly string[];
};

export type PageRequest = { cursor?: string; limit: number };
export type Page<T> = { items: readonly T[]; totalSize: number; nextCursor?: string };

export type ExternalEntityRef = {
  protocol: string;
  namespace: string;
  kind: "thread" | "task" | "run" | "message" | "artifact" | "attachment" | "interrupt";
  externalId: ExternalId;
};

export type TaskRef =
  | { taskId: TaskId }
  | { runId: RunId }
  | { externalRef: ExternalEntityRef & { kind: "task" | "run" } };
export type InterruptRef = { interruptId: InterruptId } | { externalRef: ExternalEntityRef };

export type SubmissionExternalRefs = {
  thread?: ExternalEntityRef;
  task?: ExternalEntityRef;
  run?: ExternalEntityRef;
  message?: ExternalEntityRef;
};

export type TaskInputMessage =
  | { role: "user"; parts: readonly ContentPart[]; metadata?: JsonObject }
  | { role: "tool"; actionCallId: string; parts: readonly ContentPart[]; metadata?: JsonObject };

export type SubmitTaskCommand = {
  principal: ProtocolPrincipal;
  agentId: AgentId;
  threadId?: ThreadId;
  externalRefs?: SubmissionExternalRefs;
  message: TaskInputMessage;
  idempotencyKey?: string;
  metadata?: JsonObject;
};

export type ListTasksQuery = PageRequest & {
  principal: ProtocolPrincipal;
  agentId?: AgentId;
  threadId?: ThreadId;
  statuses?: readonly TaskStatus[];
  updatedAfter?: number;
};

export type TaskView = {
  task: Task;
  runs: readonly Run[];
  messages: readonly Message[];
  artifacts: readonly Artifact[];
  interrupts: readonly Interrupt[];
  lastSeq: number;
};

export type TaskViewOptions = {
  /** Newest canonical messages, capped by the implementation. Zero omits history. */
  historyLength?: number;
};

export type ResumeTaskCommand = {
  principal: ProtocolPrincipal;
  task: TaskRef;
  externalRun?: ExternalEntityRef & { kind: "run" };
  externalMessage?: ExternalEntityRef & { kind: "message" };
  responses: readonly {
    interrupt: InterruptRef;
    status: "resolved" | "canceled";
    response?: JsonValue;
  }[];
  message?: TaskInputMessage;
  idempotencyKey?: string;
};

/** Free-form follow-up for an input-required task (for example an A2A Message). */
export type ContinueTaskCommand = {
  principal: ProtocolPrincipal;
  task: TaskRef;
  externalRun?: ExternalEntityRef & { kind: "run" };
  externalMessage?: ExternalEntityRef & { kind: "message" };
  message: TaskInputMessage;
  idempotencyKey?: string;
};

/** Authorized application use cases exposed to protocol and UI adapters. */
export interface AgentTaskPort {
  submit(command: SubmitTaskCommand, signal?: AbortSignal): Promise<TaskView>;
  get(principal: ProtocolPrincipal, task: TaskRef, options?: TaskViewOptions): Promise<TaskView | null>;
  list(query: ListTasksQuery): Promise<Page<Task>>;
  cancel(principal: ProtocolPrincipal, task: TaskRef, reason?: string): Promise<TaskView>;
  continue(command: ContinueTaskCommand, signal?: AbortSignal): Promise<TaskView>;
  resume(command: ResumeTaskCommand, signal?: AbortSignal): Promise<TaskView>;
  resolveInterrupt(
    principal: ProtocolPrincipal,
    interrupt: InterruptRef,
    response: JsonValue,
  ): Promise<Interrupt>;
  subscribe(
    principal: ProtocolPrincipal,
    task: TaskRef,
    afterSeq?: number,
    signal?: AbortSignal,
  ): AsyncIterable<TaskEventEnvelope>;
}

export type EnsureConversationCommand = {
  principal: ProtocolPrincipal;
  threadId: ThreadId;
  title?: string | null;
  metadata?: JsonObject;
};

export type PublishAgentMessageCommand = {
  principal: ProtocolPrincipal;
  agentId: AgentId;
  threadId: ThreadId;
  messageId?: MessageId;
  /** Stable source timestamp used when replaying a durable delivery. */
  createdAt?: number;
  parts: readonly ContentPart[];
  metadata?: JsonObject;
};

/** Canonical conversation use cases for durable, out-of-band agent notifications. */
export interface ConversationMessagePort {
  ensureConversation(command: EnsureConversationCommand): Promise<Conversation>;
  publishAgentMessage(command: PublishAgentMessageCommand, signal?: AbortSignal): Promise<Message>;
  listConversationMessages(
    principal: ProtocolPrincipal,
    threadId: ThreadId,
    limit?: number,
  ): Promise<readonly Message[]>;
}

export type ActionDescriptor = {
  name: string;
  description?: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
};

export type ActionInputRequest = {
  id: string;
  prompt: string;
  schema: JsonObject;
};

export type ActionResult =
  | {
      outcome: "success" | "failure";
      content: readonly ContentPart[];
      data?: JsonValue;
    }
  | {
      outcome: "input_required";
      requests: readonly ActionInputRequest[];
      /** Opaque, integrity-protected continuation state owned by the action implementation. */
      requestState: string;
    };

export type ActionInvocationContext = {
  signal?: AbortSignal;
  continuation?: {
    requestState: string;
    inputResponses: Readonly<
      Record<
        string,
        { status: "accepted"; value: JsonValue } | { status: "declined" | "canceled" }
      >
    >;
  };
};

/** Provider- and protocol-neutral executable action catalog. */
export interface ActionPort {
  list(principal: ProtocolPrincipal): Promise<readonly ActionDescriptor[]>;
  invoke(
    principal: ProtocolPrincipal,
    name: string,
    input: JsonObject,
    context?: ActionInvocationContext,
  ): Promise<ActionResult>;
}

export type AttachmentImport = {
  name?: string;
  mediaType: string;
  /** Principal-scoped replay key chosen by the ingress adapter. */
  idempotencyKey?: string;
  source:
    | { kind: "bytes"; bytes: Uint8Array }
    | { kind: "url"; url: string };
  declaredSize?: number;
  declaredSha256?: string;
};

export type AttachmentContent = {
  attachment: AttachmentRef;
  body: ReadableStream<Uint8Array>;
};

/** Policy-checked, tenant-scoped attachment ingress and egress. */
export interface AttachmentPort {
  import(
    principal: ProtocolPrincipal,
    input: AttachmentImport,
    signal?: AbortSignal,
  ): Promise<AttachmentRef>;
  open(
    principal: ProtocolPrincipal,
    attachmentId: AttachmentId,
    signal?: AbortSignal,
  ): Promise<AttachmentContent>;
  createDownloadUrl(
    principal: ProtocolPrincipal,
    attachmentId: AttachmentId,
    expiresAt: number,
  ): Promise<string>;
}

export type RuntimeCapabilityRef = {
  kind: "workspace";
  /** Opaque to the provider; resolved only by the owning runtime host. */
  ref: string;
};

export type RuntimeSessionRequest = {
  accountId: AccountId;
  agentId: AgentId;
  taskId: TaskId;
  runId: RunId;
  config: RuntimeProviderConfig;
  resumeSessionRef?: string;
  capabilities: readonly RuntimeCapabilityRef[];
  metadata: JsonObject;
};

export type RuntimePromptRequest = {
  messages: readonly Message[];
  actions: readonly ActionDescriptor[];
  metadata: JsonObject;
};

export interface RuntimeSession {
  readonly providerSessionRef: string | null;
  run(request: RuntimePromptRequest, signal?: AbortSignal): AsyncIterable<RuntimeEventDraft>;
  respond(
    interruptRef: string,
    response: { status: "resolved"; value: JsonValue } | { status: "canceled" },
    signal?: AbortSignal,
  ): Promise<void>;
  cancel(reason?: string): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeProvider {
  readonly id: string;
  describe(accountId: AccountId): Promise<RuntimeProviderDescriptor>;
  listModels(accountId: AccountId): Promise<readonly RuntimeModelDescriptor[]>;
  resolveCapabilities(
    accountId: AccountId,
    config: RuntimeProviderConfig,
  ): Promise<RuntimeCapabilities>;
  validateConfig(config: RuntimeProviderConfig): RuntimeProviderConfig;
  authState(accountId: AccountId): Promise<RuntimeAuthState>;
  createSession(request: RuntimeSessionRequest, signal?: AbortSignal): Promise<RuntimeSession>;
}

export interface RuntimeProviderRegistry {
  get(providerId: string): RuntimeProvider;
  list(accountId: AccountId): Promise<readonly RuntimeProviderDescriptor[]>;
}

export type AppendEventRequest = {
  accountId: AccountId;
  taskId: TaskId;
  runId: RunId | null;
  agentId: AgentId;
  threadId: ThreadId;
  event: CanonicalEvent;
  metadata?: JsonObject;
};

/** Append is transaction-scoped so state and outbox writes cannot diverge. */
export interface EventAppender {
  append(request: AppendEventRequest): TaskEventEnvelope;
  lastSeq(accountId: AccountId, taskId: TaskId): number;
}

/** Gap-free committed-log replay followed by a live tail. */
export interface EventLog {
  read(
    accountId: AccountId,
    taskId: TaskId,
    afterSeq: number,
    limit: number,
  ): Promise<readonly TaskEventEnvelope[]>;
  stream(
    accountId: AccountId,
    taskId: TaskId,
    afterSeq: number,
    signal?: AbortSignal,
  ): AsyncIterable<TaskEventEnvelope>;
}

export interface AgentRepository {
  get(accountId: AccountId, agentId: AgentId): Agent | null;
}

export interface ConversationRepository {
  create(conversation: Conversation): Conversation;
  get(accountId: AccountId, threadId: ThreadId): Conversation | null;
  update(conversation: Conversation): Conversation;
}

export interface TaskRepository {
  create(task: Task): Task;
  get(accountId: AccountId, taskId: TaskId): Task | null;
  list(accountId: AccountId, query: Omit<ListTasksQuery, "principal">): Page<Task>;
  transition(
    accountId: AccountId,
    taskId: TaskId,
    expected: TaskStatus,
    next: TaskStatus,
    updatedAt: number,
  ): Task;
}

export interface RunRepository {
  create(run: Run): Run;
  get(accountId: AccountId, runId: RunId): Run | null;
  listForTask(accountId: AccountId, taskId: TaskId): readonly Run[];
  update(run: Run): Run;
}

export interface MessageRepository {
  /** Reserves or finalizes one message ID; immutable ownership fields may not change. */
  append(message: Message): Message;
  get(accountId: AccountId, messageId: MessageId): Message | null;
  list(accountId: AccountId, threadId: ThreadId, taskId?: TaskId): readonly Message[];
}

export interface ArtifactRepository {
  put(artifact: Artifact): Artifact;
  get(accountId: AccountId, artifactId: ArtifactId): Artifact | null;
  list(accountId: AccountId, taskId: TaskId): readonly Artifact[];
}

export interface AttachmentRepository {
  get(accountId: AccountId, attachmentId: AttachmentId): AttachmentRef | null;
}

export interface InterruptRepository {
  put(interrupt: Interrupt): Interrupt;
  get(accountId: AccountId, interruptId: InterruptId): Interrupt | null;
  listForTask(accountId: AccountId, taskId: TaskId): readonly Interrupt[];
}

export type RuntimeInterruptCorrelation = {
  accountId: AccountId;
  taskId: TaskId;
  runId: RunId;
  interruptId: InterruptId;
  providerRequestRef: string;
};

/** Private provider correlation state; values never enter events or public metadata. */
export interface RuntimeCorrelationRepository {
  bindInterrupt(correlation: RuntimeInterruptCorrelation): void;
  getInterrupt(accountId: AccountId, interruptId: InterruptId): RuntimeInterruptCorrelation | null;
}

/**
 * Durable protocol identity storage. `subjectId` is the authenticated principal's stable
 * `ProtocolPrincipal.subjectId`, so neither lookup direction is account-global.
 */
export interface ExternalIdentityRepository {
  resolve(accountId: AccountId, subjectId: string, ref: ExternalEntityRef): ExternalIdentityBinding | null;
  findByInternal(
    accountId: AccountId,
    subjectId: string,
    target: ExternalIdentityTarget,
  ): ExternalIdentityBinding | null;
  bind(accountId: AccountId, subjectId: string, binding: ExternalIdentityBinding): void;
}

export type ExternalIdentityBinding =
  | { ref: ExternalEntityRef & { kind: "thread" }; internalId: ThreadId }
  | { ref: ExternalEntityRef & { kind: "task" }; internalId: TaskId }
  | { ref: ExternalEntityRef & { kind: "run" }; internalId: RunId }
  | { ref: ExternalEntityRef & { kind: "message" }; internalId: MessageId }
  | { ref: ExternalEntityRef & { kind: "artifact" }; internalId: ArtifactId }
  | { ref: ExternalEntityRef & { kind: "attachment" }; internalId: AttachmentId }
  | { ref: ExternalEntityRef & { kind: "interrupt" }; internalId: InterruptId };

export type ExternalIdentityTarget =
  | { protocol: string; namespace: string; kind: "thread"; internalId: ThreadId }
  | { protocol: string; namespace: string; kind: "task"; internalId: TaskId }
  | { protocol: string; namespace: string; kind: "run"; internalId: RunId }
  | { protocol: string; namespace: string; kind: "message"; internalId: MessageId }
  | { protocol: string; namespace: string; kind: "artifact"; internalId: ArtifactId }
  | { protocol: string; namespace: string; kind: "attachment"; internalId: AttachmentId }
  | { protocol: string; namespace: string; kind: "interrupt"; internalId: InterruptId };

/** Authorized stable external identity allocation for protocol response mapping. */
export interface ExternalIdentityPort {
  resolve(principal: ProtocolPrincipal, ref: ExternalEntityRef): Promise<ExternalIdentityBinding | null>;
  getOrCreate(
    principal: ProtocolPrincipal,
    target: ExternalIdentityTarget,
  ): Promise<ExternalIdentityBinding>;
}

export interface IdempotencyRepository {
  get(accountId: AccountId, subjectId: string, operation: string, key: string): JsonValue | null;
  put(accountId: AccountId, subjectId: string, operation: string, key: string, result: JsonValue): void;
}

export type OutboxRecord = {
  id: string;
  accountId: AccountId;
  topic: string;
  payload: JsonObject;
  createdAt: number;
};

export interface OutboxRepository {
  enqueue(record: OutboxRecord): void;
}

export type RunWorkItem =
  | {
      kind: "execute";
      outboxId: string;
      accountId: AccountId;
      taskId: TaskId;
      runId: RunId;
      threadId: ThreadId;
      agentId: AgentId;
      attempt: number;
      continuationInterruptIds: readonly InterruptId[];
    }
  | {
      kind: "cancel";
      outboxId: string;
      accountId: AccountId;
      taskId: TaskId;
      runId: RunId;
      reason?: string;
    };

/** Durable post-commit queue consumed by runtime workers. */
export interface RunQueuePort {
  claim(workerId: string, now: number, leaseUntil: number, limit: number): Promise<readonly RunWorkItem[]>;
  /** Extends a live claim only while `workerId` still owns it; false means ownership was lost. */
  renew(workerId: string, outboxId: string, now: number, leaseUntil: number): Promise<boolean>;
  acknowledge(workerId: string, outboxId: string, deliveredAt: number): Promise<void>;
  retry(workerId: string, outboxId: string, availableAt: number, reason: string): Promise<void>;
}

export type ApplicationTransaction = {
  agents: AgentRepository;
  conversations: ConversationRepository;
  tasks: TaskRepository;
  runs: RunRepository;
  messages: MessageRepository;
  artifacts: ArtifactRepository;
  attachments: AttachmentRepository;
  interrupts: InterruptRepository;
  runtimeCorrelations: RuntimeCorrelationRepository;
  externalIdentities: ExternalIdentityRepository;
  idempotency: IdempotencyRepository;
  events: EventAppender;
  outbox: OutboxRepository;
};

export interface UnitOfWork {
  transaction<T>(operation: (tx: ApplicationTransaction) => T): T;
}

/** Internal coordinator operations are not available to protocol adapters. */
export interface TaskCoordinatorPort {
  transition(
    accountId: AccountId,
    taskId: TaskId,
    expected: TaskStatus,
    next: TaskStatus,
    reason?: string,
  ): Promise<Task>;
  addArtifact(artifact: Artifact): Promise<Artifact>;
}

export interface Clock {
  now(): number;
}

export interface IdGenerator {
  accountId(): AccountId;
  agentId(): AgentId;
  threadId(): ThreadId;
  taskId(): TaskId;
  runId(): RunId;
  messageId(): MessageId;
  artifactId(): ArtifactId;
  attachmentId(): AttachmentId;
  interruptId(): InterruptId;
  eventId(): EventId;
  externalId(): ExternalId;
}

export interface CredentialPort {
  get(accountId: AccountId, providerId: string, key: string): Promise<string | null>;
}

export interface PeerDirectoryPort {
  resolveAgent(
    principal: ProtocolPrincipal,
    peer: string,
  ): Promise<{ agentId: AgentId; endpoint?: string } | null>;
}
