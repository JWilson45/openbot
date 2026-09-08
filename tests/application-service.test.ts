import { describe, expect, test } from "bun:test";
import {
  DefaultApplicationService,
  MAX_TASK_HISTORY_LENGTH,
  MAX_TASK_VIEW_ARTIFACTS,
  MAX_TASK_VIEW_INTERRUPTS,
  MAX_TASK_VIEW_RUNS,
  RUN_CANCEL_OUTBOX_TOPIC,
  RUN_QUEUED_OUTBOX_TOPIC,
  TASKS_READ_SCOPE,
  TASKS_WRITE_SCOPE,
  type ApplicationTransaction,
  type ExternalEntityRef,
  type ExternalIdentityBinding,
  type ExternalIdentityTarget,
  type ListTasksQuery,
  type OutboxRecord,
  type Page,
  type ProtocolPrincipal,
  type RuntimeInterruptCorrelation,
  type SubmitTaskCommand,
  type UnitOfWork,
} from "../packages/application/src/index.ts";
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
  type AgentId,
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
  type Task,
  type TaskEventEnvelope,
  type TaskId,
  type ThreadId,
} from "../packages/core/src/index.ts";

const TASK_EVENT_OUTBOX_TOPIC = "task.event";

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
  #time = 1_800_000_000_000;

  now(): number {
    return this.#time++;
  }

  #uuid(): string {
    return `00000000-0000-4000-8000-${String(this.#nextId++).padStart(12, "0")}`;
  }

  accountId(): AccountId { return accountIdSchema.parse(this.#uuid()); }
  agentId(): AgentId { return agentIdSchema.parse(this.#uuid()); }
  threadId(): ThreadId { return threadIdSchema.parse(this.#uuid()); }
  taskId(): TaskId { return taskIdSchema.parse(this.#uuid()); }
  runId(): RunId { return runIdSchema.parse(this.#uuid()); }
  messageId(): MessageId { return messageIdSchema.parse(this.#uuid()); }
  artifactId() { return artifactIdSchema.parse(this.#uuid()); }
  attachmentId() { return attachmentIdSchema.parse(this.#uuid()); }
  interruptId(): InterruptId { return interruptIdSchema.parse(this.#uuid()); }
  eventId(): EventId { return eventIdSchema.parse(this.#uuid()); }
  externalId(): ExternalId { return externalIdSchema.parse(`generated-${this.#nextId++}`); }

  transaction<T>(operation: (tx: ApplicationTransaction) => T): T {
    const snapshot = structuredClone(this.state);
    try {
      return operation(this.#transaction());
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  async read(accountId: AccountId, taskId: TaskId, afterSeq: number, limit: number): Promise<readonly TaskEventEnvelope[]> {
    return (this.state.events.get(eventKey(accountId, taskId)) ?? [])
      .filter((event) => event.seq > afterSeq)
      .slice(0, limit);
  }

  async *stream(
    accountId: AccountId,
    taskId: TaskId,
    afterSeq: number,
    signal?: AbortSignal,
  ): AsyncIterable<TaskEventEnvelope> {
    for (const event of await this.read(accountId, taskId, afterSeq, Number.MAX_SAFE_INTEGER)) {
      if (signal?.aborted) throw new ApplicationError("canceled", "stream canceled");
      yield event;
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
          let items = [...memory.state.tasks.values()].filter((task) => task.accountId === accountId);
          if (query.agentId) items = items.filter((task) => task.agentId === query.agentId);
          if (query.threadId) items = items.filter((task) => task.threadId === query.threadId);
          if (query.statuses) items = items.filter((task) => query.statuses!.includes(task.status));
          if (query.updatedAfter !== undefined) items = items.filter((task) => task.updatedAt > query.updatedAfter!);
          items.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
          const totalSize = items.length;
          const offset = query.cursor === undefined ? 0 : Number(query.cursor);
          const page = items.slice(offset, offset + query.limit);
          return {
            items: page,
            totalSize,
            ...(offset + page.length < items.length ? { nextCursor: String(offset + page.length) } : {}),
          };
        },
        transition(accountId, taskId, expected, next, updatedAt) {
          const key = entityKey(accountId, taskId);
          const task = memory.state.tasks.get(key);
          if (!task) throw new ApplicationError("not_found", "task not found");
          if (task.status !== expected) throw new ApplicationError("conflict", "stale task state");
          const updated: Task = { ...task, status: next, updatedAt };
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
          if (memory.state.messages.has(key)) throw new ApplicationError("conflict", "message exists");
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
          if (memory.state.runtimeCorrelations.has(key)) throw new ApplicationError("conflict", "runtime correlation exists");
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
          const byExternal = externalKey(accountId, subjectId, binding.ref);
          const byInternal = reverseKey(accountId, subjectId, target);
          if (memory.state.external.has(byExternal) || memory.state.externalReverse.has(byInternal)) {
            throw new ApplicationError("conflict", "external identity exists");
          }
          memory.state.external.set(byExternal, binding);
          memory.state.externalReverse.set(byInternal, binding);
        },
      },
      idempotency: {
        get(accountId, subjectId, operation, key) {
          return memory.state.idempotency.get(idemKey(accountId, subjectId, operation, key)) ?? null;
        },
        put(accountId, subjectId, operation, key, result) {
          const identity = idemKey(accountId, subjectId, operation, key);
          if (memory.state.idempotency.has(identity)) throw new ApplicationError("conflict", "idempotency exists");
          memory.state.idempotency.set(identity, result);
        },
      },
      events: {
        append(request) {
          const key = eventKey(request.accountId, request.taskId);
          const events = memory.state.events.get(key) ?? [];
          const envelope = taskEventEnvelopeSchema.parse({
            version: 1,
            eventId: memory.eventId(),
            accountId: request.accountId,
            taskId: request.taskId,
            runId: request.runId,
            agentId: request.agentId,
            threadId: request.threadId,
            seq: events.length + 1,
            time: memory.now(),
            type: request.event.type,
            data: request.event.data,
            metadata: request.metadata ?? {},
          });
          memory.state.events.set(key, [...events, envelope]);
          memory.state.outbox.push({
            id: `event-outbox:${envelope.eventId}`,
            accountId: envelope.accountId,
            topic: TASK_EVENT_OUTBOX_TOPIC,
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
          if (memory.state.outbox.some((current) => current.accountId === record.accountId && current.id === record.id)) {
            throw new ApplicationError("conflict", "outbox record exists");
          }
          memory.state.outbox.push(record);
        },
      },
    };
  }
}

type Tenant = { accountId: AccountId; agentId: AgentId; principal: ProtocolPrincipal };

function seedTenant(memory: MemoryHarness, subjectId: string): Tenant {
  const accountId = memory.accountId();
  const agentId = memory.agentId();
  const now = memory.now();
  const agent: Agent = {
    id: agentId,
    accountId,
    name: `${subjectId} agent`,
    description: "test agent",
    runtime: { providerId: "test-runtime", modelId: "test-model", options: {} },
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
  memory.state.agents.set(entityKey(accountId, agentId), agent);
  return {
    accountId,
    agentId,
    principal: {
      accountId,
      subjectId,
      kind: "user",
      scopes: [TASKS_READ_SCOPE, TASKS_WRITE_SCOPE],
    },
  };
}

function externalRef<K extends ExternalEntityRef["kind"]>(kind: K, externalId: string, namespace = "client"):
  ExternalEntityRef & { kind: K } {
  return {
    protocol: "test-protocol",
    namespace,
    kind,
    externalId: externalIdSchema.parse(externalId),
  };
}

function submitCommand(tenant: Tenant, overrides: Partial<SubmitTaskCommand> = {}): SubmitTaskCommand {
  return {
    principal: tenant.principal,
    agentId: tenant.agentId,
    message: { role: "user", parts: [{ kind: "text", text: "hello" }] },
    ...overrides,
  };
}

function setup() {
  const memory = new MemoryHarness();
  const first = seedTenant(memory, "first-user");
  const second = seedTenant(memory, "second-user");
  const service = new DefaultApplicationService({
    unitOfWork: memory,
    eventLog: memory,
    ids: memory,
    clock: memory,
    responseValidator: {
      validate(schema: JsonObject, value: JsonValue): boolean {
        if (Array.isArray(schema.enum)) return schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value));
        if (schema.type === "boolean") return typeof value === "boolean";
        if (schema.type === "string") return typeof value === "string";
        if (schema.type === "number") return typeof value === "number";
        if (schema.type === "object") return value !== null && !Array.isArray(value) && typeof value === "object";
        return true;
      },
    },
  });
  return { memory, service, first, second };
}

async function expectApplicationError(promise: Promise<unknown>, code: ApplicationError["code"]): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code} error`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationError);
    expect((error as ApplicationError).code).toBe(code);
  }
}

function eventsFor(memory: MemoryHarness, task: Task): TaskEventEnvelope[] {
  return memory.state.events.get(eventKey(task.accountId, task.id)) ?? [];
}

function forceInputRequired(memory: MemoryHarness, task: Task, run: Run): void {
  memory.state.tasks.set(entityKey(task.accountId, task.id), {
    ...task,
    status: "input_required",
    updatedAt: memory.now(),
  });
  memory.state.runs.set(entityKey(run.accountId, run.id), {
    ...run,
    status: "interrupted",
  });
}

function seedInterrupt(
  memory: MemoryHarness,
  task: Task,
  run: Run,
  kind: Interrupt["kind"] = "input",
  responseSchema: JsonObject = { type: "boolean" },
): Interrupt {
  const interrupt: Interrupt = {
    id: memory.interruptId(),
    accountId: task.accountId,
    taskId: task.id,
    runId: run.id,
    kind,
    prompt: "Continue?",
    responseSchema,
    status: "open",
    createdAt: memory.now(),
    expiresAt: null,
    resolvedAt: null,
    metadata: {},
  };
  memory.state.interrupts.set(entityKey(interrupt.accountId, interrupt.id), interrupt);
  return interrupt;
}

describe("default application task service", () => {
  test("publishes out-of-band agent messages into a canonical conversation without creating a task", async () => {
    const { memory, service, first, second } = setup();
    const threadId = memory.threadId();
    const initial = await service.ensureConversation({
      principal: first.principal,
      threadId,
      metadata: { source: "calendar" },
    });
    const ensured = await service.ensureConversation({
      principal: first.principal,
      threadId,
      metadata: { "openbot.channel": "human", "openbot.agent-id": first.agentId },
    });
    expect(ensured.id).toBe(threadId);
    expect(ensured.metadata).toEqual({
      source: "calendar",
      "openbot.channel": "human",
      "openbot.agent-id": first.agentId,
    });
    expect(ensured.updatedAt).toBeGreaterThan(initial.updatedAt);
    expect(await service.ensureConversation({ principal: first.principal, threadId })).toEqual(ensured);
    await expectApplicationError(service.ensureConversation({
      principal: first.principal,
      threadId,
      metadata: { "openbot.agent-id": second.agentId },
    }), "conflict");
    await expectApplicationError(service.ensureConversation({
      principal: first.principal,
      threadId,
      metadata: { "openbot.channel": "a2a" },
    }), "conflict");

    const agentPrincipal: ProtocolPrincipal = {
      accountId: first.accountId,
      subjectId: `agent:${first.agentId}:notification`,
      kind: "agent",
      scopes: [TASKS_READ_SCOPE, TASKS_WRITE_SCOPE],
    };
    const deliveryId = memory.messageId();
    const sourceCreatedAt = memory.now();
    const delivery = {
      principal: agentPrincipal,
      agentId: first.agentId,
      threadId,
      messageId: deliveryId,
      createdAt: sourceCreatedAt,
      parts: [{ kind: "text", text: "proactive result" }],
      metadata: { "openbot.delivery": "proactive" },
    } as const;
    const message = await service.publishAgentMessage(delivery);
    expect(message).toMatchObject({
      accountId: first.accountId,
      threadId,
      taskId: null,
      runId: null,
      role: "agent",
      parts: [{ kind: "text", text: "proactive result" }],
      createdAt: sourceCreatedAt,
    });
    expect(await service.listConversationMessages(first.principal, threadId)).toEqual([message]);
    expect(await service.publishAgentMessage(delivery)).toEqual(message);
    await expectApplicationError(service.publishAgentMessage({
      ...delivery,
      createdAt: sourceCreatedAt + 1,
    }), "conflict");
    await expectApplicationError(service.publishAgentMessage({
      ...delivery,
      parts: [{ kind: "text", text: "different delivery" }],
    }), "conflict");
    expect(await service.listConversationMessages(first.principal, threadId)).toHaveLength(1);
    expect(memory.state.tasks.size).toBe(0);
    expect(memory.state.runs.size).toBe(0);
    await expectApplicationError(service.publishAgentMessage({
      principal: first.principal,
      agentId: first.agentId,
      threadId,
      parts: [{ kind: "text", text: "not an agent" }],
    }), "forbidden");
    await expectApplicationError(service.publishAgentMessage({
      ...delivery,
      principal: {
        ...agentPrincipal,
        subjectId: `agent:${second.agentId}:notification`,
      },
      messageId: memory.messageId(),
    }), "forbidden");

    const unboundThreadId = memory.threadId();
    await service.ensureConversation({ principal: first.principal, threadId: unboundThreadId });
    await expectApplicationError(service.publishAgentMessage({
      ...delivery,
      threadId: unboundThreadId,
      messageId: memory.messageId(),
    }), "forbidden");

    const nonHumanThreadId = memory.threadId();
    await service.ensureConversation({
      principal: first.principal,
      threadId: nonHumanThreadId,
      metadata: { "openbot.channel": "a2a", "openbot.agent-id": first.agentId },
    });
    await expectApplicationError(service.publishAgentMessage({
      ...delivery,
      threadId: nonHumanThreadId,
      messageId: memory.messageId(),
    }), "forbidden");

    const otherAgentThreadId = memory.threadId();
    await service.ensureConversation({
      principal: first.principal,
      threadId: otherAgentThreadId,
      metadata: { "openbot.channel": "human", "openbot.agent-id": second.agentId },
    });
    await expectApplicationError(service.publishAgentMessage({
      ...delivery,
      threadId: otherAgentThreadId,
      messageId: memory.messageId(),
    }), "forbidden");
    await expectApplicationError(service.listConversationMessages(second.principal, threadId), "not_found");
  });

  test("submission atomically persists canonical state, ordered events, outbox work, and external identities", async () => {
    const { memory, service, first } = setup();
    const refs = {
      thread: externalRef("thread", "thread-1"),
      task: externalRef("task", "task-1"),
      run: externalRef("run", "run-1"),
      message: externalRef("message", "message-1"),
    };
    const command = submitCommand(first, {
      externalRefs: refs,
      idempotencyKey: "submit-one",
      metadata: { source: "test" },
      message: {
        role: "tool",
        actionCallId: "call-1",
        parts: [{ kind: "data", data: { answer: 42 } }],
      },
    });

    const view = await service.submit(command);
    expect(view.task.accountId).toBe(first.accountId);
    expect(view.task.status).toBe("submitted");
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]!.status).toBe("queued");
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]!.metadata.action_call_id).toBe("call-1");
    expect(view.lastSeq).toBe(4);

    const events = eventsFor(memory, view.task);
    expect(events.map((event) => event.type)).toEqual([
      "task.status.changed",
      "run.status.changed",
      "message.started",
      "message.finished",
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(memory.state.outbox.map((record) => record.topic)).toEqual([
      TASK_EVENT_OUTBOX_TOPIC,
      TASK_EVENT_OUTBOX_TOPIC,
      TASK_EVENT_OUTBOX_TOPIC,
      TASK_EVENT_OUTBOX_TOPIC,
      RUN_QUEUED_OUTBOX_TOPIC,
    ]);
    expect(memory.state.outbox.at(-1)?.payload).toMatchObject({
      taskId: view.task.id,
      runId: view.runs[0]!.id,
      attempt: 1,
      continuationInterruptIds: [],
    });

    for (const ref of Object.values(refs)) {
      const binding = await service.resolve(first.principal, ref);
      expect(binding?.ref.externalId).toBe(ref.externalId);
    }
    expect((await service.get(first.principal, { externalRef: refs.run }))?.task.id).toBe(view.task.id);
  });

  test("idempotency is principal scoped, replays exactly, conflicts on changed input, and rolls back failures", async () => {
    const { memory, service, first } = setup();
    const command = submitCommand(first, { idempotencyKey: "stable-key" });
    const initial = await service.submit(command);
    const counts = {
      tasks: memory.state.tasks.size,
      runs: memory.state.runs.size,
      messages: memory.state.messages.size,
      events: eventsFor(memory, initial.task).length,
      outbox: memory.state.outbox.length,
    };

    const replay = await service.submit(structuredClone(command));
    expect(replay.task.id).toBe(initial.task.id);
    expect({
      tasks: memory.state.tasks.size,
      runs: memory.state.runs.size,
      messages: memory.state.messages.size,
      events: eventsFor(memory, initial.task).length,
      outbox: memory.state.outbox.length,
    }).toEqual(counts);
    await expectApplicationError(service.submit(submitCommand(first, {
      idempotencyKey: "stable-key",
      message: { role: "user", parts: [{ kind: "text", text: "changed" }] },
    })), "conflict");
    expect(memory.state.tasks.size).toBe(counts.tasks);

    const servicePrincipal: ProtocolPrincipal = { ...first.principal, kind: "service" };
    const independentlyScoped = await service.submit({ ...command, principal: servicePrincipal });
    expect(independentlyScoped.task.id).not.toBe(initial.task.id);

    const occupied = externalRef("task", "occupied-task");
    memory.transaction((tx) => tx.externalIdentities.bind(
      first.accountId,
      first.principal.subjectId,
      { ref: occupied, internalId: initial.task.id },
    ));
    const beforeFailure = structuredClone(memory.state);
    await expectApplicationError(service.submit(submitCommand(first, {
      externalRefs: { task: occupied },
    })), "conflict");
    expect(memory.state.tasks.size).toBe(beforeFailure.tasks.size);
    expect(memory.state.runs.size).toBe(beforeFailure.runs.size);
    expect(memory.state.messages.size).toBe(beforeFailure.messages.size);
    expect(memory.state.outbox).toEqual(beforeFailure.outbox);
  });

  test("authorization, tenant isolation, and attachment ownership are enforced in the application boundary", async () => {
    const { memory, service, first, second } = setup();
    const taskRef = externalRef("task", "tenant-task");
    const created = await service.submit(submitCommand(first, { externalRefs: { task: taskRef } }));

    expect(await service.get(second.principal, { taskId: created.task.id })).toBeNull();
    expect(await service.get(second.principal, { externalRef: taskRef })).toBeNull();
    await expectApplicationError(service.cancel(second.principal, { taskId: created.task.id }), "not_found");

    const noScopes: ProtocolPrincipal = { ...first.principal, scopes: [] };
    await expectApplicationError(service.get(noScopes, { taskId: created.task.id }), "forbidden");
    await expectApplicationError(service.submit(submitCommand(first, { principal: noScopes })), "forbidden");

    const attachment: AttachmentRef = {
      id: memory.attachmentId(),
      name: "private.txt",
      mediaType: "text/plain",
      size: 6,
      sha256: "a".repeat(64),
    };
    memory.state.attachments.set(entityKey(second.accountId, attachment.id), attachment);
    const taskCount = memory.state.tasks.size;
    await expectApplicationError(service.submit(submitCommand(first, {
      message: { role: "user", parts: [{ kind: "file", attachment }] },
    })), "not_found");
    expect(memory.state.tasks.size).toBe(taskCount);
  });

  test("external mappings reuse conversations and allocate stable principal-scoped response identities", async () => {
    const { service, first, second } = setup();
    const thread = externalRef("thread", "shared-context");
    const sharedTask = externalRef("task", "shared-task");
    const firstTask = await service.submit(submitCommand(first, { externalRefs: { thread, task: sharedTask } }));
    const secondTask = await service.submit(submitCommand(first, { externalRefs: { thread } }));
    expect(secondTask.task.threadId).toBe(firstTask.task.threadId);
    expect(secondTask.task.id).not.toBe(firstTask.task.id);

    const peerPrincipal: ProtocolPrincipal = { ...first.principal, subjectId: "peer-in-same-account" };
    const peerTask = await service.submit(submitCommand(first, {
      principal: peerPrincipal,
      externalRefs: { thread, task: sharedTask },
    }));
    expect(peerTask.task.threadId).not.toBe(firstTask.task.threadId);
    expect((await service.resolve(first.principal, sharedTask))?.internalId).toBe(firstTask.task.id);
    expect((await service.resolve(peerPrincipal, sharedTask))?.internalId).toBe(peerTask.task.id);

    const target = {
      protocol: "test-protocol",
      namespace: "responses",
      kind: "message" as const,
      internalId: firstTask.messages[0]!.id,
    };
    const allocated = await service.getOrCreate(first.principal, target);
    const repeated = await service.getOrCreate(first.principal, target);
    const peerAllocated = await service.getOrCreate(peerPrincipal, target);
    const peerRepeated = await service.getOrCreate(peerPrincipal, target);
    expect(repeated).toEqual(allocated);
    expect(peerRepeated).toEqual(peerAllocated);
    expect(peerAllocated.ref.externalId).not.toBe(allocated.ref.externalId);
    expect(await service.resolve(first.principal, allocated.ref)).toEqual(allocated);
    expect(await service.resolve(peerPrincipal, peerAllocated.ref)).toEqual(peerAllocated);
    expect(await service.resolve(peerPrincipal, allocated.ref)).toBeNull();
    expect(await service.resolve(second.principal, allocated.ref)).toBeNull();
    await expectApplicationError(service.getOrCreate(second.principal, target), "not_found");
    expect((await service.get(first.principal, { runId: firstTask.runs[0]!.id }))?.task.id).toBe(firstTask.task.id);
  });

  test("TaskView histories and every aggregate collection are bounded to newest canonical values", async () => {
    const { memory, service, first } = setup();
    const created = await service.submit(submitCommand(first));
    const task = created.task;
    const initialRun = created.runs[0]!;

    for (let index = 0; index < MAX_TASK_HISTORY_LENGTH + 20; index += 1) {
      const message: Message = {
        id: memory.messageId(),
        accountId: task.accountId,
        threadId: task.threadId,
        taskId: task.id,
        runId: initialRun.id,
        role: "agent",
        parts: [{ kind: "text", text: `message-${index}` }],
        createdAt: 2_000_000_000_000 + index,
        metadata: {},
      };
      memory.state.messages.set(entityKey(task.accountId, message.id), message);
    }
    for (let index = 0; index < MAX_TASK_VIEW_RUNS + 5; index += 1) {
      const run: Run = {
        ...initialRun,
        id: memory.runId(),
        attempt: index + 2,
        status: "completed",
        createdAt: 2_100_000_000_000 + index,
        startedAt: 2_100_000_000_000 + index,
        finishedAt: 2_100_000_000_001 + index,
      };
      memory.state.runs.set(entityKey(task.accountId, run.id), run);
    }
    for (let index = 0; index < MAX_TASK_VIEW_ARTIFACTS + 5; index += 1) {
      const artifact: Artifact = {
        id: memory.artifactId(),
        accountId: task.accountId,
        taskId: task.id,
        name: `artifact-${index}`,
        description: null,
        parts: [],
        createdAt: 2_200_000_000_000 + index,
        updatedAt: 2_200_000_000_000 + index,
        metadata: {},
      };
      memory.state.artifacts.set(entityKey(task.accountId, artifact.id), artifact);
    }
    for (let index = 0; index < MAX_TASK_VIEW_INTERRUPTS + 5; index += 1) {
      const interrupt: Interrupt = {
        id: memory.interruptId(),
        accountId: task.accountId,
        taskId: task.id,
        runId: initialRun.id,
        kind: "input",
        prompt: `prompt-${index}`,
        responseSchema: { type: "boolean" },
        status: "resolved",
        response: true,
        createdAt: 2_300_000_000_000 + index,
        expiresAt: null,
        resolvedAt: 2_300_000_000_001 + index,
        metadata: {},
      };
      memory.state.interrupts.set(entityKey(task.accountId, interrupt.id), interrupt);
    }

    const view = await service.get(first.principal, { taskId: task.id }, { historyLength: 50_000 });
    expect(view?.messages).toHaveLength(MAX_TASK_HISTORY_LENGTH);
    expect(view?.runs).toHaveLength(MAX_TASK_VIEW_RUNS);
    expect(view?.artifacts).toHaveLength(MAX_TASK_VIEW_ARTIFACTS);
    expect(view?.interrupts).toHaveLength(MAX_TASK_VIEW_INTERRUPTS);
    expect((view?.messages[0]?.parts[0] as { text: string }).text).toBe("message-20");
    expect((await service.get(first.principal, { taskId: task.id }, { historyLength: 0 }))?.messages).toEqual([]);
  });

  test("cancel closes active execution, emits ordered durable events once, and is idempotent", async () => {
    const { memory, service, first } = setup();
    const runRef = externalRef("run", "cancel-run");
    const created = await service.submit(submitCommand(first, { externalRefs: { run: runRef } }));
    const firstInterrupt = seedInterrupt(memory, created.task, created.runs[0]!, "input");
    const secondInterrupt = seedInterrupt(memory, created.task, created.runs[0]!, "auth");
    const alreadyResolved = seedInterrupt(memory, created.task, created.runs[0]!, "permission");
    memory.state.interrupts.set(entityKey(first.accountId, alreadyResolved.id), {
      ...alreadyResolved,
      status: "resolved",
      response: true,
      resolvedAt: memory.now(),
    });
    const eventCountBeforeCancel = eventsFor(memory, created.task).length;
    const canceled = await service.cancel(first.principal, { externalRef: runRef }, "stop");
    expect(canceled.task.status).toBe("canceled");
    expect(canceled.runs[0]!.status).toBe("canceled");
    expect(canceled.interrupts.find((interrupt) => interrupt.id === firstInterrupt.id)?.status).toBe("canceled");
    expect(canceled.interrupts.find((interrupt) => interrupt.id === secondInterrupt.id)?.status).toBe("canceled");
    expect(canceled.interrupts.find((interrupt) => interrupt.id === alreadyResolved.id)?.status).toBe("resolved");
    expect(eventsFor(memory, canceled.task).slice(eventCountBeforeCancel).map((event) => event.type)).toEqual([
      "interrupt.resolved",
      "interrupt.resolved",
      "run.status.changed",
      "task.status.changed",
    ]);
    expect(memory.state.outbox.filter((record) => record.topic === RUN_CANCEL_OUTBOX_TOPIC)).toHaveLength(1);

    const eventCount = eventsFor(memory, canceled.task).length;
    const outboxCount = memory.state.outbox.length;
    const repeated = await service.cancel(first.principal, { taskId: canceled.task.id }, "different reason");
    expect(repeated.task.status).toBe("canceled");
    expect(eventsFor(memory, canceled.task)).toHaveLength(eventCount);
    expect(memory.state.outbox).toHaveLength(outboxCount);
  });

  test("interrupt responses validate schemas and repeated identical resolutions do not duplicate events", async () => {
    const { memory, service, first } = setup();
    const created = await service.submit(submitCommand(first));
    forceInputRequired(memory, created.task, created.runs[0]!);
    const interrupt = seedInterrupt(memory, created.task, created.runs[0]!, "input", { type: "boolean" });
    const binding = await service.getOrCreate(first.principal, {
      protocol: "test-protocol",
      namespace: "interrupts",
      kind: "interrupt",
      internalId: interrupt.id,
    });

    const eventCount = eventsFor(memory, created.task).length;
    await expectApplicationError(service.resolveInterrupt(first.principal, { externalRef: binding.ref }, "yes"), "invalid_argument");
    expect(eventsFor(memory, created.task)).toHaveLength(eventCount);
    expect(memory.state.interrupts.get(entityKey(first.accountId, interrupt.id))?.status).toBe("open");

    const resolved = await service.resolveInterrupt(first.principal, { externalRef: binding.ref }, true);
    expect(resolved.status).toBe("resolved");
    expect(resolved.response).toBe(true);
    expect(eventsFor(memory, created.task).at(-1)?.type).toBe("interrupt.resolved");
    const resolvedEventCount = eventsFor(memory, created.task).length;
    expect((await service.resolveInterrupt(first.principal, { interruptId: interrupt.id }, true)).id).toBe(interrupt.id);
    expect(eventsFor(memory, created.task)).toHaveLength(resolvedEventCount);
    await expectApplicationError(service.resolveInterrupt(first.principal, { interruptId: interrupt.id }, false), "conflict");
  });

  test("resume atomically resolves the complete interrupt set, queues a new run, binds IDs, and replays idempotently", async () => {
    const { memory, service, first } = setup();
    const created = await service.submit(submitCommand(first));
    const priorRun = created.runs[0]!;
    forceInputRequired(memory, created.task, priorRun);
    const firstInterrupt = seedInterrupt(memory, created.task, priorRun, "input", { type: "boolean" });
    const secondInterrupt = seedInterrupt(memory, created.task, priorRun, "permission", { type: "string" });
    const eventCount = eventsFor(memory, created.task).length;

    await expectApplicationError(service.resume({
      principal: first.principal,
      task: { taskId: created.task.id },
      responses: [{ interrupt: { interruptId: firstInterrupt.id }, status: "resolved", response: true }],
      message: { role: "user", parts: [{ kind: "text", text: "continue" }] },
    }), "conflict");
    expect(eventsFor(memory, created.task)).toHaveLength(eventCount);
    expect(memory.state.interrupts.get(entityKey(first.accountId, firstInterrupt.id))?.status).toBe("open");
    expect(memory.state.runs.size).toBe(1);

    const externalRun = externalRef("run", "resumed-run");
    const externalMessage = externalRef("message", "resumed-message");
    const command = {
      principal: first.principal,
      task: { taskId: created.task.id },
      externalRun,
      externalMessage,
      responses: [
        { interrupt: { interruptId: firstInterrupt.id }, status: "resolved" as const, response: true },
        { interrupt: { interruptId: secondInterrupt.id }, status: "canceled" as const },
      ],
      message: { role: "user" as const, parts: [{ kind: "text" as const, text: "continue" }] },
      idempotencyKey: "resume-key",
    };
    const resumed = await service.resume(command);
    expect(resumed.task.status).toBe("working");
    expect(resumed.runs).toHaveLength(2);
    expect(resumed.runs.at(-1)).toMatchObject({ attempt: 2, status: "queued" });
    expect(resumed.messages).toHaveLength(2);
    expect(resumed.interrupts.map((interrupt) => interrupt.status)).toEqual(["resolved", "canceled"]);
    expect(eventsFor(memory, resumed.task).slice(eventCount).map((event) => event.type)).toEqual([
      "interrupt.resolved",
      "interrupt.resolved",
      "task.status.changed",
      "run.status.changed",
      "message.started",
      "message.finished",
    ]);
    expect((await service.resolve(first.principal, externalRun))?.internalId).toBe(resumed.runs.at(-1)!.id);
    expect((await service.resolve(first.principal, externalMessage))?.internalId).toBe(resumed.messages.at(-1)!.id);
    expect(memory.state.outbox.at(-1)?.topic).toBe(RUN_QUEUED_OUTBOX_TOPIC);
    expect(memory.state.outbox.at(-1)?.payload.continuationInterruptIds).toEqual([
      firstInterrupt.id,
      secondInterrupt.id,
    ]);

    const finalEventCount = eventsFor(memory, resumed.task).length;
    const finalOutboxCount = memory.state.outbox.length;
    expect((await service.resume(structuredClone(command))).runs.at(-1)!.id).toBe(resumed.runs.at(-1)!.id);
    expect(eventsFor(memory, resumed.task)).toHaveLength(finalEventCount);
    expect(memory.state.outbox).toHaveLength(finalOutboxCount);
    await expectApplicationError(service.resume({
      ...command,
      responses: [
        { interrupt: { interruptId: firstInterrupt.id }, status: "resolved", response: false },
        { interrupt: { interruptId: secondInterrupt.id }, status: "canceled" },
      ],
    }), "conflict");
  });

  test("continue handles free-form input only from input-required and cancels superseded input interrupts", async () => {
    const { memory, service, first } = setup();
    const created = await service.submit(submitCommand(first));
    const priorRun = created.runs[0]!;
    forceInputRequired(memory, created.task, priorRun);
    const input = seedInterrupt(memory, created.task, priorRun, "input");
    const permission = seedInterrupt(memory, created.task, priorRun, "permission");
    const eventCount = eventsFor(memory, created.task).length;
    const externalRun = externalRef("run", "continued-run");
    const externalMessage = externalRef("message", "continued-message");
    const command = {
      principal: first.principal,
      task: { taskId: created.task.id },
      externalRun,
      externalMessage,
      message: { role: "user" as const, parts: [{ kind: "text" as const, text: "free-form answer" }] },
      idempotencyKey: "continue-key",
    };

    const continued = await service.continue(command);
    expect(continued.task.status).toBe("working");
    expect(continued.runs.at(-1)).toMatchObject({ attempt: 2, status: "queued" });
    expect(continued.messages.at(-1)?.parts).toEqual([{ kind: "text", text: "free-form answer" }]);
    expect(memory.state.interrupts.get(entityKey(first.accountId, input.id))?.status).toBe("canceled");
    expect(memory.state.interrupts.get(entityKey(first.accountId, permission.id))?.status).toBe("open");
    expect(eventsFor(memory, continued.task).slice(eventCount).map((event) => event.type)).toEqual([
      "interrupt.resolved",
      "task.status.changed",
      "run.status.changed",
      "message.started",
      "message.finished",
    ]);
    expect((await service.resolve(first.principal, externalRun))?.internalId).toBe(continued.runs.at(-1)!.id);
    expect((await service.resolve(first.principal, externalMessage))?.internalId).toBe(continued.messages.at(-1)!.id);
    expect(memory.state.outbox.at(-1)?.payload.continuationInterruptIds).toEqual([input.id]);

    const finalEvents = eventsFor(memory, continued.task).length;
    expect((await service.continue(structuredClone(command))).task.id).toBe(continued.task.id);
    expect(eventsFor(memory, continued.task)).toHaveLength(finalEvents);

    await expectApplicationError(service.cancel(first.principal, { runId: priorRun.id }), "conflict");
    expect((await service.get(first.principal, { taskId: continued.task.id }))?.task.status).toBe("working");
    const terminal = await service.cancel(first.principal, { externalRef: externalRun });
    await expectApplicationError(service.continue({ ...command, idempotencyKey: "new-key" }), "conflict");
    expect(terminal.task.status).toBe("canceled");
  });

  test("coordinator transitions and artifact writes use the same canonical event/outbox transaction", async () => {
    const { memory, service, first } = setup();
    const created = await service.submit(submitCommand(first));
    const working = await service.transition(first.accountId, created.task.id, "submitted", "working");
    expect(working.status).toBe("working");
    const afterTransition = eventsFor(memory, created.task).length;
    expect((await service.transition(first.accountId, created.task.id, "submitted", "working")).status).toBe("working");
    expect(eventsFor(memory, created.task)).toHaveLength(afterTransition);

    const artifact: Artifact = {
      id: memory.artifactId(),
      accountId: first.accountId,
      taskId: created.task.id,
      name: "result",
      description: null,
      parts: [{ kind: "text", text: "done" }],
      createdAt: memory.now(),
      updatedAt: memory.now(),
      metadata: {},
    };
    expect((await service.addArtifact(artifact)).id).toBe(artifact.id);
    expect(eventsFor(memory, created.task).at(-1)?.type).toBe("artifact.updated");
    expect(memory.state.outbox.at(-1)?.topic).toBe(TASK_EVENT_OUTBOX_TOPIC);

    await service.transition(first.accountId, created.task.id, "working", "completed");
    await expectApplicationError(service.addArtifact({ ...artifact, updatedAt: memory.now() }), "conflict");
  });

  test("list and subscribe remain tenant scoped, bounded, and gap-free", async () => {
    const { service, first, second } = setup();
    const created = await service.submit(submitCommand(first));
    await service.submit(submitCommand(second));
    const query: ListTasksQuery = { principal: first.principal, limit: 10, statuses: ["submitted"] };
    const page = await service.list(query);
    expect(page.items).toHaveLength(1);
    expect(page.totalSize).toBe(1);
    expect(page.items[0]!.accountId).toBe(first.accountId);
    expect((await service.list({ ...query, updatedAfter: page.items[0]!.updatedAt })).totalSize).toBe(0);

    const streamed: TaskEventEnvelope[] = [];
    for await (const event of service.subscribe(first.principal, { taskId: created.task.id }, 0)) streamed.push(event);
    expect(streamed.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(await service.get(second.principal, { taskId: created.task.id })).toBeNull();
  });
});
