import type { OpenbotDb } from "./index.ts";

function nid(): string {
  return crypto.randomUUID();
}

function nnow(): number {
  return Date.now();
}

export const ORG_NOTES_MAX = 1200;
export const BOT_NOTES_MAX = 2000;

export const MEMORY_WRITE_PER_TURN = 10;
export const MEMORY_WRITE_PER_HOUR = 40;
export const SEARCH_PER_TURN = 20;
export const SEARCH_SNIPPET_MAX = 400;
export const SEARCH_LIMIT_DEFAULT = 10;
export const SEARCH_LIMIT_MAX = 20;

export type MemoryScope = "org" | "bot";

export type MemoryNoteRow = {
  id: string;
  account_id: string;
  scope: MemoryScope;
  bot_id: string | null;
  body: string;
  pending_body: string | null;
  updated_by: string;
  source_turn_id: string | null;
  updated_at: number;
  created_at: number;
};

export class MemoryTextError extends Error {
  constructor(
    public readonly code: "unsafe_memory" | "cap",
    message: string,
  ) {
    super(message);
    this.name = "MemoryTextError";
  }
}

const TAKEOVER =
  /ignore\s+previous\s+instructions|systemPromptOverride|<\/rules>|<<<OPENBOT|OPENBOT_[A-Z0-9_]+>>>|##\s*Standing notes/i;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/;
const UNICODE_TAGS = /[\u{E0001}\u{E0020}-\u{E007F}]/u;
const C0_DROP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const FTS_RESERVED = new Set(["and", "or", "not", "near"]);

export function scanMemoryText(raw: string): { ok: true; text: string } | { ok: false; reason: string } {
  if (raw.includes("\u0000")) return { ok: false, reason: "nul" };
  if (BIDI.test(raw)) return { ok: false, reason: "bidi" };
  if (UNICODE_TAGS.test(raw)) return { ok: false, reason: "unicode_tag" };
  if (TAKEOVER.test(raw)) return { ok: false, reason: "injection" };
  const text = raw.replace(C0_DROP, "");
  return { ok: true, text };
}

export function assertMemoryText(raw: string, cap: number): string {
  const scanned = scanMemoryText(raw);
  if (!scanned.ok) throw new MemoryTextError("unsafe_memory", scanned.reason);
  if (scanned.text.length > cap) throw new MemoryTextError("cap", `notes exceed ${cap} characters`);
  return scanned.text;
}

/** Strip FTS operators; AND + prefix; max 12 tokens. Never pass raw user text to MATCH. */
export function ftsMatchQuery(raw: string): string | null {
  const stripped = raw.replace(/["*():^]/g, " ");
  const tokens: string[] = [];
  for (const part of stripped.split(/[^0-9A-Za-z_]+/)) {
    if (!part) continue;
    if (FTS_RESERVED.has(part.toLowerCase())) continue;
    tokens.push(part);
    if (tokens.length >= 12) break;
  }
  if (!tokens.length) return null;
  return tokens.map((t) => `${t}*`).join(" AND ");
}

function mapRow(row: MemoryNoteRow): MemoryNoteRow {
  return {
    ...row,
    scope: row.scope === "org" ? "org" : "bot",
  };
}

export function ensureOrgNotes(db: OpenbotDb, accountId: string): MemoryNoteRow {
  const existing = db.get<MemoryNoteRow>(
    "SELECT * FROM memory_notes WHERE account_id = ? AND scope = 'org'",
    [accountId],
  );
  if (existing) return mapRow(existing);
  const t = nnow();
  const row: MemoryNoteRow = {
    id: nid(),
    account_id: accountId,
    scope: "org",
    bot_id: null,
    body: "",
    pending_body: null,
    updated_by: "human",
    source_turn_id: null,
    updated_at: t,
    created_at: t,
  };
  try {
    db.run(
      `INSERT INTO memory_notes (id, account_id, scope, bot_id, body, pending_body, updated_by, source_turn_id, updated_at, created_at)
       VALUES (?, ?, 'org', NULL, '', NULL, 'human', NULL, ?, ?)`,
      [row.id, accountId, t, t],
    );
  } catch {
    const raced = db.get<MemoryNoteRow>(
      "SELECT * FROM memory_notes WHERE account_id = ? AND scope = 'org'",
      [accountId],
    );
    if (raced) return mapRow(raced);
    throw new Error("ensureOrgNotes failed");
  }
  return db.get<MemoryNoteRow>("SELECT * FROM memory_notes WHERE id = ?", [row.id]) ?? row;
}

export function ensureBotNotes(db: OpenbotDb, accountId: string, botId: string): MemoryNoteRow {
  const existing = db.get<MemoryNoteRow>(
    "SELECT * FROM memory_notes WHERE bot_id = ? AND scope = 'bot'",
    [botId],
  );
  if (existing) return mapRow(existing);
  const t = nnow();
  const row: MemoryNoteRow = {
    id: nid(),
    account_id: accountId,
    scope: "bot",
    bot_id: botId,
    body: "",
    pending_body: null,
    updated_by: "human",
    source_turn_id: null,
    updated_at: t,
    created_at: t,
  };
  try {
    db.run(
      `INSERT INTO memory_notes (id, account_id, scope, bot_id, body, pending_body, updated_by, source_turn_id, updated_at, created_at)
       VALUES (?, ?, 'bot', ?, '', NULL, 'human', NULL, ?, ?)`,
      [row.id, accountId, botId, t, t],
    );
  } catch {
    const raced = db.get<MemoryNoteRow>(
      "SELECT * FROM memory_notes WHERE bot_id = ? AND scope = 'bot'",
      [botId],
    );
    if (raced) return mapRow(raced);
    throw new Error("ensureBotNotes failed");
  }
  return db.get<MemoryNoteRow>("SELECT * FROM memory_notes WHERE id = ?", [row.id]) ?? row;
}

export function readNotes(
  db: OpenbotDb,
  accountId: string,
  botId: string,
): { org: string; bot: string; orgRow: MemoryNoteRow; botRow: MemoryNoteRow } {
  const orgRow = ensureOrgNotes(db, accountId);
  const botRow = ensureBotNotes(db, accountId, botId);
  return { org: orgRow.body, bot: botRow.body, orgRow, botRow };
}

export type MemoryWriteAction = "read" | "replace" | "add" | "remove";

function nextBody(current: string, action: Exclude<MemoryWriteAction, "read">, text: string | undefined): string {
  if (action === "replace") return text ?? "";
  if (action === "add") {
    const chunk = text ?? "";
    if (!chunk) return current;
    return current ? `${current}\n${chunk}` : chunk;
  }
  if (text == null || text === "") return "";
  const idx = current.indexOf(text);
  if (idx < 0) return current;
  return current.slice(0, idx) + current.slice(idx + text.length);
}

export function applyMemoryWrite(
  db: OpenbotDb,
  opts: {
    accountId: string;
    botId?: string;
    scope: MemoryScope;
    action: MemoryWriteAction;
    text?: string;
    actor: "human" | "agent";
    park?: boolean;
    sourceTurnId?: string | null;
  },
): { row: MemoryNoteRow; parked: boolean; applies: "next_spawn" } {
  if (opts.scope !== "org" && opts.scope !== "bot") {
    throw new MemoryTextError("unsafe_memory", "invalid scope");
  }
  if (opts.scope === "bot" && !opts.botId) {
    throw new MemoryTextError("unsafe_memory", "bot scope requires bot_id");
  }
  const row =
    opts.scope === "org" ? ensureOrgNotes(db, opts.accountId) : ensureBotNotes(db, opts.accountId, opts.botId!);
  const cap = opts.scope === "org" ? ORG_NOTES_MAX : BOT_NOTES_MAX;
  if (opts.action === "read") {
    return { row, parked: false, applies: "next_spawn" };
  }
  const base = opts.park ? (row.pending_body ?? row.body) : row.body;
  const next = nextBody(base, opts.action, opts.text);
  const scanned = assertMemoryText(next, cap);
  const t = nnow();
  if (opts.park) {
    db.run(
      `UPDATE memory_notes SET pending_body = ?, updated_by = ?, source_turn_id = ?, updated_at = ? WHERE id = ?`,
      [scanned, opts.actor, opts.sourceTurnId ?? null, t, row.id],
    );
  } else {
    db.run(
      `UPDATE memory_notes SET body = ?, pending_body = NULL, updated_by = ?, source_turn_id = ?, updated_at = ? WHERE id = ?`,
      [scanned, opts.actor, opts.sourceTurnId ?? null, t, row.id],
    );
  }
  const updated = db.get<MemoryNoteRow>("SELECT * FROM memory_notes WHERE id = ?", [row.id]) ?? row;
  return { row: mapRow(updated), parked: Boolean(opts.park), applies: "next_spawn" };
}

export function approvePendingMemory(db: OpenbotDb, accountId: string, noteId: string): MemoryNoteRow | null {
  const row = db.get<MemoryNoteRow>("SELECT * FROM memory_notes WHERE id = ? AND account_id = ?", [
    noteId,
    accountId,
  ]);
  if (!row || row.pending_body == null) return null;
  const cap = row.scope === "org" ? ORG_NOTES_MAX : BOT_NOTES_MAX;
  const scanned = assertMemoryText(row.pending_body, cap);
  const t = nnow();
  db.run(
    `UPDATE memory_notes SET body = ?, pending_body = NULL, updated_by = 'human', updated_at = ? WHERE id = ?`,
    [scanned, t, row.id],
  );
  return db.get<MemoryNoteRow>("SELECT * FROM memory_notes WHERE id = ?", [row.id]) ?? null;
}

export function rejectPendingMemory(db: OpenbotDb, accountId: string, noteId: string): MemoryNoteRow | null {
  const row = db.get<MemoryNoteRow>("SELECT * FROM memory_notes WHERE id = ? AND account_id = ?", [
    noteId,
    accountId,
  ]);
  if (!row || row.pending_body == null) return null;
  const t = nnow();
  db.run(`UPDATE memory_notes SET pending_body = NULL, updated_by = 'human', updated_at = ? WHERE id = ?`, [
    t,
    row.id,
  ]);
  return db.get<MemoryNoteRow>("SELECT * FROM memory_notes WHERE id = ?", [row.id]) ?? null;
}

export function listAccountMemory(
  db: OpenbotDb,
  accountId: string,
): {
  org: MemoryNoteRow;
  bots: Array<MemoryNoteRow & { name: string }>;
} {
  const org = ensureOrgNotes(db, accountId);
  const bots = db.all<{ id: string; name: string }>(
    `SELECT id, name FROM bots WHERE account_id = ? AND status = 'active' ORDER BY created_at`,
    [accountId],
  );
  const rows: Array<MemoryNoteRow & { name: string }> = [];
  for (const bot of bots) {
    const note = ensureBotNotes(db, accountId, bot.id);
    rows.push({ ...note, name: bot.name });
  }
  return { org, bots: rows };
}

export const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body,
  message_id UNINDEXED,
  thread_id UNINDEXED,
  account_id UNINDEXED,
  origin UNINDEXED,
  created_at UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS threads_fts USING fts5(
  title,
  thread_id UNINDEXED,
  account_id UNINDEXED,
  kind UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
WHEN NEW.origin NOT IN ('prompt', 'calendar')
BEGIN
  INSERT INTO messages_fts(body, message_id, thread_id, account_id, origin, created_at)
  SELECT NEW.body, NEW.id, NEW.thread_id, th.account_id, NEW.origin, NEW.created_at
  FROM threads th WHERE th.id = NEW.thread_id;
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE message_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF body, origin ON messages
BEGIN
  DELETE FROM messages_fts WHERE message_id = NEW.id;
  INSERT INTO messages_fts(body, message_id, thread_id, account_id, origin, created_at)
  SELECT NEW.body, NEW.id, NEW.thread_id, th.account_id, NEW.origin, NEW.created_at
  FROM threads th
  WHERE th.id = NEW.thread_id AND NEW.origin NOT IN ('prompt', 'calendar');
END;
CREATE TRIGGER IF NOT EXISTS threads_fts_ai AFTER INSERT ON threads BEGIN
  INSERT INTO threads_fts(title, thread_id, account_id, kind)
  VALUES (NEW.title, NEW.id, NEW.account_id, NEW.kind);
END;
CREATE TRIGGER IF NOT EXISTS threads_fts_ad AFTER DELETE ON threads
BEGIN
  DELETE FROM threads_fts WHERE thread_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS threads_fts_au AFTER UPDATE OF title ON threads
BEGIN
  DELETE FROM threads_fts WHERE thread_id = NEW.id;
  INSERT INTO threads_fts(title, thread_id, account_id, kind)
  VALUES (NEW.title, NEW.id, NEW.account_id, NEW.kind);
END;
`;
