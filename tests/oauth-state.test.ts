import { describe, expect, test } from "bun:test";
import { createApp } from "../apps/server/src/app.ts";
import { tempHome } from "./helpers.ts";

describe("GitHub OAuth browser binding", () => {
  test("sets a fresh secure state cookie and rejects absent or mismatched state", async () => {
    const created = createApp({
      home: tempHome(),
      port: 0,
      publicOrigin: "https://waypoint.example.test",
      githubClientId: "test-client",
      githubClientSecret: "test-secret",
      requestLogging: false,
    });
    try {
      const first = await created.app.request("/auth/github");
      const state = new URL(first.headers.get("location")!).searchParams.get("state")!;
      const cookie = first.headers.get("set-cookie")!;
      expect(state.length).toBeGreaterThanOrEqual(32);
      expect(cookie).toContain(`__Host-openbot_oauth_state=${state}`);
      for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"]) {
        expect(cookie).toContain(flag);
      }
      const second = await created.app.request("/auth/github");
      expect(new URL(second.headers.get("location")!).searchParams.get("state")).not.toBe(state);
      for (const [query, sentCookie] of [
        ["code=test", cookie.split(";")[0]!],
        [`code=test&state=${state}`, ""],
        ["code=test&state=wrong", cookie.split(";")[0]!],
      ]) {
        const response = await created.app.request(`/auth/callback/github?${query}`, {
          headers: { cookie: sentCookie! },
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "oauth_state_invalid" });
        expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      }
      // A matching state reaches code validation without making a network request.
      const valid = await created.app.request(`/auth/callback/github?state=${state}`, {
        headers: { cookie: cookie.split(";")[0]! },
      });
      expect(await valid.json()).toEqual({ error: "oauth_failed" });
    } finally {
      created.stop();
    }
  });
});
