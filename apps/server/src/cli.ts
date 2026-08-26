#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { addAllowlist, loadAllowlist } from "@openbot/auth";
import { createApp } from "./app.ts";

function defaultHome(): string {
  return process.env.OPENBOT_HOME || join(homedir(), ".openbot");
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const cmd = process.argv[2] ?? "help";

if (cmd === "demo") {
  const home = arg("--home", defaultHome())!;
  const port = Number(arg("--port", process.env.PORT ?? "8787"));
  const fake = process.argv.includes("--fake");
  addAllowlist(home, "demo");
  process.env.OPENBOT_DEV_LOGIN = "1";
  process.env.OPENBOT_GITHUB_ALLOWLIST = [process.env.OPENBOT_GITHUB_ALLOWLIST, "demo"].filter(Boolean).join(",");
  if (fake) {
    const agent = join(import.meta.dir, "../../../tests/fixtures/acp/fake-agent.ts");
    process.env.OPENBOT_ACP_COMMAND = `${process.execPath} ${agent}`;
  }
  const origin = `http://127.0.0.1:${port}`;
  const created = createApp({ home, port, publicOrigin: origin, devLogin: true });
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: created.app.fetch,
    websocket: (created as { websocket: unknown }).websocket as never,
  });
  created.ctx.port = server.port;
  created.ctx.engine.reapOrphans();
  created.ctx.engine.kick();
  const url = `http://127.0.0.1:${server.port}/auth/local?login=demo`;
  console.log(
    JSON.stringify({
      msg: "openbot demo",
      origin: `http://127.0.0.1:${server.port}`,
      signIn: url,
      fake,
      note: "Open signIn. Create a bot. Grok CLI login is enough; API key is optional. Ask the bot something.",
    }),
  );
} else if (cmd === "server") {
  const home = arg("--home", defaultHome())!;
  const port = Number(arg("--port", process.env.PORT ?? "8787"));
  const origin = arg("--origin", process.env.OPENBOT_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`);
  const created = createApp({ home, port, publicOrigin: origin });
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: created.app.fetch,
    websocket: (created as { websocket: unknown }).websocket as never,
  });
  created.ctx.port = server.port;
  created.ctx.engine.reapOrphans();
  created.ctx.engine.kick();
  console.log(
    JSON.stringify({
      msg: "openbot server listening",
      origin: `http://127.0.0.1:${server.port}`,
      home,
      desk: join(home, "desk"),
      note: "Closing a browser tab does not stop the teammate. Stopping this process does.",
    }),
  );
} else if (cmd === "allowlist") {
  const sub = process.argv[3];
  const home = arg("--home", defaultHome())!;
  if (sub === "add") {
    const login = process.argv[4];
    if (!login) {
      console.error("usage: openbot allowlist add <github-login>");
      process.exit(1);
    }
    addAllowlist(home, login);
    console.log(`allowlisted ${login.toLowerCase()}`);
  } else {
    const set = loadAllowlist(home, process.env.OPENBOT_GITHUB_ALLOWLIST);
    console.log([...set].join("\n") || "(empty)");
  }
} else {
  console.log(`openbot — always-on teammate on this machine

Usage:
  openbot demo [--port 8787] [--home ~/.openbot] [--fake]
  openbot server [--port 8787] [--home ~/.openbot]
  openbot allowlist add <github-login>
  openbot allowlist

  demo   local sign-in as "demo" (loopback). --fake uses the scripted ACP agent.

Closing a browser tab does not stop the teammate.
Stopping openbot server does.
For laptop-closed work, run the server on a machine that stays up.
The desk directory is not a security boundary.
`);
}
