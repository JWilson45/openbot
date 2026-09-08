import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";
import { Role, TaskState, type Message, type SendMessageRequest, type StreamResponse } from "@a2a-js/sdk";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";

const homes: string[] = [];
const servers: Array<{ stop(close?: boolean): void }> = [];
const originalCommand = process.env.OPENBOT_ACP_COMMAND;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  if (originalCommand === undefined) delete process.env.OPENBOT_ACP_COMMAND;
  else process.env.OPENBOT_ACP_COMMAND = originalCommand;
});

function decodeEvents(text: string): Array<{ type: string; [key: string]: unknown }> {
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      expect(frame.startsWith("data: ")).toBe(true);
      const value = JSON.parse(frame.slice(6)) as { type?: unknown; [key: string]: unknown };
      if (typeof value.type !== "string") throw new TypeError("AG-UI event type is missing");
      return value as { type: string; [key: string]: unknown };
    });
}

async function createDeskAgent(origin: string, cookie: string, name: string): Promise<string> {
  const response = await fetch(`${origin}/v1/bots`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name, description: "Protocol runtime test desk agent" }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { bot: { id: string } }).bot.id;
}

describe("protocol-to-runtime composition", () => {
  test("executes an authenticated AG-UI run through the canonical queue and Grok adapter", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const home = tempHome();
    homes.push(home);
    const created = startTestServer({ home });
    servers.push(created.server);
    const { cookie } = loginCookie(created, "runtime-integration");
    const agent = { id: await createDeskAgent(created.origin, cookie, "RuntimeDesk") };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("runtime integration timed out"), 15_000);
    let response: Response;
    try {
      response = await fetch(`${created.origin}/ag-ui/v1/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Cookie: cookie,
          "X-OpenBot-Agent-ID": agent!.id,
        },
        body: JSON.stringify({
          threadId: "runtime-thread",
          runId: "runtime-run",
          state: {},
          messages: [{ id: "runtime-message", role: "user", content: "hello from AG-UI" }],
          tools: [],
          context: [],
          forwardedProps: {},
        }),
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const raw = await response.text();
      const events = decodeEvents(raw);
      if (events.some((event) => event.type === "RUN_ERROR")) {
        const stored = created.ctx.db.all<{ event_json: string }>(
          "SELECT event_json FROM task_events ORDER BY seq",
        );
        throw new Error(`${raw}\n${stored.map((row) => row.event_json).join("\n")}`);
      }
      expect(events.map((event) => event.type)).toEqual([
        "RUN_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "RUN_FINISHED",
      ]);
      expect(raw).not.toContain("agent_message_chunk");
      expect(raw).not.toContain("agent_thought_chunk");
    } finally {
      clearTimeout(timeout);
    }

    expect(created.ctx.db.get<{ status: string }>(
      "SELECT status FROM agent_tasks ORDER BY created_at DESC LIMIT 1",
    )?.status).toBe("completed");
    expect(created.ctx.db.get<{ status: string }>(
      "SELECT status FROM agent_runs ORDER BY created_at DESC LIMIT 1",
    )?.status).toBe("completed");
    expect(created.ctx.db.get<{ status: string }>(
      "SELECT status FROM turns WHERE agent_task_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )?.status).toBe("completed");

    const historyResponse = await fetch(`${created.origin}/v1/agents/${agent!.id}/conversation`, {
      headers: { Cookie: cookie },
    });
    expect(historyResponse.status).toBe(200);
    expect(historyResponse.headers.get("cache-control")).toContain("no-store");
    const history = await historyResponse.json() as {
      conversation: { threadId: string; messages: Array<{ id: string; role: string; body: string }>; active: unknown };
    };
    expect(history.conversation.threadId).toBe("runtime-thread");
    expect(history.conversation.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(history.conversation.messages[0]?.body).toBe("hello from AG-UI");
    expect(history.conversation.messages[1]?.body).toBe("hello from AG-UI");
    expect(history.conversation.messages[1]?.body).not.toContain("working:");
    expect(history.conversation.active).toBeNull();
    expect(JSON.stringify(history)).not.toContain(created.ctx.db.get<{ id: string }>(
      "SELECT id FROM agent_tasks ORDER BY created_at DESC LIMIT 1",
    )!.id);

    const followUpResponse = await fetch(`${created.origin}/ag-ui/v1/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Cookie: cookie,
        "X-OpenBot-Agent-ID": agent!.id,
      },
      body: JSON.stringify({
        threadId: "runtime-thread",
        runId: "runtime-run-2",
        state: {},
        messages: [{ id: "runtime-message-2", role: "user", content: "reply normally [[send:proactive notice]]" }],
        tools: [],
        context: [],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(followUpResponse.status).toBe(200);
    const followUpEvents = decodeEvents(await followUpResponse.text());
    expect(followUpEvents.at(-1)?.type).toBe("RUN_FINISHED");
    expect(JSON.stringify(followUpEvents)).not.toContain("mcp_error");
    expect(created.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks")?.n).toBe(2);

    const reloaded = await fetch(`${created.origin}/v1/agents/${agent!.id}/conversation`, {
      headers: { Cookie: cookie },
    }).then((result) => result.json()) as typeof history;
    expect(reloaded.conversation.threadId).toBe("runtime-thread");
    expect(reloaded.conversation.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "assistant",
    ]);
    expect(reloaded.conversation.messages[2]?.body).toBe("reply normally [[send:proactive notice]]");
    expect(reloaded.conversation.messages.slice(3).map((message) => message.body).sort()).toEqual([
      "proactive notice",
      "reply normally",
    ]);
    expect(reloaded.conversation.messages.slice(3).every((message) => !message.body.includes("mcp_error"))).toBe(true);
    expect(reloaded.conversation.messages.slice(3).every((message) => !message.body.includes("working:"))).toBe(true);
    expect(reloaded.conversation.active).toBeNull();
  }, 20_000);

  test("pauses a Grok permission as an AG-UI interrupt and resumes the same provider turn", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const home = tempHome();
    homes.push(home);
    const created = startTestServer({ home });
    servers.push(created.server);
    const { cookie } = loginCookie(created, "runtime-permission");
    const agentId = await createDeskAgent(created.origin, cookie, "PermissionDesk");
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Cookie: cookie,
      "X-OpenBot-Agent-ID": agentId,
    };
    const initialMessage = { id: "permission-message", role: "user", content: "[[permission]]" };
    const first = await fetch(`${created.origin}/ag-ui/v1/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        threadId: "permission-thread",
        runId: "permission-task",
        state: {},
        messages: [initialMessage],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(first.status).toBe(200);
    const firstEvents = decodeEvents(await first.text());
    const interrupted = firstEvents.find((event) =>
      event.type === "RUN_FINISHED" &&
      (event.outcome as { type?: string } | undefined)?.type === "interrupt");
    expect(interrupted).toBeDefined();
    const interruptId = ((interrupted!.outcome as {
      interrupts: Array<{ id: string }>;
    }).interrupts[0]!).id;

    const interruptedBootstrap = await fetch(
      `${created.origin}/v1/agents/${agentId}/conversation`,
      { headers: { Cookie: cookie } },
    ).then((result) => result.json()) as {
      conversation: {
        active: {
          taskId: string;
          runId: string;
          status: string;
          interrupts: Array<{ id: string }>;
        };
      };
    };
    expect(interruptedBootstrap.conversation.active).toMatchObject({
      taskId: "permission-task",
      runId: "permission-task",
      status: "input_required",
    });
    expect(interruptedBootstrap.conversation.active.interrupts.map((item) => item.id)).toEqual([
      interruptId,
    ]);

    const resumed = await fetch(`${created.origin}/ag-ui/v1/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        threadId: "permission-thread",
        runId: "permission-run-two",
        state: {},
        messages: [initialMessage],
        tools: [],
        context: [],
        forwardedProps: { openbot: { taskId: "permission-task" } },
        resume: [{ interruptId, status: "resolved", payload: true }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(resumed.status).toBe(200);
    const resumedEvents = decodeEvents(await resumed.text());
    expect(resumedEvents.at(0)?.type).toBe("RUN_STARTED");
    expect(resumedEvents.at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { type: "success" },
    });
    expect(created.ctx.db.get<{ status: string }>(
      "SELECT status FROM agent_tasks ORDER BY created_at DESC LIMIT 1",
    )?.status).toBe("completed");
    expect(created.ctx.db.get<{ attempts: number }>(
      "SELECT COUNT(*) AS attempts FROM agent_runs WHERE task_id = (SELECT id FROM agent_tasks ORDER BY created_at DESC LIMIT 1)",
    )?.attempts).toBe(2);
  }, 30_000);

  test("executes an authenticated official A2A stream through the canonical queue and Grok adapter", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const home = tempHome();
    homes.push(home);
    const created = startTestServer({ home });
    servers.push(created.server);
    const { cookie, session } = loginCookie(created, "runtime-a2a");

    // The test server learns its ephemeral port after createApp. Rewrite only
    // that test-only :0 card URL while retaining the official client's wire.
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const incoming = new Request(input, init);
      const url = new URL(incoming.url);
      if (url.hostname === "127.0.0.1" && url.port === "0") {
        const live = new URL(created.origin);
        url.protocol = live.protocol;
        url.host = live.host;
      }
      const headers = new Headers(incoming.headers);
      headers.set("A2A-Version", "1.0");
      if (url.pathname === "/a2a/v1") headers.set("Authorization", `Bearer ${session.token}`);
      return fetch(new Request(url, {
        method: incoming.method,
        headers,
        body: incoming.body,
        redirect: incoming.redirect,
        signal: incoming.signal,
        ...(incoming.body === null ? {} : { duplex: "half" }),
      } as RequestInit));
    }) as typeof fetch;
    const resolver = new DefaultAgentCardResolver({ fetchImpl });
    const client = await new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
      cardResolver: resolver,
    }).createFromUrl(created.origin);
    const message: Message = {
      messageId: "runtime-a2a-message",
      contextId: "",
      taskId: "",
      role: Role.ROLE_USER,
      parts: [{
        content: { $case: "text", value: "hello from A2A" },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      }],
      metadata: { source: "official-sdk" },
      extensions: [],
      referenceTaskIds: [],
    };
    const request: SendMessageRequest = {
      tenant: "",
      message,
      configuration: {
        acceptedOutputModes: ["text/plain"],
        taskPushNotificationConfig: undefined,
        historyLength: 10,
        returnImmediately: false,
      },
      metadata: {},
    };
    const received: StreamResponse[] = [];
    for await (const event of client.sendMessageStream(request, {
      signal: AbortSignal.timeout(15_000),
    })) {
      received.push(event);
    }

    expect(received[0]?.payload?.$case).toBe("task");
    const statuses = received.flatMap((event) =>
      event.payload?.$case === "statusUpdate"
        ? [event.payload.value.status?.state]
        : []
    );
    expect(statuses).toContain(TaskState.TASK_STATE_WORKING);
    expect(statuses.at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(created.ctx.db.get<{ status: string }>(
      "SELECT status FROM agent_tasks ORDER BY created_at DESC LIMIT 1",
    )?.status).toBe("completed");
    expect(created.ctx.db.get<{ status: string }>(
      "SELECT status FROM turns WHERE agent_task_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )?.status).toBe("completed");
    const a2aReply = created.ctx.db.get<{ parts_json: string }>(
      `SELECT parts_json FROM agent_messages
       WHERE task_id IS NOT NULL AND role = 'agent' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(a2aReply && JSON.parse(a2aReply.parts_json)).toEqual([{ kind: "text", text: "hello from A2A" }]);

    const gatewayId = created.ctx.db.get<{ id: string }>(
      "SELECT id FROM bots WHERE IFNULL(role, 'desk') = 'gateway' AND status = 'active' LIMIT 1",
    )!.id;
    const localConversation = await fetch(`${created.origin}/v1/agents/${gatewayId}/conversation`, {
      headers: { Cookie: cookie },
    });
    expect(localConversation.status).toBe(404);
  }, 30_000);
});
