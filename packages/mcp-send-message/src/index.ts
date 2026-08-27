import type { KeyObject } from "node:crypto";
import {
  ensureThreadBridge,
  humanThread,
  id,
  MAX_ACTIVE_BOTS,
  now,
  orderedBotPair,
  sha256Hex,
  ThreadBridgeConflict,
  type McpTokenRow,
  type OpenbotDb,
  type OrgInboxRow,
  type TurnRow,
} from "@openbot/db";
import {
  McpError,
  createBotInput,
  inboxInput,
  sendMessageInput,
  sendToAgentInput,
  sendToOrgInput,
  sendToThreadInput,
  type SendMessageInput,
} from "@openbot/api-types";
import { signFedJws } from "@openbot/federation";
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
      const seriesFlag = db.get<{ require_human_approval: number }>(
        `SELECT s.require_human_approval
         FROM calendar_instances i
         JOIN calendar_series s ON s.id = i.series_id
         WHERE i.turn_id = ?`,
        [turn.id],
      );
      const park =
        input.urgency === "needs_user" ||
        Boolean(bot?.require_human_approval) ||
        Boolean(seriesFlag?.require_human_approval);
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
        const wanted = input.name?.trim() || input.botId || "that name";
        throw new McpError(
          "not_found",
          `target bot not found. "${wanted}" is not on this desk. Call ListBots to see names. Call CreateBot to hire a new teammate. Do not curl OpenBot HTTP or /auth/local.`,
          404,
        );
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

export type InboxItem = {
  id: string;
  fromSlug: string;
  fromOrg: string;
  preview: string;
  urgency: string;
};

export function inbox(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
): { ok: true; pending: InboxItem[]; acked?: string } {
  const input = parseOrThrow(inboxInput, coerceToolArgs(rawInput));
  const claims = verifyMcpToken(db, bearer);
  inflight.add(claims.harnessSessionId);
  try {
    return db.immediate(() => {
      const turn = lockRunningTurn(db, claims);
      if (!turn) throw new McpError("no_active_turn", "no running turn", 409);
      requireGateway(db, claims, "Inbox");
      let acked: string | undefined;
      if (input.ack) {
        const row = db.get<OrgInboxRow>("SELECT * FROM org_inbox WHERE id = ?", [input.ack]);
        if (!row || row.status !== "pending") {
          throw new McpError("not_found", "inbox item not found", 404);
        }
        const t = now();
        db.run(
          "UPDATE org_inbox SET status = 'acked', acked_at = ?, acked_turn_id = ? WHERE id = ? AND status = 'pending'",
          [t, turn.id, row.id],
        );
        acked = row.id;
      }
      const pending = listPendingInbox(db, input.limit ?? 20);
      return acked ? { ok: true as const, pending, acked } : { ok: true as const, pending };
    });
  } finally {
    inflight.remove(claims.harnessSessionId);
  }
}

export async function sendToOrg(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
  hooks?: McpHooks,
): Promise<{ ok: true; id: string; hop: 1 }> {
  const input = parseOrThrow(sendToOrgInput, normalizeSendArgs(rawInput));
  const claims = verifyMcpToken(db, bearer);
  inflight.add(claims.harnessSessionId);
  try {
    const prepared = db.immediate(() => {
      const turn = lockRunningTurn(db, claims);
      if (!turn) throw new McpError("no_active_turn", "no running turn", 409);
      const bot = requireGateway(db, claims, "SendToOrg");
      if (!federationIsOn(db, hooks)) {
        throw new McpError("federation_off", "federation is off", 409);
      }
      const org = currentOrg(db);
      if (!org) throw new McpError("federation_off", "federation is off", 409);
      const peer = lookupAllowedPeer(db, input.org);
      if (!peer) throw new McpError("not_found", "peer not found", 404);
      const dests = replyDestinations(db, turn.id);
      if (dests && !dests.has(peer.peer_org_id.toLowerCase())) {
        const human = humanThread(db, claims.botId);
        if (human) {
          insertMessage(db, {
            threadId: human.id,
            turnId: turn.id,
            role: "assistant",
            origin: "send_message",
            body: "cannot forward to a third org",
            fromBotId: claims.botId,
          });
          db.run("UPDATE turns SET sent_message_count = sent_message_count + 1 WHERE id = ?", [turn.id]);
        }
        writeFedAudit(db, claims.accountId, "fed.drop", {
          reason: "no_forward",
          toOrg: peer.peer_org_id,
        });
        return { kind: "no_forward" as const };
      }
      const sourceId = input.threadId ?? turn.thread_id;
      const source = db.get<{ id: string; kind: string; account_id: string }>(
        "SELECT id, kind, account_id FROM threads WHERE id = ?",
        [sourceId],
      );
      let threadHint: { kind: "bridge"; localThreadId: string; peerThreadId?: string } | undefined;
      if (source && source.kind === "group" && source.account_id === claims.accountId) {
        try {
          const bridge = ensureThreadBridge(db, {
            localThreadId: source.id,
            peerOrgId: peer.peer_org_id,
          });
          threadHint = {
            kind: "bridge",
            localThreadId: source.id,
            ...(bridge.peer_thread_id ? { peerThreadId: bridge.peer_thread_id } : {}),
          };
        } catch (err) {
          if (err instanceof ThreadBridgeConflict) {
            throw new McpError("conflict", err.message, 409);
          }
          throw err;
        }
      }
      // hop is a protocol constant; never increment (no A→B→C).
      const envelope = {
        id: id(),
        fromOrg: org.org_id,
        fromSlug: org.slug,
        fromActor: { type: "gateway" as const, name: bot.name, botId: claims.botId },
        toOrg: peer.peer_org_id,
        urgency: input.urgency ?? "normal",
        hop: 1 as const,
        createdAt: now(),
        body: input.body,
        ...(threadHint ? { threadHint } : {}),
      };
      return { kind: "send" as const, envelope, peer, org };
    });
    if (prepared.kind === "no_forward") {
      throw new McpError("no_forward", "cannot forward inbound mail to a third org", 409);
    }

    let privateKey: KeyObject;
    try {
      const loaded = hooks?.orgPrivateKey?.();
      if (!loaded) throw new Error("missing org key");
      privateKey = loaded;
    } catch {
      throw new McpError("no_org_key", "org key unavailable", 500);
    }

    const rawBody = JSON.stringify(prepared.envelope);
    const token = signFedJws({
      privateKey,
      fromOrgId: prepared.org.org_id,
      toOrgId: prepared.peer.peer_org_id,
      messageId: prepared.envelope.id,
      rawBody,
    });
    const url = `${prepared.peer.base_url}/fed/v1/messages`;
    let status = 0;
    try {
      const res = await (hooks?.fetchFed ?? fetch)(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": prepared.envelope.id,
        },
        body: rawBody,
        signal: AbortSignal.timeout(FED_POST_TIMEOUT_MS),
      });
      status = res.status;
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new McpError("timeout", "peer timed out", 504);
      }
      throw new McpError("outbound_failed", err instanceof Error ? err.message : "outbound failed", 502);
    }
    writeFedAudit(db, claims.accountId, "fed.outbound", {
      toOrg: prepared.peer.peer_org_id,
      jti: prepared.envelope.id,
      hop: 1,
      status,
    });
    if (status < 200 || status >= 300) {
      throw new McpError("peer_error", `peer HTTP ${status}`, 502);
    }
    return { ok: true, id: prepared.envelope.id, hop: 1 };
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
    "Send work to another named bot already on this desk. Async: returns immediately. Does not message the human. Use ListBots to see names. If they do not exist, CreateBot then SendToAgent. Do not curl OpenBot HTTP.",
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

export const SEND_TO_ORG_TOOL = {
  name: "SendToOrg",
  description:
    "Send a one-hop message to another org. Gateway only. hop is always 1. Do not forward inbound mail to a third org. Fails if federation is off.",
  inputSchema: {
    type: "object",
    properties: {
      org: { type: "string", description: "Peer unique slug or org uuid" },
      body: { type: "string" },
      urgency: { type: "string", enum: ["normal", "needs_user"] },
      threadId: { type: "string" },
    },
    required: ["org", "body"],
  },
};

export const INBOX_TOOL = {
  name: "Inbox",
  description:
    "List or ack pending inbound org mail. Gateway only. Ack binds to this running turn and does not enqueue another turn.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number" },
      ack: { type: "string", description: "org_inbox id to ack" },
    },
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

export const LIST_BOTS_TOOL = {
  name: "ListBots",
  description:
    "List active desk teammates and Gateway on this org. Use this before SendToAgent. Creating a bot is CreateBot, not this tool.",
  inputSchema: { type: "object", properties: {} },
};

export const CREATE_BOT_TOOL = {
  name: "CreateBot",
  description:
    "Hire a new desk teammate on this org (unique name, cap 6 desk bots). Desk bots only — not Gateway. After it returns, SendToAgent that name. Do not curl /auth/local or POST /v1/bots. Do not mint the human's session cookie.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Unique active name on this desk" },
      description: { type: "string", description: "Who they are / what they do" },
      model: { type: "string" },
      reasoningEffort: { type: "string", enum: ["low", "medium", "high", "extra high"] },
    },
    required: ["name"],
  },
};

export function mcpToolsForRole(role: string | null | undefined): unknown[] {
  const tools: unknown[] = [SEND_MESSAGE_TOOL, SEND_TO_AGENT_TOOL, SEND_TO_THREAD_TOOL, LIST_BOTS_TOOL];
  if (role === "gateway") tools.push(SEND_TO_ORG_TOOL, INBOX_TOOL);
  else tools.push(CREATE_BOT_TOOL);
  return tools;
}

function toolsForCaller(db: OpenbotDb, bearer: string | undefined): unknown[] {
  try {
    const claims = verifyMcpToken(db, bearer);
    return mcpToolsForRole(botRole(db, claims.botId)?.role);
  } catch {
    // Missing/invalid token: desk subset so SendToOrg is never advertised by default.
    return mcpToolsForRole("desk");
  }
}

export type McpHooks = {
  onKick?: () => void;
  federationEffective?: () => boolean;
  orgPrivateKey?: () => KeyObject;
  fetchFed?: typeof fetch;
  onCreateBot?: (bot: { accountId: string; botId: string; name: string }) => void | Promise<void>;
};

const INBOX_PREVIEW = 240;
const FED_POST_TIMEOUT_MS = 10_000;

type OrgPeerRow = {
  peer_org_id: string;
  slug: string;
  name: string;
  base_url: string;
  pubkey: string;
  status: string;
};

function parseOrThrow<T>(
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
  raw: unknown,
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new McpError("bad_request", "invalid input", 400);
  return parsed.data;
}

function botRole(db: OpenbotDb, botId: string): { role: string; name: string } | undefined {
  return db.get<{ role: string; name: string }>(
    "SELECT IFNULL(role, 'desk') AS role, name FROM bots WHERE id = ?",
    [botId],
  );
}

function requireGateway(db: OpenbotDb, claims: McpClaims, tool: string): { role: string; name: string } {
  const bot = botRole(db, claims.botId);
  if (!bot || bot.role !== "gateway") {
    throw new McpError("forbidden", `${tool} is Gateway only`, 403);
  }
  return bot;
}

function requireDesk(db: OpenbotDb, claims: McpClaims, tool: string): { role: string; name: string } {
  const bot = botRole(db, claims.botId);
  if (!bot) throw new McpError("not_found", "caller bot not found", 404);
  if (bot.role === "gateway") {
    throw new McpError("forbidden", `${tool} is desk only. Gateway does not hire teammates.`, 403);
  }
  return bot;
}

const RESERVED_GATEWAY_NAME = /^gateway(?:-\d+)?$/i;

function normalizeCreateBotArgs(raw: unknown): unknown {
  const args = coerceToolArgs(raw);
  if (typeof args.name === "string" && args.name.trim()) return args;
  for (const key of ["botName", "title", "agent"] as const) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return { ...args, name: v };
  }
  return args;
}

export function listBots(
  db: OpenbotDb,
  _inflight: McpInflight,
  bearer: string | undefined,
): { bots: Array<{ id: string; name: string; description: string }>; gateway: { id: string; name: string } | null } {
  const claims = verifyMcpToken(db, bearer);
  const rows = db.all<{ id: string; name: string; description: string; role: string }>(
    `SELECT id, name, description, IFNULL(role, 'desk') AS role
     FROM bots WHERE account_id = ? AND status = 'active' ORDER BY created_at`,
    [claims.accountId],
  );
  const bots = rows.filter((r) => r.role !== "gateway").map(({ id, name, description }) => ({ id, name, description }));
  const gw = rows.find((r) => r.role === "gateway");
  return { bots, gateway: gw ? { id: gw.id, name: gw.name } : null };
}

export async function createBot(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
  hooks?: McpHooks,
): Promise<{
  ok: true;
  botId: string;
  name: string;
  threadId: string;
  remainingDeskSlots: number;
  messageId: string;
}> {
  const claims = verifyMcpToken(db, bearer);
  const caller = requireDesk(db, claims, "CreateBot");
  const input = parseOrThrow(createBotInput, normalizeCreateBotArgs(rawInput));
  const name = input.name.trim();
  inflight.add(claims.harnessSessionId);
  try {
    let created: { accountId: string; botId: string; name: string } | undefined;
    const result = db.immediate(() => {
      const turn = lockRunningTurn(db, claims);
      if (!turn) throw new McpError("no_active_turn", "no running turn for this harness session", 409);
      if (RESERVED_GATEWAY_NAME.test(name)) {
        throw new McpError("reserved_name", "Gateway is auto-provisioned; pick another name", 409);
      }
      const activeDesk = db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM bots WHERE account_id = ? AND status = 'active' AND IFNULL(role, 'desk') = 'desk'",
        [claims.accountId],
      );
      if ((activeDesk?.n ?? 0) >= MAX_ACTIVE_BOTS) {
        throw new McpError("cap", `desk cap ${MAX_ACTIVE_BOTS} reached`, 409);
      }
      const dup = db.get(
        "SELECT id FROM bots WHERE account_id = ? AND status = 'active' AND lower(name) = lower(?)",
        [claims.accountId, name],
      );
      if (dup) throw new McpError("duplicate_name", `active bot named ${JSON.stringify(name)} already exists`, 409);

      const callerRow = db.get<{ model: string | null; reasoning_effort: string | null }>(
        "SELECT model, reasoning_effort FROM bots WHERE id = ?",
        [claims.botId],
      );
      const model = input.model?.trim() || callerRow?.model || "grok-4.6";
      const reasoningEffort = input.reasoningEffort || callerRow?.reasoning_effort || "high";
      const description = (input.description ?? "").trim() || `Teammate created by ${caller.name}.`;
      const botId = id();
      const threadId = id();
      const t = now();
      db.run(
        `INSERT INTO bots (id, account_id, name, description, status, permission_mode, model, reasoning_effort, role, created_at)
         VALUES (?, ?, ?, ?, 'active', 'auto', ?, ?, 'desk', ?)`,
        [botId, claims.accountId, name, description, model, reasoningEffort, t],
      );
      db.run(
        `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, 'New thread', 'human', ?)`,
        [threadId, claims.accountId, botId, t],
      );
      const human = humanThread(db, claims.botId);
      const notice = insertMessage(db, {
        threadId: human?.id ?? turn.thread_id,
        turnId: turn.id,
        role: "assistant",
        origin: "system",
        body: `Created teammate ${name}. Hand off with SendToAgent.`,
        fromBotId: claims.botId,
      });
      insertMessage(db, {
        threadId,
        turnId: null,
        role: "assistant",
        origin: "system",
        body: `Created by ${caller.name} via CreateBot.`,
        fromBotId: claims.botId,
      });
      db.run(
        `INSERT INTO audit_events (id, account_id, actor, type, payload, created_at)
         VALUES (?, ?, 'harness', 'create_bot', ?, ?)`,
        [
          id(),
          claims.accountId,
          JSON.stringify({ botId, name, by: claims.botId, turnId: turn.id }),
          t,
        ],
      );
      const after = db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM bots WHERE account_id = ? AND status = 'active' AND IFNULL(role, 'desk') = 'desk'",
        [claims.accountId],
      );
      created = { accountId: claims.accountId, botId, name };
      return {
        ok: true as const,
        botId,
        name,
        threadId,
        remainingDeskSlots: Math.max(0, MAX_ACTIVE_BOTS - (after?.n ?? 0)),
        messageId: notice.id,
      };
    });
    if (created) await hooks?.onCreateBot?.(created);
    return result;
  } finally {
    inflight.remove(claims.harnessSessionId);
  }
}

function federationIsOn(db: OpenbotDb, hooks?: McpHooks): boolean {
  if (hooks?.federationEffective) return hooks.federationEffective();
  const row = db.get<{ federation_enabled: number }>(
    "SELECT federation_enabled FROM org_meta WHERE id = 'current'",
  );
  if (!row || row.federation_enabled !== 1) return false;
  return process.env.OPENBOT_FEDERATION !== "0";
}

function currentOrg(db: OpenbotDb): { org_id: string; slug: string; name: string } | undefined {
  return db.get<{ org_id: string; slug: string; name: string }>(
    "SELECT org_id, slug, name FROM org_meta WHERE id = 'current'",
  );
}

function lookupAllowedPeer(db: OpenbotDb, org: string): OrgPeerRow | undefined {
  const raw = org.trim();
  if (!raw) return undefined;
  const byId = db.get<OrgPeerRow>(
    "SELECT * FROM org_peers WHERE peer_org_id = ? AND status = 'allowed'",
    [raw.toLowerCase()],
  );
  if (byId) return byId;
  return db.get<OrgPeerRow>(
    "SELECT * FROM org_peers WHERE lower(slug) = lower(?) AND status = 'allowed'",
    [raw],
  );
}

function writeFedAudit(
  db: OpenbotDb,
  accountId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  db.run(
    `INSERT INTO audit_events (id, account_id, actor, type, payload, created_at)
     VALUES (?, ?, 'federation', ?, ?, ?)`,
    [id(), accountId, type, JSON.stringify(payload), now()],
  );
}

function replyDestinations(db: OpenbotDb, turnId: string): Set<string> | null {
  const userRow = db.get<{ origin: string; remote_org_id: string | null }>(
    "SELECT origin, remote_org_id FROM messages WHERE turn_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1",
    [turnId],
  );
  if (!userRow) return null;
  if (userRow.origin !== "federation" && userRow.origin !== "prompt") return null;
  const allowed = new Set<string>();
  if (userRow.origin === "federation" && userRow.remote_org_id) {
    allowed.add(userRow.remote_org_id.toLowerCase());
  }
  const acked = db.all<{ from_org_id: string }>(
    "SELECT from_org_id FROM org_inbox WHERE acked_turn_id = ?",
    [turnId],
  );
  for (const row of acked) allowed.add(row.from_org_id.toLowerCase());
  return allowed;
}

function listPendingInbox(db: OpenbotDb, limit: number) {
  const rows = db.all<OrgInboxRow>(
    "SELECT * FROM org_inbox WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?",
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    fromSlug: r.from_slug,
    fromOrg: r.from_org_id,
    preview: r.body.length > INBOX_PREVIEW ? `${r.body.slice(0, INBOX_PREVIEW)}…` : r.body,
    urgency: r.urgency,
  }));
}

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

export async function handleMcpJsonRpc(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  body: unknown,
  hooks?: McpHooks,
): Promise<{ status: number; json: unknown }> {
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
            serverInfo: { name: "openbot", version: "0.3.0" },
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
        json: { jsonrpc: "2.0", id: idVal, result: { tools: toolsForCaller(db, bearer) } },
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
      } else if (name === "SendToOrg") {
        result = await sendToOrg(db, inflight, bearer, args, hooks);
      } else if (name === "Inbox") {
        result = inbox(db, inflight, bearer, args);
      } else if (name === "ListBots") {
        result = listBots(db, inflight, bearer);
      } else if (name === "CreateBot") {
        result = await createBot(db, inflight, bearer, args, hooks);
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
