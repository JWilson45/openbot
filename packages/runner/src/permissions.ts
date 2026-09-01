import { resolve, sep } from "node:path";
import type { LiveWorkEvent, PermissionDecision } from "@openbot/compute-protocol";
import { isInsideDir } from "./workspace.ts";

const PATH_KEYS = new Set([
  "path",
  "file",
  "filepath",
  "file_path",
  "filePath",
  "target",
  "filename",
  "uri",
]);

const VAULT_BASENAMES = new Set([
  "master.key",
  "org.ed25519",
  "allowlist",
  "openbot.sqlite",
  "openbot.sqlite-wal",
  "openbot.sqlite-shm",
]);

const SYSTEM_PREFIXES = [
  "/usr",
  "/bin",
  "/sbin",
  "/opt",
  "/lib",
  "/lib64",
  "/nix",
  "/System",
  "/Library/Frameworks",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/ssl/certs",
  "/etc/pki",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/dev",
  "/proc",
  "/Applications",
];

const DENY_EXACT = new Set([
  "/etc/shadow",
  "/etc/sudoers",
  "/etc/master.passwd",
  "/var/run/docker.sock",
  "/run/docker.sock",
]);

export function denyGatewayExec(ev: LiveWorkEvent): Promise<PermissionDecision> {
  void ev;
  return Promise.resolve({ allow: false });
}

function looksLikePath(s: string): boolean {
  if (!s || s.length > 1024) return false;
  if (s.startsWith("~") || s.startsWith("/") || s.startsWith("./") || s.startsWith("../")) return true;
  if (s.includes("/") && !s.includes("://") && !s.includes(" ")) return true;
  return false;
}

function collectFromObject(value: unknown, into: string[], depth: number): void {
  if (depth > 8 || value == null) return;
  if (typeof value === "string") {
    if (looksLikePath(value)) into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFromObject(item, into, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (PATH_KEYS.has(k) && typeof v === "string") into.push(v);
    else collectFromObject(v, into, depth + 1);
  }
}

const COMMAND_PATH = /(?:^|[\s;|&])((?:~|\/|\.\.\/|\.\/)[^\s;|&]+)/g;

function pathsFromCommand(cmd: string): string[] {
  const out: string[] = [];
  COMMAND_PATH.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMAND_PATH.exec(cmd))) out.push(m[1]!);
  return out;
}

export function extractPermissionPaths(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  const toolCall = payload.toolCall;
  if (toolCall && typeof toolCall === "object") {
    collectFromObject(toolCall, out, 0);
    const rec = toolCall as { title?: string; command?: string; kind?: string };
    if (typeof rec.command === "string") out.push(...pathsFromCommand(rec.command));
    if (typeof rec.title === "string") out.push(...pathsFromCommand(rec.title));
  } else {
    collectFromObject(payload, out, 0);
  }
  return [...new Set(out)];
}

export function resolvePermissionPath(raw: string, cwd: string, grokHome: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("file://")) {
    try {
      return resolve(new URL(trimmed).pathname);
    } catch {
      /* fall through */
    }
  }
  if (trimmed === "~") return grokHome;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~" + sep)) {
    return resolve(grokHome, trimmed.slice(2));
  }
  return resolve(cwd, trimmed);
}

export function pathIsDenied(
  resolved: string,
  roots: { desk: string; grokHome: string; openbotHome: string; operatorHome?: string },
): boolean {
  const path = resolve(resolved);
  if (DENY_EXACT.has(path)) return true;
  if (path.endsWith("docker.sock")) return true;
  const base = path.split(sep).pop() ?? "";
  if (VAULT_BASENAMES.has(base) && isInsideDir(roots.openbotHome, path) && !isInsideDir(roots.desk, path)) {
    return true;
  }
  if (isInsideDir(roots.desk, path) || isInsideDir(roots.grokHome, path)) return false;
  if (isInsideDir(roots.openbotHome, path)) return true;
  if (roots.operatorHome && isInsideDir(roots.operatorHome, path)) return true;
  for (const prefix of SYSTEM_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + sep)) {
      if (path === "/etc/shadow" || path.startsWith("/etc/shadow") || path.startsWith("/etc/sudoers")) return true;
      return false;
    }
  }
  return true;
}

export function deskPathGuard(
  ev: LiveWorkEvent,
  roots: { desk: string; grokHome: string; openbotHome: string; cwd: string; operatorHome?: string },
): Promise<PermissionDecision> {
  const raw = extractPermissionPaths(ev.payload);
  if (raw.length === 0) return Promise.resolve({ defer: true });
  for (const p of raw) {
    const resolved = resolvePermissionPath(p, roots.cwd, roots.grokHome);
    if (pathIsDenied(resolved, roots)) return Promise.resolve({ allow: false });
  }
  return Promise.resolve({ defer: true });
}
