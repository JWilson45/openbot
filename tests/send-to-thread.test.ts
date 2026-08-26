import { describe, expect, test } from "bun:test";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

type BotCreated = { bot: { id: string; name: string }; threadId: string };
type ThreadMsg = { origin: string; body: string; from_bot_id?: string | null; role?: string };

async function createBot(origin: string, headers: Record<string, string>, name: string): Promise<BotCreated> {
  const res = await fetch(`${origin}/v1/bots`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as BotCreated;
}

function startWorld() {
  process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
  const { ctx, server, origin } = startTestServer({ home: tempHome() });
  const { cookie } = loginCookie({ ctx }, "alice");
  const headers = { cookie, "content-type": "application/json" };
  return { ctx, server, origin, headers };
}

async function putKey(origin: string, headers: Record<string, string>): Promise<void> {
  await fetch(`${origin}/v1/credentials/xai`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ key: "xai-threadkey0001" }),
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

async function waitGroup(
  origin: string,
  headers: Record<string, string>,
  threadId: string,
  pred: (m: ThreadMsg) => boolean,
): Promise<ThreadMsg[]> {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const t = (await fetch(`${origin}/v1/threads/${threadId}`, { headers }).then((r) => r.json())) as {
      messages: ThreadMsg[];
    };
    if ((t.messages || []).some(pred)) return t.messages;
    await Bun.sleep(80);
  }
  throw new Error("timeout waiting for group message");
}

async function waitDm(
  origin: string,
  headers: Record<string, string>,
  botId: string,
  pred: (m: ThreadMsg) => boolean,
): Promise<ThreadMsg[]> {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const t = (await fetch(`${origin}/v1/threads?botId=${botId}`, { headers }).then((r) => r.json())) as {
      messages: ThreadMsg[];
    };
    if ((t.messages || []).some(pred)) return t.messages;
    await Bun.sleep(80);
  }
  throw new Error("timeout waiting for DM");
}

describe("SendToThread", () => {
  test("Ada [[thread:Design:@Bob please draft]] queues Bob a prompt; group has one thread line", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    await putKey(origin, headers);
    const groupId = await createGroup(origin, headers, "Design", [ada.bot.id, bob.bot.id]);
    const posted = await fetch(`${origin}/v1/threads/${groupId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "@Ada [[thread:Design:@Bob please draft]]" }),
    });
    expect(posted.status).toBe(202);
    const msgs = await waitGroup(origin, headers, groupId, (m) => m.origin === "thread");
    const threadLines = msgs.filter((m) => m.origin === "thread");
    expect(threadLines.length).toBe(1);
    expect(threadLines[0]?.from_bot_id).toBe(ada.bot.id);
    expect(threadLines[0]?.body).toContain("@Bob please draft");
    expect(msgs.some((m) => m.origin === "prompt")).toBe(false);

    const start = Date.now();
    let bobPrompt: { body: string; origin: string } | undefined;
    while (Date.now() - start < 20_000) {
      bobPrompt = ctx.db.get<{ body: string; origin: string }>(
        `SELECT m.body, m.origin FROM messages m
         JOIN turns t ON t.id = m.turn_id
         WHERE m.thread_id = ? AND m.origin = 'prompt' AND t.bot_id = ?`,
        [groupId, bob.bot.id],
      );
      if (bobPrompt && bobPrompt.body.length > 0) break;
      await Bun.sleep(80);
    }
    expect(bobPrompt?.origin).toBe("prompt");
    expect((bobPrompt?.body ?? "").length).toBeGreaterThan(0);
    server.stop(true);
  });

  test("two mentions both prompts non-empty", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const cara = await createBot(origin, headers, "Cara");
    await putKey(origin, headers);
    const groupId = await createGroup(origin, headers, "Design", [ada.bot.id, bob.bot.id, cara.bot.id]);
    // Drive from Ada's DM so the human group parser cannot also @-queue Bob/Cara.
    const posted = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[thread:Design:@Bob @Cara please both]]" }),
    });
    expect(posted.status).toBe(202);
    await waitGroup(origin, headers, groupId, (m) => m.origin === "thread" && m.body.includes("please both"));
    const start = Date.now();
    let prompts: Array<{ bot_id: string; body: string }> = [];
    while (Date.now() - start < 20_000) {
      prompts = ctx.db.all<{ bot_id: string; body: string }>(
        `SELECT t.bot_id, m.body FROM messages m
         JOIN turns t ON t.id = m.turn_id
         WHERE m.thread_id = ? AND m.origin = 'prompt'`,
        [groupId],
      );
      if (prompts.length >= 2 && prompts.every((p) => p.body.length > 0)) break;
      await Bun.sleep(80);
    }
    expect(prompts.length).toBe(2);
    expect(prompts.every((p) => p.body.length > 0)).toBe(true);
    expect(prompts.map((p) => p.bot_id).sort()).toEqual([bob.bot.id, cara.bot.id].sort());
    server.stop(true);
  });

  test("SendMessage still each human DM not the group", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    await putKey(origin, headers);
    const groupId = await createGroup(origin, headers, "Design", [ada.bot.id, bob.bot.id]);
    const posted = await fetch(`${origin}/v1/threads/${groupId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "@Ada @Bob [[send:dm-from-group]]" }),
    });
    expect(posted.status).toBe(202);
    const adaDm = await waitDm(origin, headers, ada.bot.id, (m) => m.origin === "send_message" && m.body === "dm-from-group");
    const bobDm = await waitDm(origin, headers, bob.bot.id, (m) => m.origin === "send_message" && m.body === "dm-from-group");
    expect(adaDm.some((m) => m.origin === "send_message" && m.body === "dm-from-group")).toBe(true);
    expect(bobDm.some((m) => m.origin === "send_message" && m.body === "dm-from-group")).toBe(true);
    const groupSends = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM messages WHERE thread_id = ? AND origin = 'send_message'",
      [groupId],
    );
    expect(groupSends?.n).toBe(0);
    server.stop(true);
  });

  test("omitting threadId uses the running group turn, not the cold-start DM", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    await putKey(origin, headers);
    const groupId = await createGroup(origin, headers, "Design", [ada.bot.id, bob.bot.id]);
    await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[send:warm-dm]]" }),
    });
    await waitDm(origin, headers, ada.bot.id, (m) => m.origin === "send_message" && m.body === "warm-dm");
    const posted = await fetch(`${origin}/v1/threads/${groupId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "@Ada [[thread::spoke in group]]" }),
    });
    expect(posted.status).toBe(202);
    await waitGroup(origin, headers, groupId, (m) => m.origin === "thread" && m.body === "spoke in group");
    const onGroup = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM messages WHERE thread_id = ? AND origin = 'thread' AND body = 'spoke in group'",
      [groupId],
    );
    expect(onGroup?.n).toBe(1);
    const onDm = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM messages WHERE thread_id = ? AND body = 'spoke in group'",
      [ada.threadId],
    );
    expect(onDm?.n).toBe(0);
    server.stop(true);
  });

  test("group runTurn prefix is present on every group turn", async () => {
    const { server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    await putKey(origin, headers);
    const groupId = await createGroup(origin, headers, "Design", [ada.bot.id, bob.bot.id]);
    const posted = await fetch(`${origin}/v1/threads/${groupId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "@Ada [[echo-prefix]]" }),
    });
    expect(posted.status).toBe(202);
    const adaDm = await waitDm(
      origin,
      headers,
      ada.bot.id,
      (m) => m.origin === "send_message" && (m.body === "got-group-prefix" || m.body === "no-group-prefix"),
    );
    expect(adaDm.some((m) => m.body === "got-group-prefix")).toBe(true);
    server.stop(true);
  });
});
