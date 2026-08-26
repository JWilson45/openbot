import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listGrokModels, resolveBotInference } from "@openbot/acp-grok";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

describe("inference catalog", () => {
  test("reads models_cache and clamps effort to the model's menu", () => {
    const home = tempHome();
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(
      join(home, ".grok", "models_cache.json"),
      JSON.stringify({
        models: {
          "grok-4.6": {
            info: {
              id: "grok-4.6",
              name: "Grok 4.6",
              hidden: false,
              reasoning_effort: "high",
              reasoning_efforts: [
                { id: "high", value: "high", label: "High", default: true },
                { id: "low", value: "low", label: "Low" },
              ],
            },
          },
        },
      }),
    );
    const catalog = listGrokModels(undefined, home);
    expect(catalog.some((m) => m.id === "grok-4.6")).toBe(true);
    expect(resolveBotInference(catalog, "grok-4.6", "xhigh").reasoningEffort).toBe("high");
    expect(resolveBotInference(catalog, "nope", "low").model).toBe("grok-4.6");
  });
});

describe("bot model and reasoning settings", () => {
  test("PATCH applies on the next turn and respawns a warm ACP", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    const created = (await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    }).then((r) => r.json())) as { bot: { id: string; model: string }; threadId: string };
    expect(created.bot.model).toBeTruthy();
    const catalog = (await fetch(`${origin}/v1/inference-models`, { headers }).then((r) => r.json())) as {
      models: Array<{ id: string; reasoningEfforts: Array<{ value: string }> }>;
    };
    expect(catalog.models.length).toBeGreaterThan(0);
    await fetch(`${origin}/v1/credentials/xai`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "xai-infkey0001" }),
    });
    await fetch(`${origin}/v1/threads/${created.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[send:one]]" }),
    });
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const t = ctx.db.get<{ status: string }>(
        "SELECT status FROM turns WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
        [created.bot.id],
      );
      if (t?.status === "completed") break;
      await Bun.sleep(40);
    }
    const pid1 = ctx.engine.runnerFor(
      ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [created.bot.id])!.account_id,
    ).acpPid(created.bot.id);
    expect(pid1).toBeTruthy();

    const model = catalog.models[0]!;
    const nextEffort =
      model.reasoningEfforts.find((e) => e.value !== "high")?.value ??
      model.reasoningEfforts[0]?.value ??
      "low";
    const patched = await fetch(`${origin}/v1/bots/${created.bot.id}/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ model: model.id, reasoningEffort: nextEffort }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { model: string; reasoningEffort: string; applies: string };
    expect(body.model).toBe(model.id);
    expect(body.reasoningEffort).toBe(nextEffort);
    expect(body.applies).toBe("next_turn");

    const bad = await fetch(`${origin}/v1/bots/${created.bot.id}/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ model: "not-a-real-model" }),
    });
    expect(bad.status).toBe(400);

    await fetch(`${origin}/v1/threads/${created.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[send:two]]" }),
    });
    const start2 = Date.now();
    while (Date.now() - start2 < 10_000) {
      const n = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM turns WHERE bot_id = ? AND status = 'completed'",
        [created.bot.id],
      );
      if ((n?.n ?? 0) >= 2) break;
      await Bun.sleep(40);
    }
    const accountId = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [
      created.bot.id,
    ])!.account_id;
    expect(ctx.engine.runnerFor(accountId).acpPid(created.bot.id)).not.toBe(pid1);
    const row = ctx.db.get<{ model: string; reasoning_effort: string }>(
      "SELECT model, reasoning_effort FROM bots WHERE id = ?",
      [created.bot.id],
    );
    expect(row?.model).toBe(model.id);
    expect(row?.reasoning_effort).toBe(nextEffort);
    server.stop(true);
  });
});
