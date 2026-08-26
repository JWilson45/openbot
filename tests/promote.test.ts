import { describe, expect, test } from "bun:test";
import { OpenbotDb, id, now } from "@openbot/db";
import { appendLiveWork, buildThreadDigest, parseLivePayload, promote, wrapPromptWithDigest } from "@openbot/live-work";
import { McpError } from "@openbot/api-types";
import { handleMcpJsonRpc, McpInflight, sendMessage, sendToThread } from "@openbot/mcp-send-message";
import { insertTurn, seedWorld, tempHome, type World } from "./helpers.ts";
import { join } from "node:path";

function openDb() {
  return OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
}

function insertBot(db: OpenbotDb, w: World, name: string): string {
  const botId = id();
  const t = now();
  db.run(
    `INSERT INTO bots (id, account_id, name, description, status, permission_mode, created_at)
     VALUES (?, ?, ?, 'teammate', 'active', 'auto', ?)`,
    [botId, w.accountId, name, t],
  );
  db.run(
    `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, 't', 'human', ?)`,
    [id(), w.accountId, botId, t],
  );
  return botId;
}

function insertGroup(db: OpenbotDb, w: World, botIds: string[], title: string): string {
  const groupId = id();
  const t = now();
  db.run(
    `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, ?, 'group', ?)`,
    [groupId, w.accountId, botIds[0]!, title, t],
  );
  db.run(
    `INSERT INTO thread_participants (id, thread_id, kind, user_id, bot_id, created_at)
     VALUES (?, ?, 'human', ?, NULL, ?)`,
    [id(), groupId, w.userId, t],
  );
  for (const botId of botIds) {
    db.run(
      `INSERT INTO thread_participants (id, thread_id, kind, user_id, bot_id, created_at)
       VALUES (?, ?, 'bot', NULL, ?, ?)`,
      [id(), groupId, botId, t],
    );
  }
  return groupId;
}

describe("live-work payload clipping", () => {
  test("oversized payloads store valid JSON and parse without throwing", () => {
    const db = openDb();
    const w = seedWorld(db);
    const turnId = insertTurn(db, w, "running");
    appendLiveWork(db, turnId, "agent_thought_chunk", {
      update: { content: { text: "x".repeat(80_000) } },
    });
    const row = db.get<{ payload: string }>("SELECT payload FROM live_work_events WHERE turn_id = ?", [turnId]);
    expect(row?.payload).toBeTruthy();
    const stored = JSON.parse(row!.payload) as { truncated?: boolean };
    expect(stored.truncated).toBe(true);
    expect(parseLivePayload('{"update":')).toEqual({ truncated: true });
  });
});

describe("SendMessage + promote (shipped path)", () => {
  test("SendMessage accepts string arguments and message/text aliases", () => {
    const db = openDb();
    const w = seedWorld(db);
    insertTurn(db, w, "running");
    const inflight = new McpInflight();
    const a = sendMessage(db, inflight, `Bearer ${w.token}`, JSON.stringify({ body: "from-json-string" }));
    expect(a.ok).toBe(true);
    const turn2 = insertTurn(db, w, "running");
    const b = sendMessage(db, inflight, `Bearer ${w.token}`, { text: "from-text-alias" });
    expect(b.ok).toBe(true);
    const bodies = db
      .all<{ body: string }>("SELECT body FROM messages WHERE origin = 'send_message' ORDER BY created_at")
      .map((m) => m.body);
    expect(bodies).toContain("from-json-string");
    expect(bodies).toContain("from-text-alias");
    expect(turn2).toBeTruthy();
  });

  test("successful SendMessage inserts origin send_message; acp_done with telemetry 0 does not fallback", () => {
    const db = openDb();
    const w = seedWorld(db);
    const turnId = insertTurn(db, w, "running");
    const inflight = new McpInflight();
    const result = sendMessage(db, inflight, `Bearer ${w.token}`, { body: "hello from bot" });
    expect(result.ok).toBe(true);
    promote(db, turnId, { kind: "acp_done", telemetrySentMessageCount: 0, assistantText: "leftover working text" });
    const msgs = db.all<{ origin: string; body: string }>(
      "SELECT origin, body FROM messages WHERE turn_id = ?",
      [turnId],
    );
    expect(msgs.filter((m) => m.origin === "send_message").length).toBe(1);
    expect(msgs.filter((m) => m.origin === "fallback").length).toBe(0);
    expect(msgs[0]?.body).toBe("hello from bot");
    const turn = db.get<{ status: string; sent_message_count: number }>("SELECT status, sent_message_count FROM turns WHERE id = ?", [
      turnId,
    ]);
    expect(turn?.status).toBe("completed");
    expect(turn?.sent_message_count).toBe(1);
  });

  test("turn-end with no send_message promotes swallowed assistant text as fallback", () => {
    const db = openDb();
    const w = seedWorld(db);
    const turnId = insertTurn(db, w, "running");
    promote(db, turnId, { kind: "acp_done", assistantText: "I ramble privately", telemetrySentMessageCount: 99 });
    const msgs = db.all<{ origin: string; body: string; role: string }>(
      "SELECT origin, body, role FROM messages WHERE turn_id = ?",
      [turnId],
    );
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.origin).toBe("fallback");
    expect(msgs[0]?.role).toBe("assistant");
    expect(msgs[0]?.body).toContain("I ramble privately");
    const turn = db.get<{ promote_reason: string }>("SELECT promote_reason FROM turns WHERE id = ?", [turnId]);
    expect(turn?.promote_reason).toBe("no_send_message");
  });

  test("runner-supplied send count is ignored when DB has zero", () => {
    const db = openDb();
    const w = seedWorld(db);
    const turnId = insertTurn(db, w, "running");
    promote(db, turnId, { kind: "acp_done", telemetrySentMessageCount: 99, assistantText: "still fallback" });
    const n = db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM messages WHERE turn_id = ? AND origin = 'fallback'",
      [turnId],
    );
    expect(n?.n).toBe(1);
  });

  test("insert without increment still counts as hasSend via origin row", () => {
    const db = openDb();
    const w = seedWorld(db);
    const turnId = insertTurn(db, w, "running");
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, created_at)
       VALUES ('m1', ?, ?, 'assistant', 'send_message', 'partial', 'normal', ?)`,
      [w.threadId, turnId, Date.now()],
    );
    promote(db, turnId, { kind: "acp_done", assistantText: "should not promote" });
    const fallback = db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM messages WHERE turn_id = ? AND origin = 'fallback'",
      [turnId],
    );
    expect(fallback?.n).toBe(0);
  });

  test("double acp_done is a no-op the second time", () => {
    const db = openDb();
    const w = seedWorld(db);
    const turnId = insertTurn(db, w, "running");
    promote(db, turnId, { kind: "acp_done", assistantText: "one" });
    promote(db, turnId, { kind: "acp_done", assistantText: "two" });
    const n = db.get<{ n: number }>("SELECT COUNT(*) as n FROM messages WHERE turn_id = ?", [turnId]);
    expect(n?.n).toBe(1);
  });

  test("empty turn with no SendMessage inserts origin=system", () => {
    const db = openDb();
    const w = seedWorld(db);
    const turnId = insertTurn(db, w, "running");
    promote(db, turnId, { kind: "acp_done" });
    const msg = db.get<{ origin: string }>("SELECT origin FROM messages WHERE turn_id = ?", [turnId]);
    expect(msg?.origin).toBe("system");
  });

  test("cancel + partial text, no SendMessage: fallback and cancelled", () => {
    const db = openDb();
    const w = seedWorld(db);
    const turnId = insertTurn(db, w, "running");
    promote(db, turnId, { kind: "cancel", assistantText: "halfway" });
    const turn = db.get<{ status: string; promote_reason: string }>(
      "SELECT status, promote_reason FROM turns WHERE id = ?",
      [turnId],
    );
    expect(turn?.status).toBe("cancelled");
    expect(turn?.promote_reason).toBe("cancel");
    const msg = db.get<{ origin: string }>("SELECT origin FROM messages WHERE turn_id = ?", [turnId]);
    expect(msg?.origin).toBe("fallback");
  });

  test("late SendMessage after promote does not attach to queued next turn", () => {
    const db = openDb();
    const w = seedWorld(db);
    const a = insertTurn(db, w, "running");
    const b = insertTurn(db, w, "queued");
    const inflight = new McpInflight();
    promote(db, a, { kind: "acp_done", assistantText: "done" });
    expect(() => sendMessage(db, inflight, `Bearer ${w.token}`, { body: "late" })).toThrow(McpError);
    try {
      sendMessage(db, inflight, `Bearer ${w.token}`, { body: "late" });
    } catch (err) {
      expect((err as McpError).code).toBe("no_active_turn");
    }
    const onB = db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM messages WHERE turn_id = ? AND origin = 'send_message'",
      [b],
    );
    expect(onB?.n).toBe(0);
    const onA = db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM messages WHERE turn_id = ? AND origin = 'send_message'",
      [a],
    );
    expect(onA?.n).toBe(0);
  });

  test("SendMessage attaches only to the running turn A", () => {
    const db = openDb();
    const w = seedWorld(db);
    const a = insertTurn(db, w, "running");
    insertTurn(db, w, "queued");
    const inflight = new McpInflight();
    sendMessage(db, inflight, `Bearer ${w.token}`, { body: "for A" });
    const onA = db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM messages WHERE turn_id = ? AND origin = 'send_message'",
      [a],
    );
    expect(onA?.n).toBe(1);
  });
});

describe("thread digest", () => {
  test("wraps prior human/bot lines and skips the current turn", () => {
    const db = openDb();
    const w = seedWorld(db);
    const old = insertTurn(db, w, "completed");
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, created_at)
       VALUES (?, ?, ?, 'user', 'user', 'remember the pineapple', 'normal', ?)`,
      ["m1", w.threadId, old, 1],
    );
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, created_at)
       VALUES (?, ?, ?, 'assistant', 'send_message', 'pineapple is great', 'normal', ?)`,
      ["m2", w.threadId, old, 2],
    );
    const current = insertTurn(db, w, "queued");
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, created_at)
       VALUES (?, ?, ?, 'user', 'user', 'what did I say?', 'normal', ?)`,
      ["m3", w.threadId, current, 3],
    );
    const digest = buildThreadDigest(db, {
      threadId: w.threadId,
      botId: w.botId,
      botName: "Ada",
      excludeTurnId: current,
    });
    expect(digest).toContain("Human: remember the pineapple");
    expect(digest).toContain("You: pineapple is great");
    expect(digest).not.toContain("what did I say?");
    expect(digest).toContain("Do not tell the human this is a new session");
    const wrapped = wrapPromptWithDigest(digest, "what did I say?");
    expect(wrapped.endsWith("Current message:\nwhat did I say?")).toBe(true);
    expect(wrapPromptWithDigest(null, " hello ")).toBe("hello");
  });

  test("uses from_bot_id for peer thread/send_message; includes federation; skips prompt", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bobId = insertBot(db, w, "Bob");
    const groupId = insertGroup(db, w, [w.botId, bobId], "Design");
    const old = insertTurn(db, w, "completed", { threadId: groupId });
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, from_bot_id, created_at)
       VALUES (?, ?, ?, 'assistant', 'thread', 'ada spoke', 'normal', ?, ?)`,
      ["m-self", groupId, old, w.botId, 1],
    );
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, from_bot_id, created_at)
       VALUES (?, ?, ?, 'assistant', 'thread', 'bob spoke', 'normal', ?, ?)`,
      ["m-bob-thread", groupId, old, bobId, 2],
    );
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, from_bot_id, created_at)
       VALUES (?, ?, ?, 'assistant', 'send_message', 'bob dm in group', 'normal', ?, ?)`,
      ["m-bob-send", groupId, old, bobId, 3],
    );
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, from_bot_id, created_at)
       VALUES (?, ?, ?, 'user', 'federation', 'mail from peer org', 'normal', NULL, ?)`,
      ["m-fed", groupId, old, 4],
    );
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, from_bot_id, created_at)
       VALUES (?, ?, ?, 'user', 'prompt', 'secret prompt clone', 'normal', NULL, ?)`,
      ["m-prompt", groupId, old, 5],
    );
    const current = insertTurn(db, w, "queued", { threadId: groupId });
    const digest = buildThreadDigest(db, {
      threadId: groupId,
      botId: w.botId,
      botName: "Ada",
      excludeTurnId: current,
    });
    expect(digest).toContain("You: ada spoke");
    expect(digest).toContain("Bob: bob spoke");
    expect(digest).toContain("Bob: bob dm in group");
    expect(digest).toContain("Org: mail from peer org");
    expect(digest).not.toContain("secret prompt clone");
  });
});

describe("SendToThread + group promote", () => {
  test("tools/list includes SendToThread and server is 0.3.0", async () => {
    const db = openDb();
    seedWorld(db);
    const inflight = new McpInflight();
    const init = await handleMcpJsonRpc(db, inflight, undefined, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(
      (init.json as { result: { serverInfo: { version: string } } }).result.serverInfo.version,
    ).toBe("0.3.0");
    const list = await handleMcpJsonRpc(db, inflight, undefined, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = (
      list.json as { result: { tools: Array<{ name: string }> } }
    ).result.tools.map((t) => t.name);
    expect(tools).toContain("SendMessage");
    expect(tools).toContain("SendToAgent");
    expect(tools).toContain("SendToThread");
  });

  test("fallback on a group turn lands on the group; human DM untouched", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bobId = insertBot(db, w, "Bob");
    const groupId = insertGroup(db, w, [w.botId, bobId], "Design");
    const turnId = insertTurn(db, w, "running", { threadId: groupId });
    promote(db, turnId, { kind: "acp_done", assistantText: "ramble on group" });
    const fb = db.get<{ thread_id: string; origin: string }>(
      "SELECT thread_id, origin FROM messages WHERE turn_id = ?",
      [turnId],
    );
    expect(fb?.origin).toBe("fallback");
    expect(fb?.thread_id).toBe(groupId);
    const dm = db.get<{ n: number }>("SELECT COUNT(*) as n FROM messages WHERE thread_id = ?", [
      w.threadId,
    ]);
    expect(dm?.n).toBe(0);
  });

  test("origin=thread increments sent_message_count so hasSend is true", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bobId = insertBot(db, w, "Bob");
    const groupId = insertGroup(db, w, [w.botId, bobId], "Design");
    const turnId = insertTurn(db, w, "running", { threadId: groupId });
    const inflight = new McpInflight();
    const result = sendToThread(db, inflight, `Bearer ${w.token}`, { body: "hello group" });
    expect(result.ok).toBe(true);
    const msg = db.get<{ thread_id: string; origin: string; from_bot_id: string | null }>(
      "SELECT thread_id, origin, from_bot_id FROM messages WHERE origin = 'thread'",
    );
    expect(msg?.thread_id).toBe(groupId);
    expect(msg?.from_bot_id).toBe(w.botId);
    promote(db, turnId, { kind: "acp_done", assistantText: "leftover working text" });
    const fallback = db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM messages WHERE turn_id = ? AND origin = 'fallback'",
      [turnId],
    );
    expect(fallback?.n).toBe(0);
    const turn = db.get<{ sent_message_count: number }>(
      "SELECT sent_message_count FROM turns WHERE id = ?",
      [turnId],
    );
    expect(turn?.sent_message_count).toBe(1);
  });

  test("omitting threadId uses the running group turn, not claims.threadId", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bobId = insertBot(db, w, "Bob");
    const groupId = insertGroup(db, w, [w.botId, bobId], "Design");
    insertTurn(db, w, "running", { threadId: groupId });
    const inflight = new McpInflight();
    sendToThread(db, inflight, `Bearer ${w.token}`, { body: "spoke in group" });
    const threadMsg = db.get<{ thread_id: string; origin: string }>(
      "SELECT thread_id, origin FROM messages WHERE body = 'spoke in group'",
    );
    expect(threadMsg?.origin).toBe("thread");
    expect(threadMsg?.thread_id).toBe(groupId);
    expect(threadMsg?.thread_id).not.toBe(w.threadId);
    const dm = db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM messages WHERE thread_id = ? AND body = 'spoke in group'",
      [w.threadId],
    );
    expect(dm?.n).toBe(0);
  });

  test("mentions queue origin=prompt rows for other bots and skip self", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bobId = insertBot(db, w, "Bob");
    const caraId = insertBot(db, w, "Cara");
    const groupId = insertGroup(db, w, [w.botId, bobId, caraId], "Design");
    const turnId = insertTurn(db, w, "running", { threadId: groupId });
    const inflight = new McpInflight();
    const result = sendToThread(db, inflight, `Bearer ${w.token}`, {
      body: "@Ada @Bob @Cara please both",
    });
    expect(result.turnIds.length).toBe(2);
    const prompts = db.all<{ bot_id: string; origin: string; body: string }>(
      `SELECT t.bot_id, m.origin, m.body FROM messages m
       JOIN turns t ON t.id = m.turn_id
       WHERE m.origin = 'prompt' AND m.thread_id = ?`,
      [groupId],
    );
    expect(prompts.length).toBe(2);
    expect(prompts.every((p) => p.body.length > 0)).toBe(true);
    expect(prompts.map((p) => p.bot_id).sort()).toEqual([bobId, caraId].sort());
    expect(
      db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM turns WHERE thread_id = ? AND bot_id = ? AND id != ?",
        [groupId, w.botId, turnId],
      )?.n,
    ).toBe(0);
  });
});
