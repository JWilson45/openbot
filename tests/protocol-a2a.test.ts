import { describe, expect, test } from "bun:test";
import type {
  AgentTaskPort,
  AttachmentImport,
  AttachmentPort,
  ContinueTaskCommand,
  ExternalEntityRef,
  ExternalIdentityBinding,
  ExternalIdentityPort,
  ExternalIdentityTarget,
  ListTasksQuery,
  ProtocolPrincipal,
  SubmitTaskCommand,
  TaskRef,
  TaskView,
} from "@openbot/application";
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
  type Artifact,
  type ContentPart,
  type Interrupt,
  type TaskEventEnvelope,
  type TaskStatus,
} from "@openbot/core";
import {
  AgentCard,
  Role,
  SendMessageRequest as SendMessageRequestCodec,
  TaskState,
  type AgentCard as AgentCardType,
  type Message,
  type SendMessageRequest,
  type StreamResponse,
} from "@a2a-js/sdk";
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  type Client,
} from "@a2a-js/sdk/client";
import {
  A2A_AGENT_CARD_PATH,
  A2A_RPC_PATH,
  A2A_VERSION,
  createA2AHandler,
  createA2AOutboundClient,
  type A2AHandler,
  type A2AResolvedTarget,
} from "@openbot/protocol-a2a";

const ACCOUNT_ID = accountIdSchema.parse("00000000-0000-4000-8000-000000000001");
const AGENT_ID = agentIdSchema.parse("00000000-0000-4000-8000-000000000002");
const THREAD_ID = threadIdSchema.parse("00000000-0000-4000-8000-000000000003");
const TASK_ID = taskIdSchema.parse("00000000-0000-4000-8000-000000000004");
const RUN_ID = runIdSchema.parse("00000000-0000-4000-8000-000000000005");
const MESSAGE_ID = messageIdSchema.parse("00000000-0000-4000-8000-000000000006");
const ARTIFACT_ID = artifactIdSchema.parse("00000000-0000-4000-8000-000000000007");
const ATTACHMENT_ID = attachmentIdSchema.parse("00000000-0000-4000-8000-000000000008");
const INTERRUPT_ID = interruptIdSchema.parse("00000000-0000-4000-8000-000000000009");

const principal: ProtocolPrincipal = {
  accountId: ACCOUNT_ID,
  subjectId: "caller",
  kind: "agent",
  scopes: ["tasks:read", "tasks:write"],
};

const card: AgentCardType = {
  name: "OpenBot test agent",
  description: "A protocol adapter test agent",
  supportedInterfaces: [{
    url: `https://agent.test${A2A_RPC_PATH}`,
    protocolBinding: "JSONRPC",
    tenant: "",
    protocolVersion: A2A_VERSION,
  }],
  provider: undefined,
  version: "1.0.0",
  documentationUrl: undefined,
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extensions: [],
    extendedAgentCard: false,
  },
  securitySchemes: {
    bearer: {
      scheme: {
        $case: "httpAuthSecurityScheme",
        value: {
          description: "Test bearer token",
          scheme: "Bearer",
          bearerFormat: "JWT",
        },
      },
    },
  },
  securityRequirements: [{ schemes: { bearer: { list: [] } } }],
  defaultInputModes: ["text/plain", "application/octet-stream", "application/json"],
  defaultOutputModes: ["text/plain", "application/json", "application/octet-stream"],
  skills: [{
    id: "chat",
    name: "Chat",
    description: "Respond to a user message",
    tags: ["chat"],
    examples: ["Hello"],
    inputModes: [],
    outputModes: [],
    securityRequirements: [],
  }],
  signatures: [],
  iconUrl: undefined,
};

function keyForRef(subjectId: string, ref: ExternalEntityRef): string {
  return `${subjectId}:${ref.protocol}:${ref.namespace}:${ref.kind}:${ref.externalId}`;
}

function keyForTarget(subjectId: string, target: ExternalIdentityTarget): string {
  return `${subjectId}:${target.protocol}:${target.namespace}:${target.kind}:${target.internalId}`;
}

class MemoryIdentities implements ExternalIdentityPort {
  readonly #byRef = new Map<string, ExternalIdentityBinding>();
  readonly #byTarget = new Map<string, ExternalIdentityBinding>();
  #next = 1;

  bind(
    ref: ExternalEntityRef,
    internalId: ExternalIdentityBinding["internalId"],
    subjectId = principal.subjectId,
  ): void {
    const binding = { ref, internalId } as ExternalIdentityBinding;
    this.#byRef.set(keyForRef(subjectId, ref), binding);
    this.#byTarget.set(keyForTarget(subjectId, {
      protocol: ref.protocol,
      namespace: ref.namespace,
      kind: ref.kind,
      internalId,
    } as ExternalIdentityTarget), binding);
  }

  async resolve(
    scopedPrincipal: ProtocolPrincipal,
    ref: ExternalEntityRef,
  ): Promise<ExternalIdentityBinding | null> {
    return this.#byRef.get(keyForRef(scopedPrincipal.subjectId, ref)) ?? null;
  }

  async getOrCreate(
    scopedPrincipal: ProtocolPrincipal,
    target: ExternalIdentityTarget,
  ): Promise<ExternalIdentityBinding> {
    const subjectId = scopedPrincipal.subjectId;
    const existing = this.#byTarget.get(keyForTarget(subjectId, target));
    if (existing) return existing;
    const externalId = externalIdSchema.parse(`external-${target.kind}-${this.#next++}`);
    const ref = {
      protocol: target.protocol,
      namespace: target.namespace,
      kind: target.kind,
      externalId,
    } as ExternalEntityRef;
    this.bind(ref, target.internalId, subjectId);
    return this.#byRef.get(keyForRef(subjectId, ref))!;
  }
}

function artifact(parts: readonly ContentPart[] = [{ kind: "text", text: "answer" }]): Artifact {
  return {
    id: ARTIFACT_ID,
    accountId: ACCOUNT_ID,
    taskId: TASK_ID,
    name: "result",
    description: "Agent result",
    parts: [...parts],
    createdAt: 1_002,
    updatedAt: 1_003,
    metadata: { source: "test" },
  };
}

function interrupt(): Interrupt {
  return {
    id: INTERRUPT_ID,
    accountId: ACCOUNT_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    kind: "input",
    prompt: "Which region?",
    responseSchema: { type: "string" },
    status: "open",
    createdAt: 1_010,
    expiresAt: null,
    resolvedAt: null,
    metadata: {},
  };
}

function makeView(
  status: TaskStatus = "submitted",
  options: {
    parts?: readonly ContentPart[];
    artifacts?: readonly Artifact[];
    interrupts?: readonly Interrupt[];
    lastSeq?: number;
  } = {},
): TaskView {
  const parts = options.parts ?? [{ kind: "text", text: "hello" }];
  return {
    task: {
      id: TASK_ID,
      accountId: ACCOUNT_ID,
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      status,
      createdAt: 1_000,
      updatedAt: 1_020,
      metadata: { channel: "test" },
    },
    runs: [{
      id: RUN_ID,
      accountId: ACCOUNT_ID,
      taskId: TASK_ID,
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      attempt: 1,
      status: status === "submitted" ? "queued" : status === "working" ? "running" : "completed",
      providerSessionRef: null,
      createdAt: 1_000,
      startedAt: null,
      finishedAt: null,
      metadata: {},
    }],
    messages: [{
      id: MESSAGE_ID,
      accountId: ACCOUNT_ID,
      threadId: THREAD_ID,
      taskId: TASK_ID,
      runId: RUN_ID,
      role: "user",
      parts: [...parts],
      createdAt: 1_001,
      metadata: {},
    }],
    artifacts: [...(options.artifacts ?? [])],
    interrupts: [...(options.interrupts ?? [])],
    lastSeq: options.lastSeq ?? 4,
  };
}

function event(
  seq: number,
  type: TaskEventEnvelope["type"],
  data: TaskEventEnvelope["data"],
  runId: typeof RUN_ID | null = null,
): TaskEventEnvelope {
  return taskEventEnvelopeSchema.parse({
    version: 1,
    eventId: eventIdSchema.parse(`00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`),
    accountId: ACCOUNT_ID,
    taskId: TASK_ID,
    runId,
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    seq,
    time: 2_000 + seq,
    type,
    data,
    metadata: {},
  });
}

class Fixture {
  readonly identities = new MemoryIdentities();
  readonly submitCalls: SubmitTaskCommand[] = [];
  readonly continueCalls: ContinueTaskCommand[] = [];
  readonly listCalls: ListTasksQuery[] = [];
  readonly subscriptions: number[] = [];
  readonly imports: AttachmentImport[] = [];
  readonly attachmentSignals: Array<AbortSignal | undefined> = [];
  readonly submitSignals: Array<AbortSignal | undefined> = [];
  readonly subscriptionSignals: Array<AbortSignal | undefined> = [];
  events: TaskEventEnvelope[] = [];
  current = makeView();

  readonly attachments: AttachmentPort = {
    import: async (_principal, input, signal) => {
      this.imports.push(input);
      this.attachmentSignals.push(signal);
      return {
        id: ATTACHMENT_ID,
        name: input.name ?? null,
        mediaType: input.mediaType,
        size: input.source.kind === "bytes" ? input.source.bytes.byteLength : 7,
        sha256: "a".repeat(64),
      };
    },
    open: async () => ({
      attachment: {
        id: ATTACHMENT_ID,
        name: "attachment.bin",
        mediaType: "application/octet-stream",
        size: 7,
        sha256: "a".repeat(64),
      },
      body: new ReadableStream<Uint8Array>(),
    }),
    createDownloadUrl: async (_principal, attachmentId, expiresAt) =>
      `https://downloads.test/${attachmentId}?expires=${expiresAt}`,
  };

  readonly tasks: AgentTaskPort = {
    submit: async (command, signal) => {
      this.submitCalls.push(command);
      this.submitSignals.push(signal);
      const existing = command.externalRefs?.message
        ? await this.identities.resolve(command.principal, command.externalRefs.message)
        : null;
      if (existing) return this.current;
      if (command.externalRefs?.thread) {
        this.identities.bind(command.externalRefs.thread, THREAD_ID, command.principal.subjectId);
      }
      if (command.externalRefs?.message) {
        this.identities.bind(command.externalRefs.message, MESSAGE_ID, command.principal.subjectId);
      }
      this.current = makeView("submitted", { parts: command.message.parts, lastSeq: 4 });
      return this.current;
    },
    get: async (_principal, ref, options) => {
      const internal = await this.resolveTask(ref);
      if (internal !== TASK_ID) return null;
      return {
        ...this.current,
        messages: options?.historyLength === 0
          ? []
          : options?.historyLength === undefined
            ? this.current.messages
            : this.current.messages.slice(-options.historyLength),
      };
    },
    list: async (query) => {
      this.listCalls.push(query);
      return { items: [this.current.task], totalSize: 1 };
    },
    cancel: async (_principal, ref) => {
      if (await this.resolveTask(ref) !== TASK_ID) {
        throw new ApplicationError("not_found", "missing");
      }
      this.current = { ...this.current, task: { ...this.current.task, status: "canceled" } };
      return this.current;
    },
    continue: async (command, signal) => {
      this.continueCalls.push(command);
      this.submitSignals.push(signal);
      const existing = command.externalMessage
        ? await this.identities.resolve(command.principal, command.externalMessage)
        : null;
      if (existing) return this.current;
      if (this.current.task.status !== "input_required") {
        throw new ApplicationError("conflict", "not input required");
      }
      this.identities.bind(command.externalMessage!, messageIdSchema.parse(
        "00000000-0000-4000-8000-000000000016",
      ), command.principal.subjectId);
      this.current = {
        ...this.current,
        task: { ...this.current.task, status: "working", updatedAt: 1_030 },
        interrupts: this.current.interrupts.map((value) => ({ ...value, status: "canceled" })),
        lastSeq: 14,
      };
      return this.current;
    },
    resume: async () => { throw new Error("not used"); },
    resolveInterrupt: async () => { throw new Error("not used"); },
    subscribe: (_principal, ref, afterSeq = 0, signal) => {
      this.subscriptions.push(afterSeq);
      this.subscriptionSignals.push(signal);
      const fixture = this;
      return (async function* () {
        if (await fixture.resolveTask(ref) !== TASK_ID) {
          throw new ApplicationError("not_found", "missing");
        }
        for (const item of fixture.events) {
          if (item.seq <= afterSeq) continue;
          if (item.type === "artifact.updated") {
            fixture.current = { ...fixture.current, artifacts: [item.data.artifact] };
          }
          if (item.type === "task.status.changed") {
            fixture.current = {
              ...fixture.current,
              task: { ...fixture.current.task, status: item.data.to, updatedAt: item.time },
            };
          }
          yield item;
        }
      })();
    },
  };

  async resolveTask(ref: TaskRef): Promise<typeof TASK_ID | null> {
    if ("taskId" in ref) return ref.taskId === TASK_ID ? TASK_ID : null;
    if ("runId" in ref) return ref.runId === RUN_ID ? TASK_ID : null;
    const binding = await this.identities.resolve(principal, ref.externalRef);
    return binding?.ref.kind === "task" && binding.internalId === TASK_ID ? TASK_ID : null;
  }
}

function createHandler(
  fixture: Fixture,
  resolvePrincipal: (request: Request) => ProtocolPrincipal | Promise<ProtocolPrincipal> = () => principal,
  options: { maxRequestBodyBytes?: number } = {},
): A2AHandler {
  return createA2AHandler({
    tasks: fixture.tasks,
    identities: fixture.identities,
    attachments: fixture.attachments,
    agentId: AGENT_ID,
    namespace: "https://agent.test/a2a/v1",
    agentCard: card,
    resolvePrincipal,
    now: () => 10_000,
    attachmentUrlTtlMs: 60_000,
    ...options,
  });
}

async function officialClient(handler: A2AHandler): Promise<{
  client: Client;
  requests: Request[];
}> {
  const requests: Request[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return handler.fetch(request);
  }) as typeof fetch;
  const resolver = new DefaultAgentCardResolver({ fetchImpl });
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    cardResolver: resolver,
  });
  return { client: await factory.createFromUrl("https://agent.test"), requests };
}

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: "client-message-1",
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts: [{
      content: { $case: "text", value: "hello" },
      metadata: undefined,
      filename: "",
      mediaType: "text/plain",
    }],
    metadata: { client: "official-sdk" },
    extensions: [],
    referenceTaskIds: [],
    ...overrides,
  };
}

function sendRequest(message = userMessage(), returnImmediately = true): SendMessageRequest {
  return {
    tenant: "",
    message,
    configuration: {
      acceptedOutputModes: ["text/plain"],
      taskPushNotificationConfig: undefined,
      historyLength: 10,
      returnImmediately,
    },
    metadata: { request: "metadata" },
  };
}

function resultTask(value: Awaited<ReturnType<Client["sendMessage"]>>) {
  if (!("id" in value)) throw new Error("expected a task");
  return value;
}

async function post(handler: A2AHandler, body: unknown, options: {
  version?: string;
  authorization?: string;
  contentType?: string;
} = {}): Promise<Response> {
  const headers = new Headers({
    "Content-Type": options.contentType ?? "application/json",
  });
  if (options.version !== undefined) headers.set("A2A-Version", options.version);
  if (options.authorization !== undefined) headers.set("Authorization", options.authorization);
  return handler.fetch(new Request(`https://agent.test${A2A_RPC_PATH}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

describe("A2A 1.0 protocol adapter", () => {
  test("official client discovers the card, submits idempotently, and never emits raw attachments", async () => {
    const fixture = new Fixture();
    let authCalls = 0;
    const handler = createHandler(fixture, (request) => {
      authCalls += 1;
      expect(request.headers.get("Authorization")).toBe("Bearer test");
      return principal;
    });
    const { client, requests } = await officialClient(handler);
    const message = userMessage({
      parts: [
        {
          content: { $case: "text", value: "analyze this" },
          metadata: undefined,
          filename: "",
          mediaType: "text/plain",
        },
        {
          content: { $case: "raw", value: Buffer.from("payload") },
          metadata: { source: "upload" },
          filename: "input.bin",
          mediaType: "application/octet-stream",
        },
      ],
    });
    const options = { serviceParameters: { Authorization: "Bearer test" } };

    const first = resultTask(await client.sendMessage(sendRequest(message), options));
    const replay = resultTask(await client.sendMessage(sendRequest(message), options));

    expect(first.id).toBe(replay.id);
    expect(first.id).not.toBe(TASK_ID);
    expect(first.contextId).not.toBe(THREAD_ID);
    expect(first.history[0]?.messageId).toBe(message.messageId);
    const file = first.history[0]?.parts[1];
    expect(file?.content?.$case).toBe("url");
    expect(file?.content?.value).toStartWith("https://downloads.test/");
    expect(fixture.imports).toHaveLength(2);
    expect(fixture.imports[0]?.source.kind).toBe("bytes");
    expect(fixture.imports[0]?.idempotencyKey).toBe(fixture.imports[1]?.idempotencyKey);
    expect(fixture.imports[0]?.idempotencyKey).toContain("client-message-1:1");
    expect(fixture.submitCalls).toHaveLength(2);
    expect(fixture.submitCalls.every((call) => call.idempotencyKey === message.messageId)).toBe(true);
    expect(String(fixture.submitCalls[0]?.externalRefs?.message?.externalId)).toBe(message.messageId);
    expect(fixture.submitSignals[0]).toBeInstanceOf(AbortSignal);
    expect(authCalls).toBe(2);
    expect(requests[0]?.url).toBe(`https://agent.test${A2A_AGENT_CARD_PATH}`);
    expect(requests.every((request) => request.headers.get("A2A-Version") === A2A_VERSION)).toBe(true);
  });

  test("authenticated peers receive independent mappings for the same A2A identity", async () => {
    const fixture = new Fixture();
    const secondPrincipal: ProtocolPrincipal = { ...principal, subjectId: "second-caller" };
    const handler = createHandler(fixture, (request) =>
      request.headers.get("Authorization") === "Bearer second" ? secondPrincipal : principal
    );
    const { client } = await officialClient(handler);
    const message = userMessage({ messageId: "shared-peer-message" });

    const first = resultTask(await client.sendMessage(sendRequest(message), {
      serviceParameters: { Authorization: "Bearer first" },
    }));
    const messageRef = {
      protocol: "a2a",
      namespace: "https://agent.test/a2a/v1",
      kind: "message" as const,
      externalId: externalIdSchema.parse(message.messageId),
    };
    expect(await fixture.identities.resolve(secondPrincipal, messageRef)).toBeNull();

    const second = resultTask(await client.sendMessage(sendRequest(message), {
      serviceParameters: { Authorization: "Bearer second" },
    }));
    expect(first.id).not.toBe(second.id);
    expect((await fixture.identities.resolve(principal, messageRef))?.internalId).toBe(MESSAGE_ID);
    expect((await fixture.identities.resolve(secondPrincipal, messageRef))?.internalId).toBe(MESSAGE_ID);
  });

  test("official streaming client receives Task, status, artifact, and terminal events", async () => {
    const fixture = new Fixture();
    const resultArtifact = artifact([{
      kind: "file",
      attachment: {
        id: ATTACHMENT_ID,
        name: "result.bin",
        mediaType: "application/octet-stream",
        size: 7,
        sha256: "b".repeat(64),
      },
    }]);
    fixture.events = [
      event(5, "task.status.changed", { from: "submitted", to: "working" }),
      event(6, "artifact.updated", { artifact: resultArtifact }),
      event(7, "task.status.changed", { from: "working", to: "completed" }),
    ];
    const { client } = await officialClient(createHandler(fixture));
    const received: StreamResponse[] = [];

    for await (const item of client.sendMessageStream(sendRequest(userMessage(), false))) {
      received.push(item);
    }

    expect(received.map((item) => item.payload?.$case)).toEqual([
      "task",
      "statusUpdate",
      "artifactUpdate",
      "statusUpdate",
    ]);
    const working = received[1]?.payload;
    expect(working?.$case).toBe("statusUpdate");
    if (working?.$case === "statusUpdate") {
      expect(working.value.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    }
    const artifactEvent = received[2]?.payload?.value;
    expect("artifact" in (artifactEvent ?? {})).toBe(true);
    if (artifactEvent && "artifact" in artifactEvent) {
      expect(artifactEvent.artifact?.parts[0]?.content?.$case).toBe("url");
    }
    const completed = received.at(-1)?.payload;
    expect(completed?.$case).toBe("statusUpdate");
    if (completed?.$case === "statusUpdate") {
      expect(completed.value.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    }
    expect(fixture.subscriptions).toEqual([4]);
    expect(fixture.subscriptionSignals[0]).toBeInstanceOf(AbortSignal);
  });

  test("get, input-required follow-up, list, and cancel preserve mapped task identity", async () => {
    const fixture = new Fixture();
    const { client } = await officialClient(createHandler(fixture));
    const initial = resultTask(await client.sendMessage(sendRequest()));
    fixture.current = makeView("input_required", { interrupts: [interrupt()], lastSeq: 10 });

    const waiting = await client.getTask({ tenant: "", id: initial.id, historyLength: 0 });
    expect(waiting.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(waiting.status?.message?.parts[0]?.content?.value).toBe("Which region?");
    expect(waiting.history).toEqual([]);

    const followUp = resultTask(await client.sendMessage(sendRequest(userMessage({
      messageId: "client-message-2",
      taskId: initial.id,
      contextId: initial.contextId,
      parts: [{
        content: { $case: "text", value: "us-east" },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      }],
    }))));
    expect(followUp.id).toBe(initial.id);
    expect(fixture.continueCalls).toHaveLength(1);
    expect(String(fixture.continueCalls[0]?.externalMessage?.externalId)).toBe("client-message-2");
    expect(fixture.continueCalls[0]?.message.metadata?.["a2a.request"]).toEqual({ request: "metadata" });

    const followUpReplay = resultTask(await client.sendMessage(sendRequest(userMessage({
      messageId: "client-message-2",
      taskId: initial.id,
      contextId: initial.contextId,
      parts: [{
        content: { $case: "text", value: "us-east" },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      }],
    }))));
    expect(followUpReplay.id).toBe(initial.id);
    expect(fixture.continueCalls).toHaveLength(2);

    const after = new Date(1_000).toISOString();
    const listed = await client.listTasks({
      tenant: "",
      contextId: initial.contextId,
      status: TaskState.TASK_STATE_WORKING,
      pageSize: 25,
      pageToken: "",
      historyLength: 0,
      statusTimestampAfter: after,
      includeArtifacts: false,
    });
    expect(listed.totalSize).toBe(1);
    expect(listed.tasks[0]?.id).toBe(initial.id);
    expect(fixture.listCalls[0]).toMatchObject({
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      statuses: ["working"],
      limit: 25,
      updatedAfter: 1_000,
    });

    const canceled = await client.cancelTask({ tenant: "", id: initial.id, metadata: { reason: "done" } });
    expect(canceled.id).toBe(initial.id);
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  test("resubscription replays committed canonical events from zero with stable IDs", async () => {
    const fixture = new Fixture();
    fixture.current = makeView("completed", { artifacts: [artifact()], lastSeq: 3 });
    const taskBinding = await fixture.identities.getOrCreate(principal, {
      protocol: "a2a",
      namespace: "https://agent.test/a2a/v1",
      kind: "task",
      internalId: TASK_ID,
    });
    await fixture.identities.getOrCreate(principal, {
      protocol: "a2a",
      namespace: "https://agent.test/a2a/v1",
      kind: "thread",
      internalId: THREAD_ID,
    });
    fixture.events = [
      event(1, "task.status.changed", { from: null, to: "submitted" }),
      event(2, "artifact.updated", { artifact: artifact() }),
      event(3, "task.status.changed", { from: "working", to: "completed" }),
    ];
    const { client } = await officialClient(createHandler(fixture));
    const received: StreamResponse[] = [];

    for await (const item of client.resubscribeTask({ tenant: "", id: taskBinding.ref.externalId })) {
      received.push(item);
    }

    expect(fixture.subscriptions).toEqual([0]);
    expect(received.map((item) => item.payload?.$case)).toEqual([
      "task",
      "artifactUpdate",
      "statusUpdate",
    ]);
    const initial = received[0]?.payload;
    expect(initial?.$case).toBe("task");
    if (initial?.$case === "task") {
      expect(initial.value.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    }
    const completed = received.at(-1)?.payload;
    expect(completed?.$case).toBe("statusUpdate");
    if (completed?.$case === "statusUpdate") {
      expect(completed.value.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    }
    expect(received.every((item) => {
      const value = item.payload?.value;
      return !value || !("taskId" in value) || value.taskId === taskBinding.ref.externalId;
    })).toBe(true);
  });

  test("rejects wrong versions, unauthenticated calls, wrong method casing, and unknown tasks before work", async () => {
    const fixture = new Fixture();
    let authCalls = 0;
    const handler = createHandler(fixture, (request) => {
      authCalls += 1;
      if (request.headers.get("Authorization") !== "Bearer test") {
        throw new ApplicationError("unauthenticated", "missing bearer token");
      }
      return principal;
    });
    const envelope = { jsonrpc: "2.0", id: 7, method: "GetTask", params: { id: "missing" } };

    const missingVersion = await post(handler, envelope, { authorization: "Bearer test" });
    expect((await missingVersion.json() as any).error.code).toBe(-32009);
    expect(authCalls).toBe(0);

    const unauthenticated = await post(handler, envelope, { version: A2A_VERSION });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("WWW-Authenticate")).toBe("Bearer");

    const wrongCase = await post(handler, { ...envelope, method: "getTask" }, {
      version: A2A_VERSION,
      authorization: "Bearer test",
    });
    expect((await wrongCase.json() as any).error.code).toBe(-32601);

    const unknown = await post(handler, envelope, {
      version: A2A_VERSION,
      authorization: "Bearer test",
    });
    expect((await unknown.json() as any).error.code).toBe(-32001);
    expect(fixture.submitCalls).toHaveLength(0);

    const wrongContent = await post(handler, envelope, {
      version: A2A_VERSION,
      authorization: "Bearer test",
      contentType: "application/a2a+json",
    });
    expect(wrongContent.status).toBe(400);
    expect((await wrongContent.json() as any).error.code).toBe(-32005);

    const malformed = await post(handler, "{", {
      version: A2A_VERSION,
      authorization: "Bearer test",
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json() as any).error.code).toBe(-32700);
  });

  test("maps invalid follow-up and cancellation states to native A2A errors", async () => {
    const fixture = new Fixture();
    const handler = createHandler(fixture);
    const taskBinding = await fixture.identities.getOrCreate(principal, {
      protocol: "a2a",
      namespace: "https://agent.test/a2a/v1",
      kind: "task",
      internalId: TASK_ID,
    });
    const contextBinding = await fixture.identities.getOrCreate(principal, {
      protocol: "a2a",
      namespace: "https://agent.test/a2a/v1",
      kind: "thread",
      internalId: THREAD_ID,
    });

    for (const status of ["working", "auth_required", "completed"] as const) {
      fixture.current = makeView(status);
      const params = SendMessageRequestCodec.toJSON(sendRequest(userMessage({
        messageId: `blocked-${status}`,
        taskId: taskBinding.ref.externalId,
        contextId: contextBinding.ref.externalId,
      })));
      const response = await post(handler, {
        jsonrpc: "2.0",
        id: status,
        method: "SendMessage",
        params,
      }, { version: A2A_VERSION });
      expect((await response.json() as any).error.code).toBe(-32004);
    }
    expect(fixture.continueCalls).toHaveLength(0);

    const cancel = await post(handler, {
      jsonrpc: "2.0",
      id: 10,
      method: "CancelTask",
      params: { id: taskBinding.ref.externalId },
    }, { version: A2A_VERSION });
    expect((await cancel.json() as any).error.code).toBe(-32002);
  });

  test("Agent Card is official-SDK serializable and requires the hard-cut version", async () => {
    const handler = createHandler(new Fixture());
    const wrong = await handler.fetch(new Request(`https://agent.test${A2A_AGENT_CARD_PATH}`));
    expect(wrong.status).toBe(400);

    const response = await handler.fetch(new Request(`https://agent.test${A2A_AGENT_CARD_PATH}`, {
      headers: { "A2A-Version": A2A_VERSION },
    }));
    expect(response.status).toBe(200);
    const parsed = AgentCard.fromJSON(await response.json());
    expect(parsed.supportedInterfaces).toEqual(card.supportedInterfaces);
    expect(parsed.capabilities?.streaming).toBe(true);
    expect(parsed.capabilities?.pushNotifications).toBe(false);
  });

  test("caps both declared and streamed JSON-RPC request bodies", async () => {
    const fixture = new Fixture();
    let authCalls = 0;
    const handler = createHandler(fixture, () => {
      authCalls += 1;
      return principal;
    }, { maxRequestBodyBytes: 128 });

    const declared = await handler.fetch(new Request(`https://agent.test${A2A_RPC_PATH}`, {
      method: "POST",
      headers: {
        "A2A-Version": A2A_VERSION,
        "Content-Type": "application/json",
        "Content-Length": "129",
      },
      body: "{}",
    }));
    expect(declared.status).toBe(413);
    expect(authCalls).toBe(0);

    const streamed = await post(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "GetTask",
      params: { id: "x".repeat(256) },
    }, { version: A2A_VERSION });
    expect(streamed.status).toBe(413);
    expect(authCalls).toBe(1);
    expect(fixture.submitCalls).toHaveLength(0);
  });

  test("outbound official client discovers and performs send, get, cancel, and stream", async () => {
    const fixture = new Fixture();
    const handler = createHandler(fixture, (request) => {
      expect(request.headers.get("Authorization")).toBe("Bearer outbound-secret");
      return principal;
    });
    const requests: Request[] = [];
    const targets: A2AResolvedTarget[] = [];
    let credentialCalls = 0;
    const outbound = await createA2AOutboundClient({
      baseUrl: "https://agent.test",
      resolveHostname: async (hostname) => {
        expect(hostname).toBe("agent.test");
        return ["93.184.216.34"];
      },
      pinnedFetch: async (request, target) => {
        requests.push(request.clone());
        targets.push(target);
        return handler.fetch(request);
      },
      resolveBearerCredential: async ({ agentCard, endpoint, signal }) => {
        credentialCalls += 1;
        expect(agentCard.name).toBe(card.name);
        expect(endpoint).toBe(`https://agent.test${A2A_RPC_PATH}`);
        expect(signal.aborted).toBe(false);
        return "outbound-secret";
      },
    });

    const sent = resultTask(await outbound.sendMessage(sendRequest()));
    const fetched = await outbound.getTask({ tenant: "", id: sent.id, historyLength: 0 });
    const canceled = await outbound.cancelTask({ tenant: "", id: sent.id, metadata: {} });
    expect(fetched.id).toBe(sent.id);
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);

    fixture.events = [
      event(5, "task.status.changed", { from: "submitted", to: "working" }),
      event(6, "task.status.changed", { from: "working", to: "completed" }),
    ];
    const streamed: StreamResponse[] = [];
    for await (const item of outbound.sendMessageStream(sendRequest(userMessage({
      messageId: "outbound-stream-message",
    }), false))) {
      streamed.push(item);
    }

    expect(streamed.map((item) => item.payload?.$case)).toEqual([
      "task",
      "statusUpdate",
      "statusUpdate",
    ]);
    expect(outbound.agentCard.supportedInterfaces).toHaveLength(1);
    expect(outbound.endpoint).toBe(`https://agent.test${A2A_RPC_PATH}`);
    expect(requests[0]?.url).toBe(`https://agent.test${A2A_AGENT_CARD_PATH}`);
    expect(requests[0]?.headers.get("Authorization")).toBeNull();
    expect(requests.slice(1).every((request) =>
      request.headers.get("Authorization") === "Bearer outbound-secret"
    )).toBe(true);
    expect(requests.every((request) => request.headers.get("A2A-Version") === A2A_VERSION)).toBe(true);
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
    expect(targets.every((target) =>
      target.hostname === "agent.test" &&
      target.addresses.length === 1 &&
      target.addresses[0] === "93.184.216.34" &&
      !target.trustedLoopback
    )).toBe(true);
    expect(credentialCalls).toBe(4);
  });

  test("outbound transport rejects insecure, mixed-address, and redirect targets", async () => {
    let pinnedCalls = 0;
    const neverFetch = async (): Promise<Response> => {
      pinnedCalls += 1;
      throw new Error("must not reach the network");
    };

    await expect(createA2AOutboundClient({
      baseUrl: "http://agent.test",
      resolveHostname: async () => ["93.184.216.34"],
      pinnedFetch: neverFetch,
      resolveBearerCredential: async () => null,
    })).rejects.toMatchObject({ code: "insecure_transport" });
    await expect(createA2AOutboundClient({
      baseUrl: "https://agent.test",
      resolveHostname: async () => ["93.184.216.34", "127.0.0.1"],
      pinnedFetch: neverFetch,
      resolveBearerCredential: async () => null,
    })).rejects.toMatchObject({ code: "forbidden_address" });
    expect(pinnedCalls).toBe(0);

    await expect(createA2AOutboundClient({
      baseUrl: "https://agent.test",
      resolveHostname: async () => ["93.184.216.34"],
      pinnedFetch: async () => new Response(null, {
        status: 302,
        headers: { Location: "https://elsewhere.test/card.json" },
      }),
      resolveBearerCredential: async () => null,
    })).rejects.toMatchObject({ code: "redirect_rejected" });

    const privateInterfaceCard: AgentCardType = {
      ...card,
      supportedInterfaces: [{
        ...card.supportedInterfaces[0]!,
        url: `https://127.0.0.1${A2A_RPC_PATH}`,
      }],
    };
    let credentialCalls = 0;
    await expect(createA2AOutboundClient({
      baseUrl: "https://agent.test",
      resolveHostname: async () => ["93.184.216.34"],
      pinnedFetch: async () => new Response(JSON.stringify(AgentCard.toJSON(privateInterfaceCard)), {
        headers: { "Content-Type": "application/json" },
      }),
      resolveBearerCredential: async () => {
        credentialCalls += 1;
        return "must-not-be-read";
      },
    })).rejects.toMatchObject({ code: "forbidden_address" });
    expect(credentialCalls).toBe(0);
  });

  test("outbound permits only explicitly trusted loopback HTTP origins", async () => {
    const localEndpoint = `http://127.0.0.1:8787${A2A_RPC_PATH}`;
    const localCard: AgentCardType = {
      ...card,
      supportedInterfaces: [{ ...card.supportedInterfaces[0]!, url: localEndpoint }],
    };
    const fixture = new Fixture();
    const handler = createA2AHandler({
      tasks: fixture.tasks,
      identities: fixture.identities,
      attachments: fixture.attachments,
      agentId: AGENT_ID,
      namespace: localEndpoint,
      agentCard: localCard,
      resolvePrincipal: (request) => {
        expect(request.headers.get("Authorization")).toBe("Bearer local-secret");
        return principal;
      },
    });
    let pinnedCalls = 0;
    const pinnedFetch = async (request: Request, target: A2AResolvedTarget): Promise<Response> => {
      pinnedCalls += 1;
      expect(target).toEqual({
        hostname: "127.0.0.1",
        addresses: ["127.0.0.1"],
        trustedLoopback: true,
      });
      return handler.fetch(request);
    };

    await expect(createA2AOutboundClient({
      baseUrl: "http://127.0.0.1:8787",
      resolveHostname: async () => { throw new Error("literal IP must bypass DNS"); },
      pinnedFetch,
      resolveBearerCredential: async () => "local-secret",
    })).rejects.toMatchObject({ code: "insecure_transport" });
    expect(pinnedCalls).toBe(0);

    const outbound = await createA2AOutboundClient({
      baseUrl: "http://127.0.0.1:8787",
      trustedLoopbackOrigins: ["http://127.0.0.1:8787"],
      resolveHostname: async () => { throw new Error("literal IP must bypass DNS"); },
      pinnedFetch,
      resolveBearerCredential: async () => "local-secret",
    });
    const sent = resultTask(await outbound.sendMessage(sendRequest(userMessage({
      messageId: "loopback-message",
    }))));
    expect(sent.id).not.toBe(TASK_ID);
    expect(pinnedCalls).toBe(2);
  });

  test("outbound enforces actual body limits and deadlines", async () => {
    const encodedCard = JSON.stringify(AgentCard.toJSON(card));
    await expect(createA2AOutboundClient({
      baseUrl: "https://agent.test",
      resolveHostname: async () => ["93.184.216.34"],
      pinnedFetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(encodedCard));
          controller.close();
        },
      }), { headers: { "Content-Type": "application/json" } }),
      resolveBearerCredential: async () => null,
      limits: { maxResponseBodyBytes: 64 },
    })).rejects.toMatchObject({ code: "response_too_large" });

    const fixture = new Fixture();
    const handler = createHandler(fixture);
    let requestCount = 0;
    const outbound = await createA2AOutboundClient({
      baseUrl: "https://agent.test",
      resolveHostname: async () => ["93.184.216.34"],
      pinnedFetch: async (request) => {
        requestCount += 1;
        return handler.fetch(request);
      },
      resolveBearerCredential: async () => "test",
      limits: { maxRequestBodyBytes: 1_024 },
    });
    await expect(outbound.sendMessage(sendRequest(userMessage({
      parts: [{
        content: { $case: "text", value: "x".repeat(5_000) },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      }],
    })))).rejects.toMatchObject({ code: "request_too_large" });
    expect(requestCount).toBe(1);

    await expect(createA2AOutboundClient({
      baseUrl: "https://agent.test",
      resolveHostname: async () => ["93.184.216.34"],
      pinnedFetch: async () => new Promise<Response>(() => undefined),
      resolveBearerCredential: async () => null,
      limits: { requestTimeoutMs: 5 },
    })).rejects.toMatchObject({ code: "request_timed_out" });
  });
});
