#!/usr/bin/env bun
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { addAllowlist, loadAllowlist } from "@openbot/auth";
import { detectGrokCliVersion, grokCliPinStatus, PINNED_GROK_CLI } from "@openbot/acp-grok";
import { OpenbotDb } from "@openbot/db";
import { loadOrCreateMasterKey } from "@openbot/vault";
import { createApp } from "./app.ts";
import {
  currentOrgMeta,
  deleteOrgPeer,
  ensureOrgKeypair,
  ensureOrgMeta,
  insertOrgPeer,
  listOrgPeers,
  orgCliSnapshot,
  OrgPeerError,
  orgPeerPublic,
  writeOrgJson,
} from "./org.ts";

function defaultHome(): string {
  return process.env.OPENBOT_HOME || join(homedir(), ".openbot");
}

function userHome(): string {
  return process.env.HOME || homedir();
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function openbotVersion(): string {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

function printVersion(): void {
  console.log(
    JSON.stringify({
      openbot: openbotVersion(),
      grokPin: PINNED_GROK_CLI,
      grok: detectGrokCliVersion(),
    }),
  );
}

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0"]);

function resolveHost(): string {
  const host = (arg("--host", process.env.OPENBOT_HOST ?? "127.0.0.1") ?? "127.0.0.1").trim();
  if (!ALLOWED_HOSTS.has(host)) {
    console.error(`invalid --host ${host} (allowed: 127.0.0.1, localhost, 0.0.0.0)`);
    process.exit(1);
  }
  return host;
}

function advertiseHost(host: string): string {
  return host === "0.0.0.0" ? "127.0.0.1" : host;
}

function bindNote(host: string): string | undefined {
  if (host !== "0.0.0.0") return undefined;
  return "Loopback (127.0.0.1) is the default. Exposing 0.0.0.0 without TLS is operator risk. Put Caddy or nginx in front. OpenBot does not implement TLS.";
}

function pinFields() {
  const pin = grokCliPinStatus();
  return {
    grokPin: pin.pinned,
    grokDetected: pin.detected,
    grokPinOk: pin.ok,
    ...(pin.warning ? { grokPinWarning: pin.warning } : {}),
  };
}

function printHelp(): void {
  console.log(`openbot — always-on teammate on this machine

Usage:
  openbot demo [--port 8787] [--home ~/.openbot] [--host 127.0.0.1] [--fake]
  openbot server [--port 8787] [--home ~/.openbot] [--host 127.0.0.1] [--origin http://127.0.0.1:8787]
  openbot install [--user] [--home ~/.openbot] [--port 8787] [--start]
  openbot org [--home ~/.openbot]
  openbot org init [--home ~/.openbot] [--slug acme] [--name "Acme"]
  openbot peers [--home ~/.openbot]
  openbot peers add --slug beta --url https://beta.example.com --pubkey <b64> --org-id <uuid>
  openbot peers remove --id <orgId>
  openbot version | -v | --version
  openbot allowlist add <github-login>
  openbot allowlist

  demo     local sign-in as "demo" (loopback). --fake uses the scripted ACP agent.
  server   bind the desk (default 127.0.0.1). --origin overrides OPENBOT_PUBLIC_ORIGIN.
  install  write a launchd LaunchAgent or systemd --user unit. Never requires root.
  org      print instance identity JSON including pubkey. Works with zero users.
  org init write org.json and upsert org_meta (org_id is never rotated).
  peers    list, add, or remove federation peers.
  version  print {"openbot","grokPin","grok"} JSON.

Closing a browser tab does not stop the teammate.
Stopping openbot server does.
For laptop-closed work, run the server on a machine that stays up.
The desk directory is not a security boundary.
Bind 127.0.0.1 by default. Binding 0.0.0.0 without TLS is operator risk — put Caddy or nginx in front.
See docs/host-service.md.
`);
}

function resolveBun(): string {
  const exec = process.execPath;
  const base = basename(exec).toLowerCase().replace(/\.exe$/, "");
  if (base === "bun" || base.startsWith("bun-")) return exec;
  const found = Bun.which("bun");
  if (found) return found;
  console.error("bun not found on PATH");
  process.exit(1);
}

function repoRoot(): string {
  return resolve(import.meta.dir, "../../..");
}

function cliPath(): string {
  return resolve(import.meta.dir, "cli.ts");
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unitVars(home: string, port: string): Record<string, string> {
  return {
    __BUN__: resolveBun(),
    __CLI__: cliPath(),
    __HOME__: home,
    __PORT__: port,
    __ROOT__: repoRoot(),
    __PATH__: process.env.PATH ?? "/usr/bin:/bin",
    __USER_HOME__: userHome(),
  };
}

function renderTemplate(path: string, vars: Record<string, string>, xml: boolean): string {
  let text = readFileSync(path, "utf8");
  const keys = Object.keys(vars).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    text = text.replaceAll(k, xml ? xmlEscape(vars[k]!) : vars[k]!);
  }
  return text;
}

function orgCommand(): void {
  const home = arg("--home", defaultHome())!;
  const sub = process.argv[3];
  if (sub && sub !== "init" && !sub.startsWith("-")) {
    console.error("usage: openbot org [init [--slug <slug>] [--name <name>]] [--home <dir>]");
    process.exit(1);
  }
  const init = sub === "init";
  mkdirSync(home, { recursive: true });
  const db = OpenbotDb.open(join(home, "openbot.sqlite"));
  try {
    ensureOrgMeta(db, {
      env: process.env,
      file: join(home, "org.json"),
      publicOrigin: process.env.OPENBOT_PUBLIC_ORIGIN,
      advertisedOrigin: `http://127.0.0.1:${arg("--port", process.env.PORT ?? "8787")}`,
      slug: init ? arg("--slug") : undefined,
      name: init ? arg("--name") : undefined,
    });
    const master = loadOrCreateMasterKey(home, process.env.OPENBOT_MASTER_KEY);
    ensureOrgKeypair(home, master, db);
    const row = currentOrgMeta(db);
    if (!row) throw new Error("org_meta write failed");
    if (init) writeOrgJson(join(home, "org.json"), row);
    console.log(JSON.stringify(orgCliSnapshot(row)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    db.close();
  }
}

function peersCommand(): void {
  const home = arg("--home", defaultHome())!;
  const sub = process.argv[3];
  if (sub && sub !== "add" && sub !== "remove" && !sub.startsWith("-")) {
    console.error("usage: openbot peers [add --slug <slug> --url <url> --pubkey <b64>] [remove --id <orgId>] [--home <dir>]");
    process.exit(1);
  }
  mkdirSync(home, { recursive: true });
  const db = OpenbotDb.open(join(home, "openbot.sqlite"));
  try {
    ensureOrgMeta(db, {
      env: process.env,
      file: join(home, "org.json"),
      publicOrigin: process.env.OPENBOT_PUBLIC_ORIGIN,
      advertisedOrigin: `http://127.0.0.1:${arg("--port", process.env.PORT ?? "8787")}`,
    });
    if (sub === "add") {
      const slug = arg("--slug");
      const url = arg("--url");
      const pubkey = arg("--pubkey");
      const orgId = arg("--org-id") ?? arg("--id");
      if (!slug || !url || !pubkey || !orgId) {
        console.error(
          "usage: openbot peers add --slug <slug> --url <url> --pubkey <b64> --org-id <uuid> [--name <name>] [--home <dir>]",
        );
        process.exit(1);
      }
      const row = insertOrgPeer(db, { slug, orgId, baseUrl: url, pubkey, name: arg("--name") ?? "" });
      console.log(JSON.stringify(orgPeerPublic(row)));
    } else if (sub === "remove") {
      const peerId = arg("--id");
      if (!peerId) {
        console.error("usage: openbot peers remove --id <orgId> [--home <dir>]");
        process.exit(1);
      }
      if (!deleteOrgPeer(db, peerId)) {
        console.error("not_found");
        process.exit(1);
      }
      console.log(JSON.stringify({ ok: true }));
    } else {
      console.log(JSON.stringify({ peers: listOrgPeers(db).map(orgPeerPublic) }));
    }
  } catch (err) {
    if (err instanceof OrgPeerError) {
      console.error(err.code);
      process.exit(1);
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    db.close();
  }
}

function install(): void {
  const home = resolve(arg("--home", defaultHome())!);
  const port = arg("--port", process.env.PORT ?? "8787")!;
  const start = flag("--start");
  const vars = unitVars(home, port);
  const contrib = join(repoRoot(), "contrib");
  const darwinRendered = renderTemplate(join(contrib, "launchd/ai.openbot.plist"), vars, true);
  const linuxRendered = renderTemplate(join(contrib, "systemd/openbot.service"), vars, false);

  if (process.platform === "darwin") {
    const dest = join(userHome(), "Library/LaunchAgents/ai.openbot.plist");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, darwinRendered);
    console.log(`Wrote ${dest}`);
    const uid = process.getuid?.() ?? 0;
    const domain = `gui/${uid}`;
    console.log(`To load:\n  launchctl load ${dest}\n  launchctl bootstrap ${domain} ${dest}`);
    console.log(`To unload:\n  launchctl bootout ${domain}/ai.openbot\n  launchctl unload ${dest}`);
    if (start) {
      Bun.spawnSync(["launchctl", "bootout", `${domain}/ai.openbot`], { stdout: "pipe", stderr: "pipe" });
      const r = Bun.spawnSync(["launchctl", "bootstrap", domain, dest], { stdout: "inherit", stderr: "inherit" });
      if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
    } else {
      console.log("Not loaded. Pass --start to launchctl bootstrap.");
    }
    return;
  }

  if (process.platform === "linux") {
    const dest = join(userHome(), ".config/systemd/user/openbot.service");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, linuxRendered);
    console.log(`Wrote ${dest}`);
    console.log("To enable:\n  systemctl --user daemon-reload && systemctl --user enable --now openbot");
    console.log("To stop:\n  systemctl --user disable --now openbot");
    if (start) {
      const reload = Bun.spawnSync(["systemctl", "--user", "daemon-reload"], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if (reload.exitCode !== 0) process.exit(reload.exitCode ?? 1);
      const en = Bun.spawnSync(["systemctl", "--user", "enable", "--now", "openbot"], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if (en.exitCode !== 0) process.exit(en.exitCode ?? 1);
    } else {
      console.log("Not started. Pass --start to enable --now.");
    }
    return;
  }

  console.log(`Unsupported platform ${process.platform}. User-level units (never root):\n`);
  console.log(`# launchd dest: ${join(userHome(), "Library/LaunchAgents/ai.openbot.plist")}\n${darwinRendered}`);
  console.log(`# systemd user dest: ${join(userHome(), ".config/systemd/user/openbot.service")}\n${linuxRendered}`);
}

const cmd = process.argv[2] ?? "help";

if (cmd === "version" || cmd === "-v" || cmd === "--version") {
  printVersion();
} else if (cmd === "demo") {
  const home = arg("--home", defaultHome())!;
  const port = Number(arg("--port", process.env.PORT ?? "8787"));
  const host = resolveHost();
  const fake = process.argv.includes("--fake");
  addAllowlist(home, "demo");
  process.env.OPENBOT_DEV_LOGIN = "1";
  process.env.OPENBOT_GITHUB_ALLOWLIST = [process.env.OPENBOT_GITHUB_ALLOWLIST, "demo"].filter(Boolean).join(",");
  if (fake) {
    const agent = join(import.meta.dir, "../../../tests/fixtures/acp/fake-agent.ts");
    process.env.OPENBOT_ACP_COMMAND = `${process.execPath} ${agent}`;
  }
  const created = createApp({ home, port, devLogin: true });
  const server = Bun.serve({
    port,
    hostname: host,
    fetch: created.app.fetch,
    websocket: (created as { websocket: unknown }).websocket as never,
  });
  created.ctx.port = server.port;
  const reachable = `http://${advertiseHost(host)}:${server.port}`;
  created.ctx.publicOrigin = reachable;
  created.ctx.engine.reapOrphans();
  created.ctx.engine.kick();
  const url = `${reachable}/auth/local?login=demo`;
  const expose = bindNote(host);
  console.log(
    JSON.stringify({
      msg: "openbot demo",
      origin: reachable,
      host,
      signIn: url,
      fake,
      ...pinFields(),
      note: "Open signIn. Create a bot. Grok CLI login is enough; API key is optional. Ask the bot something. Closing a browser tab does not stop the teammate.",
      ...(expose ? { bindNote: expose } : {}),
    }),
  );
} else if (cmd === "server") {
  const home = arg("--home", defaultHome())!;
  const port = Number(arg("--port", process.env.PORT ?? "8787"));
  const host = resolveHost();
  const originFlag = process.argv.includes("--origin") ? arg("--origin")?.trim() : undefined;
  const created = createApp({
    home,
    port,
    ...(originFlag ? { publicOrigin: originFlag } : {}),
  });
  const server = Bun.serve({
    port,
    hostname: host,
    fetch: created.app.fetch,
    websocket: (created as { websocket: unknown }).websocket as never,
  });
  created.ctx.port = server.port;
  created.ctx.engine.reapOrphans();
  created.ctx.engine.kick();
  const expose = bindNote(host);
  console.log(
    JSON.stringify({
      msg: "openbot server listening",
      origin: `http://${advertiseHost(host)}:${server.port}`,
      host,
      home,
      desk: join(home, "desk"),
      ...pinFields(),
      note: "Closing a browser tab does not stop the teammate. Stopping this process does.",
      ...(expose ? { bindNote: expose } : {}),
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
} else if (cmd === "org") {
  orgCommand();
} else if (cmd === "peers") {
  peersCommand();
} else if (cmd === "install") {
  install();
} else {
  printHelp();
}
