import { describe, expect, test } from "bun:test";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

async function waitCompletedTurns(
  db: { get: (sql: string, params: unknown[]) => { n: number } | null },
  botId: string,
  n: number,
  timeout = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const row = db.get("SELECT COUNT(*) as n FROM turns WHERE bot_id = ? AND status = 'completed'", [botId]);
    if ((row?.n ?? 0) >= n) return;
    await Bun.sleep(40);
  }
  throw new Error(`timeout waiting for ${n} completed turns`);
}

async function waitSendBody(
  origin: string,
  headers: Record<string, string>,
  body: string,
  timeout = 20_000,
): Promise<Array<{ origin: string; body: string }>> {
  const start = Date.now();
  let messages: Array<{ origin: string; body: string }> = [];
  while (Date.now() - start < timeout) {
    const t = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      messages: Array<{ origin: string; body: string }>;
    };
    messages = t.messages;
    if (messages.some((m) => m.origin === "send_message" && m.body === body)) return messages;
    if (messages.some((m) => m.origin === "fallback")) return messages;
    await Bun.sleep(80);
  }
  return messages;
}

async function idleKillThenEcho(opts: { fakeResume?: boolean }): Promise<{
  messages: Array<{ origin: string; body: string }>;
  events: Array<{ kind: string; payload: { reason?: string } }>;
}> {
  const prevIdle = process.env.OPENBOT_ACP_IDLE_MS;
  const prevResume = process.env.OPENBOT_FAKE_RESUME;
  process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
  process.env.OPENBOT_ACP_IDLE_MS = "80";
  if (opts.fakeResume) process.env.OPENBOT_FAKE_RESUME = "1";
  else delete process.env.OPENBOT_FAKE_RESUME;
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
      body: JSON.stringify({ key: opts.fakeResume ? "xai-resumekey0002" : "xai-resumekey0001" }),
    });
    await fetch(`${origin}/v1/threads/${created.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[send:one]]" }),
    });
    await waitCompletedTurns(ctx.db, created.bot.id, 1);
    const stored = ctx.db.get<{ acp_session_id: string }>(
      "SELECT acp_session_id FROM harness_sessions WHERE bot_id = ? AND acp_session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      [created.bot.id],
    );
    expect(stored?.acp_session_id).toBeTruthy();
    expect(ctx.engine.runnerFor(session.accountId).acpPid(created.bot.id)).toBeTruthy();

    await Bun.sleep(150);
    ctx.engine.maintenance();
    expect(ctx.engine.runnerFor(session.accountId).acpPid(created.bot.id)).toBeUndefined();

    const posted = await fetch(`${origin}/v1/threads/${created.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[echo-prompt]] [[echo-switch]]" }),
    });
    expect(posted.status).toBe(202);
    const { turnId } = (await posted.json()) as { turnId: string };
    const want = opts.fakeResume ? "no-digest" : "got-digest";
    const messages = await waitSendBody(origin, headers, want);
    const live = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) => r.json())) as {
      events: Array<{ kind: string; payload: { reason?: string; from?: string; to?: string } }>;
    };
    return { messages, events: live.events };
  } finally {
    server.stop(true);
    if (prevIdle === undefined) delete process.env.OPENBOT_ACP_IDLE_MS;
    else process.env.OPENBOT_ACP_IDLE_MS = prevIdle;
    if (prevResume === undefined) delete process.env.OPENBOT_FAKE_RESUME;
    else process.env.OPENBOT_FAKE_RESUME = prevResume;
  }
}

describe("ACP session/resume after idle kill", () => {
  test("failed resume still injects thread digest", async () => {
    const { messages, events } = await idleKillThenEcho({ fakeResume: false });
    expect(messages.some((m) => m.origin === "send_message" && m.body === "got-digest")).toBe(true);
    expect(messages.some((m) => m.origin === "send_message" && m.body === "no-switch")).toBe(true);
    const reset = events.filter((e) => e.kind === "harness_session_reset");
    expect(reset.some((e) => e.payload?.reason === "cold_start")).toBe(true);
    expect(reset.some((e) => e.payload?.reason === "resumed")).toBe(false);
    expect(events.some((e) => e.kind === "thread_switch")).toBe(false);
  });

  test("successful resume skips digest and records harness_session_reset resumed", async () => {
    const { messages, events } = await idleKillThenEcho({ fakeResume: true });
    expect(messages.some((m) => m.origin === "send_message" && m.body === "no-digest")).toBe(true);
    expect(messages.some((m) => m.origin === "send_message" && m.body === "no-switch")).toBe(true);
    const reset = events.filter((e) => e.kind === "harness_session_reset");
    expect(reset.some((e) => e.payload?.reason === "resumed")).toBe(true);
    expect(reset.some((e) => e.payload?.reason === "cold_start")).toBe(false);
    expect(events.some((e) => e.kind === "thread_switch")).toBe(false);
  });

  test("successful resume on another thread is switch not cold", async () => {
    const prevIdle = process.env.OPENBOT_ACP_IDLE_MS;
    const prevResume = process.env.OPENBOT_FAKE_RESUME;
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    process.env.OPENBOT_ACP_IDLE_MS = "80";
    process.env.OPENBOT_FAKE_RESUME = "1";
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie, session } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      const ada = (await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Ada" }),
      }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
      const bob = (await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Bob" }),
      }).then((r) => r.json())) as { bot: { id: string } };
      await fetch(`${origin}/v1/credentials/xai`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ key: "xai-resumekey0003" }),
      });
      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:one]]" }),
      });
      await waitCompletedTurns(ctx.db, ada.bot.id, 1);
      const group = await fetch(`${origin}/v1/threads`, {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "group", title: "Design", botIds: [ada.bot.id, bob.bot.id] }),
      });
      const groupId = ((await group.json()) as { thread: { id: string } }).thread.id;
      await Bun.sleep(150);
      ctx.engine.maintenance();
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBeUndefined();

      const posted = await fetch(`${origin}/v1/threads/${groupId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "@Ada [[echo-switch]] [[echo-prompt]]" }),
      });
      expect(posted.status).toBe(202);
      const { turnIds } = (await posted.json()) as { turnIds: string[] };
      const messages = await waitSendBody(origin, headers, "got-switch");
      expect(messages.some((m) => m.origin === "send_message" && m.body === "got-switch")).toBe(true);
      expect(messages.some((m) => m.origin === "send_message" && m.body === "no-digest")).toBe(true);
      expect(messages.some((m) => m.origin === "send_message" && m.body === "got-digest")).toBe(false);
      const live = (await fetch(`${origin}/v1/turns/${turnIds[0]}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { reason?: string; from?: string; to?: string } }>;
      };
      expect(live.events.some((e) => e.kind === "harness_session_reset" && e.payload?.reason === "resumed")).toBe(
        true,
      );
      expect(live.events.some((e) => e.kind === "harness_session_reset" && e.payload?.reason === "cold_start")).toBe(
        false,
      );
      const sw = live.events.filter((e) => e.kind === "thread_switch");
      expect(sw.length).toBe(1);
      expect(sw[0]?.payload?.from).toBe(ada.threadId);
      expect(sw[0]?.payload?.to).toBe(groupId);
    } finally {
      server.stop(true);
      if (prevIdle === undefined) delete process.env.OPENBOT_ACP_IDLE_MS;
      else process.env.OPENBOT_ACP_IDLE_MS = prevIdle;
      if (prevResume === undefined) delete process.env.OPENBOT_FAKE_RESUME;
      else process.env.OPENBOT_FAKE_RESUME = prevResume;
    }
  });

  test("failed resume on another thread is cold not switch", async () => {
    const prevIdle = process.env.OPENBOT_ACP_IDLE_MS;
    const prevResume = process.env.OPENBOT_FAKE_RESUME;
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    process.env.OPENBOT_ACP_IDLE_MS = "80";
    delete process.env.OPENBOT_FAKE_RESUME;
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    try {
      const { cookie, session } = loginCookie({ ctx }, "alice");
      const headers = { cookie, "content-type": "application/json" };
      const ada = (await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Ada" }),
      }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
      const bob = (await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Bob" }),
      }).then((r) => r.json())) as { bot: { id: string } };
      await fetch(`${origin}/v1/credentials/xai`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ key: "xai-resumekey0004" }),
      });
      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:one]]" }),
      });
      await waitCompletedTurns(ctx.db, ada.bot.id, 1);
      const group = await fetch(`${origin}/v1/threads`, {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "group", title: "Design", botIds: [ada.bot.id, bob.bot.id] }),
      });
      const groupId = ((await group.json()) as { thread: { id: string } }).thread.id;
      await Bun.sleep(150);
      ctx.engine.maintenance();
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBeUndefined();

      const posted = await fetch(`${origin}/v1/threads/${groupId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "@Ada [[echo-switch]] [[echo-prompt]]" }),
      });
      expect(posted.status).toBe(202);
      const { turnIds } = (await posted.json()) as { turnIds: string[] };
      const messages = await waitSendBody(origin, headers, "no-switch");
      expect(messages.some((m) => m.origin === "send_message" && m.body === "got-digest")).toBe(true);
      expect(messages.some((m) => m.origin === "send_message" && m.body === "no-switch")).toBe(true);
      expect(messages.some((m) => m.origin === "send_message" && m.body === "got-switch")).toBe(false);
      const live = (await fetch(`${origin}/v1/turns/${turnIds[0]}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { reason?: string } }>;
      };
      expect(live.events.some((e) => e.kind === "harness_session_reset" && e.payload?.reason === "cold_start")).toBe(
        true,
      );
      expect(live.events.some((e) => e.kind === "thread_switch")).toBe(false);
    } finally {
      server.stop(true);
      if (prevIdle === undefined) delete process.env.OPENBOT_ACP_IDLE_MS;
      else process.env.OPENBOT_ACP_IDLE_MS = prevIdle;
      if (prevResume === undefined) delete process.env.OPENBOT_FAKE_RESUME;
      else process.env.OPENBOT_FAKE_RESUME = prevResume;
    }
  });
});
