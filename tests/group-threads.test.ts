import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OpenbotDb, deleteBotPermanently, id, now, orderedBotPair } from "@openbot/db";
import { fakeAgentCommand, seedWorld, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

type BotCreated = { bot: { id: string; name: string }; threadId: string };

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
  const { cookie, session } = loginCookie({ ctx }, "alice");
  const headers = { cookie, "content-type": "application/json" };
  return { ctx, server, origin, headers, session };
}

describe("group threads", () => {
  test("create Ada+Bob+caller; GET kind=group lists; human GET stays a DM", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const created = await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "group", title: "standup", botIds: [ada.bot.id, bob.bot.id] }),
    });
    expect([200, 201]).toContain(created.status);
    const body = (await created.json()) as { thread: { id: string; kind: string; bot_id: string } };
    expect(body.thread.kind).toBe("group");
    expect(body.thread.bot_id).toBe(ada.bot.id);

    const groups = (await fetch(`${origin}/v1/threads?kind=group`, { headers }).then((r) => r.json())) as {
      threads: Array<{ id: string }>;
      thread?: unknown;
      messages?: unknown;
    };
    expect(Array.isArray(groups.threads)).toBe(true);
    expect(groups.threads.some((t) => t.id === body.thread.id)).toBe(true);
    expect(groups.thread).toBeUndefined();
    expect(groups.messages).toBeUndefined();

    const human = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      thread: { id: string; kind: string };
      messages: unknown[];
      threads?: unknown;
    };
    expect(human.thread).toBeTruthy();
    expect(human.thread.kind).toBe("human");
    expect(Array.isArray(human.messages)).toBe(true);
    expect(human.threads).toBeUndefined();

    const humanKind = (await fetch(`${origin}/v1/threads?kind=human&botId=${ada.bot.id}`, { headers }).then((r) =>
      r.json(),
    )) as { thread: { id: string; bot_id: string }; messages: unknown[]; threads?: unknown };
    expect(humanKind.thread.bot_id).toBe(ada.bot.id);
    expect(humanKind.thread.id).toBe(ada.threadId);
    expect(humanKind.threads).toBeUndefined();
    expect(ctx.db.all("SELECT id FROM thread_participants WHERE thread_id = ?", [body.thread.id]).length).toBe(3);
    server.stop(true);
  });

  test("me + one bot is too_small", async () => {
    const { server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const res = await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "group", title: "dm", botIds: [ada.bot.id] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("too_small");
    server.stop(true);
  });

  test("bot-only huddle with addCaller false and 2+ bots is ok", async () => {
    const { ctx, server, origin, headers, session } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const res = await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "group",
        title: "bots",
        botIds: [ada.bot.id, bob.bot.id],
        addCaller: false,
      }),
    });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { thread: { id: string } };
    const parts = ctx.db.all<{ kind: string; user_id: string | null; bot_id: string | null }>(
      "SELECT kind, user_id, bot_id FROM thread_participants WHERE thread_id = ?",
      [body.thread.id],
    );
    expect(parts.filter((p) => p.bot_id).length).toBe(2);
    expect(parts.some((p) => p.user_id === session.userId)).toBe(false);
    const got = await fetch(`${origin}/v1/threads/${body.thread.id}`, { headers });
    expect(got.status).toBe(200);
    server.stop(true);
  });

  test("extra userIds require org_members", async () => {
    const { server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const res = await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "group",
        title: "org",
        botIds: [ada.bot.id, bob.bot.id],
        userIds: [id()],
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("org_members_required");
    server.stop(true);
  });

  test("group POST with invalid JSON is 400 bad_request", async () => {
    const { server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const created = (await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "group", title: "chat", botIds: [ada.bot.id, bob.bot.id] }),
    }).then((r) => r.json())) as { thread: { id: string } };
    const posted = await fetch(`${origin}/v1/threads/${created.thread.id}/messages`, {
      method: "POST",
      headers,
      body: "not-json",
    });
    expect(posted.status).toBe(400);
    expect(((await posted.json()) as { error: string }).error).toBe("bad_request");
    server.stop(true);
  });

  test("human POST hello queues nobody", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const created = (await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "group", title: "chat", botIds: [ada.bot.id, bob.bot.id] }),
    }).then((r) => r.json())) as { thread: { id: string } };
    const posted = await fetch(`${origin}/v1/threads/${created.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "hello" }),
    });
    expect(posted.status).toBe(202);
    const json = (await posted.json()) as { turnIds: string[]; userMessageId: string };
    expect(json.turnIds).toEqual([]);
    expect(json.userMessageId).toBeTruthy();
    const msgs = ctx.db.all<{ origin: string }>("SELECT origin FROM messages WHERE thread_id = ?", [
      created.thread.id,
    ]);
    expect(msgs.filter((m) => m.origin === "user").length).toBe(1);
    expect(msgs.filter((m) => m.origin === "prompt").length).toBe(0);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) as n FROM turns WHERE thread_id = ?", [created.thread.id])?.n).toBe(
      0,
    );
    server.stop(true);
  });

  test("@Ada queues Ada only with a prompt row; convening bot is not auto-queued", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const created = (await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "group", title: "chat", botIds: [ada.bot.id, bob.bot.id] }),
    }).then((r) => r.json())) as { thread: { id: string; bot_id: string } };
    expect(created.thread.bot_id).toBe(ada.bot.id);

    const adaHit = await fetch(`${origin}/v1/threads/${created.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "@Ada take a look" }),
    });
    expect(adaHit.status).toBe(202);
    const adaJson = (await adaHit.json()) as { turnIds: string[]; mentioned: string[] };
    expect(adaJson.turnIds.length).toBe(1);
    expect(adaJson.mentioned).toContain("Ada");
    const adaTurn = ctx.db.get<{ id: string; bot_id: string; thread_id: string }>(
      "SELECT id, bot_id, thread_id FROM turns WHERE id = ?",
      [adaJson.turnIds[0]!],
    );
    expect(adaTurn?.bot_id).toBe(ada.bot.id);
    const adaPrompt = ctx.db.get<{ body: string; origin: string }>(
      "SELECT body, origin FROM messages WHERE turn_id = ? AND role = 'user'",
      [adaTurn!.id],
    );
    expect(adaPrompt?.origin).toBe("prompt");
    expect((adaPrompt?.body ?? "").length).toBeGreaterThan(0);
    expect(
      ctx.db.get<{ n: number }>("SELECT COUNT(*) as n FROM turns WHERE thread_id = ? AND bot_id = ?", [
        created.thread.id,
        bob.bot.id,
      ])?.n,
    ).toBe(0);

    const bobHit = await fetch(`${origin}/v1/threads/${created.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "hey @Bob" }),
    });
    const bobJson = (await bobHit.json()) as { turnIds: string[] };
    expect(bobJson.turnIds.length).toBe(1);
    expect(
      ctx.db.get<{ bot_id: string }>("SELECT bot_id FROM turns WHERE id = ?", [bobJson.turnIds[0]!])?.bot_id,
    ).toBe(bob.bot.id);
    expect(
      ctx.db.get<{ n: number }>("SELECT COUNT(*) as n FROM turns WHERE thread_id = ? AND bot_id = ?", [
        created.thread.id,
        ada.bot.id,
      ])?.n,
    ).toBe(1);
    server.stop(true);
  });

  test("@Ada @Bob queues two turns with non-empty prompt rows", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const created = (await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "group", title: "chat", botIds: [ada.bot.id, bob.bot.id] }),
    }).then((r) => r.json())) as { thread: { id: string } };
    const posted = await fetch(`${origin}/v1/threads/${created.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "@Ada @Bob please both draft" }),
    });
    expect(posted.status).toBe(202);
    const json = (await posted.json()) as { turnIds: string[] };
    expect(json.turnIds.length).toBe(2);
    for (const turnId of json.turnIds) {
      const prompt = ctx.db.get<{ body: string; origin: string }>(
        "SELECT body, origin FROM messages WHERE turn_id = ? AND role = 'user'",
        [turnId],
      );
      expect(prompt?.origin).toBe("prompt");
      expect((prompt?.body ?? "").length).toBeGreaterThan(0);
    }
    const bots = ctx.db
      .all<{ bot_id: string }>("SELECT bot_id FROM turns WHERE thread_id = ?", [created.thread.id])
      .map((t) => t.bot_id)
      .sort();
    expect(bots).toEqual([ada.bot.id, bob.bot.id].sort());
    server.stop(true);
  });

  test("four distinct @mentions cap at 3 and set mentionedTruncated", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const cara = await createBot(origin, headers, "Cara");
    const dana = await createBot(origin, headers, "Dana");
    const created = (await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "group",
        title: "all",
        botIds: [ada.bot.id, bob.bot.id, cara.bot.id, dana.bot.id],
      }),
    }).then((r) => r.json())) as { thread: { id: string } };
    const posted = await fetch(`${origin}/v1/threads/${created.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "@Ada @Bob @Cara @Dana go" }),
    });
    expect(posted.status).toBe(202);
    const json = (await posted.json()) as {
      turnIds: string[];
      mentioned: string[];
      mentionedTruncated?: boolean;
    };
    expect(json.turnIds.length).toBe(3);
    expect(json.mentioned).toEqual(["Ada", "Bob", "Cara"]);
    expect(json.mentionedTruncated).toBe(true);
    expect(
      ctx.db.get<{ n: number }>("SELECT COUNT(*) as n FROM turns WHERE thread_id = ? AND bot_id = ?", [
        created.thread.id,
        dana.bot.id,
      ])?.n,
    ).toBe(0);
    server.stop(true);
  });

  test("email addresses are not mentions", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const created = (await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "group", title: "mail", botIds: [ada.bot.id, bob.bot.id] }),
    }).then((r) => r.json())) as { thread: { id: string } };
    const posted = await fetch(`${origin}/v1/threads/${created.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "please email ada@example.com" }),
    });
    expect(posted.status).toBe(202);
    const json = (await posted.json()) as { turnIds: string[]; mentioned: string[] };
    expect(json.turnIds).toEqual([]);
    expect(json.mentioned).toEqual([]);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) as n FROM turns WHERE thread_id = ?", [created.thread.id])?.n).toBe(
      0,
    );
    server.stop(true);
  });

  test("GET thread messages omit origin=prompt", async () => {
    const { server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const created = (await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "group", title: "chat", botIds: [ada.bot.id, bob.bot.id] }),
    }).then((r) => r.json())) as { thread: { id: string } };
    await fetch(`${origin}/v1/threads/${created.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "@Ada hello" }),
    });
    const got = (await fetch(`${origin}/v1/threads/${created.thread.id}`, { headers }).then((r) => r.json())) as {
      messages: Array<{ origin: string; role: string }>;
    };
    expect(got.messages.some((m) => m.origin === "prompt")).toBe(false);
    expect(got.messages.filter((m) => m.origin === "user").length).toBe(1);
    server.stop(true);
  });

  test("A2A POST is still 403 a2a_readonly and GET kind=a2a stays a list", async () => {
    const { ctx, server, origin, headers, session } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const [lo, hi] = orderedBotPair(ada.bot.id, bob.bot.id);
    const a2aId = id();
    ctx.db.run(
      `INSERT INTO threads (id, account_id, bot_id, title, kind, peer_bot_id, created_at)
       VALUES (?, ?, ?, 'a2a', 'a2a', ?, ?)`,
      [a2aId, session.accountId, lo, hi, now()],
    );
    const listed = (await fetch(`${origin}/v1/threads?kind=a2a&botId=${ada.bot.id}`, { headers }).then((r) =>
      r.json(),
    )) as { threads: Array<{ id: string }>; thread?: unknown; messages?: unknown };
    expect(Array.isArray(listed.threads)).toBe(true);
    expect(listed.threads.some((t) => t.id === a2aId)).toBe(true);
    expect(listed.thread).toBeUndefined();
    expect(listed.messages).toBeUndefined();

    const posted = await fetch(`${origin}/v1/threads/${a2aId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "hi" }),
    });
    expect(posted.status).toBe(403);
    expect(((await posted.json()) as { error: string }).error).toBe("a2a_readonly");
    server.stop(true);
  });

  test("human DM POST still returns turnId", async () => {
    const { server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const posted = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "hello dm" }),
    });
    expect(posted.status).toBe(202);
    const json = (await posted.json()) as { turnId?: string; userMessageId?: string; turnIds?: string[] };
    expect(json.turnId).toBeTruthy();
    expect(json.userMessageId).toBeTruthy();
    expect(json.turnIds).toBeUndefined();
    server.stop(true);
  });

  test("deleteBotPermanently does not SQLITE_CONSTRAINT on thread_participants", () => {
    const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
    const w = seedWorld(db);
    const bobId = id();
    db.run(
      `INSERT INTO bots (id, account_id, name, description, status, permission_mode, created_at)
       VALUES (?, ?, 'Bob', 'teammate', 'active', 'auto', ?)`,
      [bobId, w.accountId, now()],
    );
    const groupId = id();
    db.run(
      `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, 'g', 'group', ?)`,
      [groupId, w.accountId, w.botId, now()],
    );
    const t = now();
    db.run(
      `INSERT INTO thread_participants (id, thread_id, kind, user_id, bot_id, created_at) VALUES (?, ?, 'human', ?, NULL, ?)`,
      [id(), groupId, w.userId, t],
    );
    db.run(
      `INSERT INTO thread_participants (id, thread_id, kind, user_id, bot_id, created_at) VALUES (?, ?, 'bot', NULL, ?, ?)`,
      [id(), groupId, w.botId, t],
    );
    db.run(
      `INSERT INTO thread_participants (id, thread_id, kind, user_id, bot_id, created_at) VALUES (?, ?, 'bot', NULL, ?, ?)`,
      [id(), groupId, bobId, t],
    );
    deleteBotPermanently(db, w.botId);
    expect(db.get("SELECT id FROM bots WHERE id = ?", [w.botId])).toBeNull();
    expect(
      db.get("SELECT id FROM thread_participants WHERE thread_id = ? AND bot_id = ?", [groupId, w.botId]),
    ).toBeNull();
    const rehomed = db.get<{ id: string; bot_id: string }>("SELECT id, bot_id FROM threads WHERE id = ?", [groupId]);
    expect(rehomed?.id).toBe(groupId);
    expect(rehomed?.bot_id).toBe(bobId);
    expect(
      db.get("SELECT id FROM thread_participants WHERE thread_id = ? AND bot_id = ?", [groupId, bobId]),
    ).toBeTruthy();
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    deleteBotPermanently(db, bobId);
    expect(db.get("SELECT id FROM bots WHERE id = ?", [bobId])).toBeNull();
    expect(db.get("SELECT id FROM threads WHERE id = ?", [groupId])).toBeNull();
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    db.close();
  });

  test("add and remove participants; extra userId and last-bot remove fail", async () => {
    const { ctx, server, origin, headers } = startWorld();
    const ada = await createBot(origin, headers, "Ada");
    const bob = await createBot(origin, headers, "Bob");
    const cara = await createBot(origin, headers, "Cara");
    const created = (await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "group", title: "p", botIds: [ada.bot.id, bob.bot.id] }),
    }).then((r) => r.json())) as { thread: { id: string } };

    const otherUser = await fetch(`${origin}/v1/threads/${created.thread.id}/participants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: id() }),
    });
    expect(otherUser.status).toBe(400);
    expect(((await otherUser.json()) as { error: string }).error).toBe("org_members_required");

    const added = await fetch(`${origin}/v1/threads/${created.thread.id}/participants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ botId: cara.bot.id }),
    });
    expect(added.status).toBe(200);

    const dropCara = await fetch(
      `${origin}/v1/threads/${created.thread.id}/participants?botId=${cara.bot.id}`,
      { method: "DELETE", headers },
    );
    expect(dropCara.status).toBe(200);

    const dropBob = await fetch(
      `${origin}/v1/threads/${created.thread.id}/participants?botId=${bob.bot.id}`,
      { method: "DELETE", headers },
    );
    expect(dropBob.status).toBe(400);
    expect(((await dropBob.json()) as { error: string }).error).toBe("too_small");
    expect(
      ctx.db.get<{ n: number }>("SELECT COUNT(*) as n FROM thread_participants WHERE thread_id = ? AND bot_id = ?", [
        created.thread.id,
        bob.bot.id,
      ])?.n,
    ).toBe(1);
    server.stop(true);
  });
});
