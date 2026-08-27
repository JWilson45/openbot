#!/usr/bin/env bun
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { addAllowlist, loadAllowlist } from "@openbot/auth";
import { detectGrokCliVersion, grokCliPinStatus, PINNED_GROK_CLI, runMcpBridge } from "@openbot/acp-grok";
import pkg from "../../../package.json" with { type: "json" };
import launchdTemplate from "../../../contrib/launchd/ai.openbot.plist" with { type: "text" };
import systemdTemplate from "../../../contrib/systemd/openbot.service" with { type: "text" };
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
  setFederationEnabled,
  writeOrgJson,
} from "./org.ts";
import { findActiveGateway } from "./gateway.ts";
import {
  listProfiles,
  openbotStateRoot,
  registerProfile,
  resolveOpenbotHome,
  setCurrentProfile,
  useProfile,
  type ResolveOpts,
  type ResolveResult,
} from "./profiles.ts";

function userHome(): string {
  return process.env.HOME || homedir();
}

const VALUE_FLAGS = new Set([
  "--home",
  "--port",
  "--host",
  "--origin",
  "--slug",
  "--name",
  "--org",
  "--profile",
  "--url",
  "--pubkey",
  "--org-id",
  "--id",
]);

function firstPositional(reserved: string[] = []): string | undefined {
  const skip = new Set(reserved);
  for (let i = 3; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) i += 1;
      continue;
    }
    if (skip.has(a)) continue;
    return a;
  }
  return undefined;
}

function invocation(extra: Partial<ResolveOpts> = {}): ResolveResult {
  return resolveOpenbotHome({
    userHome: userHome(),
    homeFlag: arg("--home"),
    orgFlag: arg("--org") ?? arg("--profile") ?? extra.orgFlag,
    envHome: process.env.OPENBOT_HOME,
    envOrg: process.env.OPENBOT_ORG,
    createSlug: extra.createSlug,
    requireExisting: extra.requireExisting,
  });
}

function mustInvocation(extra: Partial<ResolveOpts> = {}): ResolveResult {
  try {
    const inv = invocation(extra);
    if (inv.source === "env-home") {
      console.error(
        `OPENBOT_HOME=${inv.home} pins this org and ignores 'openbot use'. Unset it to switch by slug (fish: set -e OPENBOT_HOME).`,
      );
    }
    return inv;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    throw err;
  }
}

function orgRoster(): {
  current: string | null;
  orgs: Array<{ slug: string; home: string; current: boolean }>;
} {
  const listed = listProfiles(openbotStateRoot(userHome()));
  return { current: listed.current, orgs: listed.profiles };
}

function rememberProfile(inv: ResolveResult, current: boolean): void {
  if (!inv.remember || !inv.slug) return;
  registerProfile(inv.stateRoot, inv.slug, inv.home);
  if (current) setCurrentProfile(inv.stateRoot, inv.slug);
}

function applyOrgSlug(inv: ResolveResult): void {
  if (inv.slug && !process.env.OPENBOT_ORG_SLUG) process.env.OPENBOT_ORG_SLUG = inv.slug;
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
  return pkg.version;
}

function isStandaloneBinary(): boolean {
  const base = basename(process.execPath).toLowerCase().replace(/\.exe$/, "");
  return base !== "bun" && !base.startsWith("bun-");
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

Orgs (one sqlite / desk / key per slug):
  openbot org init acme --name "Acme"   # create + make current
  openbot demo                          # run the current org (loopback user "demo")
  openbot orgs                          # list
  openbot use beta                      # switch current org
  openbot use acme --home ~/.openbot-p3 # import an existing data dir
  unset OPENBOT_HOME                    # required if you exported it; it pins a path

Usage:
  openbot demo [slug] [--port 8787] [--org <slug>] [--home DIR] [--host 127.0.0.1] [--fake]
  openbot server [slug] [--port 8787] [--org <slug>] [--home DIR] [--host 127.0.0.1] [--origin URL]
  openbot install [--user] [--org <slug>] [--home DIR] [--port 8787] [--start]
  openbot orgs | profiles
  openbot use [slug] [--home DIR]
  openbot org [slug]
  openbot org init <slug> [--name "Acme"] [--home DIR]
  openbot gateway on | off [slug]
  openbot peers [--org <slug>]
  openbot peers add --slug beta --url https://beta.example.com --pubkey <b64> --org-id <uuid>
  openbot peers remove --id <orgId>
  openbot version | -v | --version
  openbot allowlist add <github-login>
  openbot allowlist

  demo      same desk as server, with loopback sign-in as "demo". --fake = scripted ACP.
  server    bind the desk (default 127.0.0.1). GitHub OAuth + allowlist. --origin overrides OPENBOT_PUBLIC_ORIGIN.
  install   write a launchd LaunchAgent or systemd --user unit. Never requires root.
  orgs      list orgs on this machine (slug → home). Current is used when you omit --org / --home.
  use       switch the current org. No slug lists. --home DIR imports that data dir.
  org       print this org's identity JSON including pubkey. Works with zero users.
  org init  create/name an org, register the slug, make it current (org_id is never rotated).
  gateway   write org_meta.federation_enabled. Env OPENBOT_FEDERATION=0 still wins. Does not delete Gateway.
  peers     list, add, or remove federation peers.
  version   print {"openbot","grokPin","grok"} JSON.

Named orgs live in ~/.openbot/orgs/<slug>/ (registry: ~/.openbot/profiles.json).
--home / OPENBOT_HOME pin a path (units snapshot this) and skip the current org.
A running demo/server stays on the org it started with until you restart it.
Grok login stays in ~/.grok (not the org home).
Install a binary: curl https://github.com/JWilson45/openbot/releases/latest/download/install.sh | bash
  or: brew tap JWilson45/openbot https://github.com/JWilson45/openbot && brew install openbot

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

function serverArgv(home: string, port: string): string[] {
  if (isStandaloneBinary()) {
    return [process.execPath, "server", "--home", home, "--port", port, "--host", "127.0.0.1"];
  }
  return [resolveBun(), cliPath(), "server", "--home", home, "--port", port, "--host", "127.0.0.1"];
}

function quoteUnitArg(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

function launchdArgsXml(args: string[]): string {
  return args.map((a) => `\t\t<string>${xmlEscape(a)}</string>`).join("\n");
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unitVars(home: string, port: string): Record<string, string> {
  const args = serverArgv(home, port);
  return {
    __HOME__: home,
    __PORT__: port,
    __WORKDIR__: isStandaloneBinary() ? home : repoRoot(),
    __EXECSTART__: args.map(quoteUnitArg).join(" "),
    __PROGRAM_ARGUMENTS__: launchdArgsXml(args),
    __PATH__: process.env.PATH ?? "/usr/bin:/bin",
    __USER_HOME__: userHome(),
  };
}

function renderTemplate(text: string, vars: Record<string, string>, xml: boolean): string {
  const keys = Object.keys(vars).sort((a, b) => b.length - a.length);
  let out = text;
  for (const k of keys) {
    const value = vars[k]!;
    out = out.replaceAll(k, xml && k !== "__PROGRAM_ARGUMENTS__" ? xmlEscape(value) : value);
  }
  return out;
}

function orgCommand(): void {
  const sub = process.argv[3];
  const init = sub === "init";
  const positionalSlug = init
    ? firstPositional(["init"])
    : sub && sub !== "init" && !sub.startsWith("-")
      ? sub
      : firstPositional(["init"]);
  const slug = init ? (arg("--slug") ?? positionalSlug) : (arg("--org") ?? arg("--profile") ?? positionalSlug);
  if (init && arg("--slug") && positionalSlug && arg("--slug") !== positionalSlug) {
    console.error("org init: positional slug and --slug must match");
    process.exit(1);
  }
  const inv = mustInvocation({
    orgFlag: init ? undefined : slug,
    createSlug: init ? slug : undefined,
    requireExisting: !init && Boolean(slug),
  });
  const home = inv.home;
  applyOrgSlug(inv);
  mkdirSync(home, { recursive: true });
  const db = OpenbotDb.open(join(home, "openbot.sqlite"));
  try {
    ensureOrgMeta(db, {
      env: process.env,
      file: join(home, "org.json"),
      publicOrigin: process.env.OPENBOT_PUBLIC_ORIGIN,
      advertisedOrigin: `http://127.0.0.1:${arg("--port", process.env.PORT ?? "8787")}`,
      slug: init ? slug : undefined,
      name: init ? arg("--name") : undefined,
    });
    const master = loadOrCreateMasterKey(home, process.env.OPENBOT_MASTER_KEY);
    ensureOrgKeypair(home, master, db);
    const row = currentOrgMeta(db);
    if (!row) throw new Error("org_meta write failed");
    if (init) writeOrgJson(join(home, "org.json"), row);
    rememberProfile(init ? { ...inv, slug: row.slug, remember: inv.source !== "home-flag" && inv.source !== "env-home" } : inv, init);
    const gw = row.account_id ? findActiveGateway(db, row.account_id) : undefined;
    const snapshot = {
      ...orgCliSnapshot(row, gw ? { id: gw.id, name: gw.name } : null),
      home,
      profile: inv.slug ?? row.slug,
    };
    console.log(JSON.stringify(snapshot));
    if (init && (inv.source === "home-flag" || inv.source === "env-home")) {
      console.error(`not registered as a profile (because --home / OPENBOT_HOME). to switch later: openbot use ${row.slug} --home ${home}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    db.close();
  }
}

function gatewayCommand(): void {
  const sub = process.argv[3];
  if (sub !== "on" && sub !== "off") {
    console.error("usage: openbot gateway on|off [slug] [--org <slug>] [--home <dir>]");
    process.exit(1);
  }
  const inv = mustInvocation({
    orgFlag: firstPositional(["on", "off"]),
    requireExisting: Boolean(firstPositional(["on", "off"]) || arg("--org") || arg("--profile")),
  });
  const home = inv.home;
  applyOrgSlug(inv);
  mkdirSync(home, { recursive: true });
  const db = OpenbotDb.open(join(home, "openbot.sqlite"));
  try {
    ensureOrgMeta(db, {
      env: process.env,
      file: join(home, "org.json"),
      publicOrigin: process.env.OPENBOT_PUBLIC_ORIGIN,
      advertisedOrigin: `http://127.0.0.1:${arg("--port", process.env.PORT ?? "8787")}`,
    });
    const row = setFederationEnabled(db, sub === "on");
    const gw = row.account_id ? findActiveGateway(db, row.account_id) : undefined;
    console.log(
      JSON.stringify({
        ...orgCliSnapshot(row, gw ? { id: gw.id, name: gw.name } : null),
        home,
        profile: inv.slug ?? row.slug,
      }),
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    db.close();
  }
}

function peersCommand(): void {
  const sub = process.argv[3];
  if (sub && sub !== "add" && sub !== "remove" && !sub.startsWith("-")) {
    console.error("usage: openbot peers [add --slug <slug> --url <url> --pubkey <b64>] [remove --id <orgId>] [--org <slug>] [--home <dir>]");
    process.exit(1);
  }
  const inv = mustInvocation();
  const home = inv.home;
  applyOrgSlug(inv);
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
  const inv = mustInvocation({ orgFlag: firstPositional([]) });
  const home = resolve(inv.home);
  applyOrgSlug(inv);
  rememberProfile(inv, inv.remember);
  const port = arg("--port", process.env.PORT ?? "8787")!;
  const start = flag("--start");
  const vars = unitVars(home, port);
  const darwinRendered = renderTemplate(launchdTemplate, vars, true);
  const linuxRendered = renderTemplate(systemdTemplate, vars, false);

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
  const inv = mustInvocation({ orgFlag: firstPositional([]) });
  const home = inv.home;
  applyOrgSlug(inv);
  rememberProfile(inv, inv.remember);
  const port = Number(arg("--port", process.env.PORT ?? "8787"));
  const host = resolveHost();
  const fake = process.argv.includes("--fake");
  if (fake && isStandaloneBinary()) {
    console.error("compiled openbot does not include --fake; clone the repo for scripted demos");
    process.exit(1);
  }
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
  created.ctx.engine.tickCalendar();
  created.ctx.engine.kick();
  const url = `${reachable}/auth/local?login=demo`;
  const expose = bindNote(host);
  console.log(
    JSON.stringify({
      msg: "openbot demo",
      origin: reachable,
      host,
      home,
      profile: inv.slug,
      org: inv.slug,
      signIn: url,
      fake,
      ...pinFields(),
      note: "Open signIn. Create a bot. Grok CLI login is enough; API key is optional. Ask the bot something. Closing a browser tab does not stop the teammate.",
      ...(expose ? { bindNote: expose } : {}),
    }),
  );
} else if (cmd === "server") {
  const inv = mustInvocation({ orgFlag: firstPositional([]) });
  const home = inv.home;
  applyOrgSlug(inv);
  rememberProfile(inv, inv.remember);
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
  created.ctx.engine.tickCalendar();
  created.ctx.engine.kick();
  const expose = bindNote(host);
  console.log(
    JSON.stringify({
      msg: "openbot server listening",
      origin: `http://${advertiseHost(host)}:${server.port}`,
      host,
      home,
      profile: inv.slug,
      org: inv.slug,
      desk: join(home, "desk"),
      ...pinFields(),
      note: "Closing a browser tab does not stop the teammate. Stopping this process does.",
      ...(expose ? { bindNote: expose } : {}),
    }),
  );
} else if (cmd === "allowlist") {
  const sub = process.argv[3];
  const inv = mustInvocation();
  const home = inv.home;
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
} else if (cmd === "gateway") {
  gatewayCommand();
} else if (cmd === "peers") {
  peersCommand();
} else if (cmd === "orgs" || cmd === "profiles" || cmd === "profile") {
  try {
    const roster = orgRoster();
    console.log(
      JSON.stringify({
        current: roster.current,
        orgs: roster.orgs,
        profiles: roster.orgs,
        note: roster.current
          ? `current org is ${roster.current}. switch: openbot use <slug>`
          : "no current org. create: openbot org init <slug>",
      }),
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
} else if (cmd === "use" || cmd === "switch") {
  const slug = process.argv[3] && !process.argv[3]!.startsWith("-") ? process.argv[3] : undefined;
  if (!slug) {
    const roster = orgRoster();
    console.log(
      JSON.stringify({
        current: roster.current,
        orgs: roster.orgs,
        profiles: roster.orgs,
        note: "switch: openbot use <slug>   import: openbot use <slug> --home DIR",
      }),
    );
  } else {
    try {
      const stateRoot = openbotStateRoot(userHome());
      const reg = useProfile(stateRoot, slug, arg("--home"));
      const home = reg.profiles[reg.current ?? slug]!.home;
      const roster = orgRoster();
      const envHome = process.env.OPENBOT_HOME?.trim();
      if (envHome) {
        console.error(
          `current org is ${reg.current}, but OPENBOT_HOME=${envHome} will still win on the next command. Unset it (fish: set -e OPENBOT_HOME).`,
        );
      }
      console.log(
        JSON.stringify({
          current: reg.current,
          org: reg.current,
          home,
          orgs: roster.orgs,
          profiles: roster.orgs,
          note: envHome
            ? `unset OPENBOT_HOME to actually run ${reg.current}. Restart demo/server after switching.`
            : `current org is ${reg.current}. Restart demo/server if one is already running.`,
        }),
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
} else if (cmd === "mcp-bridge") {
  const url = process.argv[3];
  const token = process.argv[4];
  if (!url || !token) {
    console.error("usage: openbot mcp-bridge <url> <token>");
    process.exit(1);
  }
  await runMcpBridge(url, token);
} else if (cmd === "install") {
  install();
} else {
  printHelp();
}
