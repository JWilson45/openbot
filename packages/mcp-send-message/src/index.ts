import {
  humanThread,
  id,
  now,
  orderedBotPair,
  sha256Hex,
  type McpTokenRow,
  type OpenbotDb,
  type TurnRow,
} from "@openbot/db";
import {
  McpError,
  sendMessageInput,
  sendToAgentInput,
  sendToThreadInput,
  type SendMessageInput,
} from "@openbot/api-types";
import { insertMessage } from "@openbot/live-work";

export class McpInflight {
  private counts = new Map<string, number>();

  add(harnessSessionId: string): void {
    this.counts.set(harnessSessionId, (this.counts.get(harnessSessionId) ?? 0) + 1);
  }

  remove(harnessSessionId: string): void {
    const n = (this.counts.get(harnessSessionId) ?? 1) - 1;
    if (n <= 0) this.counts.delete(harnessSessionId);
    else this.counts.set(harnessSessionId, n);
  }

  get(harnessSessionId: string): number {
    return this.counts.get(harnessSessionId) ?? 0;
  }

  async drain(harnessSessionId: string, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (this.get(harnessSessionId) > 0 && Date.now() - start < timeoutMs) {
      await Bun.sleep(20);
    }
  }
}

export type McpClaims = {
  accountId: string;
  botId: string;
  threadId: string;
  harnessSessionId: string;
};

export function mintMcpToken(): { token: string; hash: string } {
  const token = "ob_sess_" + crypto.randomUUID().replaceAll("-", "") + randomHex(16);
  return { token, hash: sha256Hex(token) };
}

function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

export function persistMcpToken(
  db: OpenbotDb,
  claims: McpClaims,
  hash: string,
): void {
  db.run(
    `INSERT INTO mcp_tokens (id, harness_session_id, account_id, bot_id, thread_id, token_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id(), claims.harnessSessionId, claims.accountId, claims.botId, claims.threadId, hash, now()],
  );
}

export function verifyMcpToken(db: OpenbotDb, bearer: string | undefined): McpClaims {
  if (!bearer) throw new McpError("unauthorized", "missing token", 401);
  const token = bearer.replace(/^Bearer\s+/i, "").trim();
  const hash = sha256Hex(token);
  const row = db.get<McpTokenRow>(
    "SELECT * FROM mcp_tokens WHERE token_hash = ? AND revoked_at IS NULL",
    [hash],
  );
  if (!row) throw new McpError("unauthorized", "invalid token", 401);
  return {
    accountId: row.account_id,
    botId: row.bot_id,
    threadId: row.thread_id,
    harnessSessionId: row.harness_session_id,
  };
}

export function sendMessage(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
): { ok: true; messageId: string } {
  const input: SendMessageInput = sendMessageInput.parse(normalizeSendArgs(rawInput));
  const claims = verifyMcpToken(db, bearer);
  inflight.add(claims.harnessSessionId);
  try {
    if (countHourlySends(db, claims.accountId) >= 100) {
      throw new McpError("rate_limited", "hourly send limit", 429);
    }

    const msg = db.immediate(() => {
      const turn = lockRunningTurn(db, claims);
      if (!turn) {
        throw new McpError("no_active_turn", "no running turn for this harness session", 409);
      }
      if (turn.sent_message_count >= 20) {
        throw new McpError("rate_limited", "per-turn send limit", 429);
      }
      const human = humanThread(db, claims.botId);
      if (!human) throw new McpError("no_human_thread", "bot has no human DM", 500);
      const bot = db.get<{ require_human_approval: number }>(
        "SELECT require_human_approval FROM bots WHERE id = ?",
        [claims.botId],
      );
      const park = input.urgency === "needs_user" || Boolean(bot?.require_human_approval);
      const row = insertMessage(db, {
        threadId: human.id,
        turnId: turn.id,
        role: "assistant",
        origin: park ? "pending_approval" : "send_message",
        body: input.body,
        urgency: input.urgency,
        fromBotId: claims.botId,
      });
      if (!park) {
        db.run("UPDATE turns SET sent_message_count = sent_message_count + 1 WHERE id = ?", [turn.id]);
      }
      db.run(
        `INSERT INTO audit_events (id, account_id, actor, type, payload, created_at)
         VALUES (?, ?, 'harness', 'send_message', ?, ?)`,
        [id(), claims.accountId, JSON.stringify({ messageId: row.id, turnId: turn.id, park }), now()],
      );
      return row;
    });
    return { ok: true, messageId: msg.id };
  } finally {
    inflight.remove(claims.harnessSessionId);
  }
}

function lockRunningTurn(db: OpenbotDb, claims: McpClaims): TurnRow | undefined {
  return db.get<TurnRow>(
    `SELECT * FROM turns
     WHERE harness_session_id = ? AND status = 'running'
     ORDER BY created_at DESC LIMIT 1`,
    [claims.harnessSessionId],
  );
}

function countHourlySends(db: OpenbotDb, accountId: string): number {
  return (
    db.get<{ n: number }>(
      `SELECT COUNT(*) as n FROM messages
       WHERE origin IN ('send_message', 'thread') AND created_at > ? AND thread_id IN
         (SELECT id FROM threads WHERE account_id = ?)`,
      [now() - 60 * 60 * 1000, accountId],
    )?.n ?? 0
  );
}

const GROUP_MENTION_CAP = 3;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseGroupMentions<T extends { name: string }>(
  body: string,
  members: T[],
): { mentioned: T[]; truncated: boolean } {
  const hits: { member: T; index: number }[] = [];
  for (const member of members) {
    if (!member.name || /\s/.test(member.name)) continue;
    const match = new RegExp(`(?:^|\\s)@${escapeRegExp(member.name)}\\b`, "i").exec(body);
    if (match) hits.push({ member, index: match.index });
  }
  hits.sort((a, b) => a.index - b.index);
  return {
    mentioned: hits.slice(0, GROUP_MENTION_CAP).map((h) => h.member),
    truncated: hits.length > GROUP_MENTION_CAP,
  };
}

export function queueGroupMentions(
  db: OpenbotDb,
  opts: { threadId: string; title: string; body: string; skipBotId?: string },
): { turnIds: string[]; mentioned: string[]; mentionedTruncated: boolean } {
  const members = db.all<{ id: string; name: string }>(
    `SELECT b.id, b.name FROM thread_participants tp
     JOIN bots b ON b.id = tp.bot_id
     WHERE tp.thread_id = ? AND tp.bot_id IS NOT NULL AND b.status = 'active'`,
    [opts.threadId],
  );
  const eligible = opts.skipBotId ? members.filter((m) => m.id !== opts.skipBotId) : members;
  const { mentioned, truncated } = parseGroupMentions(opts.body, eligible);
  const turnIds: string[] = [];
  for (const bot of mentioned) {
    const queued = db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM turns WHERE bot_id = ? AND status = 'queued'",
      [bot.id],
    );
    if ((queued?.n ?? 0) >= 5) continue;
    const turnId = id();
    const t = now();
    db.run(
      `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, deadline_at, created_at)
       VALUES (?, ?, ?, 'queued', 0, '', ?, ?)`,
      [turnId, opts.threadId, bot.id, t + 2 * 60 * 60 * 1000, t],
    );
    insertMessage(db, {
      threadId: opts.threadId,
      turnId,
      role: "user",
      origin: "prompt",
      body: `You were @mentioned in ${opts.title}.\n${opts.body}`,
    });
    turnIds.push(turnId);
  }
  return {
    turnIds,
    mentioned: mentioned.map((m) => m.name),
    mentionedTruncated: truncated,
  };
}

type GroupThreadRow = { id: string; title: string; kind: string; account_id: string };

function resolveGroupThread(
  db: OpenbotDb,
  claims: McpClaims,
  turn: TurnRow,
  input: { threadId?: string; name?: string },
): GroupThreadRow {
  let thread: GroupThreadRow | undefined;
  if (input.threadId) {
    thread = db.get<GroupThreadRow>(
      "SELECT id, title, kind, account_id FROM threads WHERE id = ? AND account_id = ?",
      [input.threadId, claims.accountId],
    );
  } else if (input.name) {
    thread = db.get<GroupThreadRow>(
      `SELECT id, title, kind, account_id FROM threads
       WHERE account_id = ? AND kind = 'group' AND lower(title) = lower(?)
       ORDER BY created_at DESC LIMIT 1`,
      [claims.accountId, input.name],
    );
  } else {
    // Warm sessions keep the cold-start DM in claims; group speech follows this turn.
    thread = db.get<GroupThreadRow>("SELECT id, title, kind, account_id FROM threads WHERE id = ?", [
      turn.thread_id,
    ]);
  }
  if (!thread || thread.account_id !== claims.accountId) {
    throw new McpError("not_found", "group thread not found", 404);
  }
  if (thread.kind !== "group") {
    throw new McpError("bad_request", "SendToThread target must be a group thread", 400);
  }
  const member = db.get(
    "SELECT id FROM thread_participants WHERE thread_id = ? AND bot_id = ?",
    [thread.id, claims.botId],
  );
  if (!member) throw new McpError("forbidden", "not a participant of this group", 403);
  return thread;
}

export function sendToThread(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
): { ok: true; messageId: string; threadId: string; turnIds: string[] } {
  const input = sendToThreadInput.parse(normalizeSendArgs(rawInput));
  const claims = verifyMcpToken(db, bearer);
  inflight.add(claims.harnessSessionId);
  try {
    if (countHourlySends(db, claims.accountId) >= 100) {
      throw new McpError("rate_limited", "hourly send limit", 429);
    }
    return db.immediate(() => {
      const turn = lockRunningTurn(db, claims);
      if (!turn) throw new McpError("no_active_turn", "no running turn for this harness session", 409);
      if (turn.sent_message_count >= 20) {
        throw new McpError("rate_limited", "per-turn send limit", 429);
      }
      const thread = resolveGroupThread(db, claims, turn, input);
      const row = insertMessage(db, {
        threadId: thread.id,
        turnId: turn.id,
        role: "assistant",
        origin: "thread",
        body: input.body,
        urgency: input.urgency,
        fromBotId: claims.botId,
      });
      db.run("UPDATE turns SET sent_message_count = sent_message_count + 1 WHERE id = ?", [turn.id]);
      db.run(
        `INSERT INTO audit_events (id, account_id, actor, type, payload, created_at)
         VALUES (?, ?, 'harness', 'send_to_thread', ?, ?)`,
        [
          id(),
          claims.accountId,
          JSON.stringify({ messageId: row.id, turnId: turn.id, threadId: thread.id }),
          now(),
        ],
      );
      const fanout = queueGroupMentions(db, {
        threadId: thread.id,
        title: thread.title,
        body: input.body,
        skipBotId: claims.botId,
      });
      return { ok: true as const, messageId: row.id, threadId: thread.id, turnIds: fanout.turnIds };
    });
  } finally {
    inflight.remove(claims.harnessSessionId);
  }
}

export function sendToAgent(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
): { ok: true; threadId: string; turnId: string } {
  const input = sendToAgentInput.parse(normalizeSendArgs(rawInput));
  if (!input.botId && !input.name) {
    throw new McpError("bad_request", "botId or name required", 400);
  }
  const claims = verifyMcpToken(db, bearer);
  inflight.add(claims.harnessSessionId);
  try {
    const hourly = db.get<{ n: number }>(
      `SELECT COUNT(*) as n FROM messages
       WHERE origin = 'agent' AND created_at > ? AND from_bot_id IN
         (SELECT id FROM bots WHERE account_id = ?)`,
      [now() - 60 * 60 * 1000, claims.accountId],
    );
    if ((hourly?.n ?? 0) >= 200) {
      throw new McpError("rate_limited", "hourly A2A limit", 429);
    }
    return db.immediate(() => {
      const turn = lockRunningTurn(db, claims);
      if (!turn) throw new McpError("no_active_turn", "no running turn", 409);
      const a2aThisTurn = db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM messages WHERE origin = 'agent' AND from_bot_id = ? AND created_at >= ?",
        [claims.botId, turn.created_at],
      );
      if ((a2aThisTurn?.n ?? 0) >= 20) throw new McpError("rate_limited", "per-turn A2A limit", 429);

      const target = input.botId
        ? db.get<{ id: string; name: string; account_id: string; status: string }>(
            "SELECT id, name, account_id, status FROM bots WHERE id = ? AND account_id = ?",
            [input.botId, claims.accountId],
          )
        : db.get<{ id: string; name: string; account_id: string; status: string }>(
            "SELECT id, name, account_id, status FROM bots WHERE account_id = ? AND status = 'active' AND lower(name) = lower(?)",
            [claims.accountId, input.name!],
          );
      if (!target || target.status !== "active") {
        throw new McpError("not_found", "target bot not found", 404);
      }
      if (target.id === claims.botId) {
        throw new McpError("bad_request", "cannot SendToAgent yourself", 400);
      }
      const queued = db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM turns WHERE bot_id = ? AND status = 'queued'",
        [target.id],
      );
      if ((queued?.n ?? 0) >= 5) {
        throw new McpError("target_busy", "target queue is full", 429);
      }
      const [lo, hi] = orderedBotPair(claims.botId, target.id);
      let thread = db.get<{ id: string }>(
        "SELECT id FROM threads WHERE kind = 'a2a' AND account_id = ? AND bot_id = ? AND peer_bot_id = ?",
        [claims.accountId, lo, hi],
      );
      if (!thread) {
        const threadId = id();
        db.run(
          `INSERT INTO threads (id, account_id, bot_id, title, kind, peer_bot_id, created_at)
           VALUES (?, ?, ?, ?, 'a2a', ?, ?)`,
          [threadId, claims.accountId, lo, `${claims.botId}↔${target.id}`, hi, now()],
        );
        thread = { id: threadId };
      }
      const targetTurnId = id();
      const tnow = now();
      db.run(
        `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, deadline_at, created_at)
         VALUES (?, ?, ?, 'queued', 0, '', ?, ?)`,
        [targetTurnId, thread.id, target.id, tnow + 2 * 60 * 60 * 1000, tnow],
      );
      insertMessage(db, {
        threadId: thread.id,
        turnId: targetTurnId,
        role: "user",
        origin: "agent",
        body: input.body,
        fromBotId: claims.botId,
      });
      return { ok: true as const, threadId: thread.id, turnId: targetTurnId };
    });
  } finally {
    inflight.remove(claims.harnessSessionId);
  }
}

export function approveMessage(db: OpenbotDb, accountId: string, messageId: string): boolean {
  return db.immediate(() => {
    const msg = db.get<{ id: string; origin: string; turn_id: string | null; thread_id: string }>(
      `SELECT m.id, m.origin, m.turn_id, m.thread_id FROM messages m
       JOIN threads th ON th.id = m.thread_id
       WHERE m.id = ? AND th.account_id = ?`,
      [messageId, accountId],
    );
    if (!msg || msg.origin !== "pending_approval") return false;
    db.run("UPDATE messages SET origin = 'send_message' WHERE id = ?", [msg.id]);
    if (msg.turn_id) {
      db.run("UPDATE turns SET sent_message_count = sent_message_count + 1 WHERE id = ?", [msg.turn_id]);
    }
    return true;
  });
}

export function rejectMessage(db: OpenbotDb, accountId: string, messageId: string): boolean {
  return db.immediate(() => {
    const msg = db.get<{ id: string; origin: string; thread_id: string; turn_id: string | null }>(
      `SELECT m.id, m.origin, m.thread_id, m.turn_id FROM messages m
       JOIN threads th ON th.id = m.thread_id
       WHERE m.id = ? AND th.account_id = ?`,
      [messageId, accountId],
    );
    if (!msg || msg.origin !== "pending_approval") return false;
    db.run("UPDATE messages SET origin = 'system', body = ? WHERE id = ?", [
      "You declined this send.",
      msg.id,
    ]);
    return true;
  });
}

export const SEND_MESSAGE_TOOL = {
  name: "SendMessage",
  description:
    "The only way to talk to the human. Call this to ask, report a result, report a blocker, or send status. Assistant text is a private work log and is not shown unless you fail to call this tool.",
  inputSchema: {
    type: "object",
    properties: {
      body: { type: "string", description: "Message shown to the human" },
      urgency: { type: "string", enum: ["normal", "needs_user"] },
    },
    required: ["body"],
  },
};

export const SEND_TO_AGENT_TOOL = {
  name: "SendToAgent",
  description:
    "Send work to another named bot on this desk. Async: returns immediately. Does not message the human. Use SendMessage to talk to the human.",
  inputSchema: {
    type: "object",
    properties: {
      botId: { type: "string" },
      name: { type: "string", description: "Active bot name on this account" },
      body: { type: "string" },
    },
    required: ["body"],
  },
};

export const SEND_TO_THREAD_TOOL = {
  name: "SendToThread",
  description:
    "Speak in a group thread. Default thread is the one this turn is on. SendMessage still DMs the human privately. SendToAgent is 1:1, not this group.",
  inputSchema: {
    type: "object",
    properties: {
      body: { type: "string", description: "Message shown in the group thread" },
      threadId: { type: "string", description: "Group thread id; defaults to this turn's thread" },
      name: { type: "string", description: "Group thread title" },
      urgency: { type: "string", enum: ["normal", "needs_user"] },
    },
    required: ["body"],
  },
};

export type McpHooks = { onKick?: () => void };

function coerceToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      return { body: raw };
    } catch {
      return { body: raw };
    }
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

function normalizeSendArgs(raw: unknown): unknown {
  const args = coerceToolArgs(raw);
  if (typeof args.body === "string" && args.body.trim()) return args;
  for (const key of ["message", "text", "content", "prompt"] as const) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return { ...args, body: v };
  }
  return args;
}

export function handleMcpJsonRpc(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  body: unknown,
  hooks?: McpHooks,
): { status: number; json: unknown } {
  const msg = body as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const idVal = msg?.id ?? null;
  const method = msg?.method ?? "";
  try {
    if (method === "initialize") {
      const requested = String(
        (msg.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "2025-03-26",
      );
      return {
        status: 200,
        json: {
          jsonrpc: "2.0",
          id: idVal,
          result: {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "openbot", version: "0.2.0" },
          },
        },
      };
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return { status: 202, json: {} };
    }
    if (method === "ping") {
      return { status: 200, json: { jsonrpc: "2.0", id: idVal, result: {} } };
    }
    if (method === "tools/list") {
      return {
        status: 200,
        json: {
          jsonrpc: "2.0",
          id: idVal,
          result: { tools: [SEND_MESSAGE_TOOL, SEND_TO_AGENT_TOOL, SEND_TO_THREAD_TOOL] },
        },
      };
    }
    if (method === "tools/call") {
      const name = String(msg.params?.name ?? "");
      const args = coerceToolArgs(msg.params?.arguments);
      let result: unknown;
      if (name === "SendMessage") {
        result = sendMessage(db, inflight, bearer, args);
      } else if (name === "SendToAgent") {
        result = sendToAgent(db, inflight, bearer, args);
        hooks?.onKick?.();
      } else if (name === "SendToThread") {
        result = sendToThread(db, inflight, bearer, args);
        hooks?.onKick?.();
      } else {
        throw new McpError("unknown_tool", `unknown tool ${name}`, 400);
      }
      return {
        status: 200,
        json: {
          jsonrpc: "2.0",
          id: idVal,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
          },
        },
      };
    }
    return {
      status: 200,
      json: {
        jsonrpc: "2.0",
        id: idVal,
        error: { code: -32601, message: `Method not found: ${method}` },
      },
    };
  } catch (err) {
    if (err instanceof McpError) {
      return {
        status: err.httpStatus,
        json: {
          jsonrpc: "2.0",
          id: idVal,
          error: { code: -32000, message: err.message, data: { code: err.code } },
        },
      };
    }
    throw err;
  }
}
