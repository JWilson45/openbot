import { copyFileSync, existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EnsureHarnessRequest } from "@openbot/compute-protocol";

export type GrokPermissionMode = EnsureHarnessRequest["permissionMode"];

/** Isolated Grok config: no user HTTP MCP servers. Auth is a copy of ~/.grok/auth.json. */
export function isolatedGrokConfig(mode: GrokPermissionMode = "auto"): string {
  const yolo = mode === "always-approve";
  const perm =
    mode === "always-approve"
      ? 'permission_mode = "always-approve"\n'
      : mode === "ask"
        ? 'permission_mode = "ask"\n'
        : "";
  return `# Managed by OpenBot. Does not replace ~/.grok/config.toml for the TUI.
[ui]
yolo = ${yolo}
${perm}[cli]
auto_update = false
`;
}

/** @deprecated Use isolatedGrokConfig(mode). Default is auto (not yolo). */
export const ISOLATED_GROK_CONFIG = isolatedGrokConfig("auto");

export function grokHomeDir(openbotHome: string): string {
  return join(openbotHome, "grok-home");
}

export function grokHomeTmpDir(openbotHome: string): string {
  return join(grokHomeDir(openbotHome), "tmp");
}

function replaceWithCopy(src: string, dst: string): void {
  try {
    lstatSync(dst);
    unlinkSync(dst);
  } catch {
    /* no dest */
  }
  if (!existsSync(src)) return;
  copyFileSync(src, dst);
}

export function prepareIsolatedGrokHome(
  openbotHome: string,
  userHome = process.env.HOME || homedir(),
  mode: GrokPermissionMode = "auto",
): string {
  const grokHome = grokHomeDir(openbotHome);
  mkdirSync(join(grokHome, "tmp"), { recursive: true });
  writeFileSync(join(grokHome, "config.toml"), isolatedGrokConfig(mode));
  replaceWithCopy(join(userHome, ".grok", "auth.json"), join(grokHome, "auth.json"));
  replaceWithCopy(join(userHome, ".grok", "models_cache.json"), join(grokHome, "models_cache.json"));
  return grokHome;
}
