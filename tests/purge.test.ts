import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OpenbotDb, deleteBotPermanently, id, now, orderedBotPair, sha256Hex } from "@openbot/db";
import { persistMcpToken } from "@openbot/mcp-send-message";
import { seedWorld, tempHome } from "./helpers.ts";

function openDb() {
  return OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
}

function seedPeer(db: OpenbotDb, accountId: string, computeId: string, name: string) {
  const botId = id();
  const threadId = id();
  const harnessSessionId = id();
  const t = now();
  db.run(
    `INSERT INTO bots (id, account_id, name, description, status, permission_mode, created_at)
     VALUES (?, ?, ?, 'teammate', 'archived', 'auto', ?)`,
    [botId, accountId, name, t],
  );
  db.run(`UPDATE bots SET archived_at = ? WHERE id = ?`, [t, botId]);
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

function insertTurnOn(
  db: OpenbotDb,
  opts: { threadId: string; botId: string; harnessSessionId: string | null; status?: string },
): string {
  const turnId = id();
  db.run(
    `INSERT INTO turns (id, thread_id, bot_id, harness_session_id, status, sent_message_count, assistant_text, created_at)
     VALUES (?, ?, ?, ?, ?, 0, '', ?)`,
    [turnId, opts.threadId, opts.botId, opts.harnessSessionId, opts.status ?? "completed", now()],
  );
  return turnId;
}

function insertMsg(
  db: OpenbotDb,
  opts: {
    threadId: string;
    turnId: string | null;
    origin: string;
    fromBotId?: string | null;
    body?: string;
  },
) {
  db.run(
    `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, from_bot_id, created_at)
     VALUES (?, ?, ?, 'assistant', ?, ?, 'normal', ?, ?)`,
    [id(), opts.threadId, opts.turnId, opts.origin, opts.body ?? "hi", opts.fromBotId ?? null, now()],
  );
}

function graph(db: OpenbotDb, purgeId: string, keepId: string, keepHuman: string, keepHarness: string) {
  const t = now();
  const [lo, hi] = orderedBotPair(purgeId, keepId);
  const a2aId = id();
  db.run(
    `INSERT INTO threads (id, account_id, bot_id, title, kind, peer_bot_id, created_at)
     VALUES (?, (SELECT account_id FROM bots WHERE id = ?), ?, 'a2a', 'a2a', ?, ?)`,
    [a2aId, purgeId, lo, hi, t],
  );
  const purgeA2aTurn = insertTurnOn(db, {
    threadId: a2aId,
    botId: purgeId,
    harnessSessionId: db.get<{ id: string }>("SELECT id FROM harness_sessions WHERE bot_id = ?", [purgeId])!.id,
  });
  const keepA2aTurn = insertTurnOn(db, {
    threadId: a2aId,
    botId: keepId,
    harnessSessionId: keepHarness,
  });
  db.run(
    `INSERT INTO live_work_events (id, turn_id, seq, kind, payload, created_at) VALUES (?, ?, 1, 'thought', '{}', ?)`,
    [id(), purgeA2aTurn, t],
  );
  db.run(
    `INSERT INTO live_work_events (id, turn_id, seq, kind, payload, created_at) VALUES (?, ?, 1, 'thought', '{}', ?)`,
    [id(), keepA2aTurn, t],
  );
  insertMsg(db, { threadId: a2aId, turnId: keepA2aTurn, origin: "agent", fromBotId: purgeId, body: "handoff" });
  insertMsg(db, { threadId: a2aId, turnId: purgeA2aTurn, origin: "agent", fromBotId: keepId, body: "reply" });
  // SendMessage landed on the surviving bot's human DM with the A2A turn_id —
  // the row that used to block DELETE FROM turns.
  insertMsg(db, { threadId: keepHuman, turnId: keepA2aTurn, origin: "send_message", fromBotId: keepId });
  insertMsg(db, { threadId: keepHuman, turnId: purgeA2aTurn, origin: "send_message", fromBotId: purgeId });
  persistMcpToken(
    db,
    {
      accountId: db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [keepId])!.account_id,
      botId: keepId,
      threadId: a2aId,
      harnessSessionId: keepHarness,
    },
    sha256Hex("ob_sess_a2a_" + keepId),
  );
  return { a2aId, purgeA2aTurn, keepA2aTurn };
}

describe("deleteBotPermanently", () => {
  test("purges a bot with live work, A2A turns, and cross-thread message FKs", () => {
    const db = openDb();
    const w = seedWorld(db);
    const peer = seedPeer(db, w.accountId, w.computeId, "Bob");
    const purgeHumanTurn = insertTurnOn(db, {
      threadId: w.threadId,
      botId: w.botId,
      harnessSessionId: w.harnessSessionId,
    });
    db.run(
      `INSERT INTO live_work_events (id, turn_id, seq, kind, payload, created_at) VALUES (?, ?, 1, 'thought', '{}', ?)`,
      [id(), purgeHumanTurn, now()],
    );
    insertMsg(db, { threadId: w.threadId, turnId: purgeHumanTurn, origin: "user" });

    const { a2aId, keepA2aTurn } = graph(db, w.botId, peer.botId, peer.threadId, peer.harnessSessionId);

    deleteBotPermanently(db, w.botId);

    expect(db.get("SELECT id FROM bots WHERE id = ?", [w.botId])).toBeNull();
    expect(db.get<{ id: string }>("SELECT id FROM bots WHERE id = ?", [peer.botId])?.id).toBe(peer.botId);
    expect(db.get("SELECT id FROM threads WHERE bot_id = ?", [w.botId])).toBeNull();
    expect(db.get("SELECT id FROM turns WHERE bot_id = ?", [w.botId])).toBeNull();
    expect(db.get("SELECT id FROM harness_sessions WHERE bot_id = ?", [w.botId])).toBeNull();
    expect(db.get("SELECT id FROM mcp_tokens WHERE bot_id = ?", [w.botId])).toBeNull();
    expect(db.get("SELECT id FROM live_work_events WHERE turn_id = ?", [purgeHumanTurn])).toBeNull();

    const a2a = db.get<{ id: string; bot_id: string; peer_bot_id: string | null }>(
      "SELECT id, bot_id, peer_bot_id FROM threads WHERE id = ?",
      [a2aId],
    );
    expect(a2a?.bot_id).toBe(peer.botId);
    expect(a2a?.peer_bot_id).toBeNull();
    expect(db.get("SELECT id FROM turns WHERE id = ?", [keepA2aTurn])?.id).toBe(keepA2aTurn);
    expect(db.get<{ n: number }>("SELECT COUNT(*) as n FROM live_work_events WHERE turn_id = ?", [keepA2aTurn])?.n).toBe(
      1,
    );
    expect(
      db.get<{ n: number }>("SELECT COUNT(*) as n FROM messages WHERE thread_id = ? AND origin = 'agent'", [a2aId])?.n,
    ).toBe(2);
    expect(
      db.get<{ n: number }>("SELECT COUNT(*) as n FROM messages WHERE thread_id = ? AND turn_id = ?", [
        peer.threadId,
        keepA2aTurn,
      ])?.n,
    ).toBe(1);
    expect(
      db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM messages WHERE thread_id = ? AND turn_id IS NULL AND origin = 'send_message'",
        [peer.threadId],
      )?.n,
    ).toBe(1);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  test("purges the A2A owner and the A2A peer independently", () => {
    const db = openDb();
    const w = seedWorld(db);
    const peer = seedPeer(db, w.accountId, w.computeId, "Bob");
    const { a2aId } = graph(db, w.botId, peer.botId, peer.threadId, peer.harnessSessionId);
    const [lo] = orderedBotPair(w.botId, peer.botId);
    const owner = lo;
    const other = owner === w.botId ? peer.botId : w.botId;
    deleteBotPermanently(db, owner);
    expect(db.get("SELECT id FROM bots WHERE id = ?", [owner])).toBeNull();
    expect(db.get<{ bot_id: string }>("SELECT bot_id FROM threads WHERE id = ?", [a2aId])?.bot_id).toBe(other);
    deleteBotPermanently(db, other);
    expect(db.get("SELECT id FROM bots WHERE id = ?", [other])).toBeNull();
    expect(db.get("SELECT id FROM threads WHERE id = ?", [a2aId])).toBeNull();
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
