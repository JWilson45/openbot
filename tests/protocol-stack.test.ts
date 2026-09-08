import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";
import { tempHome } from "./helpers.ts";
import { id, now } from "@openbot/db";
import { mintMcpToken, persistMcpToken } from "@openbot/mcp-send-message";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { enqueueHumanNotification } from "../apps/server/src/protocol-stack.ts";
import { insertMessage } from "@openbot/live-work";

const homes: string[] = [];
const servers: Array<{ stop(close?: boolean): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function createDeskAgent(origin: string, cookie: string, name: string): Promise<string> {
  const response = await fetch(`${origin}/v1/bots`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name, description: "Protocol composition test desk agent" }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { bot: { id: string } }).bot.id;
}

describe("canonical protocol composition", () => {
  test("exposes approval intents separately and publishes only an approved notification", async () => {
    const home = tempHome();
    homes.push(home);
    const created = startTestServer({ home });
    servers.push(created.server);
    const { cookie, session } = loginCookie(created, "notification-approval");
    const bot = { id: await createDeskAgent(created.origin, cookie, "NoticeDesk") };
    const thread = created.ctx.db.get<{ id: string }>(
      "SELECT id FROM threads WHERE account_id = ? AND bot_id = ? AND kind = 'human' ORDER BY created_at LIMIT 1",
      [session.accountId, bot.id],
    )!;
    const rejected = insertMessage(created.ctx.db, {
      threadId: thread.id,
      turnId: null,
      role: "assistant",
      origin: "pending_approval",
      body: "reject this",
      urgency: "needs_user",
      fromBotId: bot.id,
    });
    const pending = await fetch(`${created.origin}/v1/agents/${bot.id}/conversation`, {
      headers: { Cookie: cookie },
    }).then((response) => response.json()) as {
      conversation: { messages: unknown[]; pendingNotifications: Array<{ id: string; body: string }> };
    };
    expect(pending.conversation.messages).toEqual([]);
    expect(pending.conversation.pendingNotifications).toEqual([
      { id: rejected.id, body: "reject this", createdAt: rejected.created_at },
    ]);
    expect((await fetch(`${created.origin}/v1/messages/${rejected.id}/reject`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    })).status).toBe(200);

    const approved = insertMessage(created.ctx.db, {
      threadId: thread.id,
      turnId: null,
      role: "assistant",
      origin: "pending_approval",
      body: "approve this",
      urgency: "needs_user",
      fromBotId: bot.id,
    });
    expect((await fetch(`${created.origin}/v1/messages/${approved.id}/approve`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    })).status).toBe(200);
    await created.ctx.protocols.processAgentNotifications();
    const final = await fetch(`${created.origin}/v1/agents/${bot.id}/conversation`, {
      headers: { Cookie: cookie },
    }).then((response) => response.json()) as {
      conversation: { messages: Array<{ body: string }>; pendingNotifications: unknown[] };
    };
    expect(final.conversation.pendingNotifications).toEqual([]);
    expect(final.conversation.messages.map((message) => message.body)).toEqual(["approve this"]);
    expect(created.ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM application_outbox WHERE topic = 'human.notification.publish'",
    )?.n).toBe(1);
  });

  test("retries durable human notifications idempotently after a transient projection failure", async () => {
    const home = tempHome();
    homes.push(home);
    const created = startTestServer({ home });
    servers.push(created.server);
    const { cookie, session } = loginCookie(created, "notification-projector");
    const bot = { id: await createDeskAgent(created.origin, cookie, "ProjectorDesk") };
    const thread = created.ctx.db.get<{ id: string }>(
      "SELECT id FROM threads WHERE account_id = ? AND bot_id = ? AND kind = 'human' ORDER BY created_at LIMIT 1",
      [session.accountId, bot.id],
    )!;
    const messageId = id();
    const createdAt = now();
    created.ctx.db.immediate(() => {
      enqueueHumanNotification(created.ctx.db, {
        version: 1,
        accountId: session.accountId,
        agentId: bot.id,
        legacyMessageId: messageId,
        legacyThreadId: thread.id,
        body: "durable notice",
        createdAt,
      });
      created.ctx.db.run(
        "UPDATE application_outbox SET available_at = ? WHERE id = ?",
        [createdAt + 60_000, `human.notification.publish:${messageId}`],
      );
    });

    const publish = created.ctx.protocols.publishAgentNotification;
    created.ctx.protocols.publishAgentNotification = async () => { throw new Error("temporary projector failure"); };
    created.ctx.db.run(
      "UPDATE application_outbox SET available_at = 0 WHERE id = ?",
      [`human.notification.publish:${messageId}`],
    );
    expect(await created.ctx.protocols.processAgentNotifications()).toBe(0);
    expect(created.ctx.db.get<{ attempts: number; delivered_at: number | null; last_error: string | null }>(
      "SELECT attempts, delivered_at, last_error FROM application_outbox WHERE id = ?",
      [`human.notification.publish:${messageId}`],
    )).toMatchObject({ attempts: 1, delivered_at: null, last_error: "temporary projector failure" });

    created.ctx.protocols.publishAgentNotification = publish;
    created.ctx.db.run(
      "UPDATE application_outbox SET available_at = 0 WHERE id = ?",
      [`human.notification.publish:${messageId}`],
    );
    expect(await created.ctx.protocols.processAgentNotifications()).toBe(1);
    expect(await created.ctx.protocols.processAgentNotifications()).toBe(0);
    expect(created.ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agent_messages WHERE id = ? AND thread_id = ? AND created_at = ?",
      [messageId, thread.id, createdAt],
    )?.n).toBe(1);
  });

  test("mounts modern MCP only and authenticates before action dispatch", async () => {
    const home = tempHome();
    homes.push(home);
    const created = startTestServer({ home });
    servers.push(created.server);
    const old = await fetch(`${created.origin}/mcp/v1`, { method: "POST", body: "{}" });
    expect(old.status).toBe(404);
    const get = await fetch(`${created.origin}/mcp`);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const unauthorized = await fetch(`${created.origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(unauthorized.status).toBe(401);
  });

  test("serves the live principal-scoped action catalog to the official MCP client", async () => {
    const home = tempHome();
    homes.push(home);
    const created = startTestServer({ home });
    servers.push(created.server);
    const { session } = loginCookie(created, "mcp-stack");
    const bot = created.ctx.db.get<{ id: string }>(
      "SELECT id FROM bots WHERE account_id = ? AND status = 'active' ORDER BY created_at LIMIT 1",
      [session.accountId],
    )!;
    const thread = created.ctx.db.get<{ id: string }>(
      "SELECT id FROM threads WHERE account_id = ? AND bot_id = ? ORDER BY created_at LIMIT 1",
      [session.accountId, bot.id],
    )!;
    const compute = created.ctx.db.get<{ id: string }>(
      "SELECT id FROM compute_instances WHERE account_id = ?",
      [session.accountId],
    )!;
    const harnessId = id();
    const turnId = id();
    const minted = mintMcpToken();
    created.ctx.db.immediate(() => {
      created.ctx.db.run(
        "INSERT INTO harness_sessions(id, compute_id, bot_id, state, created_at) VALUES (?, ?, ?, 'active', ?)",
        [harnessId, compute.id, bot.id, now()],
      );
      created.ctx.db.run(
        `INSERT INTO turns(id, thread_id, bot_id, harness_session_id, status, started_at, created_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?)`,
        [turnId, thread.id, bot.id, harnessId, now(), now()],
      );
      persistMcpToken(created.ctx.db, {
        accountId: session.accountId,
        botId: bot.id,
        threadId: thread.id,
        harnessSessionId: harnessId,
      }, minted.hash);
    });

    const client = new Client(
      { name: "openbot-stack-test", version: "1.0.0" },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: "2026-07-28" } },
        supportedProtocolVersions: ["2026-07-28"],
        enforceStrictCapabilities: true,
      },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${created.origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${minted.token}` } },
    }));
    try {
      const catalog = await client.listTools();
      expect(catalog.tools.length).toBeGreaterThan(0);
      expect(catalog.tools.every((tool) => typeof tool.name === "string" && tool.inputSchema.type === "object")).toBe(true);
      expect(catalog.tools.map((tool) => tool.name)).not.toContain("SendToOrg");
      expect(catalog.tools.map((tool) => tool.name)).not.toContain("Inbox");
    } finally {
      await client.close();
    }
  });

  test("mounts authenticated AG-UI and signed attachment routes", async () => {
    const home = tempHome();
    homes.push(home);
    const created = startTestServer({ home });
    servers.push(created.server);
    const agui = await fetch(`${created.origin}/ag-ui/v1/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-OpenBot-Agent-ID": crypto.randomUUID(),
      },
      body: JSON.stringify({
        threadId: "thread-client",
        runId: "run-client",
        state: {},
        messages: [{ id: "message-client", role: "user", content: "Hello" }],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    });
    expect(agui.status).toBe(401);
    expect((await agui.json()) as object).toMatchObject({ error: { code: "unauthenticated" } });
    const conversation = await fetch(
      `${created.origin}/v1/agents/${crypto.randomUUID()}/conversation`,
    );
    expect(conversation.status).toBe(401);
    expect(await conversation.json()).toMatchObject({
      error: { code: "unauthenticated" },
    });
    const attachment = await fetch(
      `${created.origin}/v1/attachments/${crypto.randomUUID()}?account=${crypto.randomUUID()}&expires=${Date.now() + 10000}&sig=nope`,
    );
    expect(attachment.status).toBe(403);
  });

  test("publishes the Gateway A2A 1.0 card and authenticates JSON-RPC before task dispatch", async () => {
    const home = tempHome();
    homes.push(home);
    const created = startTestServer({ home });
    servers.push(created.server);
    loginCookie(created, "a2a-test");

    const cardResponse = await fetch(`${created.origin}/.well-known/agent-card.json`, {
      headers: { "A2A-Version": "1.0" },
    });
    expect(cardResponse.status).toBe(200);
    expect(cardResponse.headers.get("a2a-version")).toBe("1.0");
    const card = await cardResponse.json() as {
      supportedInterfaces: Array<{ url: string }>;
    };
    expect(card).toMatchObject({
      name: "Gateway",
      supportedInterfaces: [{
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      }],
      capabilities: { streaming: true, pushNotifications: false },
    });
    expect(new URL(card.supportedInterfaces[0]!.url).pathname).toBe("/a2a/v1");

    const unauthorized = await fetch(`${created.origin}/a2a/v1`, {
      method: "POST",
      headers: { "A2A-Version": "1.0", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: {} }),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");

    const legacyInfo = await fetch(`${created.origin}/fed/v1/info`);
    const legacyMessage = await fetch(`${created.origin}/fed/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(legacyInfo.status).toBe(404);
    expect(legacyMessage.status).toBe(404);
  });
});
