import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedGrokConfig, prepareIsolatedGrokHome } from "@openbot/acp-grok";
import { tempHome } from "./helpers.ts";

describe("isolated grok home", () => {
  test("copies CLI auth as a regular file and writes a config without user MCP servers", () => {
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
    writeFileSync(
      join(userHome, ".grok", "models_cache.json"),
      JSON.stringify({ models: { "grok-4.6": { info: { id: "grok-4.6", name: "Grok 4.6", hidden: false, reasoning_efforts: [] } } } }),
    );
    const grokHome = prepareIsolatedGrokHome(openbotHome, userHome);
    const cfg = readFileSync(join(grokHome, "config.toml"), "utf8");
    expect(cfg).toBe(isolatedGrokConfig("auto"));
    expect(cfg).not.toContain("always-approve");
    expect(readFileSync(join(grokHome, "models_cache.json"), "utf8")).toContain("grok-4.6");
    expect(cfg).not.toContain("grafana");
    const authPath = join(grokHome, "auth.json");
    expect(lstatSync(authPath).isSymbolicLink()).toBe(false);
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as {
      [k: string]: { email: string };
    };
    expect(Object.values(auth)[0]?.email).toBe("a@b.c");
  });

  test("replaces a leftover symlink with a copy", () => {
    const userHome = tempHome();
    mkdirSync(join(userHome, ".grok"), { recursive: true });
    const src = join(userHome, ".grok", "auth.json");
    writeFileSync(src, JSON.stringify({ a: { email: "x@y.z", refresh_token: "t" } }));
    const openbotHome = tempHome();
    const grokHome = join(openbotHome, "grok-home");
    mkdirSync(grokHome, { recursive: true });
    symlinkSync(src, join(grokHome, "auth.json"));
    prepareIsolatedGrokHome(openbotHome, userHome, "ask");
    const st = lstatSync(join(grokHome, "auth.json"));
    expect(st.isSymbolicLink()).toBe(false);
    expect(readFileSync(join(grokHome, "config.toml"), "utf8")).toContain('permission_mode = "ask"');
  });

  test("always-approve config sets yolo", () => {
    const cfg = isolatedGrokConfig("always-approve");
    expect(cfg).toContain("yolo = true");
    expect(cfg).toContain('permission_mode = "always-approve"');
  });
});
