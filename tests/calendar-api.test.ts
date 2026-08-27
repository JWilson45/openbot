import { describe, expect, test } from "bun:test";
import { id, now } from "@openbot/db";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

type Series = {
  id: string;
  title: string;
  prompt: string;
  kind: string;
  status: string;
  created_by: string;
  thread_id: string | null;
  assignee_bot_id: string | null;
  rrule: string | null;
  require_human_approval: number;
  capture_summary: string | null;
  source_thread_id: string | null;
};

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
  return (await res.json()) as { bot: { id: string; name: string }; threadId: string };
}

function futureDtstart(): number {
  return Date.now() + 24 * 60 * 60 * 1000;
}

describe("calendar api", () => {
  test("POST series is schedule/human/active and rejects kind", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const dtstart = futureDtstart();
    const created = await fetch(`${origin}/v1/calendar/series`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "standup",
        prompt: "summarize overnight mail",
        botId: ada.bot.id,
        dtstart,
        rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { series: Series };
    expect(body.series.kind).toBe("schedule");
    expect(body.series.created_by).toBe("human");
    expect(body.series.status).toBe("active");
    expect(body.series.thread_id).toBe(ada.threadId);
    expect(body.series.assignee_bot_id).toBe(ada.bot.id);

    const listed = (await fetch(
      `${origin}/v1/calendar?from=${dtstart - 60_000}&to=${dtstart + 14 * 24 * 60 * 60 * 1000}`,
      { headers },
    ).then((r) => r.json())) as {
      timezone: string;
      series: Series[];
      instances: Array<{ series_id: string; status: string }>;
    };
    expect(listed.timezone).toBe("UTC");
    expect(listed.series.some((s) => s.id === body.series.id)).toBe(true);
    expect(listed.instances.some((i) => i.series_id === body.series.id && i.status === "scheduled")).toBe(true);

    const withKind = await fetch(`${origin}/v1/calendar/series`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "nope",
        prompt: "nope",
        botId: ada.bot.id,
        dtstart,
        kind: "schedule",
      }),
    });
    expect(withKind.status).toBe(400);
    expect(((await withKind.json()) as { error: string }).error).toBe("kind_not_allowed");

    const badRrule = await fetch(`${origin}/v1/calendar/series`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "hourly byday",
        prompt: "nope",
        botId: ada.bot.id,
        dtstart,
        rrule: "FREQ=HOURLY;BYDAY=MO",
      }),
    });
    expect(badRrule.status).toBe(400);

    const minutely = await fetch(`${origin}/v1/calendar/series`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "too often",
        prompt: "nope",
        botId: ada.bot.id,
        dtstart,
        rrule: "FREQ=MINUTELY;INTERVAL=1",
      }),
    });
    expect(minutely.status).toBe(400);
    expect(ctx.db.all("SELECT id FROM turns").length).toBe(0);
    server.stop(true);
  });

  test("cap 32 non-cancelled including paused", async () => {
    const { server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const dtstart = futureDtstart();
    const ids: string[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await fetch(`${origin}/v1/calendar/series`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: `s${i}`,
          prompt: "p",
          botId: ada.bot.id,
          dtstart,
        }),
      });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { series: Series }).series.id);
    }
    const extra = await fetch(`${origin}/v1/calendar/series`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "s32", prompt: "p", botId: ada.bot.id, dtstart }),
    });
    expect(extra.status).toBe(409);
    expect(((await extra.json()) as { error: string }).error).toBe("cap");

    const paused = await fetch(`${origin}/v1/calendar/series/${ids[0]}/pause`, {
      method: "POST",
      headers,
      body: JSON.stringify({ paused: true }),
    });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { series: Series }).series.status).toBe("paused");

    const still = await fetch(`${origin}/v1/calendar/series`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "after-pause", prompt: "p", botId: ada.bot.id, dtstart }),
    });
    expect(still.status).toBe(409);

    const unpaused = await fetch(`${origin}/v1/calendar/series/${ids[0]}/pause`, {
      method: "POST",
      headers,
      body: JSON.stringify({ paused: false }),
    });
    expect(unpaused.status).toBe(200);
    expect(((await unpaused.json()) as { series: Series }).series.status).toBe("active");

    const del = await fetch(`${origin}/v1/calendar/series/${ids[1]}`, { method: "DELETE", headers });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { series: Series }).series.status).toBe("cancelled");
    const afterCancel = await fetch(`${origin}/v1/calendar/series`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "after-cancel", prompt: "p", botId: ada.bot.id, dtstart }),
    });
    expect(afterCancel.status).toBe(201);
    server.stop(true);
  });

  test("confirm proposed; 409 if not proposed", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const learned = await fetch(`${origin}/v1/calendar/learn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ threadId: ada.threadId }),
    });
    expect(learned.status).toBe(201);
    const proposed = ((await learned.json()) as { series: Series }).series;
    expect(proposed.kind).toBe("routine");
    expect(proposed.status).toBe("proposed");
    expect(proposed.created_by).toBe("learn");

    const ok = await fetch(`${origin}/v1/calendar/series/${proposed.id}/confirm`, { method: "POST", headers });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { series: Series }).series.status).toBe("active");

    const again = await fetch(`${origin}/v1/calendar/series/${proposed.id}/confirm`, { method: "POST", headers });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("not_proposed");
    expect(ctx.db.all("SELECT id FROM turns").length).toBe(0);
    server.stop(true);
  });

  test("learn capture keeps source thread_id and 404s missing thread", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const group = await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "group", title: "standup", botIds: [ada.bot.id, bob.bot.id] }),
    });
    expect([200, 201]).toContain(group.status);
    const groupId = ((await group.json()) as { thread: { id: string } }).thread.id;

    const t = now();
    ctx.db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, created_at)
       VALUES (?, ?, NULL, 'user', 'user', 'check overnight mail', 'normal', ?)`,
      [id(), groupId, t],
    );
    ctx.db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, created_at)
       VALUES (?, ?, NULL, 'user', 'prompt', 'secret prompt clone', 'normal', ?)`,
      [id(), groupId, t + 1],
    );
    const turnId = id();
    ctx.db.run(
      `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, created_at)
       VALUES (?, ?, ?, 'completed', 0, '', ?)`,
      [turnId, groupId, ada.bot.id, t],
    );
    ctx.db.run(
      `INSERT INTO live_work_events (id, turn_id, seq, kind, payload, created_at)
       VALUES (?, ?, 1, 'tool_call', ?, ?)`,
      [id(), turnId, JSON.stringify({ update: { title: "Read mail" } }), t],
    );

    const learned = await fetch(`${origin}/v1/calendar/learn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ threadId: groupId }),
    });
    expect(learned.status).toBe(201);
    const series = ((await learned.json()) as { series: Series }).series;
    expect(series.thread_id).toBe(groupId);
    expect(series.source_thread_id).toBe(groupId);
    expect(series.kind).toBe("routine");
    expect(series.status).toBe("proposed");
    expect(series.created_by).toBe("learn");
    expect(series.rrule).toBeNull();
    expect(series.title).toBe("standup");
    expect(series.prompt).toContain("check overnight mail");
    expect(series.prompt).not.toContain("secret prompt clone");
    expect(series.prompt).toContain("Using Read mail");
    expect(series.prompt).not.toContain('"update"');
    expect(series.capture_summary).toBeTruthy();
    expect(series.capture_summary!).not.toContain("secret prompt clone");
    const summary = JSON.parse(series.capture_summary!) as { pageUrl: string; liveWork: string[] };
    expect(summary.pageUrl).toBe("");
    expect(summary.liveWork.some((line) => line.includes("Read mail"))).toBe(true);

    const window = (await fetch(`${origin}/v1/calendar?from=${t}&to=${t + 1000}`, { headers }).then((r) =>
      r.json(),
    )) as { series: Series[] };
    expect(window.series.some((s) => s.id === series.id && s.status === "proposed")).toBe(true);

    const missing = await fetch(`${origin}/v1/calendar/learn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ threadId: id() }),
    });
    expect(missing.status).toBe(404);
    server.stop(true);
  });

  test("instance cancel; queued cancels the turn; running is in_flight", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const created = await fetch(`${origin}/v1/calendar/series`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "once",
        prompt: "do it",
        botId: ada.bot.id,
        dtstart: futureDtstart(),
      }),
    });
    expect(created.status).toBe(201);
    const series = ((await created.json()) as { series: Series }).series;
    const inst = ctx.db.get<{ id: string; status: string }>(
      "SELECT id, status FROM calendar_instances WHERE series_id = ? ORDER BY scheduled_at LIMIT 1",
      [series.id],
    );
    expect(inst?.status).toBe("scheduled");
    const cancelled = await fetch(`${origin}/v1/calendar/instances/${inst!.id}/cancel`, {
      method: "POST",
      headers,
    });
    expect(cancelled.status).toBe(200);
    expect(
      ctx.db.get<{ status: string }>("SELECT status FROM calendar_instances WHERE id = ?", [inst!.id])?.status,
    ).toBe("cancelled");

    const queuedInst = id();
    const turnId = id();
    const t = now();
    ctx.db.run(
      `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, created_at)
       VALUES (?, ?, ?, 'queued', 0, '', ?)`,
      [turnId, ada.threadId, ada.bot.id, t],
    );
    ctx.db.run(
      `INSERT INTO calendar_instances (id, series_id, scheduled_at, status, turn_id, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
      [queuedInst, series.id, t + 60_000, turnId, t],
    );
    const q = await fetch(`${origin}/v1/calendar/instances/${queuedInst}/cancel`, { method: "POST", headers });
    expect(q.status).toBe(200);
    expect(ctx.db.get<{ status: string }>("SELECT status FROM calendar_instances WHERE id = ?", [queuedInst])?.status).toBe(
      "cancelled",
    );
    expect(ctx.db.get<{ status: string }>("SELECT status FROM turns WHERE id = ?", [turnId])?.status).toBe("cancelled");

    const runningInst = id();
    ctx.db.run(
      `INSERT INTO calendar_instances (id, series_id, scheduled_at, status, created_at)
       VALUES (?, ?, ?, 'running', ?)`,
      [runningInst, series.id, t + 120_000, t],
    );
    const running = await fetch(`${origin}/v1/calendar/instances/${runningInst}/cancel`, { method: "POST", headers });
    expect(running.status).toBe(409);
    expect(((await running.json()) as { error: string }).error).toBe("in_flight");
    server.stop(true);
  });

  test("archive Ada pauses series; restore leaves it paused", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const created = await fetch(`${origin}/v1/calendar/series`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "mail",
        prompt: "summarize",
        botId: ada.bot.id,
        dtstart: futureDtstart(),
      }),
    });
    const seriesId = ((await created.json()) as { series: Series }).series.id;
    const arch = await fetch(`${origin}/v1/bots/${ada.bot.id}/archive`, { method: "POST", headers });
    expect(arch.status).toBe(200);
    expect(ctx.db.get<{ status: string }>("SELECT status FROM calendar_series WHERE id = ?", [seriesId])?.status).toBe(
      "paused",
    );
    const restored = await fetch(`${origin}/v1/bots/${ada.bot.id}/restore`, { method: "POST", headers });
    expect(restored.status).toBe(200);
    expect(ctx.db.get<{ status: string }>("SELECT status FROM calendar_series WHERE id = ?", [seriesId])?.status).toBe(
      "paused",
    );
    server.stop(true);
  });
});
