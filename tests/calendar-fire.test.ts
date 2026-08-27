import { describe, expect, test } from "bun:test";
import { CAL_MIN_INTERVAL_MS } from "@openbot/calendar";
import { id, now } from "@openbot/db";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

type BotCreated = { bot: { id: string; name: string }; threadId: string };

function startWorld() {
  process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
  const { ctx, server, origin } = startTestServer({ home: tempHome() });
  const { cookie } = loginCookie({ ctx }, "alice");
  const headers = { cookie, "content-type": "application/json" };
  return { ctx, server, origin, headers };
}

async function createBot(origin: string, headers: Record<string, string>, name: string): Promise<BotCreated> {
  const res = await fetch(`${origin}/v1/bots`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as BotCreated;
}

async function waitUntil(fn: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await Bun.sleep(40);
  }
  throw new Error("timeout");
}

function insertSeries(
  ctx: { db: import("@openbot/db").OpenbotDb },
  opts: {
    accountId: string;
    botId: string;
    threadId: string | null;
    title?: string;
    prompt: string;
    dtstartUtc: number;
    rrule?: string | null;
    lastFiredAt?: number | null;
    minIntervalMs?: number;
    requireHumanApproval?: number;
  },
): string {
  const seriesId = id();
  const t = now();
  ctx.db.run(
    `INSERT INTO calendar_series (
       id, account_id, title, prompt, assignee_bot_id, thread_id, kind, status, rrule,
       dtstart_utc, timezone, require_human_approval, created_by, min_interval_ms,
       last_fired_at, next_due_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'schedule', 'active', ?, ?, 'UTC', ?, 'human', ?, ?, ?, ?, ?)`,
    [
      seriesId,
      opts.accountId,
      opts.title ?? "event",
      opts.prompt,
      opts.botId,
      opts.threadId,
      opts.rrule ?? null,
      opts.dtstartUtc,
      opts.requireHumanApproval ?? 0,
      opts.minIntervalMs ?? CAL_MIN_INTERVAL_MS,
      opts.lastFiredAt ?? null,
      opts.dtstartUtc,
      t,
      t,
    ],
  );
  return seriesId;
}

describe("calendar fire", () => {
  test("[[send:]] enqueues a turn; GET hides the calendar prompt; instance.turn_id is set", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-calfire0001" }),
    });
    const created = await fetch(`${origin}/v1/calendar/series`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "mail",
        prompt: "[[send:cal-ok]]",
        botId: ada.bot.id,
        dtstart: Date.now() - 60_000,
      }),
    });
    expect(created.status).toBe(201);
    const seriesId = ((await created.json()) as { series: { id: string } }).series.id;
    await waitUntil(() => {
      const send = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND origin = 'send_message' AND body = 'cal-ok'",
        [ada.threadId],
      );
      return (send?.n ?? 0) > 0;
    });
    const listed = (await fetch(`${origin}/v1/threads/${ada.threadId}`, { headers }).then((r) => r.json())) as {
      messages: Array<{ origin: string; body: string }>;
    };
    expect(listed.messages.some((m) => m.origin === "calendar")).toBe(false);
    expect(listed.messages.some((m) => m.body.includes("[[send:cal-ok]]"))).toBe(false);
    expect(listed.messages.some((m) => m.origin === "send_message" && m.body === "cal-ok")).toBe(true);
    const inst = ctx.db.get<{ turn_id: string | null; status: string }>(
      "SELECT turn_id, status FROM calendar_instances WHERE series_id = ? ORDER BY scheduled_at LIMIT 1",
      [seriesId],
    );
    expect(inst?.turn_id).toBeTruthy();
    expect(["queued", "running", "completed", "failed"]).toContain(inst?.status);
    server.stop(true);
  });

  test("queued cancel cancels the turn in the same request", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [ada.bot.id])!
      .account_id;
    const seriesId = insertSeries(ctx, {
      accountId,
      botId: ada.bot.id,
      threadId: ada.threadId,
      prompt: "[[send:should-not-run]]",
      dtstartUtc: Date.now() - 30_000,
    });
    ctx.engine.tickCalendar();
    const inst = ctx.db.get<{ id: string; turn_id: string | null; status: string }>(
      "SELECT id, turn_id, status FROM calendar_instances WHERE series_id = ? AND status = 'queued'",
      [seriesId],
    );
    expect(inst?.status).toBe("queued");
    expect(inst?.turn_id).toBeTruthy();
    const cancelled = await fetch(`${origin}/v1/calendar/instances/${inst!.id}/cancel`, { method: "POST", headers });
    expect(cancelled.status).toBe(200);
    expect(ctx.db.get<{ status: string }>("SELECT status FROM calendar_instances WHERE id = ?", [inst!.id])?.status).toBe(
      "cancelled",
    );
    expect(ctx.db.get<{ status: string }>("SELECT status FROM turns WHERE id = ?", [inst!.turn_id])?.status).toBe(
      "cancelled",
    );
    server.stop(true);
  });

  test("POST /v1/turns/:id/cancel reconciles a queued calendar instance", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [ada.bot.id])!
      .account_id;
    const nine = Date.UTC(2026, 0, 1, 9, 0, 0);
    const ten = Date.UTC(2026, 0, 1, 10, 0, 0);
    const seriesId = insertSeries(ctx, {
      accountId,
      botId: ada.bot.id,
      threadId: ada.threadId,
      prompt: "hourly",
      dtstartUtc: nine,
      rrule: "FREQ=HOURLY;INTERVAL=1",
    });
    ctx.engine.tickCalendar(nine);
    const first = ctx.db.get<{ id: string; turn_id: string; status: string }>(
      "SELECT id, turn_id, status FROM calendar_instances WHERE series_id = ? AND scheduled_at = ?",
      [seriesId, nine],
    );
    expect(first?.status).toBe("queued");
    const cancelled = await fetch(`${origin}/v1/turns/${first!.turn_id}/cancel`, { method: "POST", headers });
    expect(cancelled.status).toBe(200);
    expect(ctx.db.get<{ status: string }>("SELECT status FROM turns WHERE id = ?", [first!.turn_id])?.status).toBe(
      "cancelled",
    );
    expect(ctx.db.get<{ status: string }>("SELECT status FROM calendar_instances WHERE id = ?", [first!.id])?.status).toBe(
      "cancelled",
    );
    ctx.engine.tickCalendar(ten + 60_000);
    expect(
      ctx.db.get<{ status: string; turn_id: string | null }>(
        "SELECT status, turn_id FROM calendar_instances WHERE series_id = ? AND scheduled_at = ?",
        [seriesId, ten],
      )?.status,
    ).toBe("queued");
    server.stop(true);
  });

  test("missing thread_id skips the instance once and does not leave due", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [ada.bot.id])!
      .account_id;
    const nowMs = Date.now();
    const seriesId = insertSeries(ctx, {
      accountId,
      botId: ada.bot.id,
      threadId: null,
      prompt: "[[send:no-thread]]",
      dtstartUtc: nowMs - 60_000,
    });
    ctx.engine.tickCalendar(nowMs);
    const inst = ctx.db.get<{ status: string; skipped_reason: string | null }>(
      "SELECT status, skipped_reason FROM calendar_instances WHERE series_id = ? ORDER BY scheduled_at LIMIT 1",
      [seriesId],
    );
    expect(inst?.status).toBe("cancelled");
    expect(inst?.skipped_reason).toBe("no_thread");
    expect(ctx.db.all("SELECT id FROM turns WHERE bot_id = ?", [ada.bot.id]).length).toBe(0);
    const audits = ctx.db.all<{ type: string; payload: string }>(
      "SELECT type, payload FROM audit_events WHERE type = 'calendar.skip' AND account_id = ?",
      [accountId],
    );
    expect(audits.length).toBe(1);
    expect(JSON.parse(audits[0]!.payload).reason).toBe("no_thread");
    ctx.engine.tickCalendar(nowMs + 30_000);
    expect(
      ctx.db.all("SELECT id FROM audit_events WHERE type = 'calendar.skip' AND account_id = ?", [accountId]).length,
    ).toBe(1);
    expect(
      ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM calendar_instances WHERE series_id = ? AND status = 'due'",
        [seriesId],
      )?.n,
    ).toBe(0);
    server.stop(true);
  });

  test("orphan restart does not enqueue a second turn", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [ada.bot.id])!
      .account_id;
    const seriesId = insertSeries(ctx, {
      accountId,
      botId: ada.bot.id,
      threadId: ada.threadId,
      prompt: "[[send:orphan]]",
      dtstartUtc: Date.now() - 30_000,
    });
    ctx.engine.tickCalendar();
    const inst = ctx.db.get<{ id: string; turn_id: string }>(
      "SELECT id, turn_id FROM calendar_instances WHERE series_id = ? AND status = 'queued'",
      [seriesId],
    );
    expect(inst?.turn_id).toBeTruthy();
    ctx.db.run("UPDATE turns SET status = 'running', started_at = ? WHERE id = ?", [now(), inst!.turn_id]);
    ctx.engine.reapOrphans();
    const afterReap = ctx.db.get<{ status: string; error: string | null; promote_reason: string | null }>(
      "SELECT status, error, promote_reason FROM turns WHERE id = ?",
      [inst!.turn_id],
    );
    expect(afterReap?.status).not.toBe("running");
    ctx.engine.tickCalendar();
    const turns = ctx.db.all<{ id: string }>("SELECT id FROM turns WHERE bot_id = ?", [ada.bot.id]);
    expect(turns.length).toBe(1);
    expect(turns[0]?.id).toBe(inst!.turn_id);
    const instAfter = ctx.db.get<{ status: string; turn_id: string | null }>(
      "SELECT status, turn_id FROM calendar_instances WHERE id = ?",
      [inst!.id],
    );
    expect(instAfter?.status).toBe("failed");
    expect(instAfter?.turn_id).toBe(inst!.turn_id);
    server.stop(true);
  });

  test("hourly overrun keeps 10:00 due while 09:00 is in-flight", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [ada.bot.id])!
      .account_id;
    const nine = Date.UTC(2026, 0, 1, 9, 0, 0);
    const ten = Date.UTC(2026, 0, 1, 10, 0, 0);
    const nowMs = Date.UTC(2026, 0, 1, 10, 1, 0);
    const seriesId = insertSeries(ctx, {
      accountId,
      botId: ada.bot.id,
      threadId: ada.threadId,
      prompt: "hourly",
      dtstartUtc: nine,
      rrule: "FREQ=HOURLY;INTERVAL=1",
      lastFiredAt: nine,
    });
    const turnId = id();
    ctx.db.run(
      `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, created_at, started_at)
       VALUES (?, ?, ?, 'running', 0, '', ?, ?)`,
      [turnId, ada.threadId, ada.bot.id, nine, nine],
    );
    ctx.db.run(
      `INSERT INTO calendar_instances (id, series_id, scheduled_at, status, turn_id, created_at, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      [id(), seriesId, nine, turnId, nine, nine],
    );
    ctx.engine.tickCalendar(nowMs);
    const tenInst = ctx.db.get<{ status: string; scheduled_at: number }>(
      "SELECT status, scheduled_at FROM calendar_instances WHERE series_id = ? AND scheduled_at = ?",
      [seriesId, ten],
    );
    expect(tenInst?.status).toBe("due");
    expect(
      ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM turns WHERE bot_id = ? AND id != ?",
        [ada.bot.id, turnId],
      )?.n,
    ).toBe(0);
    server.stop(true);
  });

  test("min-interval follow-up waits for the enqueue floor", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [ada.bot.id])!
      .account_id;
    const firedAt = Date.UTC(2026, 0, 1, 10, 0, 0);
    const followUp = Date.UTC(2026, 0, 1, 10, 1, 0);
    const seriesId = insertSeries(ctx, {
      accountId,
      botId: ada.bot.id,
      threadId: ada.threadId,
      prompt: "[[send:five]]",
      dtstartUtc: firedAt,
      lastFiredAt: firedAt,
      minIntervalMs: CAL_MIN_INTERVAL_MS,
    });
    ctx.db.run(
      `INSERT INTO calendar_instances (id, series_id, scheduled_at, status, created_at)
       VALUES (?, ?, ?, 'completed', ?)`,
      [id(), seriesId, firedAt, firedAt],
    );
    ctx.db.run(
      `INSERT INTO calendar_instances (id, series_id, scheduled_at, status, created_at)
       VALUES (?, ?, ?, 'due', ?)`,
      [id(), seriesId, followUp, followUp],
    );
    ctx.engine.tickCalendar(firedAt + 90_000);
    expect(
      ctx.db.get<{ status: string }>(
        "SELECT status FROM calendar_instances WHERE series_id = ? AND scheduled_at = ?",
        [seriesId, followUp],
      )?.status,
    ).toBe("due");
    expect(ctx.db.all("SELECT id FROM turns WHERE bot_id = ?", [ada.bot.id]).length).toBe(0);

    ctx.engine.tickCalendar(firedAt + CAL_MIN_INTERVAL_MS);
    expect(
      ctx.db.get<{ status: string; turn_id: string | null }>(
        "SELECT status, turn_id FROM calendar_instances WHERE series_id = ? AND scheduled_at = ?",
        [seriesId, followUp],
      )?.status,
    ).toBe("queued");
    server.stop(true);
  });

  test("group+calendar puts the calendar block before Group thread", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-calfire0002" }),
    });
    const group = await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "group", title: "standup", botIds: [ada.bot.id, bob.bot.id] }),
    });
    expect([200, 201]).toContain(group.status);
    const groupId = ((await group.json()) as { thread: { id: string } }).thread.id;
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [ada.bot.id])!
      .account_id;
    insertSeries(ctx, {
      accountId,
      botId: ada.bot.id,
      threadId: groupId,
      title: "standup ping",
      prompt: "[[echo-cal-prefix]] [[echo-prefix]]",
      dtstartUtc: Date.now() - 30_000,
      requireHumanApproval: 0,
    });
    ctx.engine.tickCalendar();
    ctx.engine.kick();
    await waitUntil(() => {
      const n = ctx.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM messages
         WHERE thread_id = ? AND origin = 'send_message'
           AND body IN ('got-calendar-prefix', 'got-group-prefix')`,
        [ada.threadId],
      );
      return (n?.n ?? 0) >= 2;
    });
    const dm = ctx.db.all<{ origin: string; body: string }>(
      "SELECT origin, body FROM messages WHERE thread_id = ? ORDER BY created_at",
      [ada.threadId],
    );
    expect(dm.some((m) => m.origin === "send_message" && m.body === "got-calendar-prefix")).toBe(true);
    expect(dm.some((m) => m.origin === "send_message" && m.body === "got-group-prefix")).toBe(true);
    const groupMsgs = (await fetch(`${origin}/v1/threads/${groupId}`, { headers }).then((r) => r.json())) as {
      messages: Array<{ origin: string; body: string }>;
    };
    expect(groupMsgs.messages.some((m) => m.origin === "calendar")).toBe(false);
    server.stop(true);
  });
});
