import { describe, expect, test } from "bun:test";
import { ARCHIVE_TTL_MS, now } from "@openbot/db";
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
      gateway: { id: string; name: string; enabled: boolean; role: string } | null;
    };
    expect(list.bots.length).toBe(6);
    expect(list.bots.some((b) => b.name === list.gateway?.name)).toBe(false);
    expect(list.gateway).toBeTruthy();
    expect(list.gateway!.role).toBe("gateway");
    expect(list.gateway!.enabled).toBe(false);
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

  test("Gateway is a sidecar, not a desk slot, and locked fields 409", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const listed = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
      bots: Array<{ name: string }>;
      gateway: { id: string; name: string; enabled: boolean } | null;
      bot: { id: string } | null;
    };
    expect(listed.bots.length).toBe(0);
    expect(listed.bot).toBeNull();
    expect(listed.gateway).toBeTruthy();
    expect(listed.gateway!.enabled).toBe(false);
    const gwId = listed.gateway!.id;
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

    const arch = await fetch(`${origin}/v1/bots/${gwId}/archive`, { method: "POST", headers });
    expect(arch.status).toBe(409);
    expect(((await arch.json()) as { error: string }).error).toBe("gateway_protected");
    const purge = await fetch(`${origin}/v1/bots/${gwId}/purge`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(purge.status).toBe(409);
    const rename = await fetch(`${origin}/v1/bots/${gwId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "NotGateway" }),
    });
    expect(rename.status).toBe(409);
    const perm = await fetch(`${origin}/v1/bots/${gwId}/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ permissionMode: "auto" }),
    });
    expect(perm.status).toBe(409);
    const harness = await fetch(`${origin}/v1/bots/${gwId}/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ harness: "codex" }),
    });
    expect(harness.status).toBe(409);
    const effort = await fetch(`${origin}/v1/bots/${gwId}/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ reasoningEffort: "medium" }),
    });
    expect(effort.status).toBe(200);

    const on = await fetch(`${origin}/v1/org`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ federationEnabled: true }),
    });
    expect(on.status).toBe(200);
    const enabled = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
      gateway: { enabled: boolean };
    };
    expect(enabled.gateway.enabled).toBe(true);
    const prevFed = process.env.OPENBOT_FEDERATION;
    process.env.OPENBOT_FEDERATION = "0";
    try {
      const forcedOff = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
        gateway: { enabled: boolean };
      };
      expect(forcedOff.gateway.enabled).toBe(false);
    } finally {
      if (prevFed === undefined) delete process.env.OPENBOT_FEDERATION;
      else process.env.OPENBOT_FEDERATION = prevFed;
    }
    server.stop(true);
  });

  test("federation off completes a Gateway DM without an ACP pid", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie, session } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const listed = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
      gateway: { id: string };
    };
    const gwId = listed.gateway.id;
    const thread = (await fetch(`${origin}/v1/threads?botId=${gwId}`, { headers }).then((r) => r.json())) as {
      thread: { id: string };
    };
    const posted = await fetch(`${origin}/v1/threads/${thread.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "hello diplomat" }),
    });
    expect(posted.status).toBe(202);
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const t = ctx.db.get<{ status: string }>(
        "SELECT status FROM turns WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
        [gwId],
      );
      if (t?.status === "completed") break;
      await Bun.sleep(40);
    }
    expect(ctx.engine.runnerFor(session.accountId).acpPid(gwId)).toBeUndefined();
    const msgs = ctx.db.all<{ origin: string; body: string }>(
      "SELECT origin, body FROM messages WHERE thread_id = ? ORDER BY created_at",
      [thread.thread.id],
    );
    expect(msgs.some((m) => m.origin === "system" && /Federation is off/.test(m.body))).toBe(true);
    server.stop(true);
  });

  test("federation on runs Gateway ACP in desk/.openbot/gateway", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const home = tempHome();
    const { ctx, server, origin } = startTestServer({ home });
    const { cookie, session } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    await fetch(`${origin}/v1/org`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ federationEnabled: true }),
    });
    const listed = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
      gateway: { id: string; enabled: boolean };
    };
    expect(listed.gateway.enabled).toBe(true);
    const gwId = listed.gateway.id;
    const thread = (await fetch(`${origin}/v1/threads?botId=${gwId}`, { headers }).then((r) => r.json())) as {
      thread: { id: string };
    };
    const posted = await fetch(`${origin}/v1/threads/${thread.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[cwd]]" }),
    });
    expect(posted.status).toBe(202);
    const start = Date.now();
    let body = "";
    while (Date.now() - start < 10_000) {
      const msgs = ctx.db.all<{ origin: string; body: string }>(
        "SELECT origin, body FROM messages WHERE thread_id = ? ORDER BY created_at",
        [thread.thread.id],
      );
      const send = msgs.find((m) => m.origin === "send_message");
      if (send) {
        body = send.body;
        break;
      }
      await Bun.sleep(40);
    }
    expect(body).toContain(".openbot/gateway");
    expect(body).not.toContain("/projects/");
    expect(ctx.engine.runnerFor(session.accountId).acpPid(gwId)).toBeTruthy();
    server.stop(true);
  });
});
