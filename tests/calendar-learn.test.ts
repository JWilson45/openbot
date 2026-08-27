import { describe, expect, test } from "bun:test";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

type Series = {
  id: string;
  kind: string;
  status: string;
  thread_id: string | null;
  source_thread_id: string | null;
  rrule: string | null;
  dtstart_utc: number;
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

describe("calendar learn", () => {
  test("group learn keeps the group as the firing thread", async () => {
    const { server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const group = await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "group", title: "standup", botIds: [ada.bot.id, bob.bot.id] }),
    });
    expect([200, 201]).toContain(group.status);
    const groupId = ((await group.json()) as { thread: { id: string } }).thread.id;

    const learned = await fetch(`${origin}/v1/calendar/learn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ threadId: groupId }),
    });
    expect(learned.status).toBe(201);
    const series = ((await learned.json()) as { series: Series }).series;
    expect(series.kind).toBe("routine");
    expect(series.status).toBe("proposed");
    expect(series.thread_id).toBe(groupId);
    expect(series.source_thread_id).toBe(groupId);
    server.stop(true);
  });

  test("confirm rematerializes after cadence edit", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const learned = await fetch(`${origin}/v1/calendar/learn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ threadId: ada.threadId }),
    });
    expect(learned.status).toBe(201);
    const proposed = ((await learned.json()) as { series: Series }).series;
    expect(proposed.status).toBe("proposed");
    expect(proposed.thread_id).toBe(ada.threadId);
    expect(ctx.db.all("SELECT id FROM calendar_instances WHERE series_id = ?", [proposed.id]).length).toBe(0);
    const before = (await fetch(`${origin}/v1/calendar/series/${proposed.id}`, { headers }).then((r) => r.json())) as {
      nextFire: number | null;
    };
    expect(before.nextFire).toBeNull();

    const patched = await fetch(`${origin}/v1/calendar/series/${proposed.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
        dtstart: proposed.dtstart_utc,
      }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { series: Series }).series.status).toBe("proposed");
    expect(ctx.db.all("SELECT id FROM calendar_instances WHERE series_id = ?", [proposed.id]).length).toBe(0);

    const ok = await fetch(`${origin}/v1/calendar/series/${proposed.id}/confirm`, { method: "POST", headers });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { series: Series }).series.status).toBe("active");

    const instances = ctx.db.all<{ status: string }>(
      "SELECT status FROM calendar_instances WHERE series_id = ? ORDER BY scheduled_at",
      [proposed.id],
    );
    expect(instances.length).toBeGreaterThan(0);
    expect(instances.some((i) => i.status === "scheduled")).toBe(true);

    const after = (await fetch(`${origin}/v1/calendar/series/${proposed.id}`, { headers }).then((r) => r.json())) as {
      series: Series;
      nextFire: number | null;
    };
    expect(after.series.status).toBe("active");
    expect(after.series.rrule).toBe("FREQ=DAILY;BYHOUR=9;BYMINUTE=0");
    expect(after.nextFire).toBeGreaterThan(0);
    expect(ctx.db.all("SELECT id FROM turns").length).toBe(0);
    server.stop(true);
  });
});
