import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  github_login text NOT NULL UNIQUE,
  github_id text,
  name text,
  email text,
  created_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at integer NOT NULL,
  created_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY,
  auth_user_id text NOT NULL UNIQUE,
  created_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  permission_mode text NOT NULL DEFAULT 'auto',
  harness text NOT NULL DEFAULT 'grok',
  require_human_approval integer NOT NULL DEFAULT 0,
  model text NOT NULL DEFAULT 'grok-4.6',
  reasoning_effort text NOT NULL DEFAULT 'high',
  role text NOT NULL DEFAULT 'desk',
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bots_active_name ON bots(account_id, name) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS bots_one_active_gateway ON bots(account_id) WHERE status = 'active' AND IFNULL(role, 'desk') = 'gateway';

CREATE TABLE IF NOT EXISTS compute_instances (
  id text PRIMARY KEY,
  account_id text NOT NULL UNIQUE REFERENCES accounts(id),
  driver text NOT NULL DEFAULT 'localhost',
  workspace_path text NOT NULL,
  state text NOT NULL,
  last_health_at integer,
  created_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  bot_id text NOT NULL REFERENCES bots(id),
  title text NOT NULL DEFAULT 'New thread',
  kind text NOT NULL DEFAULT 'human',
  peer_bot_id text,
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS threads_one_human_per_bot ON threads(bot_id) WHERE kind = 'human';
CREATE UNIQUE INDEX IF NOT EXISTS threads_a2a_pair ON threads(account_id, bot_id, peer_bot_id) WHERE kind = 'a2a';

CREATE TABLE IF NOT EXISTS thread_participants (
  id text PRIMARY KEY,
  thread_id text NOT NULL REFERENCES threads(id),
  kind text NOT NULL,
  user_id text REFERENCES users(id),
  bot_id text REFERENCES bots(id),
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tp_bot ON thread_participants(thread_id, bot_id) WHERE bot_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tp_user ON thread_participants(thread_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS harness_sessions (
  id text PRIMARY KEY,
  compute_id text NOT NULL REFERENCES compute_instances(id),
  bot_id text NOT NULL REFERENCES bots(id),
  acp_session_id text,
  state text NOT NULL,
  grok_version text,
  created_at integer NOT NULL,
  ended_at integer
);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id text PRIMARY KEY,
  harness_session_id text NOT NULL REFERENCES harness_sessions(id),
  account_id text NOT NULL REFERENCES accounts(id),
  bot_id text NOT NULL REFERENCES bots(id),
  thread_id text NOT NULL REFERENCES threads(id),
  token_hash text NOT NULL UNIQUE,
  revoked_at integer,
  created_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS takeover_tickets (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  compute_id text NOT NULL REFERENCES compute_instances(id),
  user_session_id text NOT NULL,
  ticket_hash text NOT NULL UNIQUE,
  expires_at integer NOT NULL,
  consumed_ws integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id text PRIMARY KEY,
  thread_id text NOT NULL REFERENCES threads(id),
  bot_id text NOT NULL REFERENCES bots(id),
  harness_session_id text REFERENCES harness_sessions(id),
  status text NOT NULL,
  stop_reason text,
  sent_message_count integer NOT NULL DEFAULT 0,
  assistant_text text NOT NULL DEFAULT '',
  promote_reason text,
  error text,
  deadline_at integer,
  started_at integer,
  finished_at integer,
  created_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  thread_id text NOT NULL REFERENCES threads(id),
  turn_id text REFERENCES turns(id),
  role text NOT NULL,
  origin text NOT NULL,
  body text NOT NULL,
  urgency text NOT NULL DEFAULT 'normal',
  from_bot_id text,
  remote_org_id text,
  remote_actor_name text,
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread_created ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS messages_turn_origin ON messages(turn_id, origin);

CREATE TABLE IF NOT EXISTS credentials (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  kind text NOT NULL,
  ciphertext blob NOT NULL,
  dek_wrapped blob NOT NULL,
  key_id text NOT NULL,
  last_four text NOT NULL,
  created_at integer NOT NULL,
  rotated_at integer
);
CREATE UNIQUE INDEX IF NOT EXISTS credentials_account_kind ON credentials(account_id, kind);

CREATE TABLE IF NOT EXISTS live_work_events (
  id text PRIMARY KEY,
  turn_id text NOT NULL REFERENCES turns(id),
  seq integer NOT NULL,
  kind text NOT NULL,
  payload text NOT NULL,
  created_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  account_id text REFERENCES accounts(id),
  actor text NOT NULL,
  type text NOT NULL,
  payload text NOT NULL,
  created_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  name text NOT NULL DEFAULT 'default',
  token_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  last_four text NOT NULL,
  created_at integer NOT NULL,
  last_used_at integer,
  revoked_at integer
);

CREATE TABLE IF NOT EXISTS org_meta (
  id text PRIMARY KEY,
  account_id text REFERENCES accounts(id),
  org_id text NOT NULL UNIQUE,
  slug text NOT NULL,
  name text NOT NULL,
  public_origin text,
  pubkey text NOT NULL DEFAULT '',
  federation_enabled integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS org_members (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  account_id text NOT NULL REFERENCES accounts(id),
  role text NOT NULL DEFAULT 'member',
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS org_members_user ON org_members(user_id);

CREATE TABLE IF NOT EXISTS org_peers (
  id text PRIMARY KEY,
  peer_org_id text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  base_url text NOT NULL,
  pubkey text NOT NULL,
  status text NOT NULL DEFAULT 'allowed',
  created_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS org_inbox (
  id text PRIMARY KEY,
  message_id text NOT NULL,
  from_org_id text NOT NULL,
  from_slug text NOT NULL DEFAULT '',
  to_org_id text NOT NULL,
  hop integer NOT NULL,
  urgency text NOT NULL DEFAULT 'normal',
  body text NOT NULL,
  envelope text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  acked_turn_id text REFERENCES turns(id) ON DELETE SET NULL,
  acked_at integer,
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS org_inbox_peer_msg ON org_inbox(from_org_id, message_id);
CREATE INDEX IF NOT EXISTS org_inbox_from_created ON org_inbox(from_org_id, created_at);
CREATE INDEX IF NOT EXISTS org_inbox_created ON org_inbox(created_at);

CREATE TABLE IF NOT EXISTS org_solicit (
  id text PRIMARY KEY,
  bucket text NOT NULL,
  reason text NOT NULL,
  count integer NOT NULL DEFAULT 1,
  host text,
  last_at integer NOT NULL,
  last_notice_message_id text
);
CREATE UNIQUE INDEX IF NOT EXISTS org_solicit_bucket_reason ON org_solicit(bucket, reason);
`;

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

export class OpenbotDb {
  readonly raw: Database;
  readonly path: string;

  constructor(raw: Database, path: string) {
    this.raw = raw;
    this.path = path;
    raw.exec("PRAGMA journal_mode=WAL;");
    raw.exec("PRAGMA foreign_keys=ON;");
    raw.exec("PRAGMA busy_timeout=5000;");
  }

  static open(path: string): OpenbotDb {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    const raw = new Database(path);
    const db = new OpenbotDb(raw, path);
    db.migrate();
    return db;
  }

  migrate(): void {
    this.raw.exec(SCHEMA);
    this.raw.exec("DROP INDEX IF EXISTS bots_one_active");
    this.raw.exec("DROP INDEX IF EXISTS threads_one_per_bot");
    this.ensureColumn("bots", "harness", "text NOT NULL DEFAULT 'grok'");
    this.ensureColumn("bots", "require_human_approval", "integer NOT NULL DEFAULT 0");
    this.ensureColumn("threads", "kind", "text NOT NULL DEFAULT 'human'");
    this.ensureColumn("threads", "peer_bot_id", "text");
    this.ensureColumn("messages", "from_bot_id", "text");
    this.ensureColumn("bots", "archived_at", "integer");
    this.ensureColumn("bots", "model", "text NOT NULL DEFAULT 'grok-4.6'");
    this.ensureColumn("bots", "reasoning_effort", "text NOT NULL DEFAULT 'high'");
    this.ensureColumn("bots", "role", "text NOT NULL DEFAULT 'desk'");
    this.ensureColumn("org_meta", "federation_enabled", "integer NOT NULL DEFAULT 0");
    this.ensureColumn("messages", "remote_org_id", "text");
    this.ensureColumn("messages", "remote_actor_name", "text");
    this.raw.exec(
      "UPDATE bots SET archived_at = created_at WHERE status = 'archived' AND archived_at IS NULL",
    );
    this.raw.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS bots_active_name ON bots(account_id, name) WHERE status = 'active'",
    );
    this.raw.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS bots_one_active_gateway ON bots(account_id) WHERE status = 'active' AND IFNULL(role, 'desk') = 'gateway'",
    );
    this.raw.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS threads_one_human_per_bot ON threads(bot_id) WHERE kind = 'human'",
    );
    this.raw.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS threads_a2a_pair ON threads(account_id, bot_id, peer_bot_id) WHERE kind = 'a2a'",
    );
  }

  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (cols.some((c) => c.name === column)) return;
    this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  close(): void {
    this.raw.close();
  }

  /** SQLite exclusive-writer stand-in for SELECT … FOR UPDATE. */
  immediate<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  run(sql: string, params: SqlValue[] = []): void {
    this.raw.query(sql).run(...params);
  }

  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.raw.query(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, params: SqlValue[] = []): T[] {
    return this.raw.query(sql).all(...params) as T[];
  }
}

export function now(): number {
  return Date.now();
}

export function id(): string {
  return crypto.randomUUID();
}

export function sha256Hex(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

export type TurnRow = {
  id: string;
  thread_id: string;
  bot_id: string;
  harness_session_id: string | null;
  status: string;
  stop_reason: string | null;
  sent_message_count: number;
  assistant_text: string;
  promote_reason: string | null;
  error: string | null;
  deadline_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
};

export type MessageRow = {
  id: string;
  thread_id: string;
  turn_id: string | null;
  role: string;
  origin: string;
  body: string;
  urgency: string;
  from_bot_id: string | null;
  remote_org_id: string | null;
  remote_actor_name: string | null;
  created_at: number;
};

export type OrgInboxRow = {
  id: string;
  message_id: string;
  from_org_id: string;
  from_slug: string;
  to_org_id: string;
  hop: number;
  urgency: string;
  body: string;
  envelope: string;
  status: string;
  acked_turn_id: string | null;
  acked_at: number | null;
  created_at: number;
};

export type OrgSolicitRow = {
  id: string;
  bucket: string;
  reason: string;
  count: number;
  host: string | null;
  last_at: number;
  last_notice_message_id: string | null;
};

export const MAX_ACTIVE_BOTS = 6;
/** Archived bots are purged this long after archive unless restored. */
export const ARCHIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const INBOX_ACKED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const INBOX_OPEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INBOX_CAP = 10_000;
export const FED_RATE_PEER_HOUR = 60;
export const FED_RATE_INSTANCE_HOUR = 200;
export const FED_RATE_WINDOW_MS = 60 * 60 * 1000;

export function isGatewayRole(role: string | null | undefined): boolean {
  return role === "gateway";
}

export function deleteBotPermanently(db: OpenbotDb, botId: string): void {
  const row = db.get<{ role: string | null }>("SELECT role FROM bots WHERE id = ?", [botId]);
  if (isGatewayRole(row?.role)) return;
  db.immediate(() => {
    // Membership rows FK to bots; drop this bot before the bots DELETE.
    db.run(`DELETE FROM thread_participants WHERE bot_id = ?`, [botId]);
    // Detach FKs first. SendMessage on another bot's human thread can point
    // turn_id at this bot's A2A turn; those rows must be unlinked, not deleted.
    db.run(
      `DELETE FROM live_work_events WHERE turn_id IN (SELECT id FROM turns WHERE bot_id = ?)`,
      [botId],
    );
    db.run(
      `UPDATE messages SET turn_id = NULL WHERE turn_id IN (SELECT id FROM turns WHERE bot_id = ?)`,
      [botId],
    );
    db.run(`UPDATE messages SET from_bot_id = NULL WHERE from_bot_id = ?`, [botId]);
    db.run(`DELETE FROM mcp_tokens WHERE bot_id = ?`, [botId]);
    db.run(`UPDATE turns SET harness_session_id = NULL WHERE bot_id = ?`, [botId]);
    db.run(`DELETE FROM turns WHERE bot_id = ?`, [botId]);
    db.run(`DELETE FROM harness_sessions WHERE bot_id = ?`, [botId]);

    // Keep the surviving peer's A2A history. Rehome threads this bot owned.
    db.run(
      `UPDATE threads SET bot_id = peer_bot_id, peer_bot_id = NULL
        WHERE bot_id = ? AND kind = 'a2a' AND peer_bot_id IS NOT NULL`,
      [botId],
    );
    db.run(`UPDATE threads SET peer_bot_id = NULL WHERE peer_bot_id = ?`, [botId]);

    // bot_id is only the convening pointer; keep the group if another member bot remains.
    db.run(
      `UPDATE threads SET bot_id = (
         SELECT tp.bot_id FROM thread_participants tp
         WHERE tp.thread_id = threads.id AND tp.bot_id IS NOT NULL
         LIMIT 1
       )
       WHERE bot_id = ? AND kind = 'group'
         AND EXISTS (
           SELECT 1 FROM thread_participants tp
           WHERE tp.thread_id = threads.id AND tp.bot_id IS NOT NULL
         )`,
      [botId],
    );
    // Leftover members of threads we still own (groups with no bot left).
    db.run(
      `DELETE FROM thread_participants WHERE thread_id IN (SELECT id FROM threads WHERE bot_id = ?)`,
      [botId],
    );

    // Remaining threads are this bot's human DM (and any orphaned A2A / empty group).
    db.run(
      `DELETE FROM mcp_tokens WHERE thread_id IN (SELECT id FROM threads WHERE bot_id = ?)`,
      [botId],
    );
    db.run(
      `DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE bot_id = ?)`,
      [botId],
    );
    db.run(
      `DELETE FROM live_work_events WHERE turn_id IN (
         SELECT id FROM turns WHERE thread_id IN (SELECT id FROM threads WHERE bot_id = ?)
       )`,
      [botId],
    );
    db.run(
      `UPDATE messages SET turn_id = NULL WHERE turn_id IN (
         SELECT id FROM turns WHERE thread_id IN (SELECT id FROM threads WHERE bot_id = ?)
       )`,
      [botId],
    );
    db.run(
      `UPDATE turns SET harness_session_id = NULL WHERE thread_id IN (SELECT id FROM threads WHERE bot_id = ?)`,
      [botId],
    );
    db.run(`DELETE FROM turns WHERE thread_id IN (SELECT id FROM threads WHERE bot_id = ?)`, [botId]);
    db.run(`DELETE FROM threads WHERE bot_id = ?`, [botId]);
    db.run(`DELETE FROM bots WHERE id = ?`, [botId]);
  });
}

export function purgeExpiredOrgInbox(db: OpenbotDb): number {
  const t = now();
  db.run(
    "DELETE FROM org_inbox WHERE status = 'acked' AND IFNULL(acked_at, created_at) < ?",
    [t - INBOX_ACKED_TTL_MS],
  );
  db.run(
    "DELETE FROM org_inbox WHERE status IN ('pending', 'dropped', 'held') AND created_at < ?",
    [t - INBOX_OPEN_TTL_MS],
  );
  const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM org_inbox")?.n ?? 0;
  if (n <= INBOX_CAP) return n;
  const extra = n - INBOX_CAP;
  db.run(
    `DELETE FROM org_inbox WHERE id IN (
       SELECT id FROM org_inbox ORDER BY created_at ASC, id ASC LIMIT ?
     )`,
    [extra],
  );
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM org_inbox")?.n ?? 0;
}

export function purgeExpiredArchivedBots(db: OpenbotDb, accountId?: string): string[] {
  const cutoff = now() - ARCHIVE_TTL_MS;
  const rows = accountId
    ? db.all<{ id: string }>(
        "SELECT id FROM bots WHERE status = 'archived' AND archived_at IS NOT NULL AND archived_at < ? AND account_id = ?",
        [cutoff, accountId],
      )
    : db.all<{ id: string }>(
        "SELECT id FROM bots WHERE status = 'archived' AND archived_at IS NOT NULL AND archived_at < ?",
        [cutoff],
      );
  for (const row of rows) deleteBotPermanently(db, row.id);
  return rows.map((row) => row.id);
}

export function humanThread(db: OpenbotDb, botId: string): { id: string; bot_id: string; account_id: string } | undefined {
  return db.get(
    "SELECT id, bot_id, account_id FROM threads WHERE bot_id = ? AND IFNULL(kind, 'human') = 'human'",
    [botId],
  );
}

export function orderedBotPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export type McpTokenRow = {
  id: string;
  harness_session_id: string;
  account_id: string;
  bot_id: string;
  thread_id: string;
  token_hash: string;
  revoked_at: number | null;
  created_at: number;
};
