import { describe, expect, test } from "bun:test";
import { id, now } from "@openbot/db";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

type BotCreated = { bot: { id: string; name: string }; threadId: string };
type ThreadMsg = { origin: string; body: string };

function startWorld() {
  process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
  const { ctx, server, origin } = startTestServer({ home: tempHome() });
  const { cookie, session } = loginCookie({ ctx }, "alice");
  const headers = { cookie, "content-type": "application/json" };
  return { ctx, server, origin, headers, session };
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

async function putKey(origin: string, headers: Record<string, string>, key = "xai-switchkey0001"): Promise<void> {
  await fetch(`${origin}/v1/credentials/xai`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ key }),
  });
}

async function createGroup(
  origin: string,
  headers: Record<string, string>,
  title: string,
  botIds: string[],
): Promise<string> {
  const created = await fetch(`${origin}/v1/threads`, {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "group", title, botIds }),
  });
  expect([200, 201]).toContain(created.status);
  const body = (await created.json()) as { thread: { id: string } };
  return body.thread.id;
}

async function waitCompletedTurns(
  db: { get: (sql: string, params: unknown[]) => { n: number } | null },
  botId: string,
  n: number,
  timeout = 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const row = db.get("SELECT COUNT(*) as n FROM turns WHERE bot_id = ? AND status = 'completed'", [botId]);
    if ((row?.n ?? 0) >= n) return;
    await Bun.sleep(40);
  }
  throw new Error(`timeout waiting for ${n} completed turns`);
}

async function waitDm(
  origin: string,
  headers: Record<string, string>,
  botId: string,
  pred: (messages: ThreadMsg[]) => boolean,
  timeout = 20_000,
): Promise<ThreadMsg[]> {
  const start = Date.now();
  let messages: ThreadMsg[] = [];
  while (Date.now() - start < timeout) {
    const t = (await fetch(`${origin}/v1/threads?botId=${botId}`, { headers }).then((r) => r.json())) as {
      messages: ThreadMsg[];
    };
    messages = t.messages ?? [];
    if (pred(messages)) return messages;
    await Bun.sleep(80);
  }
  return messages;
}

function sendBodies(messages: ThreadMsg[]): string[] {
  return messages.filter((m) => m.origin === "send_message").map((m) => m.body);
}

describe("warm thread switch", () => {
  test("DM → group prefixes switch digest, not cold, same pid", async () => {
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      const bob = await createBot(origin, headers, "Bob");
      await putKey(origin, headers);
      const groupId = await createGroup(origin, headers, "Design", [ada.bot.id, bob.bot.id]);
      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:warm-dm]]" }),
      });
      await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("warm-dm"));
      const runner = ctx.engine.runnerFor(session.accountId);
      const pid1 = runner.acpPid(ada.bot.id);
      expect(pid1).toBeTruthy();
      const tokensBefore = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM mcp_tokens WHERE bot_id = ?",
        [ada.bot.id],
      )?.n;

      const posted = await fetch(`${origin}/v1/threads/${groupId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "@Ada [[echo-switch]] [[echo-prompt]]" }),
      });
      expect(posted.status).toBe(202);
      const { turnIds } = (await posted.json()) as { turnIds: string[] };
      const messages = await waitDm(
        origin,
        headers,
        ada.bot.id,
        (m) => sendBodies(m).includes("got-switch") && sendBodies(m).includes("no-digest"),
      );
      expect(sendBodies(messages)).toContain("got-switch");
      expect(sendBodies(messages)).toContain("no-digest");
      expect(sendBodies(messages)).not.toContain("got-digest");
      expect(runner.acpPid(ada.bot.id)).toBe(pid1);
      const tokensAfter = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM mcp_tokens WHERE bot_id = ?",
        [ada.bot.id],
      )?.n;
      expect(tokensAfter).toBe(tokensBefore);
      const live = (await fetch(`${origin}/v1/turns/${turnIds[0]}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { from?: string; to?: string; reason?: string } }>;
      };
      const sw = live.events.filter((e) => e.kind === "thread_switch");
      expect(sw.length).toBe(1);
      expect(sw[0]?.payload?.from).toBe(ada.threadId);
      expect(sw[0]?.payload?.to).toBe(groupId);
      expect(live.events.some((e) => e.kind === "harness_session_reset")).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("two DMs are no-switch", async () => {
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      await putKey(origin, headers, "xai-switchkey0002");
      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:one]]" }),
      });
      await waitCompletedTurns(ctx.db, ada.bot.id, 1);
      const pid1 = ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id);
      const posted = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[echo-switch]] [[echo-prompt]]" }),
      });
      const { turnId } = (await posted.json()) as { turnId: string };
      const messages = await waitDm(
        origin,
        headers,
        ada.bot.id,
        (m) => sendBodies(m).includes("no-switch") && sendBodies(m).includes("no-digest"),
      );
      expect(sendBodies(messages)).toContain("no-switch");
      expect(sendBodies(messages)).not.toContain("got-switch");
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBe(pid1);
      const live = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string }>;
      };
      expect(live.events.some((e) => e.kind === "thread_switch")).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("empty destination still has switch banner", async () => {
    const { server, origin, headers } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      const bob = await createBot(origin, headers, "Bob");
      await putKey(origin, headers, "xai-switchkey0003");
      const groupId = await createGroup(origin, headers, "Empty", [ada.bot.id, bob.bot.id]);
      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:warm]]" }),
      });
      await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("warm"));
      await fetch(`${origin}/v1/threads/${groupId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "@Ada [[echo-switch]] [[echo-prompt]]" }),
      });
      const messages = await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("got-switch"));
      expect(sendBodies(messages)).toContain("got-switch");
      expect(sendBodies(messages)).toContain("no-digest");
    } finally {
      server.stop(true);
    }
  });

  test("group+calendar prefixes still compose under switch wrap", async () => {
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      const bob = await createBot(origin, headers, "Bob");
      await putKey(origin, headers, "xai-switchkey0004");
      const groupId = await createGroup(origin, headers, "standup", [ada.bot.id, bob.bot.id]);
      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:warm-dm]]" }),
      });
      await waitCompletedTurns(ctx.db, ada.bot.id, 1);
      const pid1 = ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id);
      const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [ada.bot.id])!
        .account_id;
      const seriesId = id();
      const t = now();
      ctx.db.run(
        `INSERT INTO calendar_series (
           id, account_id, title, prompt, assignee_bot_id, thread_id, kind, status, rrule,
           dtstart_utc, timezone, require_human_approval, created_by, min_interval_ms,
           last_fired_at, next_due_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'schedule', 'active', NULL, ?, 'UTC', 0, 'human', 120000, NULL, ?, ?, ?)`,
        [
          seriesId,
          accountId,
          "standup ping",
          "[[echo-cal-prefix]] [[echo-prefix]] [[echo-switch]] [[echo-prompt]]",
          ada.bot.id,
          groupId,
          Date.now() - 30_000,
          Date.now() - 30_000,
          t,
          t,
        ],
      );
      ctx.engine.tickCalendar();
      ctx.engine.kick();
      const messages = await waitDm(origin, headers, ada.bot.id, (m) => {
        const bodies = sendBodies(m);
        return (
          bodies.includes("got-calendar-prefix") &&
          bodies.includes("got-group-prefix") &&
          bodies.includes("got-switch") &&
          bodies.includes("no-digest")
        );
      });
      const bodies = sendBodies(messages);
      expect(bodies).toContain("got-calendar-prefix");
      expect(bodies).toContain("got-group-prefix");
      expect(bodies).toContain("got-switch");
      expect(bodies).toContain("no-digest");
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBe(pid1);
    } finally {
      server.stop(true);
    }
  });

  test("queued-cancel group turn is not a switch after idle resume on the DM", async () => {
    const prevIdle = process.env.OPENBOT_ACP_IDLE_MS;
    const prevResume = process.env.OPENBOT_FAKE_RESUME;
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    process.env.OPENBOT_ACP_IDLE_MS = "80";
    process.env.OPENBOT_FAKE_RESUME = "1";
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie, session } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      const ada = await createBot(origin, headers, "Ada");
      const bob = await createBot(origin, headers, "Bob");
      await putKey(origin, headers, "xai-switchkey0005");
      const groupId = await createGroup(origin, headers, "Design", [ada.bot.id, bob.bot.id]);
      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[sleep:2500]] [[send:one]]" }),
      });
      const queued = await fetch(`${origin}/v1/threads/${groupId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "@Ada please wait" }),
      });
      const { turnIds } = (await queued.json()) as { turnIds: string[] };
      expect(turnIds[0]).toBeTruthy();
      const cancelled = await fetch(`${origin}/v1/turns/${turnIds[0]}/cancel`, { method: "POST", headers });
      expect(cancelled.status).toBe(200);
      const groupTurn = ctx.db.get<{ status: string; started_at: number | null }>(
        "SELECT status, started_at FROM turns WHERE id = ?",
        [turnIds[0]],
      );
      expect(groupTurn?.status).toBe("cancelled");
      expect(groupTurn?.started_at).toBeNull();
      await waitCompletedTurns(ctx.db, ada.bot.id, 1);
      await Bun.sleep(150);
      ctx.engine.maintenance();
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBeUndefined();

      const posted = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[echo-switch]] [[echo-prompt]]" }),
      });
      const { turnId } = (await posted.json()) as { turnId: string };
      const messages = await waitDm(
        origin,
        headers,
        ada.bot.id,
        (m) => sendBodies(m).includes("no-switch") && sendBodies(m).includes("no-digest"),
      );
      expect(sendBodies(messages)).toContain("no-switch");
      expect(sendBodies(messages)).not.toContain("got-switch");
      const live = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { reason?: string } }>;
      };
      expect(live.events.some((e) => e.kind === "thread_switch")).toBe(false);
      expect(live.events.some((e) => e.kind === "harness_session_reset" && e.payload?.reason === "resumed")).toBe(
        true,
      );
    } finally {
      server.stop(true);
      if (prevIdle === undefined) delete process.env.OPENBOT_ACP_IDLE_MS;
      else process.env.OPENBOT_ACP_IDLE_MS = prevIdle;
      if (prevResume === undefined) delete process.env.OPENBOT_FAKE_RESUME;
      else process.env.OPENBOT_FAKE_RESUME = prevResume;
    }
  });
});
