import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ISOLATED_GROK_CONFIG, prepareIsolatedGrokHome } from "@openbot/acp-grok";
import { tempHome } from "./helpers.ts";

describe("isolated grok home", () => {
  test("links CLI auth and writes a config without user MCP servers", () => {
    const userHome = tempHome();
    mkdirSync(join(userHome, ".grok"), { recursive: true });
    writeFileSync(
      join(userHome, ".grok", "auth.json"),
      JSON.stringify({ "https://auth.x.ai::test": { refresh_token: "r", email: "a@b.c" } }),
    );
    writeFileSync(
      join(userHome, ".grok", "config.toml"),
      `[mcp_servers.grafana]\nurl = "https://example.invalid/mcp"\nenabled = true\n`,
    );
    const openbotHome = tempHome();
    writeFileSync(join(userHome, ".grok", "models_cache.json"), JSON.stringify({ models: { "grok-4.6": { info: { id: "grok-4.6", name: "Grok 4.6", hidden: false, reasoning_efforts: [] } } } }));
    const grokHome = prepareIsolatedGrokHome(openbotHome, userHome);
    const cfg = readFileSync(join(grokHome, "config.toml"), "utf8");
    expect(cfg).toBe(ISOLATED_GROK_CONFIG);
    expect(readFileSync(join(grokHome, "models_cache.json"), "utf8")).toContain("grok-4.6");
    expect(cfg).not.toContain("grafana");
    const auth = JSON.parse(readFileSync(join(grokHome, "auth.json"), "utf8")) as {
      [k: string]: { email: string };
    };
    expect(Object.values(auth)[0]?.email).toBe("a@b.c");
  });
});
