import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CAL_CREATE_PER_HOUR, CAL_MAX_SERIES, CAL_MIN_INTERVAL_MS } from "@openbot/calendar";
import { id, now, OpenbotDb } from "@openbot/db";
import { handleMcpJsonRpc, McpInflight } from "@openbot/mcp-send-message";
import { insertTurn, seedWorld, tempHome } from "./helpers.ts";

function rpc(json: unknown): {
  result?: { content?: Array<{ text?: string }> };
  error?: { message?: string; data?: { code?: string } };
} {
  return json as {
    result?: { content?: Array<{ text?: string }> };
    error?: { message?: string; data?: { code?: string } };
  };
}

function payload(json: unknown): Record<string, unknown> {
  const text = rpc(json).result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function call(
  db: OpenbotDb,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  hooks?: { onCalendarDue?: () => void },
) {
  const inflight = new McpInflight();
  return handleMcpJsonRpc(
    db,
    inflight,
    `Bearer ${token}`,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    hooks,
  );
}

function insertBot(db: OpenbotDb, accountId: string, name: string, role = "desk"): string {
  const botId = id();
  db.run(
    `INSERT INTO bots (id, account_id, name, description, status, permission_mode, role, created_at)
     VALUES (?, ?, ?, 'teammate', 'active', 'auto', ?, ?)`,
    [botId, accountId, name, role, now()],
  );
  db.run(
    `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, 't', 'human', ?)`,
    [id(), accountId, botId, now()],
  );
  return botId;
}

function insertSeries(
  db: OpenbotDb,
  accountId: string,
  opts?: {
    status?: string;
    kind?: string;
    assigneeBotId?: string | null;
    threadId?: string | null;
    dtstartUtc?: number;
  },
): string {
  const seriesId = id();
  const t = now();
  db.run(
    `INSERT INTO calendar_series (
       id, account_id, title, prompt, assignee_bot_id, thread_id, kind, status, rrule,
       dtstart_utc, timezone, created_by, min_interval_ms, created_at, updated_at
     ) VALUES (?, ?, ?, 'p', ?, ?, ?, ?, NULL, ?, 'UTC', 'human', ?, ?, ?)`,
    [
      seriesId,
      accountId,
      `s-${seriesId.slice(0, 8)}`,
      opts?.assigneeBotId ?? null,
      opts?.threadId ?? null,
      opts?.kind ?? "schedule",
      opts?.status ?? "active",
      opts?.dtstartUtc ?? t + 24 * 60 * 60 * 1000,
      CAL_MIN_INTERVAL_MS,
      t,
      t,
    ],
  );
  return seriesId;
}

describe("calendar MCP", () => {
  test("Gateway is forbidden and tools/list omits calendar tools", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    insertTurn(db, w, "running");
    db.run("UPDATE bots SET role = 'gateway' WHERE id = ?", [w.botId]);
    const inflight = new McpInflight();
    const listed = await handleMcpJsonRpc(db, inflight, `Bearer ${w.token}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = ((listed.json as { result: { tools: Array<{ name: string }> } }).result.tools ?? []).map(
      (t) => t.name,
    );
    expect(names).toEqual([
      "SendMessage",
      "SendToAgent",
      "SendToThread",
      "ListBots",
      "Memory",
      "SearchMessages",
      "SearchThreads",
      "SendToOrg",
      "Inbox",
    ]);
    expect(names).not.toContain("ListCalendar");
    expect(names).not.toContain("CreateEvent");
    expect(names).not.toContain("ProposeRoutine");
    expect(names).not.toContain("PauseSeries");
    expect(names).not.toContain("ConfirmSeries");
    expect(names).not.toContain("Navigate");
    expect(names).not.toContain("BrowserSnapshot");
    expect(names).not.toContain("Click");
    expect(names).not.toContain("Type");
    expect(names).not.toContain("Wait");

    for (const name of [
      "ListCalendar",
      "CreateEvent",
      "ProposeRoutine",
      "ConfirmSeries",
      "PauseSeries",
      "Navigate",
      "BrowserSnapshot",
      "Click",
      "Type",
      "Wait",
    ]) {
      const res = await call(db, w.token, name, {
        title: "t",
        prompt: "p",
        seriesId: id(),
        paused: true,
        url: "https://example.com",
        text: "Go",
      });
      expect(res.status).toBe(403);
      expect(rpc(res.json).error?.data?.code).toBe("forbidden");
    }
    db.close();
  });

  test("CreateEvent always proposed, min interval, other-desk assignee, running-turn thread default", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    const bobId = insertBot(db, w.accountId, "Bob");
    const otherThread = id();
    db.run(
      `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, 'other', 'group', ?)`,
      [otherThread, w.accountId, w.botId, now()],
    );
    insertTurn(db, w, "running", { threadId: otherThread });
    let ticks = 0;
    const created = await call(
      db,
      w.token,
      "CreateEvent",
      {
        title: "mail",
        prompt: "summarize overnight mail",
        name: "Bob",
        rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      },
      { onCalendarDue: () => ticks++ },
    );
    expect(created.status).toBe(200);
    const body = payload(created.json);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("proposed");
    expect(body.kind).toBe("schedule");
    expect(body.assigneeBotId).toBe(bobId);
    expect(body.threadId).toBe(otherThread);
    expect(body.threadId).not.toBe(w.threadId);
    expect(ticks).toBe(0);
    const row = db.get<{
      status: string;
      kind: string;
      created_by: string;
      assignee_bot_id: string;
      thread_id: string;
    }>("SELECT status, kind, created_by, assignee_bot_id, thread_id FROM calendar_series WHERE id = ?", [
      body.seriesId,
    ]);
    expect(row).toEqual({
      status: "proposed",
      kind: "schedule",
      created_by: "bot",
      assignee_bot_id: bobId,
      thread_id: otherThread,
    });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calendar_instances")?.n).toBe(0);

    const minutely = await call(db, w.token, "CreateEvent", {
      title: "too often",
      prompt: "nope",
      rrule: "FREQ=MINUTELY;INTERVAL=1",
    });
    expect(minutely.status).toBe(400);
    expect(rpc(minutely.json).error?.data?.code).toBe("min_interval");

    const gwId = insertBot(db, w.accountId, "Gateway", "gateway");
    const asGw = await call(db, w.token, "CreateEvent", { title: "gw", prompt: "nope", botId: gwId });
    expect(asGw.status).toBe(403);
    expect(rpc(asGw.json).error?.data?.code).toBe("forbidden");

    const a2a = id();
    db.run(
      `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, 'a2a', 'a2a', ?)`,
      [a2a, w.accountId, w.botId, now()],
    );
    const a2aTurn = await call(db, w.token, "CreateEvent", { title: "a2a", prompt: "nope", threadId: a2a });
    expect(a2aTurn.status).toBe(400);
    expect(rpc(a2aTurn.json).error?.data?.code).toBe("invalid_thread");
    db.close();
  });

  test("ConfirmSeries activates a proposed series and ticks", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    insertTurn(db, w, "running");
    let ticks = 0;
    const created = await call(db, w.token, "CreateEvent", {
      title: "brief",
      prompt: "ping",
      rrule: "FREQ=MINUTELY;INTERVAL=5",
    });
    const seriesId = payload(created.json).seriesId as string;
    const before = await call(db, w.token, "ListCalendar", {});
    const listed = payload(before.json).series as Array<{ id: string; status: string; nextFire: number | null }>;
    expect(listed.find((s) => s.id === seriesId)?.status).toBe("proposed");
    expect(listed.find((s) => s.id === seriesId)?.nextFire).toBeNull();

    const confirmed = await call(
      db,
      w.token,
      "ConfirmSeries",
      { seriesId },
      { onCalendarDue: () => ticks++ },
    );
    expect(confirmed.status).toBe(200);
    const body = payload(confirmed.json);
    expect(body.status).toBe("active");
    expect(ticks).toBe(1);
    expect(db.get<{ status: string }>("SELECT status FROM calendar_series WHERE id = ?", [seriesId])?.status).toBe(
      "active",
    );
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calendar_instances WHERE series_id = ?", [seriesId])?.n).toBeGreaterThan(
      0,
    );

    const other = insertBot(db, w.accountId, "Bob");
    const foreign = insertSeries(db, w.accountId, { status: "proposed", assigneeBotId: other });
    const denied = await call(db, w.token, "ConfirmSeries", { seriesId: foreign });
    expect(denied.status).toBe(403);
    db.close();
  });

  test("ProposeRoutine is proposed and defaults threadId to lockRunningTurn", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    const groupId = id();
    db.run(
      `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, 'Standup', 'group', ?)`,
      [groupId, w.accountId, w.botId, now()],
    );
    insertTurn(db, w, "running", { threadId: groupId });
    const proposed = await call(db, w.token, "ProposeRoutine", { title: "from chat", prompt: "repeat the workflow" });
    expect(proposed.status).toBe(200);
    const body = payload(proposed.json);
    expect(body.status).toBe("proposed");
    expect(body.kind).toBe("routine");
    expect(body.threadId).toBe(groupId);
    expect(body.assigneeBotId).toBe(w.botId);
    const row = db.get<{ kind: string; status: string; thread_id: string; created_by: string }>(
      "SELECT kind, status, thread_id, created_by FROM calendar_series WHERE id = ?",
      [body.seriesId],
    );
    expect(row).toEqual({ kind: "routine", status: "proposed", thread_id: groupId, created_by: "bot" });
    db.close();
  });

  test("cap 32 non-cancelled; pause does not count as create; unpause 409 at cap", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    insertTurn(db, w, "running");
    for (let i = 0; i < CAL_MAX_SERIES; i++) insertSeries(db, w.accountId, { assigneeBotId: w.botId });
    const extra = await call(db, w.token, "CreateEvent", { title: "overflow", prompt: "p" });
    expect(extra.status).toBe(409);
    expect(rpc(extra.json).error?.data?.code).toBe("cap");

    const pausedId = db.get<{ id: string }>("SELECT id FROM calendar_series LIMIT 1")!.id;
    const paused = await call(db, w.token, "PauseSeries", { seriesId: pausedId, paused: true });
    expect(paused.status).toBe(200);
    expect(payload(paused.json).status).toBe("paused");
    const still = await call(db, w.token, "CreateEvent", { title: "after-pause", prompt: "p" });
    expect(still.status).toBe(409);

    const extraPaused = insertSeries(db, w.accountId, { status: "paused", assigneeBotId: w.botId });
    const unpause = await call(db, w.token, "PauseSeries", { seriesId: extraPaused, paused: false });
    expect(unpause.status).toBe(409);
    expect(rpc(unpause.json).error?.data?.code).toBe("cap");

    const proposedId = insertSeries(db, w.accountId, { status: "proposed", assigneeBotId: w.botId });
    const pauseProposed = await call(db, w.token, "PauseSeries", { seriesId: proposedId, paused: true });
    expect(pauseProposed.status).toBe(409);
    expect(rpc(pauseProposed.json).error?.data?.code).toBe("not_active");
    expect(db.get<{ status: string }>("SELECT status FROM calendar_series WHERE id = ?", [proposedId])?.status).toBe(
      "proposed",
    );
    const unpauseProposed = await call(db, w.token, "PauseSeries", { seriesId: proposedId, paused: false });
    expect(unpauseProposed.status).toBe(409);
    expect(rpc(unpauseProposed.json).error?.data?.code).toBe("not_paused");
    db.close();
  });

  test("PauseSeries skips due and cancels queued turns; 3/turn rate via calendar.create", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    insertTurn(db, w, "running");
    const seriesId = insertSeries(db, w.accountId, { assigneeBotId: w.botId, threadId: w.threadId });
    const dueId = id();
    const queuedInst = id();
    const queuedTurn = id();
    const t = now();
    db.run(
      `INSERT INTO calendar_instances (id, series_id, scheduled_at, status, created_at) VALUES (?, ?, ?, 'due', ?)`,
      [dueId, seriesId, t, t],
    );
    db.run(
      `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, created_at)
       VALUES (?, ?, ?, 'queued', 0, '', ?)`,
      [queuedTurn, w.threadId, w.botId, t],
    );
    db.run(
      `INSERT INTO calendar_instances (id, series_id, scheduled_at, status, turn_id, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
      [queuedInst, seriesId, t + 1000, queuedTurn, t],
    );
    const paused = await call(db, w.token, "PauseSeries", { seriesId, paused: true });
    expect(paused.status).toBe(200);
    expect(db.get<{ status: string }>("SELECT status FROM calendar_instances WHERE id = ?", [dueId])?.status).toBe(
      "skipped_paused",
    );
    expect(db.get<{ status: string }>("SELECT status FROM calendar_instances WHERE id = ?", [queuedInst])?.status).toBe(
      "cancelled",
    );
    expect(db.get<{ status: string }>("SELECT status FROM turns WHERE id = ?", [queuedTurn])?.status).toBe("cancelled");
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE type = 'calendar.create'")?.n).toBe(0);

    for (let i = 0; i < 3; i++) {
      const r = await call(db, w.token, "CreateEvent", { title: `r${i}`, prompt: "p" });
      expect(r.status).toBe(200);
    }
    const fourth = await call(db, w.token, "CreateEvent", { title: "r3", prompt: "p" });
    expect(fourth.status).toBe(429);
    expect(rpc(fourth.json).error?.data?.code).toBe("rate_limited");
    db.close();
  });

  test("PauseSeries rematerializes a paused active series and calls onCalendarDue", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    insertTurn(db, w, "running");
    const dtstart = now() + 24 * 60 * 60 * 1000;
    const seriesId = insertSeries(db, w.accountId, {
      assigneeBotId: w.botId,
      threadId: w.threadId,
      dtstartUtc: dtstart,
    });
    const instId = id();
    db.run(
      `INSERT INTO calendar_instances (id, series_id, scheduled_at, status, created_at) VALUES (?, ?, ?, 'scheduled', ?)`,
      [instId, seriesId, dtstart, now()],
    );
    let ticks = 0;
    const paused = await call(db, w.token, "PauseSeries", { seriesId, paused: true }, { onCalendarDue: () => ticks++ });
    expect(paused.status).toBe(200);
    expect(payload(paused.json).status).toBe("paused");
    expect(ticks).toBe(0);
    expect(db.get<{ status: string }>("SELECT status FROM calendar_instances WHERE id = ?", [instId])?.status).toBe(
      "skipped_paused",
    );

    const unpaused = await call(
      db,
      w.token,
      "PauseSeries",
      { seriesId, paused: false },
      { onCalendarDue: () => ticks++ },
    );
    expect(unpaused.status).toBe(200);
    expect(payload(unpaused.json).status).toBe("active");
    expect(ticks).toBe(1);
    const after = db.all<{ scheduled_at: number; status: string }>(
      "SELECT scheduled_at, status FROM calendar_instances WHERE series_id = ?",
      [seriesId],
    );
    expect(after.filter((i) => i.status === "skipped_paused")).toEqual([]);
    expect(after.some((i) => i.scheduled_at === dtstart && i.status === "scheduled")).toBe(true);
    expect(db.get<{ status: string }>("SELECT status FROM calendar_series WHERE id = ?", [seriesId])?.status).toBe(
      "active",
    );
    db.close();
  });

  test("CreateEvent is rate limited 20 per account per hour", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    insertTurn(db, w, "running");
    const t = now();
    for (let i = 0; i < CAL_CREATE_PER_HOUR; i++) {
      db.run(
        `INSERT INTO audit_events (id, account_id, actor, type, payload, created_at)
         VALUES (?, ?, 'harness', 'calendar.create', ?, ?)`,
        [id(), w.accountId, JSON.stringify({ title: `seed-${i}` }), t],
      );
    }
    const blocked = await call(db, w.token, "CreateEvent", { title: "hourly", prompt: "p" });
    expect(blocked.status).toBe(429);
    expect(rpc(blocked.json).error?.data?.code).toBe("rate_limited");

    db.run(`UPDATE audit_events SET created_at = ? WHERE type = 'calendar.create' AND account_id = ?`, [
      t - 61 * 60 * 1000,
      w.accountId,
    ]);
    const ok = await call(db, w.token, "CreateEvent", { title: "after-window", prompt: "p" });
    expect(ok.status).toBe(200);
    expect(payload(ok.json).status).toBe("proposed");
    db.close();
  });

  test("ListCalendar returns series for the running desk turn", async () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    insertTurn(db, w, "running");
    const seriesId = insertSeries(db, w.accountId, { status: "proposed", assigneeBotId: w.botId });
    const listed = await call(db, w.token, "ListCalendar", { status: "proposed" });
    expect(listed.status).toBe(200);
    const body = payload(listed.json) as {
      series: Array<{ id: string; status: string; nextFire: number | null; assigneeName: string | null }>;
    };
    expect(body.series.some((s) => s.id === seriesId && s.status === "proposed" && s.nextFire === null)).toBe(true);
    expect(body.series.find((s) => s.id === seriesId)?.assigneeName).toBe("Ada");
    db.close();
  });
});
