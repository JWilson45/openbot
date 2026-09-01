import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultCommand } from "@openbot/acp-grok";
import { bwrapArgs, sandboxModeFromEnv, seatbeltProfile, wrapSandboxCommand } from "@openbot/runner";
import { tempHome } from "./helpers.ts";

describe("sandbox policy", () => {
  test("seatbelt profile denies operator home and vault files, allows desk and grok-home", () => {
    const openbotHome = "/var/lib/openbot/acme";
    const profile = seatbeltProfile({
      openbotHome,
      desk: join(openbotHome, "desk"),
      grokHome: join(openbotHome, "grok-home"),
      operatorHome: "/Users/jason",
    });
    expect(profile).toContain('(subpath "/Users/jason")');
    expect(profile).toContain(`(subpath "${openbotHome}")`);
    expect(profile).toContain(`(subpath "${join(openbotHome, "desk")}")`);
    expect(profile).toContain(`(literal "${join(openbotHome, "master.key")}")`);
    expect(profile).toContain('(literal "/var/run/docker.sock")');
  });

  test("bwrap args bind desk rw and mask vault files that exist", () => {
    const openbotHome = tempHome();
    writeFileSync(join(openbotHome, "master.key"), "00");
    mkdirSync(join(openbotHome, "desk"), { recursive: true });
    mkdirSync(join(openbotHome, "grok-home"), { recursive: true });
    const args = bwrapArgs({
      openbotHome,
      desk: join(openbotHome, "desk"),
      grokHome: join(openbotHome, "grok-home"),
    });
    expect(args).toContain("--ro-bind");
    expect(args).toContain(join(openbotHome, "desk"));
    const nullAt = args.indexOf("/dev/null");
    expect(nullAt).toBeGreaterThan(0);
    expect(args[nullAt + 1]).toBe(join(openbotHome, "master.key"));
  });

  test("auto + ACP override does not wrap", () => {
    const wrapped = wrapSandboxCommand(["grok", "agent", "stdio"], {
      openbotHome: "/tmp/ob",
      desk: "/tmp/ob/desk",
      grokHome: "/tmp/ob/grok-home",
    }, { mode: "auto", platform: "linux", acpOverride: true });
    expect(wrapped.backend).toBe("none");
    expect(wrapped.reason).toBe("OPENBOT_ACP_COMMAND");
    expect(wrapped.cmd[0]).toBe("grok");
  });

  test("none mode is a no-op", () => {
    expect(sandboxModeFromEnv("none")).toBe("none");
    const wrapped = wrapSandboxCommand(["grok"], {
      openbotHome: "/tmp/ob",
      desk: "/tmp/ob/desk",
      grokHome: "/tmp/ob/grok-home",
    }, { mode: "none" });
    expect(wrapped.cmd).toEqual(["grok"]);
  });

  test("defaultCommand omits --always-approve unless that mode", () => {
    const prev = process.env.OPENBOT_ACP_COMMAND;
    delete process.env.OPENBOT_ACP_COMMAND;
    try {
      expect(defaultCommand({ permissionMode: "auto" }).includes("--always-approve")).toBe(false);
      expect(defaultCommand({ permissionMode: "ask" }).includes("--always-approve")).toBe(false);
      expect(defaultCommand({ permissionMode: "always-approve" }).includes("--always-approve")).toBe(true);
    } finally {
      if (prev != null) process.env.OPENBOT_ACP_COMMAND = prev;
    }
  });
});
