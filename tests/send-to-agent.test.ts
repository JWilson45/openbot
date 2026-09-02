import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OpenbotDb, id, now, orderedBotPair, sha256Hex } from "@openbot/db";
import { insertMessage } from "@openbot/live-work";
import type { A2aCompleteEvent } from "@openbot/api-types";
import { deskIdentityRules, gatewayIdentityRules } from "@openbot/acp-grok";
import { handleMcpJsonRpc, McpInflight, persistMcpToken, SEND_TO_AGENT_TOOL } from "@openbot/mcp-send-message";
import { insertTurn, seedWorld, fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

async function waitOrigin(origin: string, headers: Record<string, string>, botId: string, pred: (m: { origin: string; body: string }) => boolean) {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const t = (await fetch(`${origin}/v1/threads?botId=${botId}`, { headers }).then((r) => r.json())) as {
      messages: Array<{ origin: string; body: string }>;
    };
    if ((t.messages || []).some(pred)) return t.messages;
    await Bun.sleep(80);
  }
  throw new Error("timeout");
}

describe("SendToAgent mailbox", () => {
  test("Ada sendto Bob; Bob SendMessage lands on Bob human DM; Ada DM unchanged", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const ada = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada", description: "research" }),
    }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
    const bob = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Bob", description: "writer" }),
    }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-a2akey0001" }),
    });
    const posted = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[sendto:Bob:write a draft]] [[send:I asked Bob]]" }),
    });
    expect(posted.status).toBe(202);
    const adaMsgs = await waitOrigin(origin, headers, ada.bot.id, (m) => m.origin === "send_message");
    expect(adaMsgs.some((m) => m.body === "I asked Bob")).toBe(true);

    const a2a = (await fetch(`${origin}/v1/threads?kind=a2a&botId=${ada.bot.id}`, { headers }).then((r) =>
      r.json(),
    )) as { threads: Array<{ id: string }> };
    expect(a2a.threads.length).toBe(1);
    const handoff = (await fetch(`${origin}/v1/threads/${a2a.threads[0]!.id}`, { headers }).then((r) =>
      r.json(),
    )) as { messages: Array<{ origin: string; body: string }> };
    expect(handoff.messages.some((m) => m.origin === "agent" && m.body.includes("write a draft"))).toBe(true);

    const bobHuman = await waitOrigin(origin, headers, bob.bot.id, (m) => m.origin === "send_message");
    expect(bobHuman.some((m) => m.body.includes("write a draft"))).toBe(true);
    expect(adaMsgs.filter((m) => m.body.includes("write a draft") && m.origin === "agent").length).toBe(0);
    expect(bobHuman.some((m) => m.origin === "agent")).toBe(false);
    server.stop(true);
  });
});

function rpc(json: unknown): {
  result?: { content?: Array<{ text?: string }> };
  error?: { message?: string; data?: { code?: string } };
} {
  return json as {
    result?: { content?: Array<{ text?: string }> };
    error?: { message?: string; data?: { code?: string } };
  };
}

async function call(
  db: OpenbotDb,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const inflight = new McpInflight();
  return handleMcpJsonRpc(db, inflight, `Bearer ${token}`, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function insertPeer(db: OpenbotDb, accountId: string, computeId: string, name: string, status = "active") {
  const botId = id();
  const threadId = id();
  const harnessSessionId = id();
  const t = now();
  db.run(
    `INSERT INTO bots (id, account_id, name, description, status, permission_mode, created_at)
     VALUES (?, ?, ?, 'teammate', ?, 'auto', ?)`,
    [botId, accountId, name, status, t],
  );
  if (status === "archived") db.run("UPDATE bots SET archived_at = ? WHERE id = ?", [t, botId]);
  db.run(
    `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, 't', 'human', ?)`,
    [threadId, accountId, botId, t],
  );
  db.run(
    `INSERT INTO harness_sessions (id, compute_id, bot_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`,
    [harnessSessionId, computeId, botId, t],
  );
  persistMcpToken(
    db,
    { accountId, botId, threadId, harnessSessionId },
    sha256Hex("ob_sess_peer_" + botId),
  );
  return { botId, threadId, harnessSessionId };
}

function parseA2aComplete(body: string): A2aCompleteEvent {
  const jsonAt = body.indexOf("{");
  return JSON.parse(body.slice(jsonAt)) as A2aCompleteEvent;
}

describe("SendToAgent overlay", () => {
  test("identity overlay says queued is not done and names typed errors", () => {
    const desk = deskIdentityRules("Ada", "research");
    const gw = gatewayIdentityRules("alpha", "org-id");
    for (const rules of [desk, gw]) {
      expect(rules).toMatch(/queued, not done/i);
      expect(rules).toMatch(/Typed errors/i);
      expect(rules).toContain("1:1 handoff");
    }
    expect(SEND_TO_AGENT_TOOL.description).not.toMatch(/ListBots/);
    expect(SEND_TO_AGENT_TOOL.description).toContain("CreateBot");
  });
});

describe("SendToAgent typed errors", () => {
  test("Ghost is not_found; archived Bob is target_archived; sixth queued is target_busy; self is bad_request; message is prefixed", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    insertTurn(db, w, "running");
    const bob = insertPeer(db, w.accountId, w.computeId, "Bob");

    const ghost = await call(db, w.token, "SendToAgent", { name: "Ghost", body: "hi" });
    expect(ghost.status).toBe(404);
    expect(rpc(ghost.json).error?.data?.code).toBe("not_found");
    expect(rpc(ghost.json).error?.message).toMatch(/^not_found:/);
    expect(rpc(ghost.json).error?.message).toContain("CreateBot");
    expect(rpc(ghost.json).error?.message).toContain("/auth/local");
    expect(rpc(ghost.json).error?.message).not.toMatch(/Call ListBots/i);

    const archivedByName = insertPeer(db, w.accountId, w.computeId, "Archie", "archived");
    const archName = await call(db, w.token, "SendToAgent", { name: "Archie", body: "hi" });
    expect(archName.status).toBe(409);
    expect(rpc(archName.json).error?.data?.code).toBe("target_archived");
    expect(rpc(archName.json).error?.message).toMatch(/^target_archived:/);
    expect(rpc(archName.json).error?.message).not.toMatch(/^Call CreateBot/i);

    const archId = await call(db, w.token, "SendToAgent", { botId: archivedByName.botId, body: "hi" });
    expect(archId.status).toBe(409);
    expect(rpc(archId.json).error?.data?.code).toBe("target_archived");

    const self = await call(db, w.token, "SendToAgent", { name: "Ada", body: "hi" });
    expect(self.status).toBe(400);
    expect(rpc(self.json).error?.data?.code).toBe("bad_request");
    expect(rpc(self.json).error?.message).toMatch(/^bad_request:/);

    for (let i = 0; i < 5; i++) {
      const turnId = id();
      db.run(
        `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, created_at)
         VALUES (?, ?, ?, 'queued', 0, '', ?)`,
        [turnId, bob.threadId, bob.botId, now()],
      );
    }
    const busy = await call(db, w.token, "SendToAgent", { name: "Bob", body: "hi" });
    expect(busy.status).toBe(429);
    expect(rpc(busy.json).error?.data?.code).toBe("target_busy");
    expect(rpc(busy.json).error?.message).toMatch(/^target_busy:/);
    db.close();
  });
});

describe("A2A queued cancel and archive", () => {
  test("queued HTTP cancel writes cancel complete and does not promote", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const ada = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    }).then((r) => r.json())) as { bot: { id: string } };
    const bob = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Bob" }),
    }).then((r) => r.json())) as { bot: { id: string } };
    const [lo, hi] = orderedBotPair(ada.bot.id, bob.bot.id);
    const threadId = id();
    const turnId = id();
    const t = now();
    ctx.db.run(
      `INSERT INTO threads (id, account_id, bot_id, title, kind, peer_bot_id, created_at)
       VALUES (?, ?, ?, ?, 'a2a', ?, ?)`,
      [threadId, ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [ada.bot.id])!.account_id, lo, `${lo}↔${hi}`, hi, t],
    );
    ctx.db.run(
      `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, created_at)
       VALUES (?, ?, ?, 'queued', 0, '', ?)`,
      [turnId, threadId, bob.bot.id, t],
    );
    insertMessage(ctx.db, {
      threadId,
      turnId,
      role: "user",
      origin: "agent",
      body: "please draft",
      fromBotId: ada.bot.id,
    });
    const cancelled = await fetch(`${origin}/v1/turns/${turnId}/cancel`, { method: "POST", headers });
    expect(cancelled.status).toBe(200);
    const turn = ctx.db.get<{ status: string; promote_reason: string | null }>(
      "SELECT status, promote_reason FROM turns WHERE id = ?",
      [turnId],
    );
    expect(turn?.status).toBe("cancelled");
    expect(turn?.promote_reason).toBeNull();
    const row = ctx.db.get<{ body: string; origin: string }>(
      `SELECT body, origin FROM messages WHERE turn_id = ? AND origin = 'system' AND body LIKE 'A2A complete:%'`,
      [turnId],
    );
    expect(row).toBeTruthy();
    const ev = parseA2aComplete(row!.body);
    expect(ev.code).toBe("cancel");
    expect(ev.status).toBe("cancelled");
    expect(ev.promoteReason).toBeNull();
    server.stop(true);
  });

  test("running HTTP cancel onPushes the A2A complete row", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const ada = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    }).then((r) => r.json())) as { bot: { id: string } };
    const bob = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Bob" }),
    }).then((r) => r.json())) as { bot: { id: string } };
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [
      ada.bot.id,
    ])!.account_id;
    const [lo, hi] = orderedBotPair(ada.bot.id, bob.bot.id);
    const threadId = id();
    const turnId = id();
    const t = now();
    ctx.db.run(
      `INSERT INTO threads (id, account_id, bot_id, title, kind, peer_bot_id, created_at)
       VALUES (?, ?, ?, ?, 'a2a', ?, ?)`,
      [threadId, accountId, lo, `${lo}↔${hi}`, hi, t],
    );
    ctx.db.run(
      `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, created_at)
       VALUES (?, ?, ?, 'running', 0, '', ?)`,
      [turnId, threadId, bob.bot.id, t],
    );
    insertMessage(ctx.db, {
      threadId,
      turnId,
      role: "user",
      origin: "agent",
      body: "please draft",
      fromBotId: ada.bot.id,
    });

    const pushed: Array<{ type?: string; turnId?: string; message?: { origin?: string; body?: string } }> = [];
    const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/v1/push`, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("push websocket failed")));
    });
    ws.addEventListener("message", (ev) => {
      pushed.push(JSON.parse(String(ev.data)) as { type?: string; turnId?: string; message?: { origin?: string; body?: string } });
    });

    const cancelled = await fetch(`${origin}/v1/turns/${turnId}/cancel`, { method: "POST", headers });
    expect(cancelled.status).toBe(200);
    const start = Date.now();
    while (
      Date.now() - start < 2000 &&
      !pushed.some((e) => e.message?.body?.startsWith("A2A complete:"))
    ) {
      await Bun.sleep(20);
    }
    ws.close();
    const turn = ctx.db.get<{ status: string; promote_reason: string | null }>(
      "SELECT status, promote_reason FROM turns WHERE id = ?",
      [turnId],
    );
    expect(turn?.status).toBe("cancelled");
    expect(turn?.promote_reason).toBe("empty_turn");
    const row = ctx.db.get<{ body: string }>(
      `SELECT body FROM messages WHERE turn_id = ? AND origin = 'system' AND body LIKE 'A2A complete:%'`,
      [turnId],
    );
    expect(row).toBeTruthy();
    expect(parseA2aComplete(row!.body).code).toBe("cancel");
    expect(pushed.some((e) => e.type === "message.created" && e.message?.body?.startsWith("A2A complete:"))).toBe(
      true,
    );
    expect(pushed.some((e) => e.type === "turn.updated" && e.turnId === turnId)).toBe(true);
    server.stop(true);
  });

  test("archive of a queued mailbox turn writes target_archived and onPush", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const ada = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    }).then((r) => r.json())) as { bot: { id: string } };
    const bob = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Bob" }),
    }).then((r) => r.json())) as { bot: { id: string } };
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [
      ada.bot.id,
    ])!.account_id;
    const [lo, hi] = orderedBotPair(ada.bot.id, bob.bot.id);
    const threadId = id();
    const turnId = id();
    const t = now();
    ctx.db.run(
      `INSERT INTO threads (id, account_id, bot_id, title, kind, peer_bot_id, created_at)
       VALUES (?, ?, ?, ?, 'a2a', ?, ?)`,
      [threadId, accountId, lo, `${lo}↔${hi}`, hi, t],
    );
    ctx.db.run(
      `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, created_at)
       VALUES (?, ?, ?, 'queued', 0, '', ?)`,
      [turnId, threadId, bob.bot.id, t],
    );
    insertMessage(ctx.db, {
      threadId,
      turnId,
      role: "user",
      origin: "agent",
      body: "please draft",
      fromBotId: ada.bot.id,
    });

    const pushed: Array<{ type?: string; message?: { origin?: string; body?: string } }> = [];
    const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/v1/push`, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("push websocket failed")));
    });
    ws.addEventListener("message", (ev) => {
      pushed.push(JSON.parse(String(ev.data)) as { type?: string; message?: { origin?: string; body?: string } });
    });

    const arch = await fetch(`${origin}/v1/bots/${bob.bot.id}/archive`, { method: "POST", headers });
    expect(arch.status).toBe(200);
    const start = Date.now();
    while (Date.now() - start < 2000 && !pushed.some((e) => e.message?.body?.startsWith("A2A complete:"))) {
      await Bun.sleep(20);
    }
    ws.close();
    const row = ctx.db.get<{ body: string }>(
      `SELECT body FROM messages WHERE turn_id = ? AND origin = 'system' AND body LIKE 'A2A complete:%'`,
      [turnId],
    );
    expect(row).toBeTruthy();
    const ev = parseA2aComplete(row!.body);
    expect(ev.code).toBe("target_archived");
    expect(ev.status).toBe("cancelled");
    expect(ev.fromBotId).toBe(bob.bot.id);
    expect(ev.toBotId).toBe(ada.bot.id);
    expect(pushed.some((e) => e.type === "message.created" && e.message?.body?.startsWith("A2A complete:"))).toBe(
      true,
    );
    server.stop(true);
  });
});
