import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { join } from "node:path";
import { completeGithubLogin, cookieHeader, writeAllowlistFile } from "@openbot/auth";
import { OpenbotDb } from "@openbot/db";
import { tempHome } from "./helpers.ts";

async function waitUrl(url: string, timeout = 10_000): Promise<Response> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      return res;
    } catch (err) {
      last = err;
      await Bun.sleep(50);
    }
  }
  throw new Error(`timeout waiting for ${url}: ${String(last)}`);
}

describe("openbot server CLI", () => {
  test("health, ready, web origin, authenticated /v1/me", async () => {
    const home = tempHome();
    writeAllowlistFile(home, ["alice"]);
    const proc = spawn({
      cmd: [process.execPath, join(import.meta.dir, "../apps/server/src/cli.ts"), "server", "--home", home, "--port", "0"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENBOT_GITHUB_ALLOWLIST: "alice" },
    });
    const stdout = proc.stdout ? await readUntil(proc.stdout, "listening") : "";
    const parsed = JSON.parse(stdout.split("\n").find((l) => l.includes("listening")) ?? stdout);
    const origin = parsed.origin as string;
    const health = await waitUrl(`${origin}/v1/healthz`);
    expect(health.status).toBe(200);
    const healthJson = (await health.json()) as { ok: boolean };
    expect(healthJson.ok).toBe(true);
    const ready = await fetch(`${origin}/v1/readyz`);
    expect(ready.status).toBe(200);
    const readyJson = (await ready.json()) as { ok: boolean; desk: string };
    expect(readyJson.ok).toBe(true);
    expect(readyJson.desk).toContain("desk");
    const web = await fetch(origin + "/");
    expect(web.status).toBe(200);
    const html = await web.text();
    expect(html).toContain("OpenBot");
    expect(html.length).toBeGreaterThan(200);

    const oauth = await fetch(`${origin}/auth/github`);
    expect(oauth.status).toBe(501);
    const oauthJson = (await oauth.json()) as { error: string };
    expect(oauthJson.error).toBe("github_oauth_unconfigured");

    const db = OpenbotDb.open(join(home, "openbot.sqlite"));
    const session = completeGithubLogin(db, new Set(["alice"]), { login: "alice" });
    db.close();
    const me = await fetch(`${origin}/v1/me`, {
      headers: { cookie: cookieHeader(session.token).split(";")[0]! },
    });
    expect(me.status).toBe(200);
    const meJson = (await me.json()) as { githubLogin: string };
    expect(meJson.githubLogin).toBe("alice");
    proc.kill();
    await proc.exited;
  });
});

async function readUntil(stream: ReadableStream<Uint8Array>, needle: string): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const { done, value } = await reader.read();
    if (value) text += new TextDecoder().decode(value);
    if (text.includes(needle) || done) return text;
  }
  return text;
}
