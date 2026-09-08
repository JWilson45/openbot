import { describe, expect, test } from "bun:test";
import { accountIdSchema, agentIdSchema } from "@openbot/core";
import { id, now, sha256Hex } from "@openbot/db";
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
  const { cookie, session } = loginCookie({ ctx }, "alice");
  const headers = { cookie, "content-type": "application/json" };
  return { ctx, server, origin, headers, session };
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
  test("human learn captures only canonical public AG-UI messages and retains a firing thread", async () => {
    const { ctx, server, origin, headers, session } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const principal = {
      accountId: accountIdSchema.parse(session.accountId),
      subjectId: `user:${session.userId}`,
      kind: "user" as const,
      scopes: ["tasks:read", "tasks:write"],
    };
    const view = await ctx.protocols.tasks.submit({
      principal,
      agentId: agentIdSchema.parse(ada.bot.id),
      message: { role: "user", parts: [{ kind: "text", text: "canonical public request" }] },
      metadata: { "openbot.protocol": "ag-ui", "ag-ui.sdk-version": "0.0.59" },
    });
    const run = view.runs[0]!;
    const insertCanonical = (role: "agent" | "system" | "tool", text: string) => {
      ctx.db.run(
        `INSERT INTO agent_messages
          (id, account_id, thread_id, task_id, run_id, role, parts_json, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
        [id(), session.accountId, view.task.threadId, view.task.id, run.id, role,
          JSON.stringify([{ kind: "text", text }]), now()],
      );
    };
    insertCanonical("agent", "canonical public response");
    insertCanonical("system", "canonical system instruction");
    insertCanonical("tool", "canonical tool payload");

    const legacyTurn = id();
    ctx.db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, created_at)
       VALUES (?, ?, NULL, 'user', 'user', 'legacy human transcript', 'normal', ?)`,
      [id(), ada.threadId, now()],
    );
    ctx.db.run(
      `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, created_at)
       VALUES (?, ?, ?, 'completed', 0, '', ?)`,
      [legacyTurn, ada.threadId, ada.bot.id, now()],
    );
    ctx.db.run(
      `INSERT INTO live_work_events (id, turn_id, seq, kind, payload, created_at)
       VALUES (?, ?, 1, 'tool_call', ?, ?)`,
      [id(), legacyTurn, JSON.stringify({ update: { title: "legacy private live work" } }), now()],
    );

    const learned = await fetch(`${origin}/v1/calendar/learn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agentId: ada.bot.id }),
    });
    expect(learned.status).toBe(201);
    const series = ((await learned.json()) as { series: Series & { prompt: string; capture_summary: string } }).series;
    expect(series.thread_id).toBe(ada.threadId);
    expect(series.source_thread_id).toBeNull();
    expect(series.prompt).toContain("canonical public request");
    expect(series.prompt).toContain("canonical public response");
    expect(series.prompt).not.toContain("canonical system instruction");
    expect(series.prompt).not.toContain("canonical tool payload");
    expect(series.prompt).not.toContain("legacy human transcript");
    expect(series.prompt).not.toContain("legacy private live work");
    const summary = JSON.parse(series.capture_summary) as { liveWork: string[] };
    expect(summary.liveWork).toEqual([]);

    const legacyHuman = await fetch(`${origin}/v1/calendar/learn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ threadId: ada.threadId }),
    });
    expect(legacyHuman.status).toBe(400);
    expect((await legacyHuman.json()) as object).toEqual({ error: "invalid_thread" });
    const ambiguous = await fetch(`${origin}/v1/calendar/learn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agentId: ada.bot.id, threadId: ada.threadId }),
    });
    expect(ambiguous.status).toBe(400);
    const otherUserId = id();
    const otherAccountId = id();
    const otherSessionId = id();
    const otherToken = `other-${crypto.randomUUID()}`;
    ctx.db.run("INSERT INTO users(id, github_login, created_at) VALUES (?, 'mallory', ?)", [otherUserId, now()]);
    ctx.db.run("INSERT INTO accounts(id, auth_user_id, created_at) VALUES (?, ?, ?)", [otherAccountId, otherUserId, now()]);
    ctx.db.run(
      "INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      [otherSessionId, otherUserId, sha256Hex(otherToken), now() + 60_000, now()],
    );
    const cookieName = headers.cookie.slice(0, headers.cookie.indexOf("="));
    const crossTenant = await fetch(`${origin}/v1/calendar/learn`, {
      method: "POST",
      headers: { cookie: `${cookieName}=${otherToken}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: ada.bot.id }),
    });
    expect(crossTenant.status).toBe(404);
    server.stop(true);
  });

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
      body: JSON.stringify({ agentId: ada.bot.id }),
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
