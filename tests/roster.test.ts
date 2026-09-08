import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHIVE_TTL_MS, id, now } from "@openbot/db";
import { insertMessage } from "@openbot/live-work";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

describe("roster", () => {
  test("up to 6 active bots, unique names, archive frees a slot", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const created: string[] = [];
    for (const name of ["Ada", "Bob", "Cara", "Dan", "Eve", "Fay"]) {
      const res = await fetch(`${origin}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, description: name }),
      });
      expect(res.status).toBe(200);
      created.push(((await res.json()) as { bot: { id: string } }).bot.id);
    }
    const seventh = await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Gus" }),
    });
    expect(seventh.status).toBe(409);
    expect(((await seventh.json()) as { error: string }).error).toBe("cap");
    const dup = await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    });
    expect(dup.status).toBe(409);
    const list = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
      bots: Array<{ name: string }>;
      a2aGateway: { available: boolean; endpoint: string; agentCard: string } | null;
      gateway?: unknown;
    };
    expect(list.bots.length).toBe(6);
    expect(list).not.toHaveProperty("gateway");
    expect(list.a2aGateway).toEqual({
      available: true,
      endpoint: "/a2a/v1",
      agentCard: "/.well-known/agent-card.json",
    });
    expect(list.a2aGateway).not.toHaveProperty("id");
    expect(list.a2aGateway).not.toHaveProperty("name");
    const arch = await fetch(`${origin}/v1/bots/${created[0]}/archive`, { method: "POST", headers });
    expect(arch.status).toBe(200);
    const again = await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Gus" }),
    });
    expect(again.status).toBe(200);
    const adaThread = await fetch(`${origin}/v1/threads?botId=${created[1]}`, { headers });
    expect(adaThread.status).toBe(200);
    const t = (await adaThread.json()) as { thread: { bot_id: string } };
    expect(t.thread.bot_id).toBe(created[1]);
    const wipeBad = await fetch(`${origin}/v1/compute`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ confirm: "nope" }),
    });
    expect(wipeBad.status).toBe(400);
    const wipe = await fetch(`${origin}/v1/compute/wipe`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: "delete" }),
    });
    expect(wipe.status).toBe(200);
    server.stop(true);
  });

  test("archive is reversible; permanent delete is archived-only; expired archives purge", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const created = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    }).then((r) => r.json())) as { bot: { id: string } };
    const id = created.bot.id;

    const delActive = await fetch(`${origin}/v1/bots/${id}/purge`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(delActive.status).toBe(409);

    const arch = await fetch(`${origin}/v1/bots/${id}/archive`, { method: "POST", headers });
    expect(arch.status).toBe(200);
    const listed = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
      bots: unknown[];
      archived: Array<{ id: string; name: string }>;
    };
    expect(listed.bots.length).toBe(0);
    expect(listed.archived.some((b) => b.id === id)).toBe(true);

    const restored = await fetch(`${origin}/v1/bots/${id}/restore`, { method: "POST", headers });
    expect(restored.status).toBe(200);
    expect(
      ((await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as { bots: unknown[] }).bots.length,
    ).toBe(1);

    await fetch(`${origin}/v1/bots/${id}/archive`, { method: "POST", headers });
    const gone = await fetch(`${origin}/v1/bots/${id}/purge`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(gone.status).toBe(200);
    expect(
      ((await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as { archived: unknown[] }).archived
        .length,
    ).toBe(0);

    const bob = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Bob" }),
    }).then((r) => r.json())) as { bot: { id: string } };
    await fetch(`${origin}/v1/bots/${bob.bot.id}/archive`, { method: "POST", headers });
    ctx.db.run("UPDATE bots SET archived_at = ? WHERE id = ?", [now() - ARCHIVE_TTL_MS - 1000, bob.bot.id]);
    const afterTtl = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
      archived: unknown[];
    };
    expect(afterTtl.archived.length).toBe(0);
    server.stop(true);
  });

  test("archive pauses assignee calendar series; restore does not unpause", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const created = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    }).then((r) => r.json())) as { bot: { id: string } };
    const seriesId = (await fetch(`${origin}/v1/calendar/series`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "mail",
        prompt: "summarize",
        botId: created.bot.id,
        dtstart: Date.now() + 86_400_000,
      }),
    }).then((r) => r.json())) as { series: { id: string; status: string } };
    expect(seriesId.series.status).toBe("active");

    const arch = await fetch(`${origin}/v1/bots/${created.bot.id}/archive`, { method: "POST", headers });
    expect(arch.status).toBe(200);
    expect(
      ctx.db.get<{ status: string }>("SELECT status FROM calendar_series WHERE id = ?", [seriesId.series.id])?.status,
    ).toBe("paused");

    const restored = await fetch(`${origin}/v1/bots/${created.bot.id}/restore`, { method: "POST", headers });
    expect(restored.status).toBe(200);
    expect(
      ctx.db.get<{ status: string }>("SELECT status FROM calendar_series WHERE id = ?", [seriesId.series.id])?.status,
    ).toBe("paused");
    server.stop(true);
  });

  test("A2A status is ID-free and Gateway has no human bot surface", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie, session } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const listed = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
      bots: Array<{ name: string }>;
      a2aGateway: { available: boolean; endpoint: string; agentCard: string } | null;
      gateway?: unknown;
      bot: { id: string } | null;
    };
    expect(listed.bots.length).toBe(0);
    expect(listed.bot).toBeNull();
    expect(listed).not.toHaveProperty("gateway");
    expect(listed.a2aGateway).toEqual({
      available: true,
      endpoint: "/a2a/v1",
      agentCard: "/.well-known/agent-card.json",
    });
    expect(listed.a2aGateway).not.toHaveProperty("id");
    expect(listed.a2aGateway).not.toHaveProperty("name");
    const gateway = ctx.db.get<{ id: string }>(
      "SELECT id FROM bots WHERE account_id = ? AND status = 'active' AND IFNULL(role, 'desk') = 'gateway'",
      [session.accountId],
    );
    expect(gateway).toBeTruthy();
    const gwId = gateway!.id;
    const activity = (await fetch(`${origin}/v1/activity`, { headers }).then((r) => r.json())) as {
      bots: Array<{ id: string }>;
    };
    expect(activity.bots.some((b) => b.id === gwId)).toBe(false);
    const row = ctx.db.get<{ role: string; permission_mode: string }>("SELECT role, permission_mode FROM bots WHERE id = ?", [
      gwId,
    ]);
    expect(row?.role).toBe("gateway");
    expect(row?.permission_mode).toBe("ask");

    const asRole = await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Spy", role: "gateway" }),
    });
    expect(asRole.status).toBe(400);
    expect(((await asRole.json()) as { error: string }).error).toBe("invalid_role");

    const getBot = await fetch(`${origin}/v1/bots/${gwId}`, { headers });
    expect(getBot.status).toBe(404);
    expect(((await getBot.json()) as { error: string }).error).toBe("not_found");
    const arch = await fetch(`${origin}/v1/bots/${gwId}/archive`, { method: "POST", headers });
    expect(arch.status).toBe(404);
    expect(((await arch.json()) as { error: string }).error).toBe("not_found");
    const purge = await fetch(`${origin}/v1/bots/${gwId}/purge`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(purge.status).toBe(404);
    expect(((await purge.json()) as { error: string }).error).toBe("not_found");
    const rename = await fetch(`${origin}/v1/bots/${gwId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "NotGateway" }),
    });
    expect(rename.status).toBe(404);
    expect(((await rename.json()) as { error: string }).error).toBe("not_found");
    const perm = await fetch(`${origin}/v1/bots/${gwId}/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ permissionMode: "auto" }),
    });
    expect(perm.status).toBe(404);
    expect(((await perm.json()) as { error: string }).error).toBe("not_found");
    const harness = await fetch(`${origin}/v1/bots/${gwId}/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ harness: "codex" }),
    });
    expect(harness.status).toBe(404);
    expect(((await harness.json()) as { error: string }).error).toBe("not_found");
    const effort = await fetch(`${origin}/v1/bots/${gwId}/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ reasoningEffort: "medium" }),
    });
    expect(effort.status).toBe(404);
    expect(((await effort.json()) as { error: string }).error).toBe("not_found");

    const conversation = await fetch(`${origin}/v1/agents/${gwId}/conversation`, { headers });
    expect(conversation.status).toBe(404);
    const internalThread = ctx.db.get<{ id: string }>(
      "SELECT id FROM threads WHERE account_id = ? AND bot_id = ? AND IFNULL(kind, 'human') = 'human'",
      [session.accountId, gwId],
    );
    expect(internalThread).toBeTruthy();
    const threadRead = await fetch(`${origin}/v1/threads/${internalThread!.id}`, { headers });
    expect(threadRead.status).toBe(404);
    const threadPost = await fetch(`${origin}/v1/threads/${internalThread!.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "not a human DM" }),
    });
    expect(threadPost.status).toBe(404);

    server.stop(true);
  });

  test("internal Gateway runtime runs ACP in desk/.openbot/gateway", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const home = tempHome();
    const { ctx, server } = startTestServer({ home });
    const { session } = loginCookie({ ctx }, "alice");
    const gateway = ctx.db.get<{ id: string }>(
      "SELECT id FROM bots WHERE account_id = ? AND status = 'active' AND IFNULL(role, 'desk') = 'gateway'",
      [session.accountId],
    );
    expect(gateway).toBeTruthy();
    const gwId = gateway!.id;
    const thread = ctx.db.get<{ id: string }>(
      "SELECT id FROM threads WHERE account_id = ? AND bot_id = ? AND IFNULL(kind, 'human') = 'human'",
      [session.accountId, gwId],
    );
    expect(thread).toBeTruthy();
    const turnId = id();
    const createdAt = now();
    ctx.db.immediate(() => {
      ctx.db.run(
        `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, deadline_at, created_at)
         VALUES (?, ?, ?, 'queued', 0, '', ?, ?)`,
        [turnId, thread!.id, gwId, createdAt + 2 * 60 * 60 * 1000, createdAt],
      );
      insertMessage(ctx.db, {
        threadId: thread!.id,
        turnId,
        role: "user",
        origin: "user",
        body: "[[write:gateway-cwd.txt]]",
      });
    });
    ctx.engine.kick();
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const turn = ctx.db.get<{ status: string }>("SELECT status FROM turns WHERE id = ?", [turnId]);
      if (turn?.status === "completed") break;
      await Bun.sleep(40);
    }
    const workspaceProof = readFileSync(join(home, "desk", ".openbot", "gateway", "gateway-cwd.txt"), "utf8");
    expect(workspaceProof).toContain(join(home, "desk", ".openbot", "gateway"));
    expect(workspaceProof).not.toContain("/projects/");
    expect(ctx.engine.runnerFor(session.accountId).acpPid(gwId)).toBeTruthy();
    server.stop(true);
  });
});
