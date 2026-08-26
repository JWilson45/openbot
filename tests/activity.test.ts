import { describe, expect, test } from "bun:test";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

describe("activity monitor", () => {
  test("GET /v1/activity lists active bots with presence", async () => {
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    await fetch(`${origin}/v1/bots`, { method: "POST", headers, body: JSON.stringify({ name: "Ada" }) });
    const res = await fetch(`${origin}/v1/activity`, { headers });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bots: Array<{ name: string; presence: { key: string } }> };
    expect(json.bots.some((b) => b.name === "Ada")).toBe(true);
    expect(json.bots[0]?.presence?.key).toBeTruthy();
    server.stop(true);
  });
});
