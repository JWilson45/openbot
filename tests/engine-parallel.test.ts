import { describe, expect, test } from "bun:test";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

describe("parallel turns", () => {
  test("two bots run overlapping turns", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie, session } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const ada = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
    const bob = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Bob" }),
    }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-parkey0001" }),
    });
    await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[sleep:400]] [[send:ada-done]]" }),
    });
    await fetch(`${origin}/v1/threads/${bob.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[sleep:400]] [[send:bob-done]]" }),
    });
    const start = Date.now();
    let adaRow: { started_at: number; finished_at: number } | undefined;
    let bobRow: { started_at: number; finished_at: number } | undefined;
    while (Date.now() - start < 15_000) {
      adaRow = ctx.db.get("SELECT started_at, finished_at FROM turns WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1", [
        ada.bot.id,
      ]);
      bobRow = ctx.db.get("SELECT started_at, finished_at FROM turns WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1", [
        bob.bot.id,
      ]);
      if (adaRow?.finished_at && bobRow?.finished_at) break;
      await Bun.sleep(50);
    }
    expect(adaRow?.started_at && bobRow?.started_at).toBeTruthy();
    expect(adaRow!.started_at! < bobRow!.finished_at! && bobRow!.started_at! < adaRow!.finished_at!).toBe(true);
    const runner = ctx.engine.runnerFor(session.accountId);
    expect(runner.acpFor(ada.bot.id)?.pid).toBeTruthy();
    expect(runner.acpFor(bob.bot.id)?.pid).toBeTruthy();
    expect(runner.acpPid(ada.bot.id)).not.toBe(runner.acpPid(bob.bot.id));
    server.stop(true);
  });

  test("second turn reuses Ada ACP pid", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie, session } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const ada = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-warmkey0001" }),
    });
    await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[send:one]]" }),
    });
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const t = ctx.db.get<{ status: string }>("SELECT status FROM turns WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1", [
        ada.bot.id,
      ]);
      if (t?.status === "completed") break;
      await Bun.sleep(40);
    }
    const pid1 = ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id);
    expect(pid1).toBeTruthy();
    await fetch(`${origin}/v1/threads/${ada.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[send:two]]" }),
    });
    const start2 = Date.now();
    while (Date.now() - start2 < 10_000) {
      const n = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM turns WHERE bot_id = ? AND status = 'completed'",
        [ada.bot.id],
      );
      if ((n?.n ?? 0) >= 2) break;
      await Bun.sleep(40);
    }
    expect(ctx.engine.runnerFor(session.accountId).acpPid(ada.bot.id)).toBe(pid1);
    server.stop(true);
  });
});
