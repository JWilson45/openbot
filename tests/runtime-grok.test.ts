import { describe, expect, test } from "bun:test";
import type {
  RuntimePromptRequest,
  RuntimeSessionRequest,
} from "@openbot/application";
import type {
  EnsureHarnessRequest,
  LiveWorkEvent,
  PromptResult,
  RunnerSession,
} from "@openbot/compute-protocol";
import { runtimeEventDraftSchema, type RuntimeEventDraft } from "@openbot/core";
import {
  GrokRuntimeProvider,
  type GrokRuntimeHost,
  type GrokRuntimeReleaseOutcome,
} from "../packages/runtime-grok/src/index.ts";

const ACCOUNT = "00000000-0000-4000-8000-000000000001" as any;
const AGENT = "00000000-0000-4000-8000-000000000002" as any;
const TASK = "00000000-0000-4000-8000-000000000003" as any;
const RUN = "00000000-0000-4000-8000-000000000004" as any;
const THREAD = "00000000-0000-4000-8000-000000000005" as any;
const MESSAGE = "00000000-0000-4000-8000-000000000006" as any;
const ATTACHMENT = "00000000-0000-4000-8000-000000000007" as any;

const ensureRequest: EnsureHarnessRequest = {
  botId: "bot-one",
  env: { XAI_API_KEY: "HOST_ENV_SECRET" },
  mcpUrl: "https://mcp.internal.example",
  mcpToken: "HOST_MCP_SECRET",
  cwd: "/prepared/workspace",
  botName: "Test bot",
  botDescription: "Tests the adapter",
  permissionMode: "ask",
};

const sessionRequest: RuntimeSessionRequest = {
  accountId: ACCOUNT,
  agentId: AGENT,
  taskId: TASK,
  runId: RUN,
  config: { providerId: "grok", modelId: "grok-test", options: {} },
  resumeSessionRef: "resume-acp-session",
  capabilities: [{ kind: "workspace", ref: "workspace-capability" }],
  metadata: { source: "test" },
};

const promptRequest: RuntimePromptRequest = {
  messages: [
    {
      id: MESSAGE,
      accountId: ACCOUNT,
      threadId: THREAD,
      taskId: TASK,
      runId: RUN,
      role: "user",
      parts: [
        { kind: "text", text: "Please inspect the attached input." },
        { kind: "data", data: { mode: "brief" }, mediaType: "application/json" },
        {
          kind: "file",
          attachment: {
            id: ATTACHMENT,
            name: "input.txt",
            mediaType: "text/plain",
            size: 12,
            sha256: "a".repeat(64),
          },
        },
      ],
      createdAt: 1_900_000_000_000,
      metadata: { "private-note": "MESSAGE_METADATA_MUST_NOT_LEAK" },
    },
  ],
  actions: [
    {
      name: "search",
      description: "Search public sources",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      outputSchema: { type: "object" },
    },
  ],
  metadata: { "private-request": "REQUEST_METADATA_MUST_NOT_LEAK" },
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class FakeRunner {
  onLiveWork?: (event: LiveWorkEvent, botId?: string) => void;
  ensureCalls: EnsureHarnessRequest[] = [];
  promptCalls: Array<{ text: string; botId: string }> = [];
  permissionCalls: Array<{ requestId: string; allow: boolean }> = [];
  cancelCalls: string[] = [];
  promptImpl: (text: string, botId: string) => Promise<PromptResult> = async () => ({
    stopReason: "end_turn",
    assistantText: "",
  });
  respondImpl: (requestId: string, allow: boolean) => boolean | Promise<boolean> = () => false;
  cancelImpl: (botId: string) => void | Promise<void> = () => undefined;

  async ensureHarness(request: EnsureHarnessRequest) {
    this.ensureCalls.push(request);
    return { acpSessionId: "fresh-acp-session", resumed: Boolean(request.resumeSessionId) };
  }

  async prompt(text: string, botId: string): Promise<PromptResult> {
    this.promptCalls.push({ text, botId });
    return this.promptImpl(text, botId);
  }

  async respondPermission(requestId: string, allow: boolean): Promise<boolean> {
    this.permissionCalls.push({ requestId, allow });
    return this.respondImpl(requestId, allow);
  }

  async cancel(botId: string): Promise<void> {
    this.cancelCalls.push(botId);
    await this.cancelImpl(botId);
  }

  emit(kind: string, payload: Record<string, unknown>, botId = ensureRequest.botId): void {
    this.onLiveWork?.({ kind, payload, botId }, botId);
  }

  asSession(): RunnerSession {
    return this as unknown as RunnerSession;
  }
}

function makeHost(
  runner: FakeRunner,
  release?: (
    request: RuntimeSessionRequest,
    outcome?: GrokRuntimeReleaseOutcome,
  ) => void | Promise<void>,
): GrokRuntimeHost {
  return {
    async prepare() {
      return {
        runner: runner.asSession(),
        ensureHarnessRequest: ensureRequest,
      };
    },
    async describe() {
      return {
        id: "grok",
        label: "Grok (dynamic)",
        authMethods: [{ id: "external", label: "Grok CLI", kind: "external" }],
      };
    },
    async listModels() {
      return [
        {
          id: "grok-test",
          label: "Grok Test",
          reasoningEfforts: ["low", "high"],
          isDefault: true,
        },
      ];
    },
    async resolveCapabilities() {
      return {
        supported: ["streaming", "resume", "cancellation", "actions", "interrupts", "attachments"],
        extensions: ["x.grok.runner-session"],
      };
    },
    async authState() {
      return { status: "ready", methodId: "external" };
    },
    ...(release === undefined ? {} : { release }),
  };
}

async function collect(source: AsyncIterable<RuntimeEventDraft>): Promise<RuntimeEventDraft[]> {
  const values: RuntimeEventDraft[] = [];
  for await (const value of source) values.push(runtimeEventDraftSchema.parse(value));
  return values;
}

describe("Grok runtime provider", () => {
  test("delegates dynamic discovery and resumes the prepared runner without exposing host concerns", async () => {
    const runner = new FakeRunner();
    const provider = new GrokRuntimeProvider(makeHost(runner));

    expect(await provider.describe(ACCOUNT)).toEqual({
      id: "grok",
      label: "Grok (dynamic)",
      authMethods: [{ id: "external", label: "Grok CLI", kind: "external" }],
    });
    expect((await provider.listModels(ACCOUNT))[0]?.id).toBe("grok-test");
    expect(await provider.resolveCapabilities(ACCOUNT, sessionRequest.config)).toMatchObject({
      supported: expect.arrayContaining(["streaming", "resume", "interrupts"]),
    });
    expect(await provider.authState(ACCOUNT)).toEqual({ status: "ready", methodId: "external" });
    expect(
      provider.validateConfig({
        ...sessionRequest.config,
        options: { reasoningEffort: " high " },
      }),
    ).toEqual({ ...sessionRequest.config, options: { reasoningEffort: "high" } });
    expect(() =>
      provider.validateConfig({
        ...sessionRequest.config,
        options: { unsupported: true },
      }),
    ).toThrow("unsupported Grok runtime option");
    expect(() =>
      provider.validateConfig({
        ...sessionRequest.config,
        options: { reasoningEffort: { level: "high" } },
      }),
    ).toThrow("reasoningEffort must be a non-empty JSON string");

    const session = await provider.createSession(sessionRequest);
    expect(session.providerSessionRef).toBe("fresh-acp-session");
    expect(runner.ensureCalls).toHaveLength(1);
    expect(runner.ensureCalls[0]?.resumeSessionId).toBe("resume-acp-session");
    expect(runner.ensureCalls[0]?.mcpToken).toBe("HOST_MCP_SECRET");
    await session.close();
  });

  test("maps public messages and balanced tools, drops thoughts/raw diagnostics, and releases once", async () => {
    const runner = new FakeRunner();
    const releases: Array<{
      request: RuntimeSessionRequest;
      outcome?: GrokRuntimeReleaseOutcome;
    }> = [];
    runner.promptImpl = async () => {
      runner.emit("agent_message_chunk", {
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
      });
      runner.emit("agent_thought_chunk", {
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "TOP_SECRET_THOUGHT" } },
      });
      runner.emit("harness_stderr", { line: "PRIVATE_STDERR" });
      runner.emit("raw", { value: "PRIVATE_RAW_EVENT" });
      runner.emit("tool_call", {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "PRIVATE_PROVIDER_CALL_ID",
          kind: "search",
          rawInput: { query: "protocols", apiKey: "PRIVATE_API_KEY" },
        },
      });
      runner.emit("tool_call_update", {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "PRIVATE_PROVIDER_CALL_ID",
          status: "running",
          rawOutput: { trace: "PRIVATE_RUNNING_TRACE" },
        },
      });
      runner.emit("tool_call_update", {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "PRIVATE_PROVIDER_CALL_ID",
          status: "completed",
          rawOutput: { ok: true, authorization: "PRIVATE_AUTHORIZATION" },
        },
      });
      runner.emit("agent_message_chunk", {
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
      });
      return { stopReason: "end_turn", assistantText: "Hello TOP_SECRET_THOUGHT world" };
    };
    const provider = new GrokRuntimeProvider(
      makeHost(
        runner,
        (request, outcome) => {
          releases.push({ request, ...(outcome === undefined ? {} : { outcome }) });
        },
      ),
    );
    const session = await provider.createSession(sessionRequest);
    const events = await collect(session.run(promptRequest));

    expect(events.map((event) => event.type)).toEqual([
      "message.started",
      "message.text.delta",
      "action.started",
      "action.arguments.delta",
      "activity.updated",
      "action.finished",
      "message.text.delta",
      "message.finished",
      "completed",
    ]);
    const started = events.find((event) => event.type === "action.started")!;
    const argumentsEvent = events.find((event) => event.type === "action.arguments.delta")!;
    const finished = events.find((event) => event.type === "action.finished")!;
    expect(argumentsEvent.data.providerCallRef).toBe(started.data.providerCallRef);
    expect(finished.data.providerCallRef).toBe(started.data.providerCallRef);
    expect(JSON.parse(argumentsEvent.data.delta)).toEqual({ query: "protocols", apiKey: "[redacted]" });
    expect(events.filter((event) => event.type === "completed" || event.type === "failed")).toHaveLength(1);

    const serialized = JSON.stringify(events);
    for (const privateValue of [
      "TOP_SECRET_THOUGHT",
      "PRIVATE_STDERR",
      "PRIVATE_RAW_EVENT",
      "PRIVATE_PROVIDER_CALL_ID",
      "PRIVATE_API_KEY",
      "PRIVATE_AUTHORIZATION",
      "PRIVATE_RUNNING_TRACE",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    const finalMessage = events.find((event) => event.type === "message.finished")!;
    expect(finalMessage.data.parts).toEqual([{ kind: "text", text: "Hello world" }]);

    const sentPrompt = runner.promptCalls[0]?.text ?? "";
    expect(sentPrompt).toContain("Please inspect the attached input.");
    expect(sentPrompt).toContain('"kind":"data"');
    expect(sentPrompt).toContain('"kind":"attachment"');
    expect(sentPrompt).toContain('"name":"search"');
    for (const privateValue of [
      String(MESSAGE),
      String(ATTACHMENT),
      "MESSAGE_METADATA_MUST_NOT_LEAK",
      "REQUEST_METADATA_MUST_NOT_LEAK",
      "HOST_ENV_SECRET",
      "HOST_MCP_SECRET",
    ]) {
      expect(sentPrompt).not.toContain(privateValue);
    }

    await session.close();
    await session.close();
    expect(releases).toHaveLength(1);
    expect(releases[0]?.request).toEqual(sessionRequest);
    expect(releases[0]?.outcome).toEqual({ status: "completed", stopReason: "end_turn" });
  });

  test("maps permission interrupts and responds through the runner with resolved or canceled decisions", async () => {
    const runner = new FakeRunner();
    const releases: Array<GrokRuntimeReleaseOutcome | undefined> = [];
    const first = deferred<void>();
    const second = deferred<void>();
    let pending = first;
    runner.respondImpl = (requestId) => {
      if (requestId !== (pending === first ? "permission-one" : "permission-two")) return false;
      pending.resolve();
      return true;
    };
    runner.promptImpl = async () => {
      runner.emit("agent_message_chunk", {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "I need permission." },
        },
      });
      runner.emit("tool_call", {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "permission-tool",
          kind: "execute",
          rawInput: { command: "bun test" },
        },
      });
      runner.emit("permission_request", {
        reqId: "permission-one",
        toolCall: { title: "run the test suite" },
      });
      await first.promise;
      pending = second;
      runner.emit("permission_request", {
        reqId: "permission-two",
        toolCall: { title: "read a file" },
      });
      await second.promise;
      return { stopReason: "end_turn", assistantText: "PRIVATE_AGGREGATE" };
    };
    const provider = new GrokRuntimeProvider(
      makeHost(runner, (_request, outcome) => {
        releases.push(outcome);
      }),
    );
    const initial = await provider.createSession(sessionRequest);
    const firstSegment = await collect(initial.run(promptRequest));
    expect(firstSegment.map((event) => event.type)).toEqual([
      "message.started",
      "message.text.delta",
      "action.started",
      "action.arguments.delta",
      "message.finished",
      "action.finished",
      "interrupt.requested",
    ]);
    expect(firstSegment.at(-1)).toMatchObject({
      type: "interrupt.requested",
      data: { providerRequestRef: "permission-one", kind: "permission" },
    });
    expect(firstSegment.some((event) => event.type === "completed" || event.type === "failed")).toBe(false);
    await initial.close();

    const continuation = await provider.createSession({
      ...sessionRequest,
      resumeSessionRef: "fresh-acp-session",
    });
    await continuation.respond("permission-one", { status: "resolved", value: true });
    const secondSegment = await collect(continuation.run(promptRequest));
    expect(secondSegment).toHaveLength(1);
    expect(secondSegment[0]).toMatchObject({
      type: "interrupt.requested",
      data: { providerRequestRef: "permission-two", kind: "permission" },
    });
    await continuation.close();

    const final = await provider.createSession({
      ...sessionRequest,
      resumeSessionRef: "fresh-acp-session",
    });
    await final.respond("permission-two", { status: "canceled" });
    const tail = await collect(final.run(promptRequest));

    expect(runner.permissionCalls).toEqual([
      { requestId: "permission-one", allow: true },
      { requestId: "permission-two", allow: false },
    ]);
    expect(tail.map((event) => event.type)).toEqual([
      "completed",
    ]);
    expect(runner.promptCalls).toHaveLength(1);
    await final.close();
    expect(releases).toEqual([
      undefined,
      undefined,
      { status: "completed", stopReason: "end_turn" },
    ]);
  });

  test("fails and balances a malformed duplicate tool stream without exposing the provider reference", async () => {
    const runner = new FakeRunner();
    const releases: Array<GrokRuntimeReleaseOutcome | undefined> = [];
    runner.promptImpl = async () => {
      const update = {
        sessionUpdate: "tool_call",
        toolCallId: "PRIVATE_DUPLICATE_CALL",
        kind: "search",
        rawInput: { query: "one" },
      };
      runner.emit("tool_call", { update });
      runner.emit("tool_call", { update });
      return { stopReason: "end_turn", assistantText: "PRIVATE_THOUGHT_RESULT" };
    };
    const session = await new GrokRuntimeProvider(
      makeHost(runner, (_request, outcome) => {
        releases.push(outcome);
      }),
    ).createSession(sessionRequest);
    const events = await collect(session.run(promptRequest));

    expect(events.map((event) => event.type)).toEqual([
      "action.started",
      "action.arguments.delta",
      "action.finished",
      "failed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      data: { code: "malformed_provider_event", retryable: false },
    });
    expect(events.filter((event) => event.type === "completed" || event.type === "failed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_DUPLICATE_CALL");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_THOUGHT_RESULT");
    expect(runner.cancelCalls).toEqual([ensureRequest.botId]);
    await session.close();
    expect(releases).toEqual([
      { status: "failed", code: "malformed_provider_event", retryable: false },
    ]);
  });

  test("cancels an active run and reports once-only canceled cleanup", async () => {
    const runner = new FakeRunner();
    const started = deferred<void>();
    const stopped = deferred<PromptResult>();
    const releases: Array<GrokRuntimeReleaseOutcome | undefined> = [];
    runner.promptImpl = async () => {
      started.resolve();
      return stopped.promise;
    };
    runner.cancelImpl = () => {
      stopped.resolve({ stopReason: "cancelled", assistantText: "PRIVATE_CANCEL_RESULT" });
    };
    const session = await new GrokRuntimeProvider(
      makeHost(runner, (_request, outcome) => {
        releases.push(outcome);
      }),
    ).createSession(sessionRequest);
    const work = collect(session.run(promptRequest));
    await started.promise;

    await session.cancel("user requested stop");
    const events = await work;
    expect(events).toEqual([
      {
        type: "failed",
        data: { code: "canceled", message: "Grok runtime run was canceled", retryable: false },
      },
    ]);
    expect(runner.cancelCalls).toEqual([ensureRequest.botId]);
    await session.close();
    await session.close();
    expect(releases).toEqual([{ status: "canceled", reason: "user requested stop" }]);
  });
});
