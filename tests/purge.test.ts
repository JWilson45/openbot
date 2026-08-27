import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  OpenbotDb,
  deleteBotPermanently,
  id,
  now,
  orderedBotPair,
  pauseCalendarSeriesForAssignee,
  sha256Hex,
} from "@openbot/db";
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

  test("purges series+instance+turn without SQLITE_CONSTRAINT and cancels owned series", () => {
    const db = openDb();
    const w = seedWorld(db);
    const t = now();
    const seriesId = id();
    const instanceId = id();
    const turnId = insertTurnOn(db, {
      threadId: w.threadId,
      botId: w.botId,
      harnessSessionId: w.harnessSessionId,
    });
    db.run(
      `INSERT INTO calendar_series (
         id, account_id, title, prompt, assignee_bot_id, thread_id, kind, status,
         rrule, dtstart_utc, timezone, created_by, created_by_bot_id, created_at, updated_at
       ) VALUES (?, ?, 'standup', 'summarize', ?, ?, 'schedule', 'active',
         NULL, ?, 'UTC', 'bot', ?, ?, ?)`,
      [seriesId, w.accountId, w.botId, w.threadId, t, w.botId, t, t],
    );
    db.run(
      `INSERT INTO calendar_instances (id, series_id, scheduled_at, status, turn_id, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
      [instanceId, seriesId, t, turnId, t],
    );

    deleteBotPermanently(db, w.botId);

    expect(db.get("SELECT id FROM bots WHERE id = ?", [w.botId])).toBeNull();
    const series = db.get<{
      status: string;
      assignee_bot_id: string | null;
      created_by_bot_id: string | null;
    }>("SELECT status, assignee_bot_id, created_by_bot_id FROM calendar_series WHERE id = ?", [seriesId]);
    expect(series?.status).toBe("cancelled");
    expect(series?.assignee_bot_id).toBeNull();
    expect(series?.created_by_bot_id).toBeNull();
    const inst = db.get<{ turn_id: string | null; series_id: string }>(
      "SELECT turn_id, series_id FROM calendar_instances WHERE id = ?",
      [instanceId],
    );
    expect(inst?.series_id).toBe(seriesId);
    expect(inst?.turn_id).toBeNull();
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  test("purging Bob does not cancel Ada's series on Bob's group thread", () => {
    const db = openDb();
    const w = seedWorld(db);
    const bob = seedPeer(db, w.accountId, w.computeId, "Bob");
    const t = now();
    const groupId = id();
    db.run(
      `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, 'g', 'group', ?)`,
      [groupId, w.accountId, bob.botId, t],
    );
    db.run(
      `INSERT INTO thread_participants (id, thread_id, kind, user_id, bot_id, created_at) VALUES (?, ?, 'human', ?, NULL, ?)`,
      [id(), groupId, w.userId, t],
    );
    db.run(
      `INSERT INTO thread_participants (id, thread_id, kind, user_id, bot_id, created_at) VALUES (?, ?, 'bot', NULL, ?, ?)`,
      [id(), groupId, w.botId, t],
    );
    db.run(
      `INSERT INTO thread_participants (id, thread_id, kind, user_id, bot_id, created_at) VALUES (?, ?, 'bot', NULL, ?, ?)`,
      [id(), groupId, bob.botId, t],
    );
    const seriesId = id();
    db.run(
      `INSERT INTO calendar_series (
         id, account_id, title, prompt, assignee_bot_id, thread_id, kind, status,
         rrule, dtstart_utc, timezone, created_by, created_by_bot_id, created_at, updated_at
       ) VALUES (?, ?, 'standup', 'summarize', ?, ?, 'schedule', 'active',
         NULL, ?, 'UTC', 'human', NULL, ?, ?)`,
      [seriesId, w.accountId, w.botId, groupId, t, t, t],
    );
    db.run(
      `INSERT INTO calendar_instances (id, series_id, scheduled_at, status, turn_id, created_at)
       VALUES (?, ?, ?, 'scheduled', NULL, ?)`,
      [id(), seriesId, t, t],
    );

    deleteBotPermanently(db, bob.botId);

    expect(db.get("SELECT id FROM bots WHERE id = ?", [bob.botId])).toBeNull();
    const group = db.get<{ id: string; bot_id: string }>("SELECT id, bot_id FROM threads WHERE id = ?", [groupId]);
    expect(group?.id).toBe(groupId);
    expect(group?.bot_id).toBe(w.botId);
    const series = db.get<{ status: string; assignee_bot_id: string | null; thread_id: string | null }>(
      "SELECT status, assignee_bot_id, thread_id FROM calendar_series WHERE id = ?",
      [seriesId],
    );
    expect(series?.status).toBe("active");
    expect(series?.assignee_bot_id).toBe(w.botId);
    expect(series?.thread_id).toBe(groupId);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  test("pauseCalendarSeriesForAssignee pauses active and proposed only", () => {
    const db = openDb();
    const w = seedWorld(db);
    const t = now();
    const activeId = id();
    const proposedId = id();
    const pausedId = id();
    for (const [sid, status] of [
      [activeId, "active"],
      [proposedId, "proposed"],
      [pausedId, "paused"],
    ] as const) {
      db.run(
        `INSERT INTO calendar_series (
           id, account_id, title, prompt, assignee_bot_id, thread_id, kind, status,
           rrule, dtstart_utc, timezone, created_by, created_at, updated_at
         ) VALUES (?, ?, 's', 'p', ?, ?, 'schedule', ?, NULL, ?, 'UTC', 'human', ?, ?)`,
        [sid, w.accountId, w.botId, w.threadId, status, t, t, t],
      );
    }
    pauseCalendarSeriesForAssignee(db, w.botId);
    expect(db.get<{ status: string }>("SELECT status FROM calendar_series WHERE id = ?", [activeId])?.status).toBe(
      "paused",
    );
    expect(db.get<{ status: string }>("SELECT status FROM calendar_series WHERE id = ?", [proposedId])?.status).toBe(
      "paused",
    );
    expect(db.get<{ status: string }>("SELECT status FROM calendar_series WHERE id = ?", [pausedId])?.status).toBe(
      "paused",
    );
  });
});
