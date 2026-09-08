import { describe, expect, test } from "bun:test";
import { EventSchemas, EventType, HttpAgent, type AGUIEvent, type RunAgentInput } from "@ag-ui/client";
import type {
  AgentTaskPort,
  AttachmentPort,
  ContinueTaskCommand,
  ExternalEntityRef,
  ExternalIdentityBinding,
  ExternalIdentityPort,
  ProtocolPrincipal,
  ResumeTaskCommand,
  SubmitTaskCommand,
  TaskRef,
  TaskView,
} from "@openbot/application";
import type { CanonicalEvent, TaskEventEnvelope } from "@openbot/core";
import {
  AgUiAdapterError,
  AgUiEventMapper,
  AgUiIdentityMap,
  OPENBOT_AG_UI_CANCEL_EXTENSION,
  OPENBOT_AG_UI_REPLAY_EXTENSION,
  createAgUiHandlers,
  resolveAgUiDependencies,
} from "@openbot/protocol-ag-ui";

const ACCOUNT = "00000000-0000-4000-8000-000000000001" as any;
const AGENT = "00000000-0000-4000-8000-000000000002" as any;
const TASK = "00000000-0000-4000-8000-000000000003" as any;
const THREAD = "00000000-0000-4000-8000-000000000004" as any;
const RUN = "00000000-0000-4000-8000-000000000005" as any;
const MESSAGE = "00000000-0000-4000-8000-000000000006" as any;
const INTERRUPT = "00000000-0000-4000-8000-000000000007" as any;
const RUN_TWO = "00000000-0000-4000-8000-000000000008" as any;
const MESSAGE_TWO = "00000000-0000-4000-8000-000000000009" as any;

const principal: ProtocolPrincipal = {
  accountId: ACCOUNT,
  subjectId: "test-user",
  kind: "user",
  scopes: ["tasks:read", "tasks:write"],
};

let lastImportedMediaType: string | undefined;
let importedAttachmentKeys: Array<string | undefined> = [];

function envelope(
  seq: number,
  event: CanonicalEvent,
  options: { runId?: typeof RUN | null; taskId?: typeof TASK; threadId?: typeof THREAD } = {},
): TaskEventEnvelope {
  return {
    version: 1,
    eventId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}` as any,
    accountId: ACCOUNT,
    taskId: options.taskId ?? TASK,
    runId:
      options.runId === undefined
        ? event.type === "task.status.changed" || event.type === "artifact.updated"
          ? null
          : RUN
        : options.runId,
    agentId: AGENT,
    threadId: options.threadId ?? THREAD,
    seq,
    time: 1_800_000_000_000 + seq,
    metadata: {},
    ...event,
  } as TaskEventEnvelope;
}

function basicEvents(runId = RUN, startSeq = 1): TaskEventEnvelope[] {
  return [
    envelope(
      startSeq,
      { type: "run.status.changed", data: { from: null, to: "queued" } },
      { runId },
    ),
    envelope(
      startSeq + 1,
      { type: "run.status.changed", data: { from: "queued", to: "running" } },
      { runId },
    ),
    envelope(
      startSeq + 2,
      { type: "message.started", data: { messageId: MESSAGE, role: "agent" } },
      { runId },
    ),
    envelope(
      startSeq + 3,
      { type: "message.text.delta", data: { messageId: MESSAGE, delta: "Hello" } },
      { runId },
    ),
    envelope(
      startSeq + 4,
      {
        type: "message.finished",
        data: { messageId: MESSAGE, parts: [{ kind: "text", text: "Hello" }] },
      },
      { runId },
    ),
    envelope(
      startSeq + 5,
      { type: "run.status.changed", data: { from: "running", to: "completed" } },
      { runId },
    ),
  ];
}

function taskView(runStatus: "queued" | "running" | "interrupted" | "completed" | "failed" | "canceled" = "running", runId = RUN): TaskView {
  return {
    task: {
      id: TASK,
      accountId: ACCOUNT,
      threadId: THREAD,
      agentId: AGENT,
      status:
        runStatus === "completed"
          ? "completed"
          : runStatus === "failed"
            ? "failed"
            : runStatus === "canceled"
              ? "canceled"
              : runStatus === "interrupted"
                ? "input_required"
                : "working",
      createdAt: 1,
      updatedAt: 2,
      metadata: {},
    },
    runs: [
      {
        id: runId,
        accountId: ACCOUNT,
        taskId: TASK,
        threadId: THREAD,
        agentId: AGENT,
        attempt: runId === RUN ? 1 : 2,
        status: runStatus,
        providerSessionRef: null,
        createdAt: 1,
        startedAt: 1,
        finishedAt: ["completed", "failed", "canceled"].includes(runStatus) ? 2 : null,
        metadata: {},
      },
    ],
    messages: [],
    artifacts: [],
    interrupts: [],
    lastSeq: 0,
  } as TaskView;
}

class MemoryIdentities implements ExternalIdentityPort {
  private readonly byRef = new Map<string, ExternalIdentityBinding>();
  private readonly byInternal = new Map<string, ExternalIdentityBinding>();
  private counter = 0;

  bind(ref: ExternalEntityRef, internalId: string, subjectId = principal.subjectId): void {
    const binding = { ref, internalId } as ExternalIdentityBinding;
    this.byRef.set(this.refKey(subjectId, ref), binding);
    this.byInternal.set(`${subjectId}:${ref.protocol}:${ref.namespace}:${ref.kind}:${internalId}`, binding);
  }

  async resolve(scopedPrincipal: ProtocolPrincipal, ref: ExternalEntityRef): Promise<ExternalIdentityBinding | null> {
    return this.byRef.get(this.refKey(scopedPrincipal.subjectId, ref)) ?? null;
  }

  async getOrCreate(scopedPrincipal: ProtocolPrincipal, target: any): Promise<ExternalIdentityBinding> {
    const subjectId = scopedPrincipal.subjectId;
    const key = `${subjectId}:${target.protocol}:${target.namespace}:${target.kind}:${target.internalId}`;
    const existing = this.byInternal.get(key);
    if (existing !== undefined) return existing;
    this.counter += 1;
    const ref = {
      protocol: target.protocol,
      namespace: target.namespace,
      kind: target.kind,
      externalId: `external-${target.kind}-${this.counter}`,
    } as ExternalEntityRef;
    this.bind(ref, target.internalId, subjectId);
    return this.byInternal.get(key)!;
  }

  private refKey(subjectId: string, ref: ExternalEntityRef): string {
    return `${subjectId}:${ref.protocol}:${ref.namespace}:${ref.kind}:${ref.externalId}`;
  }
}

const attachments: AttachmentPort = {
  async import(_principal, input) {
    lastImportedMediaType = input.mediaType;
    importedAttachmentKeys.push(input.idempotencyKey);
    const size = input.source.kind === "bytes" ? input.source.bytes.byteLength : 1;
    return {
      id: "00000000-0000-4000-8000-000000000010" as any,
      name: input.name ?? null,
      mediaType: input.mediaType,
      size,
      sha256: "a".repeat(64),
    };
  },
  async open() {
    return {
      attachment: {
        id: "00000000-0000-4000-8000-000000000010" as any,
        name: "file.bin",
        mediaType: "application/octet-stream",
        size: 1,
        sha256: "a".repeat(64),
      },
      body: new ReadableStream({ start(controller) { controller.close(); } }),
    };
  },
  async createDownloadUrl(_principal, id) {
    return `https://files.example/${id}`;
  },
};

class FakeTasks {
  events: TaskEventEnvelope[] = basicEvents();
  view: TaskView = taskView();
  submitted?: SubmitTaskCommand;
  resumed?: ResumeTaskCommand;
  continued?: ContinueTaskCommand;
  lastGetRef?: TaskRef;
  lastCancelRef?: TaskRef;
  cancelCalls = 0;
  subscriptionDetached = false;
  holdSubscription = false;

  constructor(readonly identities: MemoryIdentities) {}

  async submit(command: SubmitTaskCommand): Promise<TaskView> {
    this.submitted = command;
    const refs = command.externalRefs;
    if (refs?.thread) this.identities.bind(refs.thread, THREAD, command.principal.subjectId);
    if (refs?.task) this.identities.bind(refs.task, TASK, command.principal.subjectId);
    if (refs?.run) this.identities.bind(refs.run, RUN, command.principal.subjectId);
    if (refs?.message) this.identities.bind(refs.message, MESSAGE_TWO, command.principal.subjectId);
    return this.view;
  }

  async get(_principal: ProtocolPrincipal, task: TaskRef): Promise<TaskView | null> {
    this.lastGetRef = task;
    return this.view;
  }

  async list(): Promise<any> {
    return { items: [] };
  }

  async cancel(_principal: ProtocolPrincipal, task: TaskRef): Promise<TaskView> {
    this.lastCancelRef = task;
    this.cancelCalls += 1;
    return { ...this.view, task: { ...this.view.task, status: "canceled" } } as TaskView;
  }

  async resume(command: ResumeTaskCommand): Promise<TaskView> {
    this.resumed = command;
    if (command.externalRun) this.identities.bind(command.externalRun, RUN_TWO, command.principal.subjectId);
    if (command.externalMessage) this.identities.bind(command.externalMessage, MESSAGE_TWO, command.principal.subjectId);
    return this.view;
  }

  async continue(command: ContinueTaskCommand): Promise<TaskView> {
    this.continued = command;
    if (command.externalRun) this.identities.bind(command.externalRun, RUN_TWO, command.principal.subjectId);
    if (command.externalMessage) this.identities.bind(command.externalMessage, MESSAGE_TWO, command.principal.subjectId);
    return this.view;
  }

  async resolveInterrupt(): Promise<any> {
    throw new Error("legacy interrupt method must not be used");
  }

  subscribe(
    _principal: ProtocolPrincipal,
    _task: TaskRef,
    afterSeq = 0,
    signal?: AbortSignal,
  ): AsyncIterable<TaskEventEnvelope> {
    const events = this.events.filter((event) => event.seq > afterSeq);
    const owner = this;
    const hold = this.holdSubscription;
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
        if (hold && !signal?.aborted) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                owner.subscriptionDetached = true;
                resolve();
              },
              { once: true },
            );
          });
        }
      },
    };
  }
}

function dependencies(tasks: FakeTasks, identities: MemoryIdentities, limits = {}) {
  return {
    tasks: tasks as unknown as AgentTaskPort,
    identities,
    attachments,
    authenticate: async () => principal,
    resolveAgentId: async () => AGENT,
    namespace: "tests",
    limits,
    now: () => 1_900_000_000_000,
  };
}

function jsonRequest(input: unknown, method = "POST", url = "http://local/ag-ui/v1/run"): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  });
}

function runInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "thread-client",
    runId: "run-client",
    state: {},
    messages: [{ id: "message-client", role: "user", content: "Hello" }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

async function sseEvents(response: Response): Promise<AGUIEvent[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      expect(frame.startsWith("data: ")).toBe(true);
      return EventSchemas.parse(JSON.parse(frame.slice(6)));
    });
}

describe("AG-UI canonical mapper", () => {
  test("maps explicit message, tool, safe-reasoning, activity, and terminal triads", async () => {
    const identityPort = new MemoryIdentities();
    const resolved = resolveAgUiDependencies(dependencies(new FakeTasks(identityPort), identityPort));
    const mapper = new AgUiEventMapper({
      principal,
      identities: new AgUiIdentityMap(identityPort, principal, "tests"),
      attachments,
      limits: resolved.limits,
      now: resolved.now,
    });
    const events = [
      envelope(1, { type: "run.status.changed", data: { from: null, to: "queued" } }),
      envelope(2, { type: "message.started", data: { messageId: MESSAGE, role: "agent" } }),
      envelope(3, { type: "message.text.delta", data: { messageId: MESSAGE, delta: "Hi" } }),
      envelope(4, { type: "reasoning.summary.delta", data: { messageId: MESSAGE, delta: "Summary" } }),
      envelope(5, { type: "action.started", data: { actionCallId: "call-1", name: "search" } }),
      envelope(6, { type: "action.arguments.delta", data: { actionCallId: "call-1", delta: "{\"q\":\"x\"}" } }),
      envelope(7, { type: "action.finished", data: { actionCallId: "call-1", output: { ok: true }, outcome: "success" } }),
      envelope(8, { type: "activity.updated", data: { label: "Working", progress: 0.5 } }),
      envelope(9, { type: "message.finished", data: { messageId: MESSAGE, parts: [{ kind: "text", text: "Hi!" }] } }),
      envelope(10, { type: "run.status.changed", data: { from: "running", to: "completed" } }),
    ];
    const mapped: AGUIEvent[] = [];
    for (const event of events) mapped.push(...(await mapper.map(event)));
    expect(mapped.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
      EventType.RUN_FINISHED,
    ]);
    for (const event of mapped) {
      expect(EventSchemas.safeParse(event).success).toBe(true);
      expect(event.type).not.toBe(EventType.RAW);
      expect(event.rawEvent).toBeUndefined();
    }
    expect((mapped.at(-1) as any).outcome).toEqual({ type: "success" });
  });

  test("maps an interrupt only at the terminal run boundary", async () => {
    const identityPort = new MemoryIdentities();
    const resolved = resolveAgUiDependencies(dependencies(new FakeTasks(identityPort), identityPort));
    const mapper = new AgUiEventMapper({
      principal,
      identities: new AgUiIdentityMap(identityPort, principal, "tests"),
      attachments,
      limits: resolved.limits,
    });
    const requested = envelope(3, {
      type: "interrupt.requested",
      data: {
        interrupt: {
          id: INTERRUPT,
          accountId: ACCOUNT,
          taskId: TASK,
          runId: RUN,
          kind: "permission",
          prompt: "Allow search?",
          responseSchema: { type: "boolean" },
          status: "open",
          createdAt: 1,
          expiresAt: 2_000_000_000_000,
          resolvedAt: null,
          metadata: { "action-call-id": "call-1" },
        },
      },
    });
    await mapper.map(envelope(1, { type: "run.status.changed", data: { from: null, to: "running" } }));
    await mapper.map(
      envelope(2, { type: "action.started", data: { actionCallId: "call-1", name: "search" } }),
    );
    expect(await mapper.map(requested)).toEqual([]);
    const result = await mapper.map(
      envelope(4, { type: "run.status.changed", data: { from: "running", to: "interrupted" } }),
    );
    expect(result.map((event) => event.type)).toEqual([
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ]);
    expect((result[1] as any).outcome.interrupts[0]).toMatchObject({
      reason: "permission",
      message: "Allow search?",
      toolCallId: "call-1",
    });
  });

  test("rejects sequence gaps, orphan deltas, and unclosed terminal streams", async () => {
    const identityPort = new MemoryIdentities();
    const resolved = resolveAgUiDependencies(dependencies(new FakeTasks(identityPort), identityPort));
    const makeMapper = () =>
      new AgUiEventMapper({
        principal,
        identities: new AgUiIdentityMap(identityPort, principal, "tests"),
        attachments,
        limits: resolved.limits,
      });
    await expect(
      makeMapper().map(envelope(2, { type: "run.status.changed", data: { from: null, to: "running" } })),
    ).rejects.toMatchObject({ code: "event_sequence_gap" });

    const orphan = makeMapper();
    await orphan.map(envelope(1, { type: "run.status.changed", data: { from: null, to: "running" } }));
    await expect(
      orphan.map(envelope(2, { type: "message.text.delta", data: { messageId: MESSAGE, delta: "x" } })),
    ).rejects.toMatchObject({ code: "message_delta_without_start" });

    const unclosed = makeMapper();
    await unclosed.map(envelope(1, { type: "run.status.changed", data: { from: null, to: "running" } }));
    await unclosed.map(envelope(2, { type: "message.started", data: { messageId: MESSAGE, role: "agent" } }));
    await expect(
      unclosed.map(envelope(3, { type: "run.status.changed", data: { from: "running", to: "completed" } })),
    ).rejects.toMatchObject({ code: "unclosed_event_stream" });

    const malformedTool = makeMapper();
    await malformedTool.map(
      envelope(1, { type: "run.status.changed", data: { from: null, to: "running" } }),
    );
    await malformedTool.map(
      envelope(2, { type: "action.started", data: { actionCallId: "bad-call", name: "search" } }),
    );
    await malformedTool.map(
      envelope(3, { type: "action.arguments.delta", data: { actionCallId: "bad-call", delta: "{" } }),
    );
    await expect(
      malformedTool.map(
        envelope(4, {
          type: "action.finished",
          data: { actionCallId: "bad-call", outcome: "failure" },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_tool_arguments" });
  });
});

describe("AG-UI HTTP adapter", () => {
  test("interoperates with the official HttpAgent 0.0.59 over HTTP/SSE", async () => {
    const identityPort = new MemoryIdentities();
    const tasks = new FakeTasks(identityPort);
    const handler = createAgUiHandlers(dependencies(tasks, identityPort)).fetch;
    const requests: RunAgentInput[] = [];
    const agent = new HttpAgent({
      url: "http://local/ag-ui/v1/run",
      threadId: "thread-client",
      fetch: async (url, init) => {
        requests.push(JSON.parse(String(init.body)));
        return handler(new Request(url, init));
      },
    });
    agent.addMessage({ id: "message-client", role: "user", content: "Hello" });

    const result = await agent.runAgent({ runId: "run-client" });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      threadId: "thread-client",
      runId: "run-client",
      tools: [],
      context: [],
      state: {},
    });
    expect(tasks.submitted?.message).toEqual({
      role: "user",
      parts: [{ kind: "text", text: "Hello" }],
    });
    expect(result.newMessages).toHaveLength(1);
    expect(result.newMessages[0]).toMatchObject({ role: "assistant", content: "Hello" });
  });

  test("validates RunAgentInput and rejects unsupported semantics before submission", async () => {
    const identityPort = new MemoryIdentities();
    const tasks = new FakeTasks(identityPort);
    const handlers = createAgUiHandlers(dependencies(tasks, identityPort));
    const malformed = await handlers.run(jsonRequest({ threadId: "only-one-field" }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "invalid_run_input" } });

    const unsupported = await handlers.run(jsonRequest(runInput({ state: { secret: true } })));
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toMatchObject({ error: { code: "unsupported_state" } });
    expect(tasks.submitted).toBeUndefined();
  });

  test("uses the atomic free-form continuation path when no interrupt response is supplied", async () => {
    const identityPort = new MemoryIdentities();
    const tasks = new FakeTasks(identityPort);
    identityPort.bind({
      protocol: "ag-ui",
      namespace: "tests",
      kind: "task",
      externalId: "task-client",
    } as ExternalEntityRef, TASK);
    identityPort.bind({
      protocol: "ag-ui",
      namespace: "tests",
      kind: "thread",
      externalId: "thread-client",
    } as ExternalEntityRef, THREAD);
    tasks.view = { ...taskView("interrupted"), lastSeq: 10 };
    tasks.events = basicEvents(RUN_TWO, 11).map((event) => ({ ...event, runId: RUN_TWO })) as TaskEventEnvelope[];

    const response = await createAgUiHandlers(dependencies(tasks, identityPort)).run(jsonRequest(runInput({
      runId: "run-two-client",
      forwardedProps: { openbot: { taskId: "task-client" } },
      messages: [{ id: "follow-up-message", role: "user", content: "Here is the missing detail" }],
    })));

    expect(response.status).toBe(200);
    await sseEvents(response);
    expect(tasks.continued).toMatchObject({
      idempotencyKey: "run-two-client",
      externalRun: { kind: "run", externalId: "run-two-client" },
      externalMessage: { kind: "message", externalId: "follow-up-message" },
      message: { role: "user", parts: [{ kind: "text", text: "Here is the missing detail" }] },
    });
    expect(tasks.resumed).toBeUndefined();
  });

  test("atomically resumes with translated interrupt status and a typed tool result", async () => {
    const identityPort = new MemoryIdentities();
    const tasks = new FakeTasks(identityPort);
    const aguiTaskRef = {
      protocol: "ag-ui",
      namespace: "tests",
      kind: "task",
      externalId: "task-client",
    } as ExternalEntityRef;
    const aguiThreadRef = {
      protocol: "ag-ui",
      namespace: "tests",
      kind: "thread",
      externalId: "thread-client",
    } as ExternalEntityRef;
    identityPort.bind(aguiTaskRef, TASK);
    identityPort.bind(aguiThreadRef, THREAD);
    tasks.view = { ...taskView("interrupted"), lastSeq: 10 };
    tasks.events = basicEvents(RUN_TWO, 11).map((event) => ({
      ...event,
      runId: RUN_TWO,
      data:
        event.type === "message.started" || event.type === "message.text.delta" || event.type === "message.finished"
          ? { ...event.data, messageId: MESSAGE_TWO }
          : event.data,
    })) as TaskEventEnvelope[];
    const response = await createAgUiHandlers(dependencies(tasks, identityPort)).run(
      jsonRequest(
        runInput({
          runId: "run-two-client",
          forwardedProps: { openbot: { taskId: "task-client" } },
          messages: [
            {
              id: "tool-message-client",
              role: "tool",
              toolCallId: "call-1",
              content: "approved",
            },
          ],
          resume: [{ interruptId: "interrupt-client", status: "cancelled" }],
        }),
      ),
    );
    expect(response.status).toBe(200);
    const output = await sseEvents(response);
    expect(output.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(tasks.resumed).toMatchObject({
      idempotencyKey: "run-two-client",
      externalRun: { kind: "run", externalId: "run-two-client" },
      externalMessage: { kind: "message", externalId: "tool-message-client" },
      responses: [
        {
          status: "canceled",
          interrupt: { externalRef: { kind: "interrupt", externalId: "interrupt-client" } },
        },
      ],
      message: { role: "tool", actionCallId: "call-1", parts: [{ kind: "text", text: "approved" }] },
    });
  });

  test("consumer disconnect only detaches; the explicit extension performs cancellation", async () => {
    const identityPort = new MemoryIdentities();
    const tasks = new FakeTasks(identityPort);
    tasks.events = [envelope(1, { type: "run.status.changed", data: { from: null, to: "queued" } })];
    tasks.holdSubscription = true;
    const handlers = createAgUiHandlers(dependencies(tasks, identityPort));
    const response = await handlers.run(jsonRequest(runInput()));
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel("test disconnect");
    await Bun.sleep(0);
    expect(tasks.subscriptionDetached).toBe(true);
    expect(tasks.cancelCalls).toBe(0);

    const cancelled = await handlers.cancel(
      new Request("http://local/ag-ui/v1/runs/run-client?reason=user", { method: "DELETE" }),
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.headers.get("X-OpenBot-Extension")).toBe(OPENBOT_AG_UI_CANCEL_EXTENSION);
    expect(tasks.cancelCalls).toBe(1);
    expect(tasks.lastCancelRef).toMatchObject({ externalRef: { kind: "run", externalId: "run-client" } });
    const body = await cancelled.json();
    expect(body.taskId).toBe("run-client");
    expect(JSON.stringify(body)).not.toContain(TASK);
  });

  test("replays only committed events after the cursor from the external run path", async () => {
    const identityPort = new MemoryIdentities();
    const tasks = new FakeTasks(identityPort);
    const ref = {
      protocol: "ag-ui",
      namespace: "tests",
      kind: "run",
      externalId: "run-client",
    } as ExternalEntityRef;
    identityPort.bind(ref, RUN);
    tasks.view = {
      ...taskView("completed"),
      lastSeq: 6,
      messages: [
        {
          id: MESSAGE,
          accountId: ACCOUNT,
          threadId: THREAD,
          taskId: TASK,
          runId: RUN,
          role: "agent",
          parts: [{ kind: "text", text: "Recovered" }],
          createdAt: 2,
          metadata: {},
        },
      ],
    } as TaskView;
    const response = await createAgUiHandlers(dependencies(tasks, identityPort)).replay(
      new Request("http://local/ag-ui/v1/runs/run-client/events?after=4", {
        headers: { Accept: "text/event-stream" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-OpenBot-Extension")).toBe(OPENBOT_AG_UI_REPLAY_EXTENSION);
    expect(response.headers.get("X-OpenBot-Replay-Mode")).toBe("event-log");
    const output = await sseEvents(response);
    expect(output.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(response.headers.get("X-OpenBot-Replay-Cursor")).toBe("4");
    expect(tasks.lastGetRef).toMatchObject({ externalRef: { kind: "run", externalId: "run-client" } });
  });

  test("routes replay and cancel by external run ID and rejects legacy task query routes", async () => {
    const identityPort = new MemoryIdentities();
    const tasks = new FakeTasks(identityPort);
    const runRef = {
      protocol: "ag-ui",
      namespace: "tests",
      kind: "run",
      externalId: "run-client",
    } as ExternalEntityRef;
    identityPort.bind(runRef, RUN);
    tasks.view = { ...taskView("completed"), lastSeq: 6 };
    const handlers = createAgUiHandlers(dependencies(tasks, identityPort));

    const legacy = await handlers.fetch(
      new Request("http://local/ag-ui/v1/run?taskId=task-client", { headers: { Accept: "text/event-stream" } }),
    );
    expect(legacy.status).toBe(405);

    const replayed = await handlers.fetch(
      new Request("http://local/ag-ui/v1/runs/run-client/events?after=6", {
        headers: { Accept: "text/event-stream" },
      }),
    );
    expect(replayed.status).toBe(200);
    expect(await sseEvents(replayed)).toEqual([]);
  });

  test("refuses to cancel a historical run instead of cancelling its newer task run", async () => {
    const identityPort = new MemoryIdentities();
    const tasks = new FakeTasks(identityPort);
    identityPort.bind(
      {
        protocol: "ag-ui",
        namespace: "tests",
        kind: "run",
        externalId: "historical-run",
      } as ExternalEntityRef,
      RUN,
    );
    const historical = taskView("completed").runs[0]!;
    const current = taskView("running", RUN_TWO).runs[0]!;
    tasks.view = {
      ...taskView("running", RUN_TWO),
      runs: [historical, current],
      lastSeq: 20,
    };
    const response = await createAgUiHandlers(dependencies(tasks, identityPort)).cancel(
      new Request("http://local/ag-ui/v1/runs/historical-run", { method: "DELETE" }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "run_not_current" } });
    expect(tasks.cancelCalls).toBe(0);
  });

  test("enforces request, event, and attachment limits", async () => {
    const identityPort = new MemoryIdentities();
    const tasks = new FakeTasks(identityPort);
    const handlers = createAgUiHandlers(
      dependencies(tasks, identityPort, { maxRequestBytes: 256, maxAttachmentBytes: 2 }),
    );
    const large = await handlers.run(jsonRequest(runInput({ messages: [{ id: "m", role: "user", content: "x".repeat(500) }] })));
    expect(large.status).toBe(413);

    const attachmentHandlers = createAgUiHandlers(
      dependencies(tasks, identityPort, { maxRequestBytes: 4_096, maxAttachmentBytes: 2 }),
    );
    const attachment = await attachmentHandlers.run(
      jsonRequest(
        runInput({
          messages: [
            {
              id: "m",
              role: "user",
              content: [
                {
                  type: "binary",
                  mimeType: "application/octet-stream",
                  data: btoa("abc"),
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(attachment.status).toBe(413);
    expect(await attachment.json()).toMatchObject({ error: { code: "attachment_too_large" } });
  });

  test("uses a concrete media type when an AG-UI URL source omits MIME metadata", async () => {
    lastImportedMediaType = undefined;
    const identityPort = new MemoryIdentities();
    const tasks = new FakeTasks(identityPort);
    const response = await createAgUiHandlers(dependencies(tasks, identityPort)).run(
      jsonRequest(
        runInput({
          messages: [
            {
              id: "image-message",
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "url", value: "https://images.example/example" },
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(String(lastImportedMediaType)).toBe("application/octet-stream");
    expect(String(lastImportedMediaType)).not.toContain("*");
  });

  test("uses a stable message-part key when replaying AG-UI attachment imports", async () => {
    importedAttachmentKeys = [];
    const identityPort = new MemoryIdentities();
    const tasks = new FakeTasks(identityPort);
    const handlers = createAgUiHandlers(dependencies(tasks, identityPort));
    const input = runInput({
      messages: [
        {
          id: "attachment-message",
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "binary",
              mimeType: "application/octet-stream",
              data: btoa("one"),
            },
            {
              type: "image",
              source: { type: "url", value: "https://images.example/two" },
            },
          ],
        },
      ],
    });
    const first = await handlers.run(jsonRequest(input));
    await first.text();
    const second = await handlers.run(jsonRequest(input));
    await second.text();

    expect(importedAttachmentKeys).toHaveLength(4);
    expect(importedAttachmentKeys[0]).toBe(importedAttachmentKeys[2]);
    expect(importedAttachmentKeys[1]).toBe(importedAttachmentKeys[3]);
    expect(importedAttachmentKeys[0]).not.toBe(importedAttachmentKeys[1]);
    expect(importedAttachmentKeys[0]).toContain("tests");
    expect(importedAttachmentKeys[0]).toContain("attachment-message:1");
    expect(importedAttachmentKeys[1]).toContain("attachment-message:2");
  });

  test("turns malformed canonical stream boundaries into a validated terminal error", async () => {
    const identityPort = new MemoryIdentities();
    const tasks = new FakeTasks(identityPort);
    tasks.events = [
      envelope(1, { type: "run.status.changed", data: { from: null, to: "running" } }),
      envelope(2, { type: "message.text.delta", data: { messageId: MESSAGE, delta: "orphan" } }),
    ];
    const response = await createAgUiHandlers(dependencies(tasks, identityPort)).run(jsonRequest(runInput()));
    const output = await sseEvents(response);
    expect(output.map((event) => event.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR]);
    expect(output.at(-1)).toMatchObject({ code: "message_delta_without_start" });
  });
});
