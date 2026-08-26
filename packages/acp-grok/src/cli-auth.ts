import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CliLoginStatus = {
  id: "grok" | "codex";
  label: string;
  cliPath: string | null;
  authFile: string | null;
  signedIn: boolean;
  email?: string;
  authMode?: string;
};

function which(bin: string): string | null {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    const p = join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

function grokStatus(home: string): CliLoginStatus {
  const authFile = join(home, ".grok", "auth.json");
  const status: CliLoginStatus = {
    id: "grok",
    label: "Grok Build",
    cliPath: which("grok"),
    authFile: existsSync(authFile) ? authFile : null,
    signedIn: false,
  };
  if (!status.authFile) return status;
  try {
    const raw = JSON.parse(readFileSync(status.authFile, "utf8")) as Record<string, unknown>;
    const entries = Object.values(raw);
    const first = entries[0];
    if (first && typeof first === "object") {
      const rec = first as Record<string, unknown>;
      status.signedIn = Boolean(rec.refresh_token || rec.key || rec.access_token);
      if (typeof rec.email === "string") status.email = rec.email;
      if (typeof rec.auth_mode === "string") status.authMode = rec.auth_mode;
    }
  } catch {
    /* unreadable */
  }
  return status;
}

function codexStatus(home: string): CliLoginStatus {
  const authFile = join(home, ".codex", "auth.json");
  const status: CliLoginStatus = {
    id: "codex",
    label: "Codex",
    cliPath: which("codex"),
    authFile: existsSync(authFile) ? authFile : null,
    signedIn: false,
  };
  if (!status.authFile) return status;
  try {
    const raw = JSON.parse(readFileSync(status.authFile, "utf8")) as Record<string, unknown>;
    status.signedIn = Boolean(raw.tokens || raw.token || raw.access_token || raw.OPENAI_API_KEY);
    const tokens = raw.tokens as Record<string, unknown> | undefined;
    const account = (raw.account ?? tokens?.account) as Record<string, unknown> | undefined;
    if (account && typeof account.email === "string") status.email = account.email;
    else if (typeof raw.email === "string") status.email = raw.email;
  } catch {
    /* unreadable */
  }
  return status;
}

export function detectCliLogins(home = process.env.HOME || homedir()): CliLoginStatus[] {
  return [grokStatus(home), codexStatus(home)];
}

export function grokCliSignedIn(home?: string): boolean {
  return detectCliLogins(home).some((s) => s.id === "grok" && s.signedIn);
}
