import { describe, expect, test } from "bun:test";
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
      )) as { events: Array<{ kind: string; payload: string }> };
      const perm = events.events.find((e) => e.kind === "permission_request");
      if (perm) {
        const payload = JSON.parse(perm.payload) as { reqId?: string };
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
});
