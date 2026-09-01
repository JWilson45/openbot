import { describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join as pathJoin } from "node:path";
import { joinRunner } from "@openbot/runner";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";
import {
  hostIsLoopback,
  unauthenticatedRunnerAdminAllowed,
} from "../apps/server/src/runner-admin.ts";

const CLI = pathJoin(import.meta.dir, "../apps/server/src/cli.ts");

async function waitMessages(
  origin: string,
  headers: Record<string, string>,
  pred: (msgs: Array<{ origin: string; body: string }>) => boolean,
  timeout = 25_000,
) {
  const start = Date.now();
  let messages: Array<{ origin: string; body: string }> = [];
  while (Date.now() - start < timeout) {
    const t = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      messages: Array<{ origin: string; body: string }>;
    };
    messages = t.messages;
    if (pred(messages)) return messages;
    await Bun.sleep(80);
  }
  throw new Error(`timeout waiting for messages: ${JSON.stringify(messages.slice(-5))}`);
}

async function waitCompute(
  origin: string,
  headers: Record<string, string>,
  pred: (j: Record<string, unknown>) => boolean,
  timeout = 15_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  let last: Record<string, unknown> = {};
  while (Date.now() - start < timeout) {
    const res = await fetch(`${origin}/v1/compute`, { headers });
    last = (await res.json()) as Record<string, unknown>;
    if (pred(last)) return last;
    await Bun.sleep(50);
  }
  throw new Error(`timeout waiting for compute: ${JSON.stringify(last)}`);
}

async function readUntil(
  stream: ReadableStream<Uint8Array> | null | undefined,
  needle: string,
  timeout = 15_000,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  let text = "";
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { done, value } = await reader.read();
    if (value) text += new TextDecoder().decode(value);
    if (text.includes(needle) || done) return text;
  }
  return text;
}

function postWithHost(
  port: number,
  path: string,
  host: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { Host: host, ...extra },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function childPids(ppid: number): number[] {
  const r = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" });
  const text = new TextDecoder().decode(r.stdout);
  const kids: number[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const parent = Number(parts[1]);
    if (parent === ppid && Number.isFinite(pid)) kids.push(pid);
  }
  return kids;
}

function descendants(pid: number): number[] {
  const out: number[] = [];
  const q = [pid];
  while (q.length) {
    const cur = q.pop()!;
    for (const c of childPids(cur)) {
      out.push(c);
      q.push(c);
    }
  }
  return out;
}

function psCommand(pid: number): string {
  const r = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(r.stdout).trim();
}

/** Fake-ACP children of `rootPid` (the shipped `openbot runner join` process). */
function fakeAgentPids(rootPid: number): number[] {
  return descendants(rootPid).filter((pid) => psCommand(pid).includes("fake-agent.ts"));
}

async function spawnJoin(
  origin: string,
  token: string,
  home: string,
): Promise<{ proc: Subprocess; pid: number; stdout: Promise<string> }> {
  const proc = spawn({
    cmd: [process.execPath, CLI, "runner", "join", origin, "--token", token, "--home", home],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENBOT_ACP_COMMAND: fakeAgentCommand() },
  });
  const stdout = readUntil(proc.stdout, "openbot runner");
  const text = await stdout;
  if (!text.includes("openbot runner")) {
    const err = proc.stderr ? await new Response(proc.stderr).text() : "";
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    throw new Error(`join failed: ${text} ${err}`);
  }
  return { proc, pid: proc.pid ?? 0, stdout: Promise.resolve(text) };
}

async function setupOrg() {
  const home = tempHome();
  process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
  const created = startTestServer({ home });
  const { cookie, session } = loginCookie(created, "alice");
  const headers = { cookie, "content-type": "application/json" };
  const bot = (await fetch(`${created.origin}/v1/bots`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Ada" }),
  }).then((r) => r.json())) as { bot: { id: string }; threadId: string };
  await fetch(`${created.origin}/v1/credentials/xai`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ key: "xai-runnerkey0001" }),
  });
  return { ...created, home, cookie, headers, accountId: session.accountId, botId: bot.bot.id, threadId: bot.threadId };
}

describe("runner admin dual-gate", () => {
  test("peer loopback AND Host loopback required without cookie", () => {
    expect(unauthenticatedRunnerAdminAllowed("8.8.8.8", "127.0.0.1")).toBe(false);
    expect(unauthenticatedRunnerAdminAllowed("127.0.0.1", "desk.example.com")).toBe(false);
    expect(unauthenticatedRunnerAdminAllowed("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(unauthenticatedRunnerAdminAllowed("127.0.0.1", "127.0.0.1:8787")).toBe(true);
    expect(unauthenticatedRunnerAdminAllowed("::1", "localhost")).toBe(true);
    expect(unauthenticatedRunnerAdminAllowed("::ffff:127.0.0.1", "127.0.0.1")).toBe(true);
    expect(hostIsLoopback("[::1]:8787")).toBe(true);
  });

  test("HTTP (a)(b)(c) enroll/revoke gate; cookie + public Host enrolls", async () => {
    const home = tempHome();
    const created = startTestServer({ home });
    const { cookie } = loginCookie(created, "alice");
    const port = created.server.port;
    try {
      const a = await created.app.request("http://127.0.0.1/v1/runner/enroll", {
        method: "POST",
        headers: { host: "127.0.0.1" },
      });
      expect(a.status).toBe(403);

      const b = await postWithHost(port, "/v1/runner/enroll", "desk.example.com");
      expect(b.status).toBe(403);
      const bRevoke = await postWithHost(port, "/v1/runner/revoke", "desk.example.com");
      expect(bRevoke.status).toBe(403);

      const c = await postWithHost(port, "/v1/runner/enroll", "127.0.0.1");
      expect(c.status).toBe(200);
      const json = JSON.parse(c.body) as { token: string; join: string; origin: string };
      expect(json.token.startsWith("ob_enroll_")).toBe(true);
      expect(json.join).toContain("openbot runner join");
      expect(json.origin).not.toContain(":0");
      expect(json.origin).toContain(`127.0.0.1:${port}`);

      const cookiePublic = await postWithHost(port, "/v1/runner/enroll", "desk.example.com", {
        cookie,
      });
      expect(cookiePublic.status).toBe(200);

      const caddy = await Bun.file(pathJoin(import.meta.dir, "../contrib/caddy/Caddyfile.example")).text();
      expect(caddy).toContain("handle /mcp/v1*");
      expect(caddy).toContain("respond 404");
    } finally {
      created.server.stop(true);
    }
  });
});

describe("localhost sibling runner", () => {
  test("enroll kills in-process ACP including in_turn; join owns Grok; send+nav; kill join", async () => {
    const world = await setupOrg();
    const { origin, headers, accountId, botId, threadId, home, ctx, server } = world;
    let join: { proc: Subprocess; pid: number } | undefined;
    let runnerAcpPids: number[] = [];
    try {
      await fetch(`${origin}/v1/threads/${threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[sleep:8000]] [[send:should-die]]" }),
      });
      const start = Date.now();
      let acpPid: number | undefined;
      while (Date.now() - start < 10_000) {
        acpPid = ctx.engine.runners.get(accountId)?.acpPid(botId);
        if (acpPid) break;
        await Bun.sleep(40);
      }
      expect(acpPid).toBeTruthy();
      expect(pidAlive(acpPid)).toBe(true);

      const enrollRes = await fetch(`${origin}/v1/runner/enroll`, { method: "POST" });
      expect(enrollRes.status).toBe(200);
      const enrolled = (await enrollRes.json()) as { token: string };
      const computePending = await waitCompute(origin, headers, (j) => j.connection === "pending");
      expect(computePending.connection).toBe("pending");
      expect(computePending.state).not.toBe("running");
      expect(computePending.driver === "localhost" && computePending.state === "running").toBe(false);
      const diedAt = Date.now();
      while (pidAlive(acpPid) && Date.now() - diedAt < 5_000) await Bun.sleep(30);
      expect(pidAlive(acpPid)).toBe(false);
      expect(ctx.engine.runners.get(accountId)).toBeUndefined();

      join = await spawnJoin(origin, enrolled.token, home);
      expect(join.pid).not.toBe(process.pid);
      await waitCompute(origin, headers, (j) => j.connection === "connected" && j.driver === "runner");
      expect(ctx.engine.remotes.get(accountId)?.connected).toBe(true);
      expect(ctx.engine.runners.get(accountId)).toBeUndefined();

      await fetch(`${origin}/v1/threads/${threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[sleep:3000]] [[send:from-runner]]" }),
      });
      const messages = await waitMessages(origin, headers, (m) =>
        m.some((x) => x.origin === "send_message" && x.body === "from-runner"),
      );
      const sends = messages.filter((m) => m.origin === "send_message" && m.body === "from-runner");
      expect(sends.length).toBeGreaterThanOrEqual(1);
      const acpKids = fakeAgentPids(join.pid);
      runnerAcpPids = acpKids;
      expect(acpKids.length).toBeGreaterThan(0);
      for (const pid of acpKids) {
        expect(pid).not.toBe(process.pid);
        expect(pid).not.toBe(join.pid);
        expect(pidAlive(pid)).toBe(true);
      }
      expect(ctx.engine.runners.get(accountId)).toBeUndefined();

      await fetch(`${origin}/v1/threads/${threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "[[nav:https://example.com]] [[send:nav-done]]" }),
      });
      const navMessages = await waitMessages(origin, headers, (m) =>
        m.some((x) => x.origin === "send_message" && x.body === "nav-done"),
      );
      expect(navMessages.some((m) => m.origin === "send_message" && m.body === "nav-done")).toBe(true);

      const take = await fetch(`${origin}/v1/compute/takeover`, { method: "POST", headers });
      expect(take.status).toBe(200);
      const { ticket } = (await take.json()) as { ticket: string };
      const wsUrl = origin.replace(/^http/, "ws") + "/v1/takeover";
      const ws = new WebSocket(wsUrl);
      let gotBinary = false;
      let gotText = false;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("takeover timeout")), 12_000);
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "auth", ticket }));
        });
        ws.addEventListener("message", (ev) => {
          if (typeof ev.data === "string") gotText = true;
          else gotBinary = true;
          if (gotBinary) {
            clearTimeout(t);
            resolve();
          }
        });
        ws.addEventListener("error", () => {
          clearTimeout(t);
          reject(new Error("takeover ws error"));
        });
      });
      expect(gotBinary).toBe(true);
      ws.close();
      expect(ctx.engine.remotes.get(accountId)?.peer.binaryMessages ?? 0).toBe(0);
      expect(ctx.engine.remotes.get(accountId)?.binaryOnControl ?? 0).toBe(0);

      if (existsSync(pathJoin(home, "openbot.sqlite"))) {
        const lsof = Bun.spawnSync(["lsof", "-p", String(join.pid)], { stdout: "pipe", stderr: "pipe" });
        const listing = new TextDecoder().decode(lsof.stdout);
        expect(listing.includes("openbot.sqlite")).toBe(false);
      }

      let stealCode: number | undefined;
      let stealErr = "";
      try {
        await joinRunner({ origin, token: enrolled.token, home: tempHome() });
      } catch (err) {
        stealErr = JSON.stringify({ error: (err as Error).message, code: (err as { code?: number }).code });
        stealCode = 1;
      }
      expect(stealCode).not.toBe(0);
      expect(stealErr).toContain("runner_attached");
      expect(stealErr).toContain("-32001");

      const joinPid = join.pid;
      join.proc.kill();
      await join.proc.exited;
      join = undefined;
      const gone = await waitCompute(origin, headers, (j) => j.connection === "disconnected");
      expect(gone.driver).toBe("runner");
      expect(gone.state).not.toBe("running");
      expect(gone.driver === "localhost" && gone.state === "running").toBe(false);
      const ready = await fetch(`${origin}/v1/readyz`);
      expect(ready.status).toBe(200);
      expect(ctx.engine.runners.get(accountId)).toBeUndefined();
      expect(ctx.engine.remotes.get(accountId)?.connected).toBeFalsy();
      for (const pid of runnerAcpPids) expect(pidAlive(pid)).toBe(false);
      expect(fakeAgentPids(joinPid)).toEqual([]);

      const attached = await fetch(`${origin}/v1/runner/enroll`, { method: "POST" });
      expect(attached.status).toBe(409);

      const revoked = await fetch(`${origin}/v1/runner/revoke`, { method: "POST" });
      expect(revoked.status).toBe(200);
      expect(ctx.engine.remotes.get(accountId)).toBeUndefined();
      const afterRevoke = (await fetch(`${origin}/v1/compute`, { headers }).then((r) => r.json())) as {
        driver: string;
        connection?: string;
      };
      expect(afterRevoke.driver).toBe("localhost");
      expect(afterRevoke.connection).toBeUndefined();
    } finally {
      try {
        join?.proc.kill();
        await join?.proc.exited;
      } catch {
        /* ignore */
      }
      server.stop(true);
    }
  }, 90_000);

  test("enroll token survives createApp restart; last hello wins", async () => {
    const world = await setupOrg();
    let join1: { proc: Subprocess; pid: number } | undefined;
    let join2: { proc: Subprocess; pid: number } | undefined;
    try {
      const enrollRes = await fetch(`${world.origin}/v1/runner/enroll`, { method: "POST" });
      const enrolled = (await enrollRes.json()) as { token: string };
      world.server.stop(true);

      const again = startTestServer({ home: world.home });
      const { cookie } = loginCookie(again, "alice");
      const headers = { cookie, "content-type": "application/json" };
      try {
        join1 = await spawnJoin(again.origin, enrolled.token, world.home);
        await waitCompute(again.origin, headers, (j) => j.connection === "connected");
        const tokenFile = pathJoin(world.home, "machine.token");
        expect(existsSync(tokenFile)).toBe(true);
        const machine = readFileSync(tokenFile, "utf8").trim();
        expect(machine.startsWith("ob_run_")).toBe(true);

        join2 = await spawnJoin(again.origin, machine, world.home);
        await waitCompute(again.origin, headers, (j) => j.connection === "connected");
        const firstExit = await Promise.race([
          join1.proc.exited.then(() => true),
          Bun.sleep(8_000).then(() => false),
        ]);
        expect(firstExit).toBe(true);
        const acct = again.ctx.db.get<{ account_id: string }>(
          "SELECT account_id FROM org_meta WHERE id = 'current'",
        )!.account_id;
        expect(again.ctx.engine.remotes.get(acct)?.connected).toBe(true);
      } finally {
        try {
          join1?.proc.kill();
          join2?.proc.kill();
          await join1?.proc.exited;
          await join2?.proc.exited;
        } catch {
          /* ignore */
        }
        again.server.stop(true);
      }
    } catch (err) {
      try {
        world.server.stop(true);
      } catch {
        /* already stopped */
      }
      throw err;
    }
  }, 60_000);

  test("CLI enroll against live server posts loopback", async () => {
    const world = await setupOrg();
    try {
      const proc = spawn({
        cmd: [process.execPath, CLI, "runner", "enroll", "--port", String(world.server.port), "--home", world.home],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
      const stdout = await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(code).toBe(0);
      const json = JSON.parse(stdout.trim()) as { token: string };
      expect(json.token.startsWith("ob_enroll_")).toBe(true);
      const compute = (await fetch(`${world.origin}/v1/compute`, { headers: world.headers }).then((r) => r.json())) as {
        connection?: string;
      };
      expect(compute.connection).toBe("pending");
    } finally {
      world.server.stop(true);
    }
  });
});
