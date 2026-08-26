import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Isolated Grok config: no user HTTP MCP servers, always-approve. Auth is linked from ~/.grok. */
export const ISOLATED_GROK_CONFIG = `# Managed by OpenBot. Does not replace ~/.grok/config.toml for the TUI.
[ui]
yolo = true
permission_mode = "always-approve"

[cli]
auto_update = false
`;

export function prepareIsolatedGrokHome(
  openbotHome: string,
  userHome = process.env.HOME || homedir(),
): string {
  const grokHome = join(openbotHome, "grok-home");
  mkdirSync(grokHome, { recursive: true });
  writeFileSync(join(grokHome, "config.toml"), ISOLATED_GROK_CONFIG);
  const src = join(userHome, ".grok", "auth.json");
  const dst = join(grokHome, "auth.json");
  if (existsSync(src)) {
    try {
      if (existsSync(dst)) unlinkSync(dst);
    } catch {
      /* replace */
    }
    try {
      symlinkSync(src, dst);
    } catch {
      writeFileSync(dst, readFileSync(src));
    }
  }
  const cacheSrc = join(userHome, ".grok", "models_cache.json");
  const cacheDst = join(grokHome, "models_cache.json");
  if (existsSync(cacheSrc)) {
    try {
      writeFileSync(cacheDst, readFileSync(cacheSrc));
    } catch {
      /* optional */
    }
  }
  return grokHome;
}
