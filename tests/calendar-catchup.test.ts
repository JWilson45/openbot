import { describe, expect, test } from "bun:test";
import { CAL_CATCHUP_MS, CAL_MIN_INTERVAL_MS, materializeHorizon } from "@openbot/calendar";
import { id, now } from "@openbot/db";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

function startWorld() {
  process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
  const { ctx, server, origin } = startTestServer({ home: tempHome() });
  const { cookie } = loginCookie({ ctx }, "alice");
  const headers = { cookie, "content-type": "application/json" };
  return { ctx, server, origin, headers };
}

async function createBot(origin: string, headers: Record<string, string>, name: string) {
  const res = await fetch(`${origin}/v1/bots`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { bot: { id: string }; threadId: string };
}

function insertSeries(
  ctx: { db: import("@openbot/db").OpenbotDb },
  opts: {
    accountId: string;
    botId: string;
    threadId: string;
    title?: string;
    prompt?: string;
    dtstartUtc: number;
    rrule?: string | null;
  },
): string {
  const seriesId = id();
  const t = now();
  ctx.db.run(
    `INSERT INTO calendar_series (
       id, account_id, title, prompt, assignee_bot_id, thread_id, kind, status, rrule,
       dtstart_utc, timezone, require_human_approval, created_by, min_interval_ms,
       next_due_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'schedule', 'active', ?, ?, 'UTC', 0, 'human', ?, ?, ?, ?)`,
    [
      seriesId,
      opts.accountId,
      opts.title ?? "event",
      opts.prompt ?? "do it",
      opts.botId,
      opts.threadId,
      opts.rrule ?? null,
      opts.dtstartUtc,
      CAL_MIN_INTERVAL_MS,
      opts.dtstartUtc,
      t,
      t,
    ],
  );
  return seriesId;
}

describe("calendar catch-up", () => {
  test("past one-shot 10 minutes ago fires once", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [ada.bot.id])!
      .account_id;
    const nowMs = Date.UTC(2026, 5, 1, 12, 0, 0);
    const dtstart = nowMs - 10 * 60_000;
    const seriesId = insertSeries(ctx, {
      accountId,
      botId: ada.bot.id,
      threadId: ada.threadId,
      dtstartUtc: dtstart,
    });
    const result = ctx.engine.tickCalendar(nowMs);
    expect(result.enqueued).toBe(1);
    const inst = ctx.db.get<{ status: string; scheduled_at: number; turn_id: string | null }>(
      "SELECT status, scheduled_at, turn_id FROM calendar_instances WHERE series_id = ? AND scheduled_at = ?",
      [seriesId, dtstart],
    );
    expect(inst?.status).toBe("queued");
    expect(inst?.turn_id).toBeTruthy();
    server.stop(true);
  });

  test("daily created after 09:00 still fires this morning", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [ada.bot.id])!
      .account_id;
    const morning = Date.UTC(2026, 5, 1, 9, 0, 0);
    const nowMs = Date.UTC(2026, 5, 1, 10, 0, 0);
    const seriesId = insertSeries(ctx, {
      accountId,
      botId: ada.bot.id,
      threadId: ada.threadId,
      dtstartUtc: morning,
      rrule: "FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0",
    });
    const result = ctx.engine.tickCalendar(nowMs);
    expect(result.enqueued).toBe(1);
    expect(
      ctx.db.get<{ status: string }>(
        "SELECT status FROM calendar_instances WHERE series_id = ? AND scheduled_at = ?",
        [seriesId, morning],
      )?.status,
    ).toBe("queued");
    server.stop(true);
  });

  test("host-down ≥24h skips offline with a system DM and no enqueue", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [ada.bot.id])!
      .account_id;
    const nowMs = Date.UTC(2026, 5, 4, 12, 0, 0);
    const dtstart = nowMs - 3 * 24 * 60 * 60 * 1000;
    const seriesId = insertSeries(ctx, {
      accountId,
      botId: ada.bot.id,
      threadId: ada.threadId,
      title: "overnight mail",
      dtstartUtc: dtstart,
    });
    const result = ctx.engine.tickCalendar(nowMs);
    expect(result.enqueued).toBe(0);
    expect(result.skippedOffline).toBe(1);
    expect(
      ctx.db.get<{ status: string }>(
        "SELECT status FROM calendar_instances WHERE series_id = ? AND scheduled_at = ?",
        [seriesId, dtstart],
      )?.status,
    ).toBe("skipped_offline");
    expect(ctx.db.all("SELECT id FROM turns WHERE bot_id = ?", [ada.bot.id]).length).toBe(0);
    const notice = ctx.db.get<{ body: string; origin: string }>(
      "SELECT body, origin FROM messages WHERE thread_id = ? AND origin = 'system' ORDER BY created_at DESC LIMIT 1",
      [ada.threadId],
    );
    expect(notice?.body).toContain("overnight mail");
    expect(notice?.body).toContain("were not replayed");
    const audit = ctx.db.get<{ type: string }>(
      "SELECT type FROM audit_events WHERE type = 'calendar.skipped_offline' AND account_id = ?",
      [accountId],
    );
    expect(audit?.type).toBe("calendar.skipped_offline");
    server.stop(true);
  });

  test("5-minute series frozen 20h later catch-up is the latest beat, not now-24h+5.3h", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [ada.bot.id])!
      .account_id;
    const dtstart = Date.UTC(2026, 5, 1, 0, 0, 0);
    const nowMs = dtstart + 20 * 60 * 60 * 1000;
    const seriesId = insertSeries(ctx, {
      accountId,
      botId: ada.bot.id,
      threadId: ada.threadId,
      dtstartUtc: dtstart,
      rrule: "FREQ=MINUTELY;INTERVAL=5",
    });
    const horizon = materializeHorizon({
      dtstartUtc: dtstart,
      timezone: "UTC",
      rrule: "FREQ=MINUTELY;INTERVAL=5",
      nowMs,
    });
    expect(horizon.catchup).toBe(nowMs);
    const wrong = nowMs - CAL_CATCHUP_MS + Math.round(5.3 * 60 * 60 * 1000);
    expect(horizon.catchup).not.toBe(wrong);
    const result = ctx.engine.tickCalendar(nowMs);
    expect(result.enqueued).toBe(1);
    const queued = ctx.db.get<{ scheduled_at: number; status: string }>(
      "SELECT scheduled_at, status FROM calendar_instances WHERE series_id = ? AND status = 'queued'",
      [seriesId],
    );
    expect(queued?.scheduled_at).toBe(horizon.catchup);
    const stale = ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM calendar_instances
        WHERE series_id = ? AND scheduled_at < ? AND status IN ('scheduled', 'due', 'queued')`,
      [seriesId, horizon.catchup],
    );
    expect(stale?.n).toBe(0);
    expect(
      ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM calendar_instances WHERE series_id = ? AND scheduled_at = ?",
        [seriesId, wrong],
      )?.n,
    ).toBe(0);
    server.stop(true);
  });

  test("queue_full leaves the instance due", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [ada.bot.id])!
      .account_id;
    const nowMs = Date.UTC(2026, 5, 1, 12, 0, 0);
    const seriesId = insertSeries(ctx, {
      accountId,
      botId: ada.bot.id,
      threadId: ada.threadId,
      dtstartUtc: nowMs - 60_000,
    });
    for (let i = 0; i < 5; i++) {
      ctx.db.run(
        `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, created_at)
         VALUES (?, ?, ?, 'queued', 0, '', ?)`,
        [id(), ada.threadId, ada.bot.id, nowMs],
      );
    }
    const result = ctx.engine.tickCalendar(nowMs);
    expect(result.enqueued).toBe(0);
    expect(result.dueLeft).toBeGreaterThan(0);
    expect(
      ctx.db.get<{ status: string }>(
        "SELECT status FROM calendar_instances WHERE series_id = ? AND scheduled_at = ?",
        [seriesId, nowMs - 60_000],
      )?.status,
    ).toBe("due");
    expect(
      ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM turns WHERE bot_id = ? AND status = 'queued'", [ada.bot.id])
        ?.n,
    ).toBe(5);
    server.stop(true);
  });
});
