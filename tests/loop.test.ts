import { describe, expect, test } from "bun:test";
import { id } from "@openbot/db";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

async function waitAssistant(origin: string, headers: Record<string, string>) {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const t = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      messages: Array<{ origin: string; body: string; role: string; id: string }>;
    };
    if (t.messages.some((m) => m.origin === "send_message" || m.origin === "fallback" || m.origin === "system")) {
      return t.messages;
    }
    await Bun.sleep(80);
  }
  throw new Error("timeout");
}

describe("teammate loop via fake ACP", () => {
  test("SendMessage yields a thread assistant row origin=send_message", async () => {
    const home = tempHome();
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home });
    const { cookie } = loginCookie({ app: null as never, ctx, ready: () => undefined }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    await fetch(`${origin}/v1/bots`, { method: "POST", headers, body: JSON.stringify({ name: "Ada" }) });
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-loopkey0001" }),
    });
    const thread = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      thread: { id: string };
    };
    await fetch(`${origin}/v1/threads/${thread.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[send:loop-ok]]" }),
    });
    const messages = await waitAssistant(origin, headers);
    const sends = messages.filter((m) => m.origin === "send_message");
    expect(sends.length).toBe(1);
    expect(sends[0]?.body).toBe("loop-ok");
    expect(messages.filter((m) => m.origin === "fallback").length).toBe(0);
    server.stop(true);
  });

  test("turn that never calls SendMessage yields a fallback-marked row and not a duplicate", async () => {
    const home = tempHome();
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home });
    const { cookie } = loginCookie({ app: null as never, ctx, ready: () => undefined }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    await fetch(`${origin}/v1/bots`, { method: "POST", headers, body: JSON.stringify({ name: "Ada" }) });
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-loopkey0002" }),
    });
    const thread = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      thread: { id: string };
    };
    await fetch(`${origin}/v1/threads/${thread.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[ramble]] please just think" }),
    });
    const messages = await waitAssistant(origin, headers);
    const fallbacks = messages.filter((m) => m.origin === "fallback");
    expect(fallbacks.length).toBe(1);
    expect(messages.filter((m) => m.origin === "send_message").length).toBe(0);
    expect(fallbacks[0]?.body).toContain("working:");
    server.stop(true);
  });

  test("cold harness start injects prior thread instead of a blank ACP session", async () => {
    const home = tempHome();
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home });
    const { cookie } = loginCookie({ app: null as never, ctx, ready: () => undefined }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const created = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-loopkey0003" }),
    });
    ctx.db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, from_bot_id, created_at)
       VALUES (?, ?, NULL, 'user', 'user', 'remember the pineapple', 'normal', NULL, ?)`,
      [id(), created.threadId, Date.now() - 2000],
    );
    ctx.db.run(
      `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, from_bot_id, created_at)
       VALUES (?, ?, NULL, 'assistant', 'send_message', 'pineapple is great', 'normal', ?, ?)`,
      [id(), created.threadId, created.bot.id, Date.now() - 1000],
    );
    await fetch(`${origin}/v1/threads/${created.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[echo-prompt]]" }),
    });
    const start = Date.now();
    let messages: Array<{ origin: string; body: string }> = [];
    while (Date.now() - start < 20_000) {
      const t = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
        messages: Array<{ origin: string; body: string }>;
      };
      messages = t.messages;
      if (messages.some((m) => m.origin === "send_message" && m.body === "got-digest")) break;
      if (messages.some((m) => m.origin === "fallback" || m.origin === "system")) break;
      await Bun.sleep(80);
    }
    expect(messages.some((m) => m.origin === "send_message" && m.body === "got-digest")).toBe(true);
    server.stop(true);
  });
});
