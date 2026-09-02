import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { grokCliPinStatus, parseGrokCliVersion, PINNED_GROK_CLI } from "../packages/acp-grok/src/pin.ts";
import { tempHome } from "./helpers.ts";

const cli = join(import.meta.dir, "../apps/server/src/cli.ts");

async function runOpenbot(
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, cli, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : process.env,
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

describe("openbot version / help / install", () => {
  test("openbot version and --version include 0.7.0 and grokPin 1.0.5", async () => {
    for (const args of [["version"], ["--version"], ["-v"]]) {
      const { stdout, code } = await runOpenbot(args);
      expect(code).toBe(0);
      const json = JSON.parse(stdout.trim()) as { openbot: string; grokPin: string; grok: string | null };
      expect(json.openbot).toBe("0.7.0");
      expect(json.grokPin).toBe("1.0.5");
      expect(json.grok === null || typeof json.grok === "string").toBe(true);
    }
  });

  test("help mentions install and --host", async () => {
    const { stdout, code } = await runOpenbot(["help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("install");
    expect(stdout).toContain("--host");
    expect(stdout).toContain("--origin");
    expect(stdout).toContain("--org");
    expect(stdout).toContain("openbot orgs");
    expect(stdout).toContain("openbot use");
    expect(stdout).toContain("openbot org init");
    expect(stdout).toContain("brew tap");
    expect(stdout).toContain("install.sh");
    expect(stdout).toContain("docs/host-service.md");
    expect(stdout).toContain("Closing a browser tab does not stop the teammate.");
  });

  test("openbot install writes a user unit into HOME", async () => {
    const home = tempHome();
    const { stdout, code } = await runOpenbot(
      ["install", "--user", "--home", home, "--port", "8799"],
      { HOME: home },
    );
    expect(code).toBe(0);
    let dest: string | null = null;
    if (process.platform === "darwin") {
      dest = join(home, "Library/LaunchAgents/ai.openbot.plist");
    } else if (process.platform === "linux") {
      dest = join(home, ".config/systemd/user/openbot.service");
    } else {
      expect(stdout).toContain(process.execPath);
      expect(stdout).toContain("apps/server/src/cli.ts");
      return;
    }
    expect(existsSync(dest)).toBe(true);
    const body = readFileSync(dest, "utf8");
    expect(body).toContain(process.execPath);
    expect(body).toContain("apps/server/src/cli.ts");
    expect(body).toContain(home);
    expect(body).toContain("8799");
    expect(stdout).toContain(dest);
  });
});

describe("grok CLI pin", () => {
  test("pin.ts parses grok 1.0.5 (abc) [stable]", () => {
    expect(parseGrokCliVersion("grok 1.0.5 (abc) [stable]")).toBe("1.0.5");
    expect(PINNED_GROK_CLI).toBe("1.0.5");
  });

  test("grokCliPinStatus treats missing, same minor, and same-major newer as documented", () => {
    const missing = grokCliPinStatus(null);
    expect(missing.ok).toBe(true);
    expect(missing.detected).toBeNull();
    expect(missing.pinned).toBe("1.0.5");
    expect(missing.warning).toBeTruthy();

    const exact = grokCliPinStatus("1.0.5");
    expect(exact.ok).toBe(true);
    expect(exact.warning).toBeUndefined();

    const olderPatch = grokCliPinStatus("1.0.4");
    expect(olderPatch.ok).toBe(true);
    expect(olderPatch.warning).toContain("older");

    const newerMinor = grokCliPinStatus("1.1.0");
    expect(newerMinor.ok).toBe(true);
    expect(newerMinor.warning).toBeUndefined();

    const olderMajor = grokCliPinStatus("0.9.0");
    expect(olderMajor.ok).toBe(false);
    expect(olderMajor.warning).toBeTruthy();
  });
});
