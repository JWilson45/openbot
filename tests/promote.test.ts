import { describe, expect, test } from "bun:test";
import { OpenbotDb, id, now, orderedBotPair, sha256Hex } from "@openbot/db";
import {
  appendLiveWork,
  buildThreadDigest,
  buildThreadMemory,
  formatThreadDigest,
  insertMessage,
  parseLivePayload,
  promote,
  refreshThreadSummary,
  summarizeLiveEvent,
  wrapPromptWithDigest,
} from "@openbot/live-work";
import { assembleTurnPrompt } from "../apps/server/src/engine.ts";
import { McpError, type A2aCompleteEvent } from "@openbot/api-types";
import {
  handleMcpJsonRpc,
  McpInflight,
  persistMcpToken,
  sendMessage,
  sendToAgent,
  sendToThread,
} from "@openbot/mcp-send-message";
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
    expect(digest).toContain("Recent:");
    expect(digest).toContain("Human: remember the pineapple");
    expect(digest).toContain("You: pineapple is great");
    expect(digest).not.toContain("Earlier (summary):");
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

  test("folds 25 eligible messages into Earlier summary plus Recent tail", () => {
    const db = openDb();
    const w = seedWorld(db);
    const old = insertTurn(db, w, "completed");
    for (let i = 1; i <= 25; i++) {
      const body =
        i === 1 ? "unique-early-phrase-quince" : i === 25 ? "unique-newest-phrase-durian" : `filler-${i}`;
      db.run(
        `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, created_at)
         VALUES (?, ?, ?, 'user', 'user', ?, 'normal', ?)`,
        [`m-old-${i}`, w.threadId, old, body, i],
      );
    }
    refreshThreadSummary(db, w.threadId);
    const current = insertTurn(db, w, "queued");
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, created_at)
       VALUES (?, ?, ?, 'user', 'user', 'unique-current-phrase-currant', 'normal', ?)`,
      ["m-current", w.threadId, current, 26],
    );
    const digest = buildThreadDigest(db, {
      threadId: w.threadId,
      botId: w.botId,
      botName: "Ada",
      excludeTurnId: current,
    });
    expect(digest).toContain("Earlier (summary):");
    expect(digest).toContain("Recent:");
    const earlier = digest!.split("Recent:")[0]!;
    const recent = digest!.split("Recent:")[1]!;
    expect(earlier).toContain("unique-early-phrase-quince");
    expect(recent).not.toContain("unique-early-phrase-quince");
    expect(recent).toContain("unique-newest-phrase-durian");
    expect(earlier).not.toContain("unique-newest-phrase-durian");
    expect(digest).not.toContain("unique-current-phrase-currant");
  });

  test("group summary stores Ada not You when Bob cold-starts", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bobId = insertBot(db, w, "Bob");
    const groupId = insertGroup(db, w, [w.botId, bobId], "Design");
    const old = insertTurn(db, w, "completed", { threadId: groupId, botId: w.botId });
    for (let i = 1; i <= 25; i++) {
      const body = i === 1 ? "unique-ada-early-kumquat" : `ada-filler-${i}`;
      db.run(
        `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, from_bot_id, created_at)
         VALUES (?, ?, ?, 'assistant', 'thread', ?, 'normal', ?, ?)`,
        [`m-ada-${i}`, groupId, old, body, w.botId, i],
      );
    }
    const current = insertTurn(db, w, "queued", { threadId: groupId, botId: bobId });
    const digest = buildThreadDigest(db, {
      threadId: groupId,
      botId: bobId,
      botName: "Bob",
      excludeTurnId: current,
    });
    const earlier = digest!.split("Recent:")[0]!;
    expect(earlier).toContain("Ada: unique-ada-early-kumquat");
    expect(earlier).not.toContain("You: unique-ada-early-kumquat");
    db.close();
  });

  test("prompt and calendar origins never appear in digest", () => {
    const db = openDb();
    const w = seedWorld(db);
    const old = insertTurn(db, w, "completed");
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, created_at)
       VALUES (?, ?, ?, 'user', 'user', 'visible pineapple', 'normal', ?)`,
      ["m-user", w.threadId, old, 1],
    );
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, created_at)
       VALUES (?, ?, ?, 'user', 'prompt', 'secret prompt clone', 'normal', ?)`,
      ["m-prompt", w.threadId, old, 2],
    );
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, created_at)
       VALUES (?, ?, ?, 'user', 'calendar', 'secret calendar fire', 'normal', ?)`,
      ["m-cal", w.threadId, old, 3],
    );
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, created_at)
       VALUES (?, ?, ?, 'assistant', 'send_message', 'pineapple is great', 'normal', ?)`,
      ["m-send", w.threadId, old, 4],
    );
    refreshThreadSummary(db, w.threadId);
    const current = insertTurn(db, w, "queued");
    const digest = buildThreadDigest(db, {
      threadId: w.threadId,
      botId: w.botId,
      botName: "Ada",
      excludeTurnId: current,
    });
    expect(digest).toContain("visible pineapple");
    expect(digest).toContain("pineapple is great");
    expect(digest).not.toContain("secret prompt clone");
    expect(digest).not.toContain("secret calendar fire");
    expect(digest).not.toContain("Earlier (summary):");
  });

  test("thread_switch digest always banners and never says ACP session reset", () => {
    const db = openDb();
    const w = seedWorld(db);
    const old = insertTurn(db, w, "completed");
    db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, created_at)
       VALUES (?, ?, ?, 'user', 'user', 'remember the pineapple', 'normal', ?)`,
      ["m-sw", w.threadId, old, 1],
    );
    const current = insertTurn(db, w, "queued");
    const memory = buildThreadMemory(db, {
      threadId: w.threadId,
      botId: w.botId,
      botName: "Ada",
      excludeTurnId: current,
    });
    const digest = formatThreadDigest({
      kind: "thread_switch",
      botName: "Ada",
      threadLabel: 'group "Design"',
      memory,
    });
    expect(digest).toContain("You are now on a different thread: group \"Design\".");
    expect(digest).toContain("Human: remember the pineapple");
    expect(digest).not.toContain("ACP session reset");
    expect(formatThreadDigest({
      kind: "thread_switch",
      botName: "Ada",
      threadLabel: "your DM with the human",
      memory: { summary: "", tailLines: [] },
    })).toContain("You are now on a different thread: your DM with the human.");
    expect(
      formatThreadDigest({
        kind: "cold_start",
        botName: "Ada",
        threadLabel: "",
        memory: { summary: "", tailLines: [] },
      }),
    ).toBeNull();
    db.close();
  });

  test("assembleTurnPrompt is calendar then group then user, one outer wrap", () => {
    const inner = assembleTurnPrompt({
      wrap: "none",
      userBody: "hello",
      groupTitle: "standup",
      calendarBlock: 'This turn was started by calendar event "ping" (schedule).',
    });
    expect(inner.indexOf("This turn was started by calendar event")).toBeLessThan(inner.indexOf('Group thread "standup"'));
    expect(inner.endsWith("hello")).toBe(true);
    expect(inner).not.toContain("Current message:");
    const switched = assembleTurnPrompt({
      wrap: "switch",
      userBody: "hello",
      groupTitle: "standup",
      digest: "You are now on a different thread: group \"standup\".",
    });
    expect(switched.startsWith("You are now on a different thread:")).toBe(true);
    expect(switched).toContain("Current message:");
    expect(switched.indexOf("You are now on a different thread:")).toBeLessThan(switched.indexOf("Current message:"));
    expect(switched.endsWith("hello")).toBe(true);
    const compacted = assembleTurnPrompt({
      wrap: "compact",
      userBody: "hello",
      digest: "ACP session reset. You are still Ada, same human, same desk.",
    });
    const cold = assembleTurnPrompt({
      wrap: "cold",
      userBody: "hello",
      digest: "ACP session reset. You are still Ada, same human, same desk.",
    });
    expect(compacted).toBe(cold);
    expect(compacted).toContain("ACP session reset");
    expect(compacted).not.toContain("You are now on a different thread");
  });


  test("thread_switch live-work summarizes as Switched thread", () => {
    expect(summarizeLiveEvent("thread_switch", { from: "a", to: "b" })).toBe("Switched thread");
    expect(summarizeLiveEvent("harness_session_reset", { reason: "compacted", trigger: "turns" })).toBe(
      "Context refreshed",
    );
    expect(summarizeLiveEvent("harness_session_reset", { reason: "cold_start" })).toBe("Harness restarted");
  });

  test("promote with send_message writes a thread_summaries row", () => {
    const db = openDb();
    const w = seedWorld(db);
    const turnId = insertTurn(db, w, "running");
    const inflight = new McpInflight();
    sendMessage(db, inflight, `Bearer ${w.token}`, { body: "hello from bot" });
    promote(db, turnId, { kind: "acp_done", telemetrySentMessageCount: 0, assistantText: "leftover" });
    const row = db.get<{ body: string; through_created_at: number; updated_at: number }>(
      "SELECT body, through_created_at, updated_at FROM thread_summaries WHERE thread_id = ?",
      [w.threadId],
    );
    expect(row).toBeTruthy();
    expect(row?.body).toBe("");
    expect(row?.through_created_at).toBe(0);
    expect(row?.updated_at).toBeGreaterThan(0);
  });
});

describe("SendToThread + group promote", () => {
  test("tools/list includes SendToThread and server is 0.6.0", async () => {
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
    ).toBe("0.6.0");
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

function parseA2aComplete(body: string): A2aCompleteEvent {
  expect(body.startsWith("A2A complete:")).toBe(true);
  const jsonAt = body.indexOf("{");
  expect(jsonAt).toBeGreaterThan(0);
  return JSON.parse(body.slice(jsonAt)) as A2aCompleteEvent;
}

function completeRows(db: OpenbotDb, opts: { turnId?: string; threadId?: string }) {
  if (opts.turnId) {
    return db.all<{ body: string; turn_id: string; from_bot_id: string | null; origin: string }>(
      `SELECT body, turn_id, from_bot_id, origin FROM messages
       WHERE turn_id = ? AND origin = 'system' AND body LIKE 'A2A complete:%'`,
      [opts.turnId],
    );
  }
  return db.all<{ body: string; turn_id: string; from_bot_id: string | null; origin: string }>(
    `SELECT body, turn_id, from_bot_id, origin FROM messages
     WHERE thread_id = ? AND origin = 'system' AND body LIKE 'A2A complete:%'
     ORDER BY created_at`,
    [opts.threadId],
  );
}

function insertDeskBot(db: OpenbotDb, w: World, name: string) {
  const botId = id();
  const threadId = id();
  const harnessSessionId = id();
  const token = "ob_sess_test_" + id().replaceAll("-", "");
  const t = now();
  db.run(
    `INSERT INTO bots (id, account_id, name, description, status, permission_mode, created_at)
     VALUES (?, ?, ?, 'teammate', 'active', 'auto', ?)`,
    [botId, w.accountId, name, t],
  );
  db.run(
    `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, 't', 'human', ?)`,
    [threadId, w.accountId, botId, t],
  );
  db.run(
    `INSERT INTO harness_sessions (id, compute_id, bot_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`,
    [harnessSessionId, w.computeId, botId, t],
  );
  persistMcpToken(db, { accountId: w.accountId, botId, threadId, harnessSessionId }, sha256Hex(token));
  return { botId, threadId, harnessSessionId, token };
}

function insertA2aMailbox(
  db: OpenbotDb,
  opts: {
    accountId: string;
    fromBotId: string;
    toBotId: string;
    status?: string;
    harnessSessionId?: string | null;
  },
) {
  const [lo, hi] = orderedBotPair(opts.fromBotId, opts.toBotId);
  let thread = db.get<{ id: string }>(
    "SELECT id FROM threads WHERE kind = 'a2a' AND account_id = ? AND bot_id = ? AND peer_bot_id = ?",
    [opts.accountId, lo, hi],
  );
  if (!thread) {
    const threadId = id();
    db.run(
      `INSERT INTO threads (id, account_id, bot_id, title, kind, peer_bot_id, created_at)
       VALUES (?, ?, ?, ?, 'a2a', ?, ?)`,
      [threadId, opts.accountId, lo, `${lo}↔${hi}`, hi, now()],
    );
    thread = { id: threadId };
  }
  const turnId = id();
  db.run(
    `INSERT INTO turns (id, thread_id, bot_id, harness_session_id, status, sent_message_count, assistant_text, created_at)
     VALUES (?, ?, ?, ?, ?, 0, '', ?)`,
    [turnId, thread.id, opts.toBotId, opts.harnessSessionId ?? null, opts.status ?? "running", now()],
  );
  insertMessage(db, {
    threadId: thread.id,
    turnId,
    role: "user",
    origin: "agent",
    body: "please do the thing",
    fromBotId: opts.fromBotId,
  });
  return { threadId: thread.id, turnId };
}

describe("A2A complete ping", () => {
  test("hasSend on an A2A turn writes code=ok sentMessage=true on that thread only", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bob = insertDeskBot(db, w, "Bob");
    const { threadId, turnId } = insertA2aMailbox(db, {
      accountId: w.accountId,
      fromBotId: w.botId,
      toBotId: bob.botId,
      harnessSessionId: bob.harnessSessionId,
    });
    const inflight = new McpInflight();
    sendMessage(db, inflight, `Bearer ${bob.token}`, { body: "draft for the human" });
    expect(() => promote(db, turnId, { kind: "acp_done", assistantText: "leftover" })).not.toThrow(
      /transaction/i,
    );
    const rows = completeRows(db, { turnId });
    expect(rows.length).toBe(1);
    expect(rows[0]?.from_bot_id).toBe(bob.botId);
    const ev = parseA2aComplete(rows[0]!.body);
    expect(ev.event).toBe("a2a_complete");
    expect(ev.code).toBe("ok");
    expect(ev.sentMessage).toBe(true);
    expect(ev.status).toBe("completed");
    expect(ev.from).toBe("Bob");
    expect(ev.fromBotId).toBe(bob.botId);
    expect(ev.toBotId).toBe(w.botId);
    expect(ev.turnId).toBe(turnId);
    expect(ev.promoteReason).toBeNull();
    expect(completeRows(db, { threadId }).length).toBe(1);
    expect(
      db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM messages WHERE thread_id = ? AND body LIKE 'A2A complete:%'",
        [w.threadId],
      )?.n,
    ).toBe(0);
    expect(
      db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM messages WHERE thread_id = ? AND body LIKE 'A2A complete:%'",
        [bob.threadId],
      )?.n,
    ).toBe(0);
    db.close();
  });

  test("sent_message_count from SendToThread counts as hasSend", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bob = insertDeskBot(db, w, "Bob");
    const { turnId } = insertA2aMailbox(db, {
      accountId: w.accountId,
      fromBotId: w.botId,
      toBotId: bob.botId,
    });
    db.run("UPDATE turns SET sent_message_count = 1 WHERE id = ?", [turnId]);
    promote(db, turnId, { kind: "acp_done", assistantText: "leftover" });
    const ev = parseA2aComplete(completeRows(db, { turnId })[0]!.body);
    expect(ev.code).toBe("ok");
    expect(ev.sentMessage).toBe(true);
    expect(
      db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM messages WHERE turn_id = ? AND origin = 'fallback'",
        [turnId],
      )?.n,
    ).toBe(0);
    db.close();
  });

  test("ramble fallback is no_send_message", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bob = insertDeskBot(db, w, "Bob");
    const { turnId } = insertA2aMailbox(db, {
      accountId: w.accountId,
      fromBotId: w.botId,
      toBotId: bob.botId,
    });
    promote(db, turnId, { kind: "acp_done", assistantText: "I ramble privately" });
    const ev = parseA2aComplete(completeRows(db, { turnId })[0]!.body);
    expect(ev.code).toBe("no_send_message");
    expect(ev.sentMessage).toBe(false);
    expect(ev.promoteReason).toBe("no_send_message");
    expect(
      db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM messages WHERE turn_id = ? AND origin = 'fallback'",
        [turnId],
      )?.n,
    ).toBe(1);
    db.close();
  });

  test("empty A2A has placeholder plus complete empty_turn", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bob = insertDeskBot(db, w, "Bob");
    const { turnId } = insertA2aMailbox(db, {
      accountId: w.accountId,
      fromBotId: w.botId,
      toBotId: bob.botId,
    });
    promote(db, turnId, { kind: "acp_done" });
    const system = db.all<{ origin: string; body: string; role: string }>(
      "SELECT origin, body, role FROM messages WHERE turn_id = ? AND origin = 'system' ORDER BY created_at",
      [turnId],
    );
    expect(system.length).toBe(2);
    expect(system[0]?.body).toContain("finished this turn without a message");
    const ev = parseA2aComplete(system[1]!.body);
    expect(ev.code).toBe("empty_turn");
    expect(ev.sentMessage).toBe(false);
    expect(ev.promoteReason).toBe("empty_turn");
    db.close();
  });

  test("promote crash is code crash", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bob = insertDeskBot(db, w, "Bob");
    const { turnId } = insertA2aMailbox(db, {
      accountId: w.accountId,
      fromBotId: w.botId,
      toBotId: bob.botId,
    });
    promote(db, turnId, { kind: "crash" });
    const ev = parseA2aComplete(completeRows(db, { turnId })[0]!.body);
    expect(ev.code).toBe("crash");
    expect(ev.status).toBe("completed");
    db.close();
  });

  test("running cancel via promote is code cancel", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bob = insertDeskBot(db, w, "Bob");
    const { turnId } = insertA2aMailbox(db, {
      accountId: w.accountId,
      fromBotId: w.botId,
      toBotId: bob.botId,
    });
    promote(db, turnId, { kind: "cancel", assistantText: "halfway" });
    const ev = parseA2aComplete(completeRows(db, { turnId })[0]!.body);
    expect(ev.code).toBe("cancel");
    expect(ev.status).toBe("cancelled");
    expect(ev.promoteReason).toBe("cancel");
    db.close();
  });

  test("deadline promote is code deadline", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bob = insertDeskBot(db, w, "Bob");
    const { turnId } = insertA2aMailbox(db, {
      accountId: w.accountId,
      fromBotId: w.botId,
      toBotId: bob.botId,
    });
    promote(db, turnId, { kind: "deadline", assistantText: "too slow" });
    const ev = parseA2aComplete(completeRows(db, { turnId })[0]!.body);
    expect(ev.code).toBe("deadline");
    expect(ev.status).toBe("failed");
    db.close();
  });

  test("second promote on the same turn still one complete line", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bob = insertDeskBot(db, w, "Bob");
    const { turnId } = insertA2aMailbox(db, {
      accountId: w.accountId,
      fromBotId: w.botId,
      toBotId: bob.botId,
    });
    promote(db, turnId, { kind: "acp_done", assistantText: "one" });
    promote(db, turnId, { kind: "acp_done", assistantText: "two" });
    expect(completeRows(db, { turnId }).length).toBe(1);
    db.close();
  });

  test("Ada then Bob hop writes two complete lines with different turn ids", () => {
    const db = openDb();
    const w = seedWorld(db);
    insertTurn(db, w, "running");
    const bob = insertDeskBot(db, w, "Bob");
    const inflight = new McpInflight();
    const first = sendToAgent(db, inflight, `Bearer ${w.token}`, { name: "Bob", body: "write a draft" });
    db.run("UPDATE turns SET status = 'running', harness_session_id = ? WHERE id = ?", [
      bob.harnessSessionId,
      first.turnId,
    ]);
    const second = sendToAgent(db, inflight, `Bearer ${bob.token}`, { name: "Ada", body: "here is the draft" });
    db.run("UPDATE turns SET sent_message_count = 1 WHERE id = ?", [first.turnId]);
    promote(db, first.turnId, { kind: "acp_done" });
    db.run("UPDATE turns SET status = 'running' WHERE id = ?", [second.turnId]);
    db.run("UPDATE turns SET sent_message_count = 1 WHERE id = ?", [second.turnId]);
    promote(db, second.turnId, { kind: "acp_done" });
    const rows = completeRows(db, { threadId: first.threadId });
    expect(rows.length).toBe(2);
    expect(first.threadId).toBe(second.threadId);
    expect(rows[0]?.turn_id).toBe(first.turnId);
    expect(rows[1]?.turn_id).toBe(second.turnId);
    const a = parseA2aComplete(rows[0]!.body);
    const b = parseA2aComplete(rows[1]!.body);
    expect(a.fromBotId).toBe(bob.botId);
    expect(a.toBotId).toBe(w.botId);
    expect(b.fromBotId).toBe(w.botId);
    expect(b.toBotId).toBe(bob.botId);
    db.close();
  });

  test("human and group promote write zero complete lines", () => {
    const db = openDb();
    const w = seedWorld(db);
    const humanTurn = insertTurn(db, w, "running");
    promote(db, humanTurn, { kind: "acp_done", assistantText: "ramble" });
    expect(completeRows(db, { turnId: humanTurn }).length).toBe(0);
    const bobId = insertBot(db, w, "Bob");
    const groupId = insertGroup(db, w, [w.botId, bobId], "Design");
    const groupTurn = insertTurn(db, w, "running", { threadId: groupId });
    promote(db, groupTurn, { kind: "acp_done", assistantText: "group ramble" });
    expect(completeRows(db, { turnId: groupTurn }).length).toBe(0);
    db.close();
  });
});
