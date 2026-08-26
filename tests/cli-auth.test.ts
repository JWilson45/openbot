import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectCliLogins } from "@openbot/acp-grok";
import { tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

describe("CLI subscription auth", () => {
  test("detects grok oidc login from auth.json without treating it as an API key", () => {
    const home = tempHome();
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(
      join(home, ".grok", "auth.json"),
      JSON.stringify({
        "https://auth.x.ai::test": {
          auth_mode: "oidc",
          email: "user@example.com",
          refresh_token: "refresh-not-a-key",
        },
      }),
    );
    const logins = detectCliLogins(home);
    const grok = logins.find((l) => l.id === "grok");
    expect(grok?.signedIn).toBe(true);
    expect(grok?.email).toBe("user@example.com");
    expect(grok?.authMode).toBe("oidc");
  });

  test("GET /v1/harness-auth reports CLI login and does not require a vault key", async () => {
    const { ctx, server, origin } = startTestServer({ home: tempHome() });
    const { cookie } = loginCookie({ ctx }, "alice");
    const res = await fetch(`${origin}/v1/harness-auth`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      vaultKey: boolean;
      logins: Array<{ id: string; signedIn: boolean; cliInstalled: boolean }>;
      preferred: string;
    };
    expect(json.vaultKey).toBe(false);
    expect(json.logins.some((l) => l.id === "grok")).toBe(true);
    server.stop(true);
  });
});
