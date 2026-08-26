import { describe, expect, test } from "bun:test";
import { OpenbotDb } from "@openbot/db";
import { appendLiveWork, buildThreadDigest, parseLivePayload, promote, wrapPromptWithDigest } from "@openbot/live-work";
import { McpError } from "@openbot/api-types";
import { McpInflight, sendMessage } from "@openbot/mcp-send-message";
import { insertTurn, seedWorld, tempHome } from "./helpers.ts";
import { join } from "node:path";

function openDb() {
  return OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
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
});
