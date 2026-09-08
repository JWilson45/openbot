import {
  ApplicationError,
  accountIdSchema,
  agentIdSchema,
  agentSchema,
  artifactIdSchema,
  artifactSchema,
  attachmentIdSchema,
  attachmentRefSchema,
  conversationSchema,
  eventIdSchema,
  externalIdSchema,
  interruptIdSchema,
  interruptSchema,
  messageIdSchema,
  messageSchema,
  runIdSchema,
  runSchema,
  runtimeProviderConfigSchema,
  taskEventEnvelopeSchema,
  taskIdSchema,
  taskSchema,
  threadIdSchema,
  type AccountId,
  type Agent,
  type AgentId,
  type Artifact,
  type AttachmentRef,
  type Conversation,
  type Interrupt,
  type JsonObject,
  type JsonValue,
  type Message,
  type Run,
  type RunId,
  type Task,
  type TaskEventEnvelope,
  type TaskId,
  type ThreadId,
} from "@openbot/core";
import type {
  AgentRepository,
  ApplicationTransaction,
  ArtifactRepository,
  AttachmentRepository,
  EventAppender,
  EventLog,
  ExternalEntityRef,
  ExternalIdentityBinding,
  ExternalIdentityRepository,
  ExternalIdentityTarget,
  IdempotencyRepository,
  InterruptRepository,
  ListTasksQuery,
  MessageRepository,
  OutboxRecord,
  OutboxRepository,
  Page,
  RunRepository,
  RunQueuePort,
  RunWorkItem,
  RuntimeCorrelationRepository,
  RuntimeInterruptCorrelation,
  TaskRepository,
  UnitOfWork,
} from "@openbot/application";
import type { OpenbotDb } from "./index.ts";

const newDbId = () => crypto.randomUUID();
const dbNow = () => Date.now();

type DbRow = Record<string, string | number | null>;

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new ApplicationError("internal", "stored JSON is invalid", { cause });
  }
}

function stringifyJson(value: JsonValue): string {
  return JSON.stringify(value);
}

function asTask(row: DbRow): Task {
  return taskSchema.parse({
    id: row.id,
    accountId: row.account_id,
    threadId: row.thread_id,
    agentId: row.agent_id,
    status: row.status,
    metadata: parseJson(String(row.metadata_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function asRun(row: DbRow): Run {
  return runSchema.parse({
    id: row.id,
    accountId: row.account_id,
    taskId: row.task_id,
    threadId: row.thread_id,
    agentId: row.agent_id,
    attempt: row.attempt,
    status: row.status,
    providerSessionRef: row.provider_session_ref,
    metadata: parseJson(String(row.metadata_json)),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

function asMessage(row: DbRow): Message {
  return messageSchema.parse({
    id: row.id,
    accountId: row.account_id,
    threadId: row.thread_id,
    taskId: row.task_id,
    runId: row.run_id,
    role: row.role,
    parts: parseJson(String(row.parts_json)),
    metadata: parseJson(String(row.metadata_json)),
    createdAt: row.created_at,
  });
}

function asArtifact(row: DbRow): Artifact {
  return artifactSchema.parse({
    id: row.id,
    accountId: row.account_id,
    taskId: row.task_id,
    name: row.name,
    description: row.description,
    parts: parseJson(String(row.parts_json)),
    metadata: parseJson(String(row.metadata_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function asInterrupt(row: DbRow): Interrupt {
  return interruptSchema.parse({
    id: row.id,
    accountId: row.account_id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    prompt: row.prompt,
    responseSchema: parseJson(String(row.response_schema_json)),
    status: row.status,
    response: row.response_json === null ? undefined : parseJson(String(row.response_json)),
    metadata: parseJson(String(row.metadata_json)),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
  });
}

class SqliteAgentRepository implements AgentRepository {
  constructor(private readonly db: OpenbotDb) {}

  get(accountId: AccountId, agentId: AgentId): Agent | null {
    const row = this.db.get<DbRow>(
      `SELECT id, account_id, name, description, provider_id, runtime_config_json,
              role, created_at, updated_at
       FROM bots WHERE account_id = ? AND id = ?`,
      [accountId, agentId],
    );
    if (!row) return null;
    const runtime = runtimeProviderConfigSchema.parse(parseJson(String(row.runtime_config_json)));
    if (runtime.providerId !== row.provider_id) {
      throw new ApplicationError("internal", "agent provider identity is inconsistent");
    }
    return agentSchema.parse({
      id: row.id,
      accountId: row.account_id,
      name: row.name,
      description: row.description,
      runtime,
      metadata: { role: String(row.role) },
      createdAt: row.created_at,
      updatedAt: Number(row.updated_at) || Number(row.created_at),
    });
  }
}

export class SqliteConversationRepository {
  constructor(private readonly db: OpenbotDb) {}

  create(conversation: Conversation): Conversation {
    const value = conversationSchema.parse(conversation);
    this.db.run(
      `INSERT INTO agent_conversations
       (id, account_id, title, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [value.id, value.accountId, value.title, stringifyJson(value.metadata), value.createdAt, value.updatedAt],
    );
    return value;
  }

  get(accountId: AccountId, threadId: ThreadId): Conversation | null {
    const row = this.db.get<DbRow>(
      "SELECT * FROM agent_conversations WHERE account_id = ? AND id = ?",
      [accountId, threadId],
    );
    if (!row) return null;
    return conversationSchema.parse({
      id: row.id,
      accountId: row.account_id,
      title: row.title,
      metadata: parseJson(String(row.metadata_json)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  update(conversation: Conversation): Conversation {
    const value = conversationSchema.parse(conversation);
    this.db.run(
      `UPDATE agent_conversations
          SET title = ?, metadata_json = ?, updated_at = ?
        WHERE account_id = ? AND id = ? AND created_at = ?`,
      [value.title, stringifyJson(value.metadata), value.updatedAt, value.accountId, value.id, value.createdAt],
    );
    const stored = this.get(value.accountId, value.id);
    if (!stored) throw new ApplicationError("not_found", "conversation not found");
    if (stored.createdAt !== value.createdAt) {
      throw new ApplicationError("conflict", "conversation identity is already owned by another aggregate");
    }
    return stored;
  }
}

class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly db: OpenbotDb) {}

  create(task: Task): Task {
    const value = taskSchema.parse(task);
    this.db.run(
      `INSERT INTO agent_tasks
       (id, account_id, thread_id, agent_id, status, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [value.id, value.accountId, value.threadId, value.agentId, value.status, stringifyJson(value.metadata), value.createdAt, value.updatedAt],
    );
    return value;
  }

  get(accountId: AccountId, taskId: TaskId): Task | null {
    const row = this.db.get<DbRow>("SELECT * FROM agent_tasks WHERE account_id = ? AND id = ?", [accountId, taskId]);
    return row ? asTask(row) : null;
  }

  list(accountId: AccountId, query: Omit<ListTasksQuery, "principal">): Page<Task> {
    const limit = Math.max(1, Math.min(100, query.limit));
    const conditions = ["account_id = ?"];
    const params: Array<string | number> = [accountId];
    if (query.agentId) {
      conditions.push("agent_id = ?");
      params.push(query.agentId);
    }
    if (query.threadId) {
      conditions.push("thread_id = ?");
      params.push(query.threadId);
    }
    if (query.statuses && query.statuses.length > 0) {
      conditions.push(`status IN (${query.statuses.map(() => "?").join(",")})`);
      params.push(...query.statuses);
    }
    if (query.updatedAfter !== undefined) {
      conditions.push("updated_at > ?");
      params.push(query.updatedAfter);
    }
    const totalSize = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_tasks WHERE ${conditions.join(" AND ")}`,
      params,
    )?.n ?? 0;
    const pageConditions = [...conditions];
    const pageParams = [...params];
    if (query.cursor) {
      const [updated, cursorId] = query.cursor.split(":", 2);
      const updatedAt = Number(updated);
      if (!Number.isSafeInteger(updatedAt) || !cursorId) throw new ApplicationError("invalid_argument", "invalid cursor");
      pageConditions.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
      pageParams.push(updatedAt, updatedAt, cursorId);
    }
    pageParams.push(limit + 1);
    const rows = this.db.all<DbRow>(
      `SELECT * FROM agent_tasks WHERE ${pageConditions.join(" AND ")}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
      pageParams,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(asTask);
    const last = items.at(-1);
    return {
      items,
      totalSize,
      nextCursor: hasMore && last ? `${last.updatedAt}:${last.id}` : undefined,
    };
  }

  transition(
    accountId: AccountId,
    taskId: TaskId,
    expected: Task["status"],
    next: Task["status"],
    updatedAt: number,
  ): Task {
    this.db.run(
      "UPDATE agent_tasks SET status = ?, updated_at = ? WHERE account_id = ? AND id = ? AND status = ?",
      [next, updatedAt, accountId, taskId, expected],
    );
    const task = this.get(accountId, taskId);
    if (!task) throw new ApplicationError("not_found", "task not found");
    if (task.status !== next) throw new ApplicationError("conflict", `task is ${task.status}, expected ${expected}`);
    return task;
  }
}

class SqliteRunRepository implements RunRepository {
  constructor(private readonly db: OpenbotDb) {}

  create(run: Run): Run {
    const value = runSchema.parse(run);
    this.db.run(
      `INSERT INTO agent_runs
       (id, account_id, task_id, thread_id, agent_id, attempt, status, provider_session_ref,
        metadata_json, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [value.id, value.accountId, value.taskId, value.threadId, value.agentId, value.attempt, value.status,
        value.providerSessionRef, stringifyJson(value.metadata), value.createdAt, value.startedAt, value.finishedAt],
    );
    return value;
  }

  get(accountId: AccountId, runId: RunId): Run | null {
    const row = this.db.get<DbRow>("SELECT * FROM agent_runs WHERE account_id = ? AND id = ?", [accountId, runId]);
    return row ? asRun(row) : null;
  }

  listForTask(accountId: AccountId, taskId: TaskId): readonly Run[] {
    return this.db
      .all<DbRow>("SELECT * FROM agent_runs WHERE account_id = ? AND task_id = ? ORDER BY attempt, id", [accountId, taskId])
      .map(asRun);
  }

  update(run: Run): Run {
    const value = runSchema.parse(run);
    this.db.run(
      `UPDATE agent_runs SET status = ?, provider_session_ref = ?, metadata_json = ?,
       started_at = ?, finished_at = ? WHERE account_id = ? AND id = ?`,
      [value.status, value.providerSessionRef, stringifyJson(value.metadata), value.startedAt,
        value.finishedAt, value.accountId, value.id],
    );
    return this.get(value.accountId, value.id) ?? (() => { throw new ApplicationError("not_found", "run not found"); })();
  }
}

class SqliteMessageRepository implements MessageRepository {
  constructor(private readonly db: OpenbotDb) {}

  append(message: Message): Message {
    const value = messageSchema.parse(message);
    this.db.run(
      `INSERT INTO agent_messages
       (id, account_id, thread_id, task_id, run_id, role, parts_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         parts_json = excluded.parts_json,
         metadata_json = excluded.metadata_json
       WHERE agent_messages.account_id = excluded.account_id
         AND agent_messages.thread_id = excluded.thread_id
         AND agent_messages.task_id IS excluded.task_id
         AND agent_messages.run_id IS excluded.run_id
         AND agent_messages.role = excluded.role
         AND agent_messages.created_at = excluded.created_at`,
      [value.id, value.accountId, value.threadId, value.taskId, value.runId, value.role,
        stringifyJson(value.parts), stringifyJson(value.metadata), value.createdAt],
    );
    const stored = this.get(value.accountId, value.id);
    if (!stored || stored.threadId !== value.threadId || stored.taskId !== value.taskId ||
        stored.runId !== value.runId || stored.role !== value.role || stored.createdAt !== value.createdAt) {
      throw new ApplicationError("conflict", "message identity is already owned by another aggregate");
    }
    return stored;
  }

  get(accountId: AccountId, messageId: Message["id"]): Message | null {
    const row = this.db.get<DbRow>("SELECT * FROM agent_messages WHERE account_id = ? AND id = ?", [accountId, messageId]);
    return row ? asMessage(row) : null;
  }

  list(accountId: AccountId, threadId: ThreadId, taskId?: TaskId): readonly Message[] {
    const rows = taskId
      ? this.db.all<DbRow>(
          "SELECT * FROM agent_messages WHERE account_id = ? AND thread_id = ? AND task_id = ? ORDER BY created_at, id",
          [accountId, threadId, taskId],
        )
      : this.db.all<DbRow>(
          "SELECT * FROM agent_messages WHERE account_id = ? AND thread_id = ? ORDER BY created_at, id",
          [accountId, threadId],
        );
    return rows.map(asMessage);
  }
}

class SqliteArtifactRepository implements ArtifactRepository {
  constructor(private readonly db: OpenbotDb) {}

  put(artifact: Artifact): Artifact {
    const value = artifactSchema.parse(artifact);
    this.db.run(
      `INSERT INTO agent_artifacts
       (id, account_id, task_id, name, description, parts_json, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
         parts_json = excluded.parts_json, metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at
       WHERE agent_artifacts.account_id = excluded.account_id AND agent_artifacts.task_id = excluded.task_id`,
      [value.id, value.accountId, value.taskId, value.name, value.description,
        stringifyJson(value.parts), stringifyJson(value.metadata), value.createdAt, value.updatedAt],
    );
    return value;
  }

  get(accountId: AccountId, artifactId: Artifact["id"]): Artifact | null {
    const row = this.db.get<DbRow>("SELECT * FROM agent_artifacts WHERE account_id = ? AND id = ?", [accountId, artifactId]);
    return row ? asArtifact(row) : null;
  }

  list(accountId: AccountId, taskId: TaskId): readonly Artifact[] {
    return this.db
      .all<DbRow>("SELECT * FROM agent_artifacts WHERE account_id = ? AND task_id = ? ORDER BY created_at, id", [accountId, taskId])
      .map(asArtifact);
  }
}

class SqliteAttachmentRepository implements AttachmentRepository {
  constructor(private readonly db: OpenbotDb) {}

  get(accountId: AccountId, attachmentId: AttachmentRef["id"]): AttachmentRef | null {
    const row = this.db.get<DbRow>("SELECT * FROM attachments WHERE account_id = ? AND id = ?", [accountId, attachmentId]);
    if (!row) return null;
    return attachmentRefSchema.parse({
      id: row.id,
      name: row.name,
      mediaType: row.media_type,
      size: row.size,
      sha256: row.sha256,
    });
  }
}

class SqliteInterruptRepository implements InterruptRepository {
  constructor(private readonly db: OpenbotDb) {}

  put(interrupt: Interrupt): Interrupt {
    const value = interruptSchema.parse(interrupt);
    this.db.run(
      `INSERT INTO agent_interrupts
       (id, account_id, task_id, run_id, kind, prompt, response_schema_json, status,
        response_json, metadata_json, created_at, expires_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, response_json = excluded.response_json,
         metadata_json = excluded.metadata_json, resolved_at = excluded.resolved_at
       WHERE agent_interrupts.account_id = excluded.account_id`,
      [value.id, value.accountId, value.taskId, value.runId, value.kind, value.prompt,
        stringifyJson(value.responseSchema), value.status,
        value.response === undefined ? null : stringifyJson(value.response), stringifyJson(value.metadata),
        value.createdAt, value.expiresAt, value.resolvedAt],
    );
    return value;
  }

  get(accountId: AccountId, interruptId: Interrupt["id"]): Interrupt | null {
    const row = this.db.get<DbRow>("SELECT * FROM agent_interrupts WHERE account_id = ? AND id = ?", [accountId, interruptId]);
    return row ? asInterrupt(row) : null;
  }

  listForTask(accountId: AccountId, taskId: TaskId): readonly Interrupt[] {
    return this.db
      .all<DbRow>("SELECT * FROM agent_interrupts WHERE account_id = ? AND task_id = ? ORDER BY created_at, id", [accountId, taskId])
      .map(asInterrupt);
  }
}

class SqliteRuntimeCorrelationRepository implements RuntimeCorrelationRepository {
  constructor(private readonly db: OpenbotDb) {}

  bindInterrupt(correlation: RuntimeInterruptCorrelation): void {
    if (!correlation.providerRequestRef || correlation.providerRequestRef.length > 512) {
      throw new ApplicationError("invalid_argument", "provider request reference is invalid");
    }
    const interrupt = this.db.get<{ account_id: string; task_id: string; run_id: string }>(
      "SELECT account_id, task_id, run_id FROM agent_interrupts WHERE id = ?",
      [correlation.interruptId],
    );
    if (
      !interrupt || interrupt.account_id !== correlation.accountId ||
      interrupt.task_id !== correlation.taskId || interrupt.run_id !== correlation.runId
    ) {
      throw new ApplicationError("conflict", "runtime interrupt correlation identity is inconsistent");
    }
    this.db.run(
      `INSERT INTO runtime_interrupt_correlations
       (interrupt_id, account_id, task_id, run_id, provider_request_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [correlation.interruptId, correlation.accountId, correlation.taskId, correlation.runId,
        correlation.providerRequestRef, dbNow()],
    );
  }

  getInterrupt(accountId: AccountId, interruptId: Interrupt["id"]): RuntimeInterruptCorrelation | null {
    const row = this.db.get<DbRow>(
      `SELECT * FROM runtime_interrupt_correlations
       WHERE account_id = ? AND interrupt_id = ?`,
      [accountId, interruptId],
    );
    if (!row) return null;
    return {
      accountId: accountIdSchema.parse(row.account_id),
      taskId: taskIdSchema.parse(row.task_id),
      runId: runIdSchema.parse(row.run_id),
      interruptId: interruptIdSchema.parse(row.interrupt_id),
      providerRequestRef: String(row.provider_request_ref),
    };
  }
}

function bindingFromRow(row: DbRow): ExternalIdentityBinding {
  const ref = {
    protocol: String(row.protocol),
    namespace: String(row.namespace),
    kind: String(row.entity_kind),
    externalId: externalIdSchema.parse(row.external_id),
  } as ExternalEntityRef;
  switch (ref.kind) {
    case "thread": return { ref: { ...ref, kind: "thread" }, internalId: threadIdSchema.parse(row.internal_id) };
    case "task": return { ref: { ...ref, kind: "task" }, internalId: taskIdSchema.parse(row.internal_id) };
    case "run": return { ref: { ...ref, kind: "run" }, internalId: runIdSchema.parse(row.internal_id) };
    case "message": return { ref: { ...ref, kind: "message" }, internalId: messageIdSchema.parse(row.internal_id) };
    case "artifact": return { ref: { ...ref, kind: "artifact" }, internalId: artifactIdSchema.parse(row.internal_id) };
    case "attachment": return { ref: { ...ref, kind: "attachment" }, internalId: attachmentIdSchema.parse(row.internal_id) };
    case "interrupt": return { ref: { ...ref, kind: "interrupt" }, internalId: interruptIdSchema.parse(row.internal_id) };
  }
}

class SqliteExternalIdentityRepository implements ExternalIdentityRepository {
  constructor(private readonly db: OpenbotDb) {}

  resolve(accountId: AccountId, subjectId: string, ref: ExternalEntityRef): ExternalIdentityBinding | null {
    const row = this.db.get<DbRow>(
      `SELECT * FROM protocol_identities
       WHERE account_id = ? AND subject_id = ? AND protocol = ? AND namespace = ?
         AND entity_kind = ? AND external_id = ?`,
      [accountId, subjectId, ref.protocol, ref.namespace, ref.kind, ref.externalId],
    );
    return row ? bindingFromRow(row) : null;
  }

  findByInternal(
    accountId: AccountId,
    subjectId: string,
    target: ExternalIdentityTarget,
  ): ExternalIdentityBinding | null {
    const row = this.db.get<DbRow>(
      `SELECT * FROM protocol_identities
       WHERE account_id = ? AND subject_id = ? AND protocol = ? AND namespace = ?
         AND entity_kind = ? AND internal_id = ?`,
      [accountId, subjectId, target.protocol, target.namespace, target.kind, target.internalId],
    );
    return row ? bindingFromRow(row) : null;
  }

  bind(accountId: AccountId, subjectId: string, binding: ExternalIdentityBinding): void {
    this.db.run(
      `INSERT INTO protocol_identities
       (id, account_id, subject_id, protocol, namespace, entity_kind, external_id, internal_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newDbId(), accountId, subjectId, binding.ref.protocol, binding.ref.namespace, binding.ref.kind,
        binding.ref.externalId, binding.internalId, dbNow()],
    );
  }
}

class SqliteIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly db: OpenbotDb) {}

  get(accountId: AccountId, subjectId: string, operation: string, key: string): JsonValue | null {
    const row = this.db.get<{ result_json: string }>(
      `SELECT result_json FROM idempotency_records
       WHERE account_id = ? AND subject_id = ? AND operation = ? AND idempotency_key = ?`,
      [accountId, subjectId, operation, key],
    );
    return row ? (parseJson(row.result_json) as JsonValue) : null;
  }

  put(accountId: AccountId, subjectId: string, operation: string, key: string, result: JsonValue): void {
    this.db.run(
      `INSERT INTO idempotency_records
       (id, account_id, subject_id, operation, idempotency_key, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newDbId(), accountId, subjectId, operation, key, stringifyJson(result), dbNow()],
    );
  }
}

class SqliteOutboxRepository implements OutboxRepository {
  constructor(private readonly db: OpenbotDb) {}

  enqueue(record: OutboxRecord): void {
    this.db.run(
      `INSERT INTO application_outbox
       (id, account_id, topic, payload_json, created_at, available_at, attempts)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [record.id, record.accountId, record.topic, stringifyJson(record.payload), record.createdAt, record.createdAt],
    );
  }
}

class SqliteEventAppender implements EventAppender {
  readonly appended: TaskEventEnvelope[] = [];

  constructor(
    private readonly db: OpenbotDb,
    private readonly outbox: SqliteOutboxRepository,
  ) {}

  lastSeq(accountId: AccountId, taskId: TaskId): number {
    const row = this.db.get<{ last_seq: number }>(
      `SELECT s.last_seq FROM task_event_sequences s
       JOIN agent_tasks t ON t.id = s.task_id
       WHERE t.account_id = ? AND s.task_id = ?`,
      [accountId, taskId],
    );
    return row?.last_seq ?? 0;
  }

  append(request: Parameters<EventAppender["append"]>[0]): TaskEventEnvelope {
    const task = this.db.get<{ account_id: string; thread_id: string; agent_id: string }>(
      "SELECT account_id, thread_id, agent_id FROM agent_tasks WHERE id = ?",
      [request.taskId],
    );
    if (!task) throw new ApplicationError("not_found", "task not found");
    if (task.account_id !== request.accountId || task.thread_id !== request.threadId || task.agent_id !== request.agentId) {
      throw new ApplicationError("conflict", "event aggregate identity does not match task");
    }
    if (request.runId) {
      const run = this.db.get<{ task_id: string; account_id: string }>(
        "SELECT task_id, account_id FROM agent_runs WHERE id = ?",
        [request.runId],
      );
      if (!run || run.task_id !== request.taskId || run.account_id !== request.accountId) {
        throw new ApplicationError("conflict", "event run identity does not match task");
      }
      const terminal = this.db.get<{ terminal: string }>(
        `SELECT json_extract(event_json, '$.data.to') AS terminal FROM task_events
         WHERE run_id = ? AND json_extract(event_json, '$.type') = 'run.status.changed'
           AND json_extract(event_json, '$.data.to') IN ('completed', 'failed', 'canceled')
         LIMIT 1`,
        [request.runId],
      );
      if (terminal) throw new ApplicationError("conflict", `run already ended as ${terminal.terminal}`);
    }

    this.db.run(
      "INSERT INTO task_event_sequences(task_id, last_seq) VALUES (?, 0) ON CONFLICT(task_id) DO NOTHING",
      [request.taskId],
    );
    const sequence = this.db.get<{ last_seq: number }>(
      "UPDATE task_event_sequences SET last_seq = last_seq + 1 WHERE task_id = ? RETURNING last_seq",
      [request.taskId],
    );
    if (!sequence) throw new ApplicationError("internal", "could not allocate event sequence");

    const envelope = taskEventEnvelopeSchema.parse({
      version: 1,
      eventId: eventIdSchema.parse(newDbId()),
      accountId: request.accountId,
      taskId: request.taskId,
      runId: request.runId,
      agentId: request.agentId,
      threadId: request.threadId,
      seq: sequence.last_seq,
      time: dbNow(),
      metadata: request.metadata ?? {},
      ...request.event,
    });
    this.db.run(
      `INSERT INTO task_events(event_id, account_id, task_id, run_id, seq, event_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [envelope.eventId, envelope.accountId, envelope.taskId, envelope.runId, envelope.seq,
        JSON.stringify(envelope), envelope.time],
    );
    this.outbox.enqueue({
      id: newDbId(),
      accountId: request.accountId,
      topic: "task.event",
      payload: JSON.parse(JSON.stringify(envelope)) as JsonObject,
      createdAt: envelope.time,
    });
    this.appended.push(envelope);
    return envelope;
  }
}

type Subscriber = {
  queue: TaskEventEnvelope[];
  wake: (() => void) | null;
  closed: boolean;
};

export class SqliteApplicationStore implements UnitOfWork, EventLog {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  constructor(readonly db: OpenbotDb) {}

  transaction<T>(operation: (tx: ApplicationTransaction) => T): T {
    let appended: TaskEventEnvelope[] = [];
    const result = this.db.immediate(() => {
      const outbox = new SqliteOutboxRepository(this.db);
      const events = new SqliteEventAppender(this.db, outbox);
      const tx: ApplicationTransaction = {
        agents: new SqliteAgentRepository(this.db),
        conversations: new SqliteConversationRepository(this.db),
        tasks: new SqliteTaskRepository(this.db),
        runs: new SqliteRunRepository(this.db),
        messages: new SqliteMessageRepository(this.db),
        artifacts: new SqliteArtifactRepository(this.db),
        attachments: new SqliteAttachmentRepository(this.db),
        interrupts: new SqliteInterruptRepository(this.db),
        runtimeCorrelations: new SqliteRuntimeCorrelationRepository(this.db),
        externalIdentities: new SqliteExternalIdentityRepository(this.db),
        idempotency: new SqliteIdempotencyRepository(this.db),
        events,
        outbox,
      };
      const value = operation(tx);
      appended = events.appended;
      return value;
    });
    if (appended.length > 0) this.drainPendingEvents();
    return result;
  }

  async read(
    accountId: AccountId,
    taskId: TaskId,
    afterSeq: number,
    limit: number,
  ): Promise<readonly TaskEventEnvelope[]> {
    const bounded = Math.max(1, Math.min(1_000, limit));
    const rows = this.db.all<{ event_json: string }>(
      `SELECT event_json FROM task_events
       WHERE account_id = ? AND task_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      [accountId, taskId, Math.max(0, afterSeq), bounded],
    );
    return rows.map((row) => taskEventEnvelopeSchema.parse(parseJson(row.event_json)));
  }

  async *stream(
    accountId: AccountId,
    taskId: TaskId,
    afterSeq: number,
    signal?: AbortSignal,
  ): AsyncIterable<TaskEventEnvelope> {
    const subscriber: Subscriber = { queue: [], wake: null, closed: false };
    const key = taskId as string;
    const set = this.subscribers.get(key) ?? new Set<Subscriber>();
    set.add(subscriber);
    this.subscribers.set(key, set);
    const abort = () => {
      subscriber.closed = true;
      subscriber.wake?.();
    };
    signal?.addEventListener("abort", abort, { once: true });

    let cursor = Math.max(0, afterSeq);
    try {
      while (true) {
        const page = await this.read(accountId, taskId, cursor, 1_000);
        for (const event of page) {
          if (event.seq <= cursor) continue;
          cursor = event.seq;
          yield event;
          if (event.type === "task.status.changed" && ["completed", "failed", "canceled", "rejected"].includes(event.data.to)) return;
        }
        if (page.length < 1_000) break;
      }

      while (!subscriber.closed) {
        subscriber.queue.sort((a, b) => a.seq - b.seq);
        const event = subscriber.queue.shift();
        if (event) {
          if (event.accountId !== accountId || event.seq <= cursor) continue;
          cursor = event.seq;
          yield event;
          if (event.type === "task.status.changed" && ["completed", "failed", "canceled", "rejected"].includes(event.data.to)) return;
          continue;
        }
        await new Promise<void>((resolve) => {
          subscriber.wake = resolve;
          if (subscriber.closed || subscriber.queue.length > 0) resolve();
        });
        subscriber.wake = null;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      set.delete(subscriber);
      if (set.size === 0) this.subscribers.delete(key);
    }
  }

  drainPendingEvents(): number {
    const rows = this.db.all<{ id: string; payload_json: string }>(
      `SELECT id, payload_json FROM application_outbox
       WHERE topic = 'task.event' AND delivered_at IS NULL AND available_at <= ?
       ORDER BY created_at, id LIMIT 1000`,
      [dbNow()],
    );
    const events: TaskEventEnvelope[] = [];
    for (const row of rows) events.push(taskEventEnvelopeSchema.parse(parseJson(row.payload_json)));
    this.publish(events);
    for (const row of rows) {
      this.db.run("UPDATE application_outbox SET delivered_at = ?, attempts = attempts + 1 WHERE id = ?", [dbNow(), row.id]);
    }
    return events.length;
  }

  private publish(events: readonly TaskEventEnvelope[]): void {
    for (const event of events) {
      const set = this.subscribers.get(event.taskId as string);
      if (!set) continue;
      for (const subscriber of set) {
        subscriber.queue.push(event);
        subscriber.wake?.();
      }
    }
  }

}

type RunQueueRow = {
  id: string;
  account_id: string;
  topic: string;
  payload_json: string;
};

/** SQLite lease queue for committed run.queued/run.cancel outbox records. */
export class SqliteRunQueue implements RunQueuePort {
  constructor(readonly db: OpenbotDb) {}

  async claim(workerId: string, now: number, leaseUntil: number, limit: number): Promise<readonly RunWorkItem[]> {
    if (!workerId || !Number.isSafeInteger(now) || !Number.isSafeInteger(leaseUntil) || leaseUntil <= now) {
      throw new ApplicationError("invalid_argument", "invalid run queue claim");
    }
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.db.immediate(() => {
      const rows = this.db.all<RunQueueRow>(
        `SELECT id, account_id, topic, payload_json FROM application_outbox
         WHERE topic IN ('run.queued', 'run.cancel') AND delivered_at IS NULL
           AND available_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         ORDER BY created_at, id LIMIT ?`,
        [now, now, bounded],
      );
      for (const row of rows) {
        this.db.run(
          `UPDATE application_outbox SET lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1
           WHERE id = ? AND delivered_at IS NULL`,
          [workerId, leaseUntil, row.id],
        );
      }
      return rows.map((row) => this.toWorkItem(row));
    });
  }

  async acknowledge(workerId: string, outboxId: string, deliveredAt: number): Promise<void> {
    this.db.run(
      `UPDATE application_outbox SET delivered_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
       WHERE id = ? AND lease_owner = ? AND delivered_at IS NULL`,
      [deliveredAt, outboxId, workerId],
    );
  }

  async renew(workerId: string, outboxId: string, now: number, leaseUntil: number): Promise<boolean> {
    if (!workerId || !outboxId || !Number.isSafeInteger(now) || !Number.isSafeInteger(leaseUntil) || leaseUntil <= now) {
      throw new ApplicationError("invalid_argument", "invalid run queue lease renewal");
    }
    return this.db.immediate(() => {
      this.db.run(
        `UPDATE application_outbox SET lease_expires_at = ?
         WHERE id = ? AND lease_owner = ? AND delivered_at IS NULL
           AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
        [leaseUntil, outboxId, workerId, now],
      );
      const row = this.db.get<{ lease_owner: string; lease_expires_at: number }>(
        `SELECT lease_owner, lease_expires_at FROM application_outbox
         WHERE id = ? AND delivered_at IS NULL`,
        [outboxId],
      );
      return row?.lease_owner === workerId && row.lease_expires_at === leaseUntil;
    });
  }

  async retry(workerId: string, outboxId: string, availableAt: number, reason: string): Promise<void> {
    this.db.run(
      `UPDATE application_outbox SET available_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?
       WHERE id = ? AND lease_owner = ? AND delivered_at IS NULL`,
      [availableAt, reason.slice(0, 2_000), outboxId, workerId],
    );
  }

  private toWorkItem(row: RunQueueRow): RunWorkItem {
    const payload = parseJson(row.payload_json) as Record<string, unknown>;
    const accountId = accountIdSchema.parse(row.account_id);
    if (payload.accountId !== undefined && payload.accountId !== accountId) {
      throw new ApplicationError("internal", "run queue account identity is inconsistent");
    }
    const taskId = taskIdSchema.parse(payload.taskId);
    const runId = runIdSchema.parse(payload.runId);
    if (row.topic === "run.cancel") {
      const reason = payload.reason;
      if (reason !== undefined && typeof reason !== "string") {
        throw new ApplicationError("internal", "run cancel reason is invalid");
      }
      return { kind: "cancel", outboxId: row.id, accountId, taskId, runId, ...(reason === undefined ? {} : { reason }) };
    }
    const attempt = Number(payload.attempt);
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new ApplicationError("internal", "run queue attempt is invalid");
    const continuationInterruptIds = Array.isArray(payload.continuationInterruptIds)
      ? payload.continuationInterruptIds.map((value) => interruptIdSchema.parse(value))
      : [];
    if (new Set(continuationInterruptIds).size !== continuationInterruptIds.length) {
      throw new ApplicationError("internal", "run queue continuation interrupt IDs are duplicated");
    }
    return {
      kind: "execute",
      outboxId: row.id,
      accountId,
      taskId,
      runId,
      threadId: threadIdSchema.parse(payload.threadId),
      agentId: agentIdSchema.parse(payload.agentId),
      attempt,
      continuationInterruptIds,
    };
  }
}
