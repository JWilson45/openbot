import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { grokHomeDir, grokHomeTmpDir } from "@openbot/acp-grok";
import { buildChromiumEnv, buildHarnessEnv, snapshotChildEnv } from "@openbot/runner";
import { fakeAgentCommand, tempHome } from "./helpers.ts";
import { loginCookie, startTestServer } from "../apps/server/src/test-helpers.ts";

describe("harness spawn env", () => {
  test("allowlists PATH, sets HOME to grok-home, drops SSH_AUTH_SOCK and MCP token", () => {
    const home = tempHome();
    const env = buildHarnessEnv({
      openbotHome: home,
      extras: {
        XAI_API_KEY: "xai-secret",
        OPENBOT_MCP_URL: "http://127.0.0.1:9/mcp/v1",
        OPENBOT_MCP_TOKEN: "should-not-land",
        GROK_CONFIG: "{}",
      },
      from: {
        PATH: "/usr/bin",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        GPG_AGENT_INFO: "secret",
        OPENBOT_GITHUB_CLIENT_SECRET: "oauth",
        LANG: "en_US.UTF-8",
      },
    });
    expect(env.HOME).toBe(grokHomeDir(home));
    expect(env.GROK_HOME).toBe(grokHomeDir(home));
    expect(env.TMPDIR).toBe(grokHomeTmpDir(home));
    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GPG_AGENT_INFO).toBeUndefined();
    expect(env.OPENBOT_GITHUB_CLIENT_SECRET).toBeUndefined();
    expect(env.OPENBOT_MCP_TOKEN).toBeUndefined();
    expect(env.OPENBOT_MCP_URL).toBe("http://127.0.0.1:9/mcp/v1");
    expect(env.XAI_API_KEY).toBe("xai-secret");
    const snap = snapshotChildEnv(env);
    expect(snap.hasSshAuthSock).toBe(false);
    expect(snap.hasXaiKey).toBe(true);
    expect(snap.hasMcpToken).toBe(false);
  });

  test("chromium env keeps operator HOME and does not inherit SSH_AUTH_SOCK", () => {
    const desk = join(tempHome(), "desk");
    const env = buildChromiumEnv({
      desk,
      from: {
        HOME: "/Users/jason",
        PATH: "/usr/bin",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        OPENBOT_GITHUB_CLIENT_SECRET: "x",
      },
    });
    expect(env.HOME).toBe("/Users/jason");
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.OPENBOT_GITHUB_CLIENT_SECRET).toBeUndefined();
  });

  test("spawned fake agent HOME is grok-home and SSH_AUTH_SOCK is unset", async () => {
    const home = tempHome();
    process.env.OPENBOT_ACP_COMMAND = fakeAgentCommand();
    process.env.SSH_AUTH_SOCK = "/tmp/openbot-test-agent.sock";
    const { ctx, server, origin } = startTestServer({ home });
    const { cookie, session } = loginCookie({ ctx }, "alice");
    const headers = { cookie, "content-type": "application/json" };
    await fetch(`${origin}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada" }),
    });
    const thread = (await fetch(`${origin}/v1/threads`, { headers }).then((r) => r.json())) as {
      thread: { id: string };
    };
    const posted = await fetch(`${origin}/v1/threads/${thread.thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "[[env:HOME]] [[env:SSH_AUTH_SOCK]]" }),
    });
    expect(posted.status).toBe(202);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const turn = ctx.db.get<{ status: string }>("SELECT status FROM turns ORDER BY created_at DESC LIMIT 1");
      if (turn && (turn.status === "completed" || turn.status === "failed")) break;
      await Bun.sleep(50);
    }
    const runner = ctx.engine.runnerFor(session.accountId);
    expect(runner.lastChildEnv?.HOME).toBe(grokHomeDir(home));
    expect(runner.lastChildEnv?.hasSshAuthSock).toBe(false);
    expect(runner.lastChildEnv?.hasMcpToken).toBe(false);
    expect(runner.lastSandbox?.backend).toBe("none");
    const msgs = ctx.db.all<{ body: string }>(
      "SELECT body FROM messages WHERE origin = 'send_message' ORDER BY created_at",
      [],
    );
    expect(msgs.some((m) => m.body === `HOME=${grokHomeDir(home)}`)).toBe(true);
    expect(msgs.some((m) => m.body === "SSH_AUTH_SOCK=")).toBe(true);
    server.stop(true);
  });
});
