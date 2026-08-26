import { describe, expect, test } from "bun:test";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

async function waitOrigin(origin: string, headers: Record<string, string>, botId: string, pred: (m: { origin: string; body: string }) => boolean) {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const t = (await fetch(`${origin}/v1/threads?botId=${botId}`, { headers }).then((r) => r.json())) as {
      messages: Array<{ origin: string; body: string }>;
    };
    if ((t.messages || []).some(pred)) return t.messages;
    await Bun.sleep(80);
  }
  throw new Error("timeout");
}

describe("SendToAgent mailbox", () => {
  test("Ada sendto Bob; Bob SendMessage lands on Bob human DM; Ada DM unchanged", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const ada = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada", description: "research" }),
    }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
    const bob = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Bob", description: "writer" }),
    }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-a2akey0001" }),
    });
    const posted = await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[sendto:Bob:write a draft]] [[send:I asked Bob]]" }),
    });
    expect(posted.status).toBe(202);
    const adaMsgs = await waitOrigin(origin, headers, ada.bot.id, (m) => m.origin === "send_message");
    expect(adaMsgs.some((m) => m.body === "I asked Bob")).toBe(true);

    const a2a = (await fetch(`${origin}/v1/threads?kind=a2a&botId=${ada.bot.id}`, { headers }).then((r) =>
      r.json(),
    )) as { threads: Array<{ id: string }> };
    expect(a2a.threads.length).toBe(1);
    const handoff = (await fetch(`${origin}/v1/threads/${a2a.threads[0]!.id}`, { headers }).then((r) =>
      r.json(),
    )) as { messages: Array<{ origin: string; body: string }> };
    expect(handoff.messages.some((m) => m.origin === "agent" && m.body.includes("write a draft"))).toBe(true);

    const bobHuman = await waitOrigin(origin, headers, bob.bot.id, (m) => m.origin === "send_message");
    expect(bobHuman.some((m) => m.body.includes("write a draft"))).toBe(true);
    expect(adaMsgs.filter((m) => m.body.includes("write a draft") && m.origin === "agent").length).toBe(0);
    expect(bobHuman.some((m) => m.origin === "agent")).toBe(false);
    server.stop(true);
  });
});
