import { describe, expect, test } from "bun:test";
import { now } from "@openbot/db";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

describe("orphan running turns", () => {
  test("a leftover running turn is reaped so a queued message can run", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const created = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-reapkey0001" }),
    });

    const zombieId = "11111111-1111-4111-8111-111111111111";
    ctx.db.run(
      `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, created_at, started_at)
       VALUES (?, ?, ?, 'running', 0, '', ?, ?)`,
      [zombieId, created.threadId, created.bot.id, now(), now()],
    );

    await fetch(`${origin}/v1/threads/${created.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[send:after-reap]]" }),
    });

    const start = Date.now();
    let messages: Array<{ origin: string; body: string; role: string }> = [];
    while (Date.now() - start < 15_000) {
      const t = (await fetch(`${origin}/v1/threads?botId=${created.bot.id}`, { headers }).then((r) =>
        r.json(),
      )) as { messages: Array<{ origin: string; body: string; role: string }> };
      messages = t.messages;
      if (messages.some((m) => m.origin === "send_message" && m.body.includes("after-reap"))) break;
      await Bun.sleep(80);
    }
    expect(messages.some((m) => m.origin === "send_message" && m.body.includes("after-reap"))).toBe(true);
    const zombie = ctx.db.get<{ status: string }>("SELECT status FROM turns WHERE id = ?", [zombieId]);
    expect(zombie?.status).not.toBe("running");
    server.stop(true);
  });
});
