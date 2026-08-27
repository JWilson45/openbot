import { describe, expect, test } from "bun:test";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

async function waitUntil(fn: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await Bun.sleep(40);
  }
  throw new Error("timeout");
}

describe("calendar series approval flag", () => {
  test("series require_human_approval parks SendMessage and does not empty_turn", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const ada = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-calappr0001" }),
    });
    const created = await fetch(`${origin}/v1/calendar/series`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "needs eyes",
        prompt: "[[send:please confirm]]",
        botId: ada.bot.id,
        dtstart: Date.now() - 30_000,
        requireHumanApproval: true,
      }),
    });
    expect(created.status).toBe(201);
    await waitUntil(() => {
      const parked = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND origin = 'pending_approval'",
        [ada.threadId],
      );
      const done = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM turns WHERE bot_id = ? AND status = 'completed'",
        [ada.bot.id],
      );
      return (parked?.n ?? 0) > 0 && (done?.n ?? 0) > 0;
    });
    const msgs = ctx.db.all<{ origin: string; body: string }>(
      "SELECT origin, body FROM messages WHERE thread_id = ? ORDER BY created_at",
      [ada.threadId],
    );
    expect(msgs.some((m) => m.origin === "pending_approval" && m.body === "please confirm")).toBe(true);
    expect(msgs.some((m) => m.origin === "send_message")).toBe(false);
    expect(msgs.some((m) => m.origin === "system" && /finished this turn without a message/.test(m.body))).toBe(false);
    expect(msgs.some((m) => m.origin === "fallback")).toBe(false);
    const turn = ctx.db.get<{ promote_reason: string | null; sent_message_count: number }>(
      "SELECT promote_reason, sent_message_count FROM turns WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
      [ada.bot.id],
    );
    expect(turn?.promote_reason).not.toBe("empty_turn");
    expect((turn?.sent_message_count ?? 0) >= 1).toBe(true);
    server.stop(true);
  });
});
