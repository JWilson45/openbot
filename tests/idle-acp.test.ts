import { describe, expect, test } from "bun:test";
import { DEFAULT_ACP_IDLE_MS, acpIdleTtlMs } from "@openbot/runner";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

function withIdleMs<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.OPENBOT_ACP_IDLE_MS;
  try {
    if (value === undefined) delete process.env.OPENBOT_ACP_IDLE_MS;
    else process.env.OPENBOT_ACP_IDLE_MS = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.OPENBOT_ACP_IDLE_MS;
    else process.env.OPENBOT_ACP_IDLE_MS = prev;
  }
}

describe("acpIdleTtlMs", () => {
  test("defaults, disables at 0, and rejects invalid values", () => {
    expect(withIdleMs(undefined, acpIdleTtlMs)).toBe(DEFAULT_ACP_IDLE_MS);
    expect(withIdleMs("", acpIdleTtlMs)).toBe(DEFAULT_ACP_IDLE_MS);
    expect(withIdleMs("0", acpIdleTtlMs)).toBe(0);
    expect(withIdleMs("80", acpIdleTtlMs)).toBe(80);
    expect(withIdleMs("-1", acpIdleTtlMs)).toBe(DEFAULT_ACP_IDLE_MS);
    expect(withIdleMs("nope", acpIdleTtlMs)).toBe(DEFAULT_ACP_IDLE_MS);
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
});
