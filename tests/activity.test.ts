import { describe, expect, test } from "bun:test";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

describe("activity monitor", () => {
  test("GET /v1/activity lists active bots with presence", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie, session } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    await fetch(`${origin}/v1/bots`, { method: "POST", headers, body: JSON.stringify({ name: "Ada" }) });
    const listed = (await fetch(`${origin}/v1/bots`, { headers }).then((r) => r.json())) as {
      a2aGateway: { available: boolean; endpoint: string; agentCard: string } | null;
      gateway?: unknown;
    };
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
    const res = await fetch(`${origin}/v1/activity`, { headers });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bots: Array<{ id: string; name: string; presence: { key: string } }> };
    expect(json.bots.some((b) => b.name === "Ada")).toBe(true);
    expect(json.bots.some((b) => b.id === gateway!.id)).toBe(false);
    expect(json.bots.some((b) => /^Gateway/.test(b.name))).toBe(false);
    expect(json.bots[0]?.presence?.key).toBeTruthy();
    const health = (await fetch(`${origin}/v1/compute`, { headers }).then((r) => r.json())) as {
      bots: Array<{ id: string }>;
    };
    expect(health.bots.some((b) => b.id === gateway!.id)).toBe(false);
    server.stop(true);
  });
});
