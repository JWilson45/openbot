import { homedir } from "node:os";
import { join } from "node:path";
import { grokHomeDir, grokHomeTmpDir } from "@openbot/acp-grok";

/** Env names the Grok/Chromium child may inherit. Not a denylist — SSH_AUTH_SOCK never matches. */
export const CHILD_ENV_PASSTHROUGH = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "OPENBOT_FAKE_RESUME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NIX_SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export type ChildEnvSnapshot = {
  HOME: string;
  GROK_HOME?: string;
  TMPDIR: string;
  hasSshAuthSock: boolean;
  hasXaiKey: boolean;
  hasMcpToken: boolean;
};

export function passthroughEnv(from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of CHILD_ENV_PASSTHROUGH) {
    const v = from[k];
    if (v) env[k] = v;
  }
  return env;
}

export function snapshotChildEnv(env: Record<string, string>): ChildEnvSnapshot {
  return {
    HOME: env.HOME ?? "",
    GROK_HOME: env.GROK_HOME,
    TMPDIR: env.TMPDIR ?? "",
    hasSshAuthSock: env.SSH_AUTH_SOCK != null && env.SSH_AUTH_SOCK !== "",
    hasXaiKey: Boolean(env.XAI_API_KEY),
    hasMcpToken: Boolean(env.OPENBOT_MCP_TOKEN),
  };
}

export function buildHarnessEnv(opts: {
  openbotHome: string;
  extras?: Record<string, string>;
  from?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const grokHome = grokHomeDir(opts.openbotHome);
  const env: Record<string, string> = {
    ...passthroughEnv(opts.from),
    HOME: grokHome,
    TMPDIR: grokHomeTmpDir(opts.openbotHome),
    TERM: "dumb",
    GROK_HOME: grokHome,
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_CURSOR_MCPS_ENABLED: "0",
    GROK_CLAUDE_MCPS_ENABLED: "0",
    GROK_SUBAGENTS: "0",
  };
  for (const [k, v] of Object.entries(opts.extras ?? {})) {
    if (v === "") delete env[k];
    else env[k] = v;
  }
  delete env.SSH_AUTH_SOCK;
  delete env.GPG_AGENT_INFO;
  delete env.OPENBOT_MCP_TOKEN;
  return env;
}

export function chromiumTmpDir(desk: string): string {
  return join(desk, ".openbot", "tmp");
}

/** Chromium keeps the operator HOME so macOS can find the login keychain. Profile still lives in user-data-dir. */
export function buildChromiumEnv(opts: {
  desk: string;
  from?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const from = opts.from ?? process.env;
  const env: Record<string, string> = {
    ...passthroughEnv(from),
    HOME: from.HOME || homedir(),
    TMPDIR: chromiumTmpDir(opts.desk),
    TERM: "dumb",
  };
  delete env.SSH_AUTH_SOCK;
  delete env.GPG_AGENT_INFO;
  return env;
}
