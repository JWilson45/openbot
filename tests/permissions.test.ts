import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { denyGatewayExec, deskPathGuard, pathIsDenied, resolvePermissionPath } from "@openbot/runner";
import { grokHomeDir } from "@openbot/acp-grok";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

async function waitMessages(origin: string, headers: Record<string, string>, pred: (m: { origin: string; body: string }) => boolean) {
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const t = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      messages: Array<{ origin: string; body: string }>;
      latestTurnId: string | null;
    };
    if (t.messages.some(pred)) return t;
    await Bun.sleep(80);
  }
  throw new Error("timeout waiting for messages");
}

describe("ACP session/request_permission", () => {
  test("ask mode waits for POST /v1/turns/:id/permissions/:reqId which answers ACP JSON-RPC", async () => {
    const home = tempHome();
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const botRes = await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    });
    const bot = (await botRes.json()) as { bot: { id: string } };
    await fetch(`${origin}/v1/bots/${bot.bot.id}/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ permissionMode: "ask" }),
    });
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-permkey0001" }),
    });
    const thread = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      thread: { id: string };
    };
    const posted = await fetch(`${origin}/v1/threads/${thread.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[permission]] [[send:allowed-after-ask]]" }),
    });
    expect(posted.status).toBe(202);
    const { turnId } = (await posted.json()) as { turnId: string };

    const start = Date.now();
    let reqId: string | undefined;
    while (Date.now() - start < 10_000 && !reqId) {
      const events = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) =>
        r.json(),
      )) as { events: Array<{ kind: string; payload: { reqId?: string } | string }> };
      const perm = events.events.find((e) => e.kind === "permission_request");
      if (perm) {
        const payload =
          typeof perm.payload === "string"
            ? (JSON.parse(perm.payload) as { reqId?: string })
            : perm.payload;
        reqId = payload.reqId;
      } else await Bun.sleep(50);
    }
    expect(reqId).toBeTruthy();

    const mid = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      messages: Array<{ origin: string }>;
    };
    expect(mid.messages.some((m) => m.origin === "send_message")).toBe(false);

    const answered = await fetch(`${origin}/v1/turns/${turnId}/permissions/${reqId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ allow: true }),
    });
    expect(answered.status).toBe(200);
    const ansJson = (await answered.json()) as { answered: boolean };
    expect(ansJson.answered).toBe(true);

    const done = await waitMessages(origin, headers, (m) => m.origin === "send_message");
    expect(done.messages.some((m) => m.body === "allowed-after-ask")).toBe(true);
    expect(done.latestTurnId).toBe(turnId);

    const catchup = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) =>
      r.json(),
    )) as { events: Array<{ kind: string }> };
    expect(catchup.events.some((e) => e.kind === "permission_request")).toBe(true);
    expect(catchup.events.length).toBeGreaterThan(0);

    server.stop(true);
  });

  test("denyGatewayExec rejects execute/shell", async () => {
    expect(
      await denyGatewayExec({
        kind: "permission_request",
        payload: { toolCall: { kind: "execute", title: "run a command" } },
      }),
    ).toEqual({ allow: false });
    expect(
      await denyGatewayExec({
        kind: "permission_request",
        payload: { toolCall: { kind: "shell" } },
      }),
    ).toEqual({ allow: false });
  });

  test("deskPathGuard denies vault and operator paths, defers in-desk", async () => {
    const openbotHome = tempHome();
    const desk = join(openbotHome, "desk");
    const grokHome = grokHomeDir(openbotHome);
    const cwd = join(desk, "projects", "ada");
    const roots = { desk, grokHome, openbotHome, cwd, operatorHome: "/Users/jason" };
    expect(
      await deskPathGuard(
        { kind: "permission_request", payload: { toolCall: { kind: "read", path: join(openbotHome, "master.key") } } },
        roots,
      ),
    ).toEqual({ allow: false });
    expect(
      await deskPathGuard(
        { kind: "permission_request", payload: { toolCall: { kind: "read", path: "/etc/passwd" } } },
        roots,
      ),
    ).toEqual({ allow: false });
    expect(
      await deskPathGuard(
        { kind: "permission_request", payload: { toolCall: { kind: "read", path: join(cwd, "README.md") } } },
        roots,
      ),
    ).toEqual({ defer: true });
    expect(
      await deskPathGuard(
        {
          kind: "permission_request",
          payload: { toolCall: { kind: "read", path: join(desk, "skills", "confirm-series", "SKILL.md") } },
        },
        roots,
      ),
    ).toEqual({ defer: true });
    expect(
      await deskPathGuard(
        {
          kind: "permission_request",
          payload: { toolCall: { kind: "read", path: "/Users/jason/.grok/skills/confirm-series/SKILL.md" } },
        },
        roots,
      ),
    ).toEqual({ allow: false });
    expect(
      await deskPathGuard(
        { kind: "permission_request", payload: { toolCall: { kind: "execute", title: "run a command" } } },
        roots,
      ),
    ).toEqual({ defer: true });
    expect(pathIsDenied("/Users/jason/.ssh/id_rsa", roots)).toBe(true);
    expect(resolvePermissionPath("~/auth.json", cwd, grokHome)).toBe(join(grokHome, "auth.json"));
  });

  test("auto mode denies master.key without waiting for the human", async () => {
    const home = tempHome();
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const botRes = await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    });
    const bot = (await botRes.json()) as { bot: { id: string } };
    const vault = join(home, "master.key");
    const thread = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      thread: { id: string };
    };
    const posted = await fetch(`${origin}/v1/threads/${thread.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: `[[permission-path:${vault}]] [[send:after-deny]]` }),
    });
    expect(posted.status).toBe(202);
    const { turnId } = (await posted.json()) as { turnId: string };
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const t = ctx.db.get<{ status: string }>("SELECT status FROM turns WHERE id = ?", [turnId]);
      if (t?.status === "completed") break;
      await Bun.sleep(40);
    }
    const done = await waitMessages(origin, headers, (m) => m.origin === "send_message" && m.body === "after-deny");
    expect(done.messages.some((m) => m.body === "after-deny")).toBe(true);
    const events = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) =>
      r.json(),
    )) as { events: Array<{ kind: string }> };
    expect(events.events.some((e) => e.kind === "permission_request")).toBe(true);
    expect(bot.bot.id).toBeTruthy();
    server.stop(true);
  });

  test("auto mode defers in-desk paths and still completes without a modal", async () => {
    const home = tempHome();
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const botRes = await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    });
    const bot = (await botRes.json()) as { bot: { id: string } };
    const inside = join(home, "desk", "projects", bot.bot.id, "README.md");
    const thread = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      thread: { id: string };
    };
    const posted = await fetch(`${origin}/v1/threads/${thread.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: `[[permission-path:${inside}]] [[send:after-allow]]` }),
    });
    expect(posted.status).toBe(202);
    const done = await waitMessages(origin, headers, (m) => m.origin === "send_message" && m.body === "after-allow");
    expect(done.messages.some((m) => m.body === "after-allow")).toBe(true);
    server.stop(true);
  });

  test("Gateway auto-denies exec without waiting for the human", async () => {
    const home = tempHome();
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home });
    const { cookie, session } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    await fetch(`${origin}/v1/org`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ federationEnabled: true }),
    });
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
      body: JSON.stringify({ body: "[[permission]] [[send:gateway-denied-exec]]" }),
    });
    expect(posted.status).toBe(202);
    const { turnId } = (await posted.json()) as { turnId: string };
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const t = ctx.db.get<{ status: string }>(
        "SELECT status FROM turns WHERE id = ?",
        [turnId],
      );
      if (t?.status === "completed") break;
      await Bun.sleep(40);
    }
    expect(ctx.engine.runnerFor(session.accountId).acpFor(gwId)?.permissionHandler).toBe(denyGatewayExec);
    const msgs = ctx.db.all<{ origin: string; body: string }>(
      "SELECT origin, body FROM messages WHERE thread_id = ? ORDER BY created_at",
      [thread.thread.id],
    );
    expect(msgs.some((m) => m.origin === "send_message" && m.body === "gateway-denied-exec")).toBe(true);
    const events = (await fetch(`${origin}/v1/turns/${turnId}/live-work`, { headers }).then((r) =>
      r.json(),
    )) as { events: Array<{ kind: string }> };
    expect(events.events.some((e) => e.kind === "permission_request")).toBe(true);
    server.stop(true);
  });
});
