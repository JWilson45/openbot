import { id, now, type MessageRow, type OpenbotDb, type TurnRow } from "@openbot/db";
import type { PromoteCause } from "@openbot/api-types";

const ASSISTANT_CAP = 256 * 1024;

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

export function promote(db: OpenbotDb, turnId: string, cause: PromoteCause): MessageRow | null {
  return db.immediate(() => {
    const turn = db.get<TurnRow>("SELECT * FROM turns WHERE id = ?", [turnId]);
    if (!turn || turn.status !== "running") return null;

    if (cause.assistantText) {
      turn.assistant_text = cap(turn.assistant_text + cause.assistantText, ASSISTANT_CAP);
    }

    const sendRows = db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM messages WHERE turn_id = ? AND origin = 'send_message'",
      [turnId],
    );
    const hasSend = turn.sent_message_count > 0 || (sendRows?.n ?? 0) > 0;

    let inserted: MessageRow | null = null;

    if (!hasSend) {
      const body = turn.assistant_text.trim();
      if (body.length > 0) {
        inserted = insertMessage(db, {
          threadId: turn.thread_id,
          turnId,
          origin: "fallback",
          role: "assistant",
          body,
        });
        turn.promote_reason =
          cause.kind === "crash"
            ? "crash"
            : cause.kind === "cancel"
              ? "cancel"
              : cause.kind === "deadline"
                ? "deadline"
                : "no_send_message";
      } else {
        inserted = insertMessage(db, {
          threadId: turn.thread_id,
          turnId,
          origin: "system",
          role: "system",
          body: "The teammate finished this turn without a message.",
        });
        turn.promote_reason = "empty_turn";
      }
    }

    turn.status =
      cause.kind === "cancel" ? "cancelled" : cause.kind === "deadline" ? "failed" : "completed";
    turn.stop_reason = "stopReason" in cause ? (cause.stopReason ?? null) : null;
    turn.finished_at = now();

    db.run(
      `UPDATE turns SET
        status = ?, stop_reason = ?, assistant_text = ?, promote_reason = ?, finished_at = ?
       WHERE id = ?`,
      [
        turn.status,
        turn.stop_reason,
        turn.assistant_text,
        turn.promote_reason,
        turn.finished_at,
        turn.id,
      ],
    );

    return inserted;
  });
}

export function insertMessage(
  db: OpenbotDb,
  row: {
    threadId: string;
    turnId?: string | null;
    origin: string;
    role: string;
    body: string;
    urgency?: string;
    fromBotId?: string | null;
  },
): MessageRow {
  const msg: MessageRow = {
    id: id(),
    thread_id: row.threadId,
    turn_id: row.turnId ?? null,
    role: row.role,
    origin: row.origin,
    body: row.body,
    urgency: row.urgency ?? "normal",
    from_bot_id: row.fromBotId ?? null,
    created_at: now(),
  };
  db.run(
    `INSERT INTO messages (id, thread_id, turn_id, role, origin, body, urgency, from_bot_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      msg.id,
      msg.thread_id,
      msg.turn_id,
      msg.role,
      msg.origin,
      msg.body,
      msg.urgency,
      msg.from_bot_id,
      msg.created_at,
    ],
  );
  return msg;
}

const DIGEST_MAX_MESSAGES = 40;
const DIGEST_MAX_CHARS = 12_000;
const DIGEST_LINE_MAX = 800;

export function buildThreadDigest(
  db: OpenbotDb,
  opts: { threadId: string; botId: string; botName: string; excludeTurnId: string },
): string | null {
  const rows = db.all<{
    origin: string;
    body: string;
    from_bot_id: string | null;
  }>(
    `SELECT origin, body, from_bot_id FROM messages
     WHERE thread_id = ?
       AND origin IN ('user', 'send_message', 'fallback', 'agent', 'system', 'thread', 'federation')
       AND (turn_id IS NULL OR turn_id != ?)
     ORDER BY created_at DESC
     LIMIT ?`,
    [opts.threadId, opts.excludeTurnId, DIGEST_MAX_MESSAGES],
  );
  const names = new Map<string, string>();
  names.set(opts.botId, opts.botName);
  const lines: string[] = [];
  let used = 0;
  for (const m of rows) {
    const body = m.body.replace(/\s+/g, " ").trim();
    if (!body) continue;
    if (m.origin === "system" && /OpenBot restarted/i.test(body)) continue;
    const speaker = digestSpeaker(db, m, opts, names);
    const clipped = body.length > DIGEST_LINE_MAX ? `${body.slice(0, DIGEST_LINE_MAX)}…` : body;
    const line = `${speaker}: ${clipped}`;
    if (used + line.length + 1 > DIGEST_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return null;
  lines.reverse();
  return [
    `ACP session reset. You are still ${opts.botName}, same human, same desk.`,
    "The block below is prior thread you already lived. Treat it as memory.",
    "Do not tell the human this is a new session. Do not say you reconstructed anything. Do not recap unless they ask.",
    "",
    ...lines,
  ].join("\n");
}

function digestSpeaker(
  db: OpenbotDb,
  m: { origin: string; from_bot_id: string | null },
  opts: { botId: string; botName: string },
  names: Map<string, string>,
): string {
  if (m.origin === "user") return "Human";
  if (m.origin === "system") return "System";
  if (m.origin === "federation") return "Org";
  if (m.from_bot_id && m.from_bot_id !== opts.botId) {
    const cached = names.get(m.from_bot_id);
    if (cached) return cached;
    const row = db.get<{ name: string }>("SELECT name FROM bots WHERE id = ?", [m.from_bot_id]);
    const name = row?.name || "Peer";
    names.set(m.from_bot_id, name);
    return name;
  }
  return "You";
}

export function wrapPromptWithDigest(digest: string | null, current: string): string {
  const body = current.trim();
  if (!digest) return body;
  return `${digest}\n\n---\nCurrent message:\n${body}`;
}

export function appendLiveWork(
  db: OpenbotDb,
  turnId: string,
  kind: string,
  payload: unknown,
): void {
  const last = db.get<{ seq: number }>(
    "SELECT COALESCE(MAX(seq), 0) as seq FROM live_work_events WHERE turn_id = ?",
    [turnId],
  );
  const seq = (last?.seq ?? 0) + 1;
  const clipped = clipJson(payload, 16 * 1024);
  db.run(
    `INSERT INTO live_work_events (id, turn_id, seq, kind, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id(), turnId, seq, kind, clipped, now()],
  );
}

function clipJson(payload: unknown, max: number): string {
  const raw = JSON.stringify(payload ?? {});
  if (raw.length <= max) return raw;
  return JSON.stringify({ truncated: true, bytes: raw.length });
}

export function parseLivePayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { truncated: true };
  }
}

export function summarizeLiveEvent(kind: string, payload: unknown): string | null {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const update = ((p.update ?? p) || {}) as Record<string, unknown>;
  const content = update.content as { text?: string } | undefined;
  const snip = String(content?.text ?? update.title ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (kind === "agent_thought_chunk") return snip ? `Thinking · ${snip}` : "Thinking";
  if (kind === "agent_message_chunk") return snip ? `Writing · ${snip}` : "Writing";
  if (kind === "tool_call") return `Using ${String(update.title || update.kind || "a tool")}`;
  if (kind === "tool_call_update") {
    if (update.status === "completed") return `Finished ${String(update.title || "tool")}`;
    if (update.status === "failed") return "Tool failed";
    return "Tool running";
  }
  if (kind === "user_message_chunk") return "Reading your message";
  if (kind === "permission_request") return "Needs permission";
  if (kind === "harness_session_reset") return "Harness restarted";
  if (kind === "acp_notify") {
    const method = String(p.method ?? "");
    if (method.includes("prompt_complete")) return "Turn finished";
    if (method.includes("mcp")) return "Talking to tools";
    return null;
  }
  return null;
}
