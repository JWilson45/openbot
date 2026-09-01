import { describe, expect, test } from "bun:test";
import { summarizeLiveEvent } from "@openbot/live-work";
import {
  DEFAULT_ACP_COMPACT_CHARS,
  DEFAULT_ACP_COMPACT_TURNS,
  acpCompactChars,
  acpCompactOnSwitch,
  acpCompactTurns,
} from "@openbot/runner";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

type BotCreated = { bot: { id: string; name: string }; threadId: string };
type ThreadMsg = { origin: string; body: string };

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

async function putKey(origin: string, headers: Record<string, string>, key = "xai-compactkey0001"): Promise<void> {
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

async function postAndWait(
  origin: string,
  headers: Record<string, string>,
  db: { get: (sql: string, params: unknown[]) => { n: number } | null },
  threadId: string,
  botId: string,
  body: string,
  completed: number,
): Promise<{ turnId: string }> {
  const posted = await fetch(`${origin}/v1/threads/${threadId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body }),
  });
  expect(posted.status).toBe(202);
  const json = (await posted.json()) as { turnId?: string; turnIds?: string[] };
  const turnId = json.turnId ?? json.turnIds?.[0] ?? "";
  await waitCompletedTurns(db, botId, completed);
  return { turnId };
}

describe("compact env parser", () => {
  test("defaults 20 / 48000, 0 disables, invalid falls back", () => {
    expect(DEFAULT_ACP_COMPACT_TURNS).toBe(20);
    expect(DEFAULT_ACP_COMPACT_CHARS).toBe(48_000);
    expect(withEnv("OPENBOT_ACP_COMPACT_TURNS", undefined, acpCompactTurns)).toBe(20);
    expect(withEnv("OPENBOT_ACP_COMPACT_TURNS", "", acpCompactTurns)).toBe(20);
    expect(withEnv("OPENBOT_ACP_COMPACT_TURNS", "0", acpCompactTurns)).toBe(0);
    expect(withEnv("OPENBOT_ACP_COMPACT_TURNS", "2", acpCompactTurns)).toBe(2);
    expect(withEnv("OPENBOT_ACP_COMPACT_TURNS", "-1", acpCompactTurns)).toBe(20);
    expect(withEnv("OPENBOT_ACP_COMPACT_TURNS", "nope", acpCompactTurns)).toBe(20);
    expect(withEnv("OPENBOT_ACP_COMPACT_CHARS", undefined, acpCompactChars)).toBe(48_000);
    expect(withEnv("OPENBOT_ACP_COMPACT_CHARS", "0", acpCompactChars)).toBe(0);
    expect(withEnv("OPENBOT_ACP_COMPACT_CHARS", "100", acpCompactChars)).toBe(100);
    expect(withEnv("OPENBOT_ACP_COMPACT_CHARS", "-3", acpCompactChars)).toBe(48_000);
    expect(withEnv("OPENBOT_ACP_COMPACT_ON_SWITCH", undefined, acpCompactOnSwitch)).toBe(false);
    expect(withEnv("OPENBOT_ACP_COMPACT_ON_SWITCH", "0", acpCompactOnSwitch)).toBe(false);
    expect(withEnv("OPENBOT_ACP_COMPACT_ON_SWITCH", "1", acpCompactOnSwitch)).toBe(true);
    expect(withEnv("OPENBOT_ACP_COMPACT_ON_SWITCH", "2", acpCompactOnSwitch)).toBe(false);
  });

  test("summarizeLiveEvent compacted is Context refreshed", () => {
    expect(summarizeLiveEvent("harness_session_reset", { reason: "compacted", trigger: "turns" })).toBe(
      "Context refreshed",
    );
  });
});

describe("warm compact", () => {
  test("COMPACT_TURNS=2 third turn got-digest, same pid, remints MCP", async () => {
    const prevTurns = process.env.OPENBOT_ACP_COMPACT_TURNS;
    const prevChars = process.env.OPENBOT_ACP_COMPACT_CHARS;
    process.env.OPENBOT_ACP_COMPACT_TURNS = "2";
    process.env.OPENBOT_ACP_COMPACT_CHARS = "0";
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      await putKey(origin, headers);
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:one]]", 1);
      const runner = ctx.engine.runnerFor(session.accountId);
      const pid1 = runner.acpPid(ada.bot.id);
      expect(pid1).toBeTruthy();
      const tokensBefore = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM mcp_tokens WHERE bot_id = ?",
        [ada.bot.id],
      )?.n;
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:two]]", 2);
      const third = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[send:compact-ok]] [[echo-prompt]]" }),
      });
      expect(third.status).toBe(202);
      const { turnId } = (await third.json()) as { turnId: string };
      const messages = await waitDm(
        origin,
        headers,
        ada.bot.id,
        (m) => sendBodies(m).includes("got-digest") && sendBodies(m).includes("compact-ok"),
      );
      expect(sendBodies(messages)).toContain("got-digest");
      expect(sendBodies(messages)).toContain("compact-ok");
      expect(runner.acpPid(ada.bot.id)).toBe(pid1);
      const tokensAfter = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM mcp_tokens WHERE bot_id = ?",
        [ada.bot.id],
      )?.n;
      expect(tokensAfter).toBeGreaterThan(tokensBefore ?? 0);
      const live = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { reason?: string; trigger?: string } }>;
      };
      expect(
        live.events.some(
          (e) => e.kind === "harness_session_reset" && e.payload?.reason === "compacted" && e.payload?.trigger === "turns",
        ),
      ).toBe(true);
      expect(messages.some((m) => m.origin === "system" && /compact/i.test(m.body))).toBe(false);
    } finally {
      server.stop(true);
      if (prevTurns === undefined) delete process.env.OPENBOT_ACP_COMPACT_TURNS;
      else process.env.OPENBOT_ACP_COMPACT_TURNS = prevTurns;
      if (prevChars === undefined) delete process.env.OPENBOT_ACP_COMPACT_CHARS;
      else process.env.OPENBOT_ACP_COMPACT_CHARS = prevChars;
    }
  });

  test("below N stays no-digest", async () => {
    const prevTurns = process.env.OPENBOT_ACP_COMPACT_TURNS;
    const prevChars = process.env.OPENBOT_ACP_COMPACT_CHARS;
    process.env.OPENBOT_ACP_COMPACT_TURNS = "5";
    process.env.OPENBOT_ACP_COMPACT_CHARS = "0";
    const { ctx, server, origin, headers } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      await putKey(origin, headers, "xai-compactkey0002");
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:one]]", 1);
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[echo-prompt]]", 2);
      const messages = await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("no-digest"));
      expect(sendBodies(messages)).toContain("no-digest");
      expect(sendBodies(messages)).not.toContain("got-digest");
    } finally {
      server.stop(true);
      if (prevTurns === undefined) delete process.env.OPENBOT_ACP_COMPACT_TURNS;
      else process.env.OPENBOT_ACP_COMPACT_TURNS = prevTurns;
      if (prevChars === undefined) delete process.env.OPENBOT_ACP_COMPACT_CHARS;
      else process.env.OPENBOT_ACP_COMPACT_CHARS = prevChars;
    }
  });

  test("TURNS=0 does not compact on turn count", async () => {
    const prevTurns = process.env.OPENBOT_ACP_COMPACT_TURNS;
    const prevChars = process.env.OPENBOT_ACP_COMPACT_CHARS;
    process.env.OPENBOT_ACP_COMPACT_TURNS = "0";
    process.env.OPENBOT_ACP_COMPACT_CHARS = "0";
    const { ctx, server, origin, headers } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      await putKey(origin, headers, "xai-compactkey0003");
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:one]]", 1);
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:two]]", 2);
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[echo-prompt]]", 3);
      const messages = await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("no-digest"));
      expect(sendBodies(messages)).toContain("no-digest");
      expect(sendBodies(messages)).not.toContain("got-digest");
    } finally {
      server.stop(true);
      if (prevTurns === undefined) delete process.env.OPENBOT_ACP_COMPACT_TURNS;
      else process.env.OPENBOT_ACP_COMPACT_TURNS = prevTurns;
      if (prevChars === undefined) delete process.env.OPENBOT_ACP_COMPACT_CHARS;
      else process.env.OPENBOT_ACP_COMPACT_CHARS = prevChars;
    }
  });

  test("tiny CHARS uses inner body >= threshold", async () => {
    const prevTurns = process.env.OPENBOT_ACP_COMPACT_TURNS;
    const prevChars = process.env.OPENBOT_ACP_COMPACT_CHARS;
    process.env.OPENBOT_ACP_COMPACT_TURNS = "0";
    process.env.OPENBOT_ACP_COMPACT_CHARS = "20";
    const { ctx, server, origin, headers } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      await putKey(origin, headers, "xai-compactkey0004");
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:one]]", 1);
      const posted = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[echo-prompt]]" }),
      });
      const { turnId } = (await posted.json()) as { turnId: string };
      const messages = await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("got-digest"));
      expect(sendBodies(messages)).toContain("got-digest");
      const live = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { reason?: string; trigger?: string } }>;
      };
      expect(
        live.events.some(
          (e) => e.kind === "harness_session_reset" && e.payload?.reason === "compacted" && e.payload?.trigger === "chars",
        ),
      ).toBe(true);
    } finally {
      server.stop(true);
      if (prevTurns === undefined) delete process.env.OPENBOT_ACP_COMPACT_TURNS;
      else process.env.OPENBOT_ACP_COMPACT_TURNS = prevTurns;
      if (prevChars === undefined) delete process.env.OPENBOT_ACP_COMPACT_CHARS;
      else process.env.OPENBOT_ACP_COMPACT_CHARS = prevChars;
    }
  });

  test("wrap-only size does not trigger when inner+accumulated is under threshold", async () => {
    const prevTurns = process.env.OPENBOT_ACP_COMPACT_TURNS;
    const prevChars = process.env.OPENBOT_ACP_COMPACT_CHARS;
    process.env.OPENBOT_ACP_COMPACT_TURNS = "0";
    process.env.OPENBOT_ACP_COMPACT_CHARS = "250";
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      const bob = await createBot(origin, headers, "Bob");
      await putKey(origin, headers, "xai-compactkey0005");
      const groupId = await createGroup(origin, headers, "Design", [ada.bot.id, bob.bot.id]);
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:warm]]", 1);
      const pid1 = ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id);
      await fetch(`${origin}/v1/threads/${groupId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "@Ada [[echo-switch]] [[echo-prompt]]" }),
      });
      const messages = await waitDm(
        origin,
        headers,
        ada.bot.id,
        (m) => sendBodies(m).includes("got-switch") && sendBodies(m).includes("no-digest"),
      );
      expect(sendBodies(messages)).toContain("got-switch");
      expect(sendBodies(messages)).toContain("no-digest");
      expect(sendBodies(messages)).not.toContain("got-digest");
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBe(pid1);
    } finally {
      server.stop(true);
      if (prevTurns === undefined) delete process.env.OPENBOT_ACP_COMPACT_TURNS;
      else process.env.OPENBOT_ACP_COMPACT_TURNS = prevTurns;
      if (prevChars === undefined) delete process.env.OPENBOT_ACP_COMPACT_CHARS;
      else process.env.OPENBOT_ACP_COMPACT_CHARS = prevChars;
    }
  });

  test("default switch is still got-switch no-digest same pid", async () => {
    const prevOn = process.env.OPENBOT_ACP_COMPACT_ON_SWITCH;
    process.env.OPENBOT_ACP_COMPACT_ON_SWITCH = "0";
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      const bob = await createBot(origin, headers, "Bob");
      await putKey(origin, headers, "xai-compactkey0006");
      const groupId = await createGroup(origin, headers, "Design", [ada.bot.id, bob.bot.id]);
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:warm-dm]]", 1);
      const pid1 = ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id);
      await fetch(`${origin}/v1/threads/${groupId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "@Ada [[echo-switch]] [[echo-prompt]]" }),
      });
      const messages = await waitDm(
        origin,
        headers,
        ada.bot.id,
        (m) => sendBodies(m).includes("got-switch") && sendBodies(m).includes("no-digest"),
      );
      expect(sendBodies(messages)).toContain("got-switch");
      expect(sendBodies(messages)).not.toContain("got-digest");
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBe(pid1);
    } finally {
      server.stop(true);
      if (prevOn === undefined) delete process.env.OPENBOT_ACP_COMPACT_ON_SWITCH;
      else process.env.OPENBOT_ACP_COMPACT_ON_SWITCH = prevOn;
    }
  });

  test("COMPACT_ON_SWITCH=1 is got-digest no-switch same pid", async () => {
    const prevOn = process.env.OPENBOT_ACP_COMPACT_ON_SWITCH;
    const prevTurns = process.env.OPENBOT_ACP_COMPACT_TURNS;
    const prevChars = process.env.OPENBOT_ACP_COMPACT_CHARS;
    process.env.OPENBOT_ACP_COMPACT_ON_SWITCH = "1";
    process.env.OPENBOT_ACP_COMPACT_TURNS = "0";
    process.env.OPENBOT_ACP_COMPACT_CHARS = "0";
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      const bob = await createBot(origin, headers, "Bob");
      await putKey(origin, headers, "xai-compactkey0007");
      const groupId = await createGroup(origin, headers, "Design", [ada.bot.id, bob.bot.id]);
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:warm-dm]]", 1);
      const pid1 = ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id);
      const posted = await fetch(`${origin}/v1/threads/${groupId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "@Ada [[echo-switch]] [[echo-prompt]]" }),
      });
      const { turnIds } = (await posted.json()) as { turnIds: string[] };
      const messages = await waitDm(
        origin,
        headers,
        ada.bot.id,
        (m) => sendBodies(m).includes("got-digest") && sendBodies(m).includes("no-switch"),
      );
      expect(sendBodies(messages)).toContain("got-digest");
      expect(sendBodies(messages)).toContain("no-switch");
      expect(sendBodies(messages)).not.toContain("got-switch");
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBe(pid1);
      const live = (await fetch(`${origin}/v1/turns/${turnIds[0]}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { reason?: string; trigger?: string } }>;
      };
      expect(
        live.events.some(
          (e) =>
            e.kind === "harness_session_reset" && e.payload?.reason === "compacted" && e.payload?.trigger === "thread",
        ),
      ).toBe(true);
      expect(live.events.some((e) => e.kind === "thread_switch")).toBe(false);
    } finally {
      server.stop(true);
      if (prevOn === undefined) delete process.env.OPENBOT_ACP_COMPACT_ON_SWITCH;
      else process.env.OPENBOT_ACP_COMPACT_ON_SWITCH = prevOn;
      if (prevTurns === undefined) delete process.env.OPENBOT_ACP_COMPACT_TURNS;
      else process.env.OPENBOT_ACP_COMPACT_TURNS = prevTurns;
      if (prevChars === undefined) delete process.env.OPENBOT_ACP_COMPACT_CHARS;
      else process.env.OPENBOT_ACP_COMPACT_CHARS = prevChars;
    }
  });

  test("[[overflow]] then next echo compact same pid", async () => {
    const prevTurns = process.env.OPENBOT_ACP_COMPACT_TURNS;
    const prevChars = process.env.OPENBOT_ACP_COMPACT_CHARS;
    process.env.OPENBOT_ACP_COMPACT_TURNS = "0";
    process.env.OPENBOT_ACP_COMPACT_CHARS = "0";
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      await putKey(origin, headers, "xai-compactkey0008");
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:one]]", 1);
      const pid1 = ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id);
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[overflow]]", 2);
      const nulled = ctx.db.get<{ acp_session_id: string | null }>(
        "SELECT acp_session_id FROM harness_sessions WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
        [ada.bot.id],
      );
      expect(nulled?.acp_session_id).toBeNull();
      const posted = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[echo-prompt]]" }),
      });
      const { turnId } = (await posted.json()) as { turnId: string };
      const messages = await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("got-digest"));
      expect(sendBodies(messages)).toContain("got-digest");
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBe(pid1);
      const live = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { reason?: string; trigger?: string } }>;
      };
      expect(
        live.events.some(
          (e) =>
            e.kind === "harness_session_reset" && e.payload?.reason === "compacted" && e.payload?.trigger === "overflow",
        ),
      ).toBe(true);
    } finally {
      server.stop(true);
      if (prevTurns === undefined) delete process.env.OPENBOT_ACP_COMPACT_TURNS;
      else process.env.OPENBOT_ACP_COMPACT_TURNS = prevTurns;
      if (prevChars === undefined) delete process.env.OPENBOT_ACP_COMPACT_CHARS;
      else process.env.OPENBOT_ACP_COMPACT_CHARS = prevChars;
    }
  });

  test("overflowed id is not resumed (latest row NULL, no history walk)", async () => {
    const prevIdle = process.env.OPENBOT_ACP_IDLE_MS;
    const prevResume = process.env.OPENBOT_FAKE_RESUME;
    const prevTurns = process.env.OPENBOT_ACP_COMPACT_TURNS;
    const prevChars = process.env.OPENBOT_ACP_COMPACT_CHARS;
    process.env.OPENBOT_ACP_IDLE_MS = "80";
    process.env.OPENBOT_FAKE_RESUME = "1";
    process.env.OPENBOT_ACP_COMPACT_TURNS = "0";
    process.env.OPENBOT_ACP_COMPACT_CHARS = "0";
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      await putKey(origin, headers, "xai-compactkey0009");
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:one]]", 1);
      const overflowedId = ctx.db.get<{ acp_session_id: string | null }>(
        "SELECT acp_session_id FROM harness_sessions WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
        [ada.bot.id],
      )?.acp_session_id;
      expect(overflowedId).toBeTruthy();
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[overflow]]", 2);
      const afterOverflow = ctx.db.get<{ acp_session_id: string | null }>(
        "SELECT acp_session_id FROM harness_sessions WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
        [ada.bot.id],
      );
      expect(afterOverflow?.acp_session_id).toBeNull();
      await Bun.sleep(150);
      ctx.engine.maintenance();
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBeUndefined();
      const posted = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[echo-prompt]]" }),
      });
      const { turnId } = (await posted.json()) as { turnId: string };
      const messages = await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("got-digest"));
      expect(sendBodies(messages)).toContain("got-digest");
      const live = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { reason?: string } }>;
      };
      expect(live.events.some((e) => e.kind === "harness_session_reset" && e.payload?.reason === "cold_start")).toBe(
        true,
      );
      expect(live.events.some((e) => e.kind === "harness_session_reset" && e.payload?.reason === "resumed")).toBe(
        false,
      );
      expect(overflowedId).toBeTruthy();
    } finally {
      server.stop(true);
      if (prevIdle === undefined) delete process.env.OPENBOT_ACP_IDLE_MS;
      else process.env.OPENBOT_ACP_IDLE_MS = prevIdle;
      if (prevResume === undefined) delete process.env.OPENBOT_FAKE_RESUME;
      else process.env.OPENBOT_FAKE_RESUME = prevResume;
      if (prevTurns === undefined) delete process.env.OPENBOT_ACP_COMPACT_TURNS;
      else process.env.OPENBOT_ACP_COMPACT_TURNS = prevTurns;
      if (prevChars === undefined) delete process.env.OPENBOT_ACP_COMPACT_CHARS;
      else process.env.OPENBOT_ACP_COMPACT_CHARS = prevChars;
    }
  });

  test("explicit compactSession between turns restamps overlay, same pid", async () => {
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      await putKey(origin, headers, "xai-compactkey0010");
      await postAndWait(
        origin,
        headers,
        ctx.db,
        ada.threadId,
        ada.bot.id,
        "[[memory:add:self:compact-note]]",
        1,
      );
      const runner = ctx.engine.runnerFor(session.accountId);
      const pid1 = runner.acpPid(ada.bot.id);
      const sess1 = runner.acpFor(ada.bot.id)?.sessionId;
      const result = await ctx.engine.compactSession(ada.bot.id);
      expect(result.compacted).toBe(true);
      expect(runner.acpPid(ada.bot.id)).toBe(pid1);
      expect(runner.acpFor(ada.bot.id)?.sessionId).toBeTruthy();
      expect(runner.acpFor(ada.bot.id)?.sessionId).not.toBe(sess1);
      await postAndWait(
        origin,
        headers,
        ctx.db,
        ada.threadId,
        ada.bot.id,
        "[[echo-standing:compact-note]] [[echo-rules]]",
        2,
      );
      const messages = await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("got-standing"));
      expect(sendBodies(messages)).toContain("got-standing");
      expect(sendBodies(messages).some((b) => b.includes("You are Ada"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("refuse in_turn returns compacted:false and does not session/new", async () => {
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      await putKey(origin, headers, "xai-compactkey0011");
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:one]]", 1);
      const runner = ctx.engine.runnerFor(session.accountId);
      const sess1 = runner.acpFor(ada.bot.id)?.sessionId;
      await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[sleep:4000]] [[send:woke]]" }),
      });
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const t = ctx.db.get<{ status: string }>(
          "SELECT status FROM turns WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
          [ada.bot.id],
        );
        if (t?.status === "running") break;
        await Bun.sleep(40);
      }
      await Bun.sleep(80);
      const result = await ctx.engine.compactSession(ada.bot.id);
      expect(result.compacted).toBe(false);
      expect(runner.acpFor(ada.bot.id)?.sessionId).toBe(sess1);
    } finally {
      server.stop(true);
    }
  });

  test("Ada compact while Bob is in_turn", async () => {
    const prevTurns = process.env.OPENBOT_ACP_COMPACT_TURNS;
    const prevChars = process.env.OPENBOT_ACP_COMPACT_CHARS;
    process.env.OPENBOT_ACP_COMPACT_TURNS = "2";
    process.env.OPENBOT_ACP_COMPACT_CHARS = "0";
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      const bob = await createBot(origin, headers, "Bob");
      await putKey(origin, headers, "xai-compactkey0012");
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:ada-one]]", 1);
      await postAndWait(origin, headers, ctx.db, bob.threadId, bob.bot.id, "[[send:bob-one]]", 1);
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:ada-two]]", 2);
      const runner = ctx.engine.runnerFor(session.accountId);
      const adaPid = runner.acpPid(ada.bot.id);
      const bobPid = runner.acpPid(bob.bot.id);
      await fetch(`${origin}/v1/threads/${bob.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[sleep:4000]] [[send:bob-woke]]" }),
      });
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const t = ctx.db.get<{ status: string }>(
          "SELECT status FROM turns WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
          [bob.bot.id],
        );
        if (t?.status === "running") break;
        await Bun.sleep(40);
      }
      await Bun.sleep(80);
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[echo-prompt]]", 3);
      const messages = await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("got-digest"));
      expect(sendBodies(messages)).toContain("got-digest");
      expect(runner.acpPid(ada.bot.id)).toBe(adaPid);
      expect(runner.acpPid(bob.bot.id)).toBe(bobPid);
    } finally {
      server.stop(true);
      if (prevTurns === undefined) delete process.env.OPENBOT_ACP_COMPACT_TURNS;
      else process.env.OPENBOT_ACP_COMPACT_TURNS = prevTurns;
      if (prevChars === undefined) delete process.env.OPENBOT_ACP_COMPACT_CHARS;
      else process.env.OPENBOT_ACP_COMPACT_CHARS = prevChars;
    }
  });

  test("Bob overflow must not empty-token Ada", async () => {
    const prevTurns = process.env.OPENBOT_ACP_COMPACT_TURNS;
    const prevChars = process.env.OPENBOT_ACP_COMPACT_CHARS;
    process.env.OPENBOT_ACP_COMPACT_TURNS = "0";
    process.env.OPENBOT_ACP_COMPACT_CHARS = "0";
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      const bob = await createBot(origin, headers, "Bob");
      await putKey(origin, headers, "xai-compactkey0013");
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:ada-one]]", 1);
      await postAndWait(origin, headers, ctx.db, bob.threadId, bob.bot.id, "[[send:bob-one]]", 1);
      const runner = ctx.engine.runnerFor(session.accountId);
      const adaPid = runner.acpPid(ada.bot.id);
      await postAndWait(origin, headers, ctx.db, bob.threadId, bob.bot.id, "[[overflow]]", 2);
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:still-ada]]", 2);
      const messages = await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("still-ada"));
      expect(sendBodies(messages)).toContain("still-ada");
      expect(runner.acpPid(ada.bot.id)).toBe(adaPid);
    } finally {
      server.stop(true);
      if (prevTurns === undefined) delete process.env.OPENBOT_ACP_COMPACT_TURNS;
      else process.env.OPENBOT_ACP_COMPACT_TURNS = prevTurns;
      if (prevChars === undefined) delete process.env.OPENBOT_ACP_COMPACT_CHARS;
      else process.env.OPENBOT_ACP_COMPACT_CHARS = prevChars;
    }
  });

  test("idle still kills after compact; fake resume of post-compact id is no-digest", async () => {
    const prevIdle = process.env.OPENBOT_ACP_IDLE_MS;
    const prevResume = process.env.OPENBOT_FAKE_RESUME;
    const prevTurns = process.env.OPENBOT_ACP_COMPACT_TURNS;
    const prevChars = process.env.OPENBOT_ACP_COMPACT_CHARS;
    process.env.OPENBOT_ACP_IDLE_MS = "80";
    process.env.OPENBOT_ACP_COMPACT_TURNS = "2";
    process.env.OPENBOT_ACP_COMPACT_CHARS = "0";
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      await putKey(origin, headers, "xai-compactkey0014");
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:one]]", 1);
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:two]]", 2);
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[echo-prompt]]", 3);
      await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("got-digest"));
      const postCompactId = ctx.db.get<{ acp_session_id: string | null }>(
        "SELECT acp_session_id FROM harness_sessions WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
        [ada.bot.id],
      )?.acp_session_id;
      expect(postCompactId).toBeTruthy();
      const counters = ctx.db.get<{ compact_turns: number }>(
        "SELECT compact_turns FROM harness_sessions WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
        [ada.bot.id],
      );
      expect(counters?.compact_turns).toBe(1);
      await Bun.sleep(150);
      ctx.engine.maintenance();
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBeUndefined();
      process.env.OPENBOT_FAKE_RESUME = "1";
      const posted = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[echo-prompt]]" }),
      });
      const { turnId } = (await posted.json()) as { turnId: string };
      const messages = await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("no-digest"));
      expect(sendBodies(messages)).toContain("no-digest");
      const live = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { reason?: string } }>;
      };
      expect(live.events.some((e) => e.kind === "harness_session_reset" && e.payload?.reason === "resumed")).toBe(
        true,
      );
      const resumedId = ctx.db.get<{ acp_session_id: string | null }>(
        "SELECT acp_session_id FROM harness_sessions WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
        [ada.bot.id],
      )?.acp_session_id;
      expect(resumedId).toBe(postCompactId);
    } finally {
      server.stop(true);
      if (prevIdle === undefined) delete process.env.OPENBOT_ACP_IDLE_MS;
      else process.env.OPENBOT_ACP_IDLE_MS = prevIdle;
      if (prevResume === undefined) delete process.env.OPENBOT_FAKE_RESUME;
      else process.env.OPENBOT_FAKE_RESUME = prevResume;
      if (prevTurns === undefined) delete process.env.OPENBOT_ACP_COMPACT_TURNS;
      else process.env.OPENBOT_ACP_COMPACT_TURNS = prevTurns;
      if (prevChars === undefined) delete process.env.OPENBOT_ACP_COMPACT_CHARS;
      else process.env.OPENBOT_ACP_COMPACT_CHARS = prevChars;
    }
  });

  test("19-turn counters restore across idle+resume so the next turn can compact", async () => {
    const prevIdle = process.env.OPENBOT_ACP_IDLE_MS;
    const prevResume = process.env.OPENBOT_FAKE_RESUME;
    const prevTurns = process.env.OPENBOT_ACP_COMPACT_TURNS;
    const prevChars = process.env.OPENBOT_ACP_COMPACT_CHARS;
    process.env.OPENBOT_ACP_IDLE_MS = "80";
    process.env.OPENBOT_FAKE_RESUME = "1";
    process.env.OPENBOT_ACP_COMPACT_TURNS = "20";
    process.env.OPENBOT_ACP_COMPACT_CHARS = "0";
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      await putKey(origin, headers, "xai-compactkey0015");
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:one]]", 1);
      ctx.db.run("UPDATE harness_sessions SET compact_turns = 19, compact_chars = 100 WHERE bot_id = ?", [
        ada.bot.id,
      ]);
      await Bun.sleep(150);
      ctx.engine.maintenance();
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBeUndefined();
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[echo-prompt]]", 2);
      const afterResume = await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("no-digest"));
      expect(sendBodies(afterResume)).toContain("no-digest");
      const copied = ctx.db.get<{ compact_turns: number }>(
        "SELECT compact_turns FROM harness_sessions WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
        [ada.bot.id],
      );
      expect(copied?.compact_turns).toBe(20);
      const posted = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[echo-prompt]]" }),
      });
      const { turnId } = (await posted.json()) as { turnId: string };
      const compacted = await waitDm(
        origin,
        headers,
        ada.bot.id,
        (m) => sendBodies(m).filter((b) => b === "got-digest").length >= 1,
      );
      expect(sendBodies(compacted)).toContain("got-digest");
      const live = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { reason?: string; trigger?: string } }>;
      };
      expect(
        live.events.some(
          (e) => e.kind === "harness_session_reset" && e.payload?.reason === "compacted" && e.payload?.trigger === "turns",
        ),
      ).toBe(true);
    } finally {
      server.stop(true);
      if (prevIdle === undefined) delete process.env.OPENBOT_ACP_IDLE_MS;
      else process.env.OPENBOT_ACP_IDLE_MS = prevIdle;
      if (prevResume === undefined) delete process.env.OPENBOT_FAKE_RESUME;
      else process.env.OPENBOT_FAKE_RESUME = prevResume;
      if (prevTurns === undefined) delete process.env.OPENBOT_ACP_COMPACT_TURNS;
      else process.env.OPENBOT_ACP_COMPACT_TURNS = prevTurns;
      if (prevChars === undefined) delete process.env.OPENBOT_ACP_COMPACT_CHARS;
      else process.env.OPENBOT_ACP_COMPACT_CHARS = prevChars;
    }
  });

  test("19-turn counters survive two idle+resume copies (not reset to 0)", async () => {
    const prevIdle = process.env.OPENBOT_ACP_IDLE_MS;
    const prevResume = process.env.OPENBOT_FAKE_RESUME;
    const prevTurns = process.env.OPENBOT_ACP_COMPACT_TURNS;
    const prevChars = process.env.OPENBOT_ACP_COMPACT_CHARS;
    process.env.OPENBOT_ACP_IDLE_MS = "80";
    process.env.OPENBOT_FAKE_RESUME = "1";
    process.env.OPENBOT_ACP_COMPACT_TURNS = "0";
    process.env.OPENBOT_ACP_COMPACT_CHARS = "0";
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const ada = await createBot(origin, headers, "Ada");
      await putKey(origin, headers, "xai-compactkey0016");
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[send:one]]", 1);
      ctx.db.run("UPDATE harness_sessions SET compact_turns = 19, compact_chars = 100 WHERE bot_id = ?", [
        ada.bot.id,
      ]);
      await Bun.sleep(150);
      ctx.engine.maintenance();
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBeUndefined();
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[echo-prompt]]", 2);
      await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).includes("no-digest"));
      const afterFirst = ctx.db.get<{ compact_turns: number }>(
        "SELECT compact_turns FROM harness_sessions WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
        [ada.bot.id],
      );
      expect(afterFirst?.compact_turns).toBeGreaterThanOrEqual(19);
      await Bun.sleep(150);
      ctx.engine.maintenance();
      expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBeUndefined();
      await postAndWait(origin, headers, ctx.db, ada.threadId, ada.bot.id, "[[echo-prompt]]", 3);
      await waitDm(origin, headers, ada.bot.id, (m) => sendBodies(m).filter((b) => b === "no-digest").length >= 2);
      const afterSecond = ctx.db.get<{ compact_turns: number }>(
        "SELECT compact_turns FROM harness_sessions WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
        [ada.bot.id],
      );
      expect(afterSecond?.compact_turns).toBeGreaterThanOrEqual(19);
      expect(afterSecond?.compact_turns).not.toBe(0);
    } finally {
      server.stop(true);
      if (prevIdle === undefined) delete process.env.OPENBOT_ACP_IDLE_MS;
      else process.env.OPENBOT_ACP_IDLE_MS = prevIdle;
      if (prevResume === undefined) delete process.env.OPENBOT_FAKE_RESUME;
      else process.env.OPENBOT_FAKE_RESUME = prevResume;
      if (prevTurns === undefined) delete process.env.OPENBOT_ACP_COMPACT_TURNS;
      else process.env.OPENBOT_ACP_COMPACT_TURNS = prevTurns;
      if (prevChars === undefined) delete process.env.OPENBOT_ACP_COMPACT_CHARS;
      else process.env.OPENBOT_ACP_COMPACT_CHARS = prevChars;
    }
  });

  test("Gateway turn-count compact", async () => {
    const prevTurns = process.env.OPENBOT_ACP_COMPACT_TURNS;
    const prevChars = process.env.OPENBOT_ACP_COMPACT_CHARS;
    process.env.OPENBOT_ACP_COMPACT_TURNS = "2";
    process.env.OPENBOT_ACP_COMPACT_CHARS = "0";
    process.env.OPENBOT_FED_ALLOW_HTTP = "1";
    const { ctx, server, origin, headers, session } = startWorld();
    try {
      const on = await fetch(`${origin}/v1/org`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ federationEnabled: true }),
      });
      expect(on.status).toBe(200);
      const listed = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
        gateway: { id: string } | null;
      };
      expect(listed.gateway?.id).toBeTruthy();
      const gwId = listed.gateway!.id;
      const thread = (await fetch(`${origin}/v1/threads?botId=${gwId}`, { headers }).then((r) => r.json())) as {
        thread: { id: string };
      };
      await putKey(origin, headers, "xai-compactkey0017");
      await postAndWait(origin, headers, ctx.db, thread.thread.id, gwId, "[[send:gw-one]]", 1);
      const pid1 = ctx.engine.runnerFor(session.accountId).acpPid(gwId);
      await postAndWait(origin, headers, ctx.db, thread.thread.id, gwId, "[[send:gw-two]]", 2);
      const posted = await fetch(`${origin}/v1/threads/${thread.thread.id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[echo-prompt]]" }),
      });
      const { turnId } = (await posted.json()) as { turnId: string };
      const messages = await waitDm(origin, headers, gwId, (m) => sendBodies(m).includes("got-digest"));
      expect(sendBodies(messages)).toContain("got-digest");
      expect(ctx.engine.runnerFor(session.accountId).acpPid(gwId)).toBe(pid1);
      const live = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) => r.json())) as {
        events: Array<{ kind: string; payload: { reason?: string; trigger?: string } }>;
      };
      expect(
        live.events.some(
          (e) => e.kind === "harness_session_reset" && e.payload?.reason === "compacted" && e.payload?.trigger === "turns",
        ),
      ).toBe(true);
    } finally {
      server.stop(true);
      if (prevTurns === undefined) delete process.env.OPENBOT_ACP_COMPACT_TURNS;
      else process.env.OPENBOT_ACP_COMPACT_TURNS = prevTurns;
      if (prevChars === undefined) delete process.env.OPENBOT_ACP_COMPACT_CHARS;
      else process.env.OPENBOT_ACP_COMPACT_CHARS = prevChars;
    }
  });
});
