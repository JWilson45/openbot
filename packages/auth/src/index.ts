import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { id, now, sha256Hex, type OpenbotDb } from "@openbot/db";

export const SESSION_COOKIE = "openbot_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function loadAllowlist(home: string, envList?: string): Set<string> {
  const set = new Set<string>();
  if (envList) {
    for (const part of envList.split(/[\s,]+/)) {
      const login = part.trim().toLowerCase();
      if (login) set.add(login);
    }
  }
  const file = join(home, "allowlist");
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const login = line.trim().toLowerCase();
      if (login && !login.startsWith("#")) set.add(login);
    }
  }
  return set;
}

export function addAllowlist(home: string, githubLogin: string): void {
  mkdirSync(home, { recursive: true });
  const file = join(home, "allowlist");
  const login = githubLogin.trim().toLowerCase();
  const existing = loadAllowlist(home);
  if (existing.has(login)) return;
  appendFileSync(file, login + "\n", { encoding: "utf8" });
}

export function isAllowlisted(allowlist: Set<string>, githubLogin: string): boolean {
  return allowlist.has(githubLogin.trim().toLowerCase());
}

export class AuthDenied extends Error {
  constructor(message = "not allowlisted") {
    super(message);
    this.name = "AuthDenied";
  }
}

export type SessionInfo = {
  sessionId: string;
  token: string;
  userId: string;
  accountId: string;
  githubLogin: string;
};

/** Same path used by GitHub OAuth callback and tests. */
export function completeGithubLogin(
  db: OpenbotDb,
  allowlist: Set<string>,
  profile: { login: string; id?: string; name?: string; email?: string },
): SessionInfo {
  const login = profile.login.trim().toLowerCase();
  if (!isAllowlisted(allowlist, login)) {
    throw new AuthDenied(`GitHub user ${login} is not on the allowlist`);
  }

  return db.immediate(() => {
    let user = db.get<{ id: string }>("SELECT id FROM users WHERE github_login = ?", [login]);
    if (user == null) {
      const userId = id();
      db.run(
        `INSERT INTO users (id, github_login, github_id, name, email, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, login, profile.id ?? null, profile.name ?? null, profile.email ?? null, now()],
      );
      user = { id: userId };
    }

    const org = db.get<{ org_id: string; account_id: string | null }>(
      "SELECT org_id, account_id FROM org_meta WHERE id = 'current'",
    );
    let accountId: string;
    if (org != null && org.account_id != null) {
      accountId = org.account_id;
    } else {
      let account = db.get<{ id: string }>("SELECT id FROM accounts WHERE auth_user_id = ?", [user.id]);
      if (account == null) {
        const newId = id();
        db.run("INSERT INTO accounts (id, auth_user_id, created_at) VALUES (?, ?, ?)", [
          newId,
          user.id,
          now(),
        ]);
        account = { id: newId };
      }
      accountId = account.id;
      if (org != null) {
        db.run("UPDATE org_meta SET account_id = ? WHERE id = 'current'", [accountId]);
      }
    }

    if (org != null) {
      const member = db.get<{ id: string }>("SELECT id FROM org_members WHERE user_id = ?", [user.id]);
      if (member == null) {
        db.run(
          `INSERT INTO org_members (id, org_id, user_id, account_id, role, created_at)
           VALUES (?, ?, ?, ?, 'member', ?)`,
          [id(), org.org_id, user.id, accountId, now()],
        );
      }
    }

    const token = crypto.randomUUID().replaceAll("-", "") + randomHex(16);
    const sessionId = id();
    db.run(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [sessionId, user.id, sha256Hex(token), now() + SESSION_TTL_MS, now()],
    );
    return {
      sessionId,
      token,
      userId: user.id,
      accountId,
      githubLogin: login,
    };
  });
}

function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

export function sessionFromToken(
  db: OpenbotDb,
  token: string | undefined,
): SessionInfo | null {
  if (!token) return null;
  const row = db.get<{
    id: string;
    user_id: string;
    expires_at: number;
    github_login: string;
    account_id: string | null;
  }>(
    `SELECT s.id, s.user_id, s.expires_at, u.github_login,
            COALESCE(om.account_id, a.id) AS account_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN org_members om ON om.user_id = u.id
       LEFT JOIN accounts a ON a.auth_user_id = u.id
      WHERE s.token_hash = ?`,
    [sha256Hex(token)],
  );
  if (row == null || row.expires_at < now() || row.account_id == null) return null;
  return {
    sessionId: row.id,
    token,
    userId: row.user_id,
    accountId: row.account_id,
    githubLogin: row.github_login,
  };
}

export function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1];
}

export type ApiKeyPublic = {
  id: string;
  name: string;
  prefix: string;
  lastFour: string;
  createdAt: number;
  lastUsedAt: number | null;
};

export type MintedApiKey = {
  id: string;
  name: string;
  token: string;
  prefix: string;
  lastFour: string;
};

export function mintApiKey(db: OpenbotDb, accountId: string, name?: string): MintedApiKey {
  const trimmed = (name ?? "").trim() || "default";
  const token = "sk-ob_" + Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  const keyId = id();
  const prefix = token.slice(0, 10);
  const lastFour = token.slice(-4);
  db.run(
    `INSERT INTO api_keys (id, account_id, name, token_hash, prefix, last_four, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [keyId, accountId, trimmed, sha256Hex(token), prefix, lastFour, now()],
  );
  return { id: keyId, name: trimmed, token, prefix, lastFour };
}

export function listApiKeys(db: OpenbotDb, accountId: string): ApiKeyPublic[] {
  const rows = db.all<{
    id: string;
    name: string;
    prefix: string;
    last_four: string;
    created_at: number;
    last_used_at: number | null;
  }>(
    `SELECT id, name, prefix, last_four, created_at, last_used_at
     FROM api_keys
     WHERE account_id = ? AND revoked_at IS NULL
     ORDER BY created_at`,
    [accountId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    lastFour: r.last_four,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

export function revokeApiKey(db: OpenbotDb, accountId: string, keyId: string): boolean {
  const row = db.get<{ id: string }>(
    "SELECT id FROM api_keys WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
    [keyId, accountId],
  );
  if (!row) return false;
  db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ?", [now(), keyId]);
  return true;
}

/**
 * Org-scoped `sk-ob_` credential for OpenAI clients, not a second-human identity.
 * Reports the founding user. Do not accept API keys on peer-admin routes.
 */
export function sessionFromApiKey(db: OpenbotDb, token: string | undefined): SessionInfo | null {
  if (!token) return null;
  const row = db.get<{
    id: string;
    account_id: string;
    user_id: string;
    github_login: string;
    revoked_at: number | null;
  }>(
    `SELECT k.id, k.account_id, k.revoked_at, u.id as user_id, u.github_login
     FROM api_keys k
     JOIN accounts a ON a.id = k.account_id
     JOIN users u ON u.id = a.auth_user_id
     WHERE k.token_hash = ?`,
    [sha256Hex(token)],
  );
  if (!row || row.revoked_at != null) return null;
  db.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [now(), row.id]);
  return {
    sessionId: row.id,
    token,
    userId: row.user_id,
    accountId: row.account_id,
    githubLogin: row.github_login,
  };
}

/** Bearer API key first, then a session token. Does not read cookies. */
export function sessionFromBearer(db: OpenbotDb, token: string | undefined): SessionInfo | null {
  if (!token) return null;
  return sessionFromApiKey(db, token) ?? sessionFromToken(db, token);
}

export function cookieHeader(token: string, secure = false): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function parseCookie(header: string | undefined, name = SESSION_COOKIE): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

export function writeAllowlistFile(home: string, logins: string[]): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "allowlist"), logins.map((l) => l.toLowerCase()).join("\n") + "\n");
}
