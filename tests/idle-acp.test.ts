import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ACP_IDLE_MS,
  DEFAULT_GATEWAY_ACP_IDLE_MS,
  acpIdleTtlMs,
  gatewayAcpIdleTtlMs,
} from "@openbot/runner";
import { id, now } from "@openbot/db";
import { CAL_MIN_INTERVAL_MS } from "@openbot/calendar";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

describe("acpIdleTtlMs", () => {
  test("defaults, disables at 0, and rejects invalid values", () => {
    expect(withEnv("OPENBOT_ACP_IDLE_MS", undefined, acpIdleTtlMs)).toBe(DEFAULT_ACP_IDLE_MS);
    expect(withEnv("OPENBOT_ACP_IDLE_MS", "", acpIdleTtlMs)).toBe(DEFAULT_ACP_IDLE_MS);
    expect(withEnv("OPENBOT_ACP_IDLE_MS", "0", acpIdleTtlMs)).toBe(0);
    expect(withEnv("OPENBOT_ACP_IDLE_MS", "80", acpIdleTtlMs)).toBe(80);
    expect(withEnv("OPENBOT_ACP_IDLE_MS", "-1", acpIdleTtlMs)).toBe(DEFAULT_ACP_IDLE_MS);
    expect(withEnv("OPENBOT_ACP_IDLE_MS", "nope", acpIdleTtlMs)).toBe(DEFAULT_ACP_IDLE_MS);
  });

  test("gateway TTL is independent of desk TTL", () => {
    expect(withEnv("OPENBOT_GATEWAY_ACP_IDLE_MS", undefined, gatewayAcpIdleTtlMs)).toBe(
      DEFAULT_GATEWAY_ACP_IDLE_MS,
    );
    expect(withEnv("OPENBOT_GATEWAY_ACP_IDLE_MS", "0", gatewayAcpIdleTtlMs)).toBe(0);
    expect(withEnv("OPENBOT_GATEWAY_ACP_IDLE_MS", "90", gatewayAcpIdleTtlMs)).toBe(90);
    expect(
      withEnv("OPENBOT_ACP_IDLE_MS", "0", () =>
        withEnv("OPENBOT_GATEWAY_ACP_IDLE_MS", undefined, gatewayAcpIdleTtlMs),
      ),
    ).toBe(DEFAULT_GATEWAY_ACP_IDLE_MS);
  });
});

describe("idle ACP TTL", () => {
  test("kills a warm harness after idle TTL and cold-starts the next message", async () => {
    const prevIdle = process.env.OPENBOT_ACP_IDLE_MS;
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    process.env.OPENBOT_ACP_IDLE_MS = "80";
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie, session } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      const created = (await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Ada" }),
      }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
      await fetch(`${origin}/v1/credentials/xai`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ key: "xai-idlekey0001" }),
      });
      await fetch(`${origin}/v1/threads/${created.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:one]]" }),
      });
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const t = ctx.db.get<{ status: string }>(
          "SELECT status FROM turns WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
          [created.bot.id],
        );
        if (t?.status === "completed") break;
        await Bun.sleep(40);
      }
      const pid1 = ctx.engine.runnerFor(session.accountId).acpPid(created.bot.id);
      expect(pid1).toBeTruthy();

      await Bun.sleep(150);
      ctx.engine.maintenance();
      expect(ctx.engine.runnerFor(session.accountId).acpPid(created.bot.id)).toBeUndefined();

      await fetch(`${origin}/v1/threads/${created.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:two]]" }),
      });
      const start2 = Date.now();
      while (Date.now() - start2 < 10_000) {
        const n = ctx.db.get<{ n: number }>(
          "SELECT COUNT(*) as n FROM turns WHERE bot_id = ? AND status = 'completed'",
          [created.bot.id],
        );
        if ((n?.n ?? 0) >= 2) break;
        await Bun.sleep(40);
      }
      const pid2 = ctx.engine.runnerFor(session.accountId).acpPid(created.bot.id);
      expect(pid2).toBeTruthy();
    } finally {
      server.stop(true);
      if (prevIdle === undefined) delete process.env.OPENBOT_ACP_IDLE_MS;
      else process.env.OPENBOT_ACP_IDLE_MS = prevIdle;
    }
  });

  test("desk idle 0 does not kill Gateway; Gateway uses its own TTL", async () => {
    const prevIdle = process.env.OPENBOT_ACP_IDLE_MS;
    const prevGw = process.env.OPENBOT_GATEWAY_ACP_IDLE_MS;
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    process.env.OPENBOT_ACP_IDLE_MS = "0";
    process.env.OPENBOT_GATEWAY_ACP_IDLE_MS = "80";
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie, session } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      await fetch(`${origin}/v1/org`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ federationEnabled: true }),
      });
      const ada = (await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Ada" }),
      }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
      const listed = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
        gateway: { id: string };
      };
      const gwId = listed.gateway.id;
      const gwThread = (await fetch(`${origin}/v1/threads?botId=${gwId}`, { headers }).then((r) =>
        r.json(),
      )) as { thread: { id: string } };
      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:desk]]" }),
      });
      await fetch(`${origin}/v1/threads/${gwThread.thread.id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:gw]]" }),
      });
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const deskDone = ctx.db.get<{ n: number }>(
          "SELECT COUNT(*) as n FROM turns WHERE bot_id = ? AND status = 'completed'",
          [ada.bot.id],
        );
        const gwDone = ctx.db.get<{ n: number }>(
          "SELECT COUNT(*) as n FROM turns WHERE bot_id = ? AND status = 'completed'",
          [gwId],
        );
        if ((deskDone?.n ?? 0) >= 1 && (gwDone?.n ?? 0) >= 1) break;
        await Bun.sleep(40);
      }
      const runner = ctx.engine.runnerFor(session.accountId);
      expect(runner.acpPid(ada.bot.id)).toBeTruthy();
      expect(runner.acpPid(gwId)).toBeTruthy();
      await Bun.sleep(150);
      ctx.engine.maintenance();
      expect(runner.acpPid(ada.bot.id)).toBeTruthy();
      expect(runner.acpPid(gwId)).toBeUndefined();
    } finally {
      server.stop(true);
      if (prevIdle === undefined) delete process.env.OPENBOT_ACP_IDLE_MS;
      else process.env.OPENBOT_ACP_IDLE_MS = prevIdle;
      if (prevGw === undefined) delete process.env.OPENBOT_GATEWAY_ACP_IDLE_MS;
      else process.env.OPENBOT_GATEWAY_ACP_IDLE_MS = prevGw;
    }
  });

  test("maintenance() alone does not start calendar turns", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      const created = (await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Ada" }),
      }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
      const accountId = ctx.db.get<{ account_id: string }>(
        "SELECT account_id FROM bots WHERE id = ?",
        [created.bot.id],
      )!.account_id;
      const t = now();
      const seriesId = id();
      ctx.db.run(
        `INSERT INTO calendar_series (
           id, account_id, title, prompt, assignee_bot_id, thread_id, kind, status, rrule,
           dtstart_utc, timezone, require_human_approval, created_by, min_interval_ms,
           next_due_at, created_at, updated_at
         ) VALUES (?, ?, 'idle', '[[send:nope]]', ?, ?, 'schedule', 'active', NULL, ?, 'UTC', 0, 'human', ?, ?, ?, ?)`,
        [seriesId, accountId, created.bot.id, created.threadId, t - 60_000, CAL_MIN_INTERVAL_MS, t - 60_000, t, t],
      );
      ctx.engine.maintenance();
      expect(ctx.db.all("SELECT id FROM turns WHERE bot_id = ?", [created.bot.id]).length).toBe(0);
      ctx.engine.tickCalendar();
      expect(
        ctx.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM turns WHERE bot_id = ? AND status = 'queued'",
          [created.bot.id],
        )?.n,
      ).toBe(1);
      ctx.engine.maintenance();
      expect(
        ctx.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM turns WHERE bot_id = ? AND status = 'queued'",
          [created.bot.id],
        )?.n,
      ).toBe(1);
      expect(
        ctx.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM turns WHERE bot_id = ? AND status IN ('running', 'completed')",
          [created.bot.id],
        )?.n,
      ).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});
