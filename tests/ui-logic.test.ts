import { describe, expect, test } from "bun:test";
import { SPA_JS } from "../apps/server/src/spa.ts";

function extractFn(src: string, name: string): string {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  if (src.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  const brace = src.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} not closed`);
}

function loadFn<T extends (...args: never[]) => unknown>(name: string, extras: Record<string, unknown> = {}): T {
  const src = extractFn(SPA_JS, name);
  const keys = Object.keys(extras);
  const vals = keys.map((k) => extras[k]);
  return new Function(...keys, `${src}; return ${name};`)(...vals) as T;
}

describe("shipped desk UI helpers", () => {
  test("AG-UI reducer deterministically renders balanced canonical events", () => {
    const newRun = loadFn<(threadId: string, runId: string) => any>("newAgUiRunState");
    const reduce = loadFn<(state: any, event: any) => any>("reduceAgUiEvent");
    let run = newRun("thread-external", "run-external");
    const event = (type: string, seq: number, fields: Record<string, unknown> = {}) => ({
      type,
      metadata: { openbot: { seq } },
      ...fields,
    });
    for (const item of [
      event("RUN_STARTED", 1, { threadId: "thread-external", runId: "run-external" }),
      event("TEXT_MESSAGE_START", 2, { messageId: "message-1", role: "assistant" }),
      event("TEXT_MESSAGE_CONTENT", 3, { messageId: "message-1", delta: "Hello" }),
      event("REASONING_START", 4, { messageId: "reasoning-span" }),
      event("REASONING_MESSAGE_START", 4, { messageId: "reasoning-message", role: "reasoning" }),
      event("REASONING_MESSAGE_CONTENT", 4, { messageId: "reasoning-message", delta: "Safe summary" }),
      event("TOOL_CALL_START", 5, { toolCallId: "call-1", toolCallName: "search" }),
      event("TOOL_CALL_ARGS", 6, { toolCallId: "call-1", delta: '{"q":"docs"}' }),
      event("TOOL_CALL_END", 7, { toolCallId: "call-1" }),
      event("TOOL_CALL_RESULT", 7, { messageId: "result-1", toolCallId: "call-1", role: "tool", content: '{"ok":true}', metadata: { openbot: { seq: 7 }, outcome: "success" } }),
      event("ACTIVITY_SNAPSHOT", 8, { messageId: "activity-1", activityType: "openbot.run.activity", content: { label: "Working", progress: 0.5 }, replace: true }),
      event("TEXT_MESSAGE_END", 9, { messageId: "message-1" }),
      event("REASONING_MESSAGE_END", 9, { messageId: "reasoning-message" }),
      event("REASONING_END", 9, { messageId: "reasoning-span" }),
      event("RUN_FINISHED", 10, { threadId: "thread-external", runId: "run-external", outcome: { type: "success" } }),
    ]) run = reduce(run, item);

    expect(run.phase).toBe("completed");
    expect(run.lastSeq).toBe(10);
    expect(run.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "write", id: "message-1", text: "Hello", status: "completed" }),
      expect.objectContaining({ type: "thought", text: "Safe summary", status: "completed" }),
      expect.objectContaining({ type: "tool", id: "call-1", status: "success", input: '{"q":"docs"}', output: '{"ok":true}' }),
      expect.objectContaining({ type: "status", text: "Working", progress: 0.5 }),
      expect.objectContaining({ type: "status", text: "Turn finished" }),
    ]));
    expect(() => reduce(run, event("RUN_FINISHED", 11, { threadId: "thread-external", runId: "run-external", outcome: { type: "success" } }))).toThrow("outside an active run");
  });

  test("AG-UI reducer rejects raw/orphan events and materializes interrupts", () => {
    const newRun = loadFn<(threadId: string, runId: string) => any>("newAgUiRunState");
    const reduce = loadFn<(state: any, event: any) => any>("reduceAgUiEvent");
    expect(() => reduce(newRun("t", "r"), { type: "RAW", event: { private: true } })).toThrow("raw events are forbidden");
    expect(() => reduce(newRun("t", "r"), { type: "RUN_STARTED", threadId: "t", runId: "r", rawEvent: undefined })).toThrow("raw events are forbidden");

    let orphan = reduce(newRun("t", "r"), { type: "RUN_STARTED", threadId: "t", runId: "r" });
    expect(() => reduce(orphan, { type: "TEXT_MESSAGE_CONTENT", messageId: "missing", delta: "x" })).toThrow("no open message");

    let run = reduce(newRun("t", "r"), { type: "RUN_STARTED", threadId: "t", runId: "r" });
    run = reduce(run, { type: "TOOL_CALL_START", toolCallId: "call", toolCallName: "browser" });
    run = reduce(run, { type: "TOOL_CALL_ARGS", toolCallId: "call", delta: "{}" });
    run = reduce(run, { type: "TOOL_CALL_END", toolCallId: "call" });
    run = reduce(run, {
      type: "RUN_FINISHED",
      threadId: "t",
      runId: "r",
      outcome: { type: "interrupt", interrupts: [{ id: "interrupt-1", reason: "permission", message: "Allow browser?", toolCallId: "call", responseSchema: { type: "boolean" } }] },
    });
    expect(run.phase).toBe("interrupted");
    expect(run.interrupts).toEqual([expect.objectContaining({ id: "interrupt-1", message: "Allow browser?" })]);
    expect(run.blocks.find((block: any) => block.id === "call")?.status).toBe("needs permission");
  });

  test("AG-UI SSE parser handles chunked CRLF frames and fails malformed input", async () => {
    const parse = loadFn<(buffer: string, flush?: boolean) => { events: any[]; rest: string }>("parseAgUiSseFrames");
    const read = loadFn<(response: Response, onEvent: (event: any) => void) => Promise<void>>("readAgUiSse", { parseAgUiSseFrames: parse });
    const first = parse('data: {\r\ndata: "type":"RUN_STARTED",\r\ndata: "threadId":"t","runId":"r"}\r\n\r\n');
    expect(first.rest).toBe("");
    expect(first.events).toEqual([{ type: "RUN_STARTED", threadId: "t", runId: "r" }]);
    expect(() => parse("data: not-json\n\n")).toThrow("event is not JSON");
    expect(() => parse("x".repeat(2_097_153))).toThrow("too large");

    const bytes = new TextEncoder().encode('data: {"type":"RUN_ERROR","message":"nope"}\n\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 11));
        controller.enqueue(bytes.slice(11));
        controller.close();
      },
    });
    const received: any[] = [];
    await read(new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } }), (item) => { received.push(item); });
    expect(received).toEqual([{ type: "RUN_ERROR", message: "nope" }]);
  });

  test("human DMs use AG-UI while push remains a resource invalidation channel", () => {
    expect(SPA_JS).toContain("/ag-ui/v1/run");
    expect(SPA_JS).toContain("/ag-ui/v1/runs/");
    expect(SPA_JS).toContain("/v1/agents/");
    expect(SPA_JS).toContain("/conversation");
    expect(SPA_JS).toContain("X-OpenBot-Agent-ID");
    expect(SPA_JS).not.toContain("agent_thought_chunk");
    expect(SPA_JS).not.toContain("agent_message_chunk");
    expect(SPA_JS).not.toContain("tool_call_update");
    expect(SPA_JS).not.toContain("rawInput");
    expect(SPA_JS).not.toContain("rawOutput");
    expect(SPA_JS).not.toContain("/live-work");
    expect(SPA_JS).not.toContain('id="live-raw"');
    const push = extractFn(SPA_JS, "connectPush");
    expect(push).toContain("agent.conversation.updated");
    expect(push).toContain("void reloadThread()");
    expect(push).not.toContain("message.created");
    expect(push).not.toContain("turn.updated");
    expect(push).not.toContain("live_work");
    expect(push).not.toContain("permission_request");
    const post = extractFn(SPA_JS, "postAgUiRun");
    expect(post).toContain("method:'POST'");
    const cancel = extractFn(SPA_JS, "cancelAgUiRun");
    expect(cancel).toContain("method:'DELETE'");
    expect(cancel).not.toContain("/v1/turns/");
    const learn = extractFn(SPA_JS, "learnThis");
    expect(learn).toContain("state.view === 'human'");
    expect(learn).toContain("{ agentId:state.bot.id }");
    expect(learn).toContain("{ threadId:state.thread.id }");
  });

  test("A2A is a connection surface and Gateway cannot become a human-chat principal", () => {
    const render = extractFn(SPA_JS, "renderApp");
    const boot = extractFn(SPA_JS, "boot");
    const principalById = extractFn(SPA_JS, "principalById");
    const newGroup = extractFn(SPA_JS, "openNewGroup");
    const bookmarks = extractFn(SPA_JS, "openOrgs");
    const settings = extractFn(SPA_JS, "openSettings");

    expect(render).not.toContain("open-gateway");
    expect(render).not.toContain("gatewayPin");
    expect(render).not.toContain("gwSelected");
    expect(boot).not.toContain("last === state.gateway.id");
    expect(principalById).not.toContain("state.gateway");
    expect(newGroup).not.toContain("state.gateway");
    expect(SPA_JS).not.toContain("openbot/Gateway");
    expect(SPA_JS).toContain("A2A");
    expect(SPA_JS).toContain("/.well-known/agent-card.json");
    expect(SPA_JS).toContain("/a2a/v1");
    expect(SPA_JS).toContain("openbot-orgs");
    expect(bookmarks).toContain("loadOrgBookmarks");
    expect(bookmarks).toContain("stored only in this browser");
    for (const source of [render, bookmarks, settings]) {
      expect(source).not.toContain("Federation");
      expect(source).not.toContain("federationEnabled");
      expect(source).not.toContain("/v1/org/peers");
      expect(source).not.toContain("/v1/org/inbox");
      expect(source).not.toContain("/fed/v1/info");
      expect(source).not.toContain("peer-from-info");
      expect(source).not.toContain("solicit-list");
    }
  });

  test("AG-UI context and request identifiers remain stable across reloads", () => {
    const store: Record<string, string> = {};
    const localStorage = {
      getItem(key: string) { return store[key] ?? null; },
      setItem(key: string, value: string) { store[key] = value; },
    };
    let sequence = 0;
    const newAgUiId = (kind: string) => `external-${kind}-${++sequence}`;
    const agUiContextKey = loadFn<(botId: string, threadId: string) => string>("agUiContextKey");
    const saveAgUiContext = loadFn<(context: any) => void>("saveAgUiContext", { localStorage });
    const loadAgUiContext = loadFn<(botId: string, threadId: string) => any>("loadAgUiContext", {
      agUiContextKey,
      localStorage,
      newAgUiId,
      saveAgUiContext,
    });
    const first = loadAgUiContext("internal-bot", "internal-thread");
    first.taskId = "external-task-1";
    first.started = true;
    first.lastRunId = "external-run-1";
    saveAgUiContext(first);
    const restored = loadAgUiContext("internal-bot", "internal-thread");
    expect(restored.threadId).toBe(first.threadId);
    expect(restored.taskId).toBe(first.taskId);
    expect(restored.lastRunId).toBe("external-run-1");
    expect(sequence).toBe(1);

    const input = loadFn<(context: any, runId: string, parentRunId: string | null, message: any, resume: any[] | null, taskId: string | null) => any>("agUiRequestInput");
    expect(input(restored, "external-run-2", "external-run-1", null, [{ interruptId: "i", status: "resolved", payload: true }], restored.taskId)).toMatchObject({
      threadId: first.threadId,
      runId: "external-run-2",
      parentRunId: "external-run-1",
      forwardedProps: { openbot: { taskId: first.taskId } },
      resume: [{ interruptId: "i", status: "resolved", payload: true }],
      tools: [],
      context: [],
    });

    const applyContext = loadFn<(context: any, run: any, event: any) => any>("applyAgUiContextEvent");
    restored.active = true;
    applyContext(restored, { phase: "interrupted", lastSeq: 8 }, { type: "RUN_FINISHED" });
    expect(restored.taskId).toBe("external-task-1");
    expect(restored.interrupted).toBe(true);
    restored.active = true;
    applyContext(restored, { phase: "completed", lastSeq: 9 }, { type: "RUN_FINISHED" });
    expect(restored.taskId).toBeNull();
    expect(restored.interrupted).toBe(false);
    const firstNormal = input(restored, "normal-run-1", null, { id: "normal-message-1", body: "first" }, null, null);
    const secondNormal = input(restored, "normal-run-2", null, { id: "normal-message-2", body: "second" }, null, null);
    expect(firstNormal.threadId).toBe(secondNormal.threadId);
    expect(firstNormal.runId).not.toBe(secondNormal.runId);
    expect(firstNormal.forwardedProps).toBeUndefined();
    expect(secondNormal.forwardedProps).toBeUndefined();
    expect(secondNormal.messages).toEqual([{ id: "normal-message-2", role: "user", content: "second" }]);
  });

  test("canonical conversation bootstrap owns human history and active context", () => {
    const context: any = {
      storageKey: "cache",
      threadId: "cached-thread",
      taskId: null,
      started: false,
      active: false,
      interrupted: false,
      lastRunId: null,
      lastSeq: 0,
    };
    const saved: any[] = [];
    const adopt = loadFn<(context: any, conversation: any) => any[]>("adoptAgUiConversation", {
      newAgUiId: () => "new-thread",
      saveAgUiContext: (value: any) => saved.push({ ...value }),
    });
    const messages = adopt(context, {
      threadId: "server-thread",
      messages: [
        { id: "message-user", role: "user", body: "hello", createdAt: 10 },
        { id: "message-agent", role: "assistant", body: "hi", createdAt: 11 },
      ],
      pendingNotifications: [
        { id: "message-pending", body: "approve me", createdAt: 12 },
      ],
      active: {
        taskId: "server-task",
        runId: "server-run",
        status: "input_required",
        lastSeq: 7,
        interrupts: [{ id: "interrupt" }],
      },
    });
    expect(context).toMatchObject({
      threadId: "server-thread",
      taskId: "server-task",
      lastRunId: "server-run",
      lastSeq: 7,
      active: false,
      interrupted: true,
    });
    expect(messages).toEqual([
      expect.objectContaining({ id: "message-user", role: "user", origin: "user", body: "hello", _agUi: true }),
      expect.objectContaining({ id: "message-agent", role: "assistant", origin: "ag-ui", body: "hi", _agUi: true }),
      expect.objectContaining({ id: "message-pending", role: "assistant", origin: "pending_approval", body: "approve me" }),
    ]);
    adopt(context, { threadId: "server-thread", messages: [], active: null });
    expect(context.taskId).toBeNull();
    expect(context.lastRunId).toBeNull();
    expect(context.interrupted).toBe(false);
    expect(saved.length).toBe(2);

    const reload = extractFn(SPA_JS, "reloadThread");
    expect(reload).toContain("fetchAgUiConversation(botId)");
    expect(reload).toContain("adoptAgUiConversation");
  });

  test("AG-UI POST and cancel use the canonical routes and agent header", async () => {
    const requests: Array<{ path: string; options: RequestInit }> = [];
    const context = { botId: "agent-internal" };
    const state: Record<string, unknown> = { agUiAbort: null, agUiContext: context, agUiRun: { phase: "active", runId: "external/run" } };
    const fetch = async (path: string, options: RequestInit = {}) => {
      requests.push({ path, options });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const post = loadFn<(context: any, input: any, run: any) => Promise<any>>("postAgUiRun", {
      state,
      fetch,
      currentAgUiOwner: () => true,
      consumeAgUiResponse: async (_response: Response, _context: unknown, run: unknown) => run,
    });
    await post(context, { threadId: "thread", runId: "run" }, { phase: "idle" });
    expect(requests[0]?.path).toBe("/ag-ui/v1/run");
    expect(requests[0]?.options.method).toBe("POST");
    expect((requests[0]?.options.headers as Record<string, string>)["X-OpenBot-Agent-ID"]).toBe("agent-internal");
    expect((requests[0]?.options.headers as Record<string, string>).accept).toBe("text/event-stream");

    const cancel = loadFn<() => Promise<void>>("cancelAgUiRun", {
      state,
      fetch,
      agUiHttpError: async () => new Error("failed"),
      announce: () => undefined,
    });
    await cancel();
    expect(requests[1]?.path).toBe("/ag-ui/v1/runs/external%2Frun");
    expect(requests[1]?.options.method).toBe("DELETE");
    expect((requests[1]?.options.headers as Record<string, string>)["X-OpenBot-Agent-ID"]).toBe("agent-internal");
  });

  test("visibleMessages drops prompt and calendar", () => {
    const visibleMessages = loadFn<(list: Array<{ origin: string }>) => Array<{ origin: string }>>("visibleMessages");
    const out = visibleMessages([
      { origin: "user" },
      { origin: "send_message" },
      { origin: "prompt" },
      { origin: "calendar" },
      { origin: "fallback" },
    ]);
    expect(out.map((m) => m.origin)).toEqual(["user", "send_message", "fallback"]);
  });

  test("deskChipText is quiet copy, never Writing", () => {
    const deskChipText = loadFn<(blocks: unknown[], harness?: string) => string>("deskChipText");
    expect(deskChipText([], "idle")).toBe("");
    expect(deskChipText([], undefined)).toBe("");
    expect(deskChipText([], "in_turn")).toBe("Working on the desk…");
    expect(deskChipText([], "starting")).toBe("Working on the desk…");
    expect(deskChipText([{ type: "thought", text: "hmm" }])).toBe("Working on the desk…");
    expect(deskChipText([{ type: "write", text: "hello" }])).toBe("Working on the desk…");
    expect(deskChipText([{ type: "tool", title: "SendMessage", status: "running" }])).toBe("Working on the desk…");
    expect(deskChipText([{ type: "status", text: "Needs permission" }])).toBe("Needs permission");
    expect(deskChipText([{ type: "status", text: "Turn finished" }])).toBe("");
    expect(deskChipText([{ type: "write", text: "x" }, { type: "status", text: "Turn finished" }])).toBe("");
    expect(JSON.stringify([
      deskChipText([], "in_turn"),
      deskChipText([{ type: "write" }]),
      deskChipText([{ type: "thought" }]),
    ])).not.toContain("Writing");
  });

  test("applyTheme writes light/dark/system without renderApp", () => {
    const dataset: Record<string, string> = {};
    const metas: Array<{ name: string; media?: string; content?: string }> = [];
    const document = {
      documentElement: { dataset },
      head: { appendChild(n: { name: string }) { metas.push(n); } },
      querySelector(sel: string) {
        if (sel.includes("theme-color") && sel.includes("not([media])")) {
          return metas.find((m) => m.name === "theme-color" && !m.media) || null;
        }
        return null;
      },
      createElement() {
        const node: { name: string; media?: string; content?: string; setAttribute: (k: string, v: string) => void } = {
          name: "",
          setAttribute(k, v) {
            if (k === "name") node.name = v;
            else (node as unknown as Record<string, string>)[k] = v;
          },
        };
        return node;
      },
    };
    const store: Record<string, string> = {};
    const localStorage = {
      getItem(k: string) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k]! : null; },
      setItem(k: string, v: string) { store[k] = String(v); },
    };
    const window = { matchMedia: (q: string) => ({ matches: q.includes("prefers-color-scheme: light") ? false : false }) };
    const applyTheme = loadFn<(value: string, persist?: boolean) => void>("applyTheme", { document, localStorage, window });
    applyTheme("light");
    expect(store["openbot-theme"]).toBe("light");
    expect(dataset.theme).toBe("light");
    applyTheme("dark");
    expect(dataset.theme).toBe("dark");
    applyTheme("system");
    expect(store["openbot-theme"]).toBe("system");
    expect(dataset.theme).toBeUndefined();
    const src = extractFn(SPA_JS, "applyTheme");
    expect(src).not.toContain("renderApp");
  });

  test("toggleDebug sets storage and inert, does not renderApp", () => {
    const state = { debug: false };
    const side = {
      inert: true,
      setAttribute(name: string, value: string) { if (name === "inert") this.inert = true; void value; },
      removeAttribute(name: string) { if (name === "inert") this.inert = false; },
    };
    const btn = { pressed: "false", setAttribute(name: string, value: string) { if (name === "aria-pressed") this.pressed = value; } };
    const dataset: Record<string, string> = {};
    const document = {
      documentElement: { dataset },
      getElementById(id: string) { return id === "side" ? side : id === "debug-mode" ? btn : null; },
    };
    const store: Record<string, string> = {};
    const localStorage = {
      getItem(k: string) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k]! : null; },
      setItem(k: string, v: string) { store[k] = String(v); },
    };
    const toggleDebug = loadFn<(on: boolean) => void>("toggleDebug", { state, document, localStorage });
    toggleDebug(true);
    expect(state.debug).toBe(true);
    expect(store["openbot-debug"]).toBe("1");
    expect(dataset.debug).toBe("1");
    expect(side.inert).toBe(false);
    expect(btn.pressed).toBe("true");
    toggleDebug(false);
    expect(state.debug).toBe(false);
    expect(store["openbot-debug"]).toBe("0");
    expect(dataset.debug).toBe("0");
    expect(side.inert).toBe(true);
    expect(btn.pressed).toBe("false");
    expect(extractFn(SPA_JS, "toggleDebug")).not.toContain("renderApp");
  });
});
