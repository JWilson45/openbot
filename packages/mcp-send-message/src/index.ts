import type { KeyObject } from "node:crypto";
import {
  ensureThreadBridge,
  humanThread,
  id,
  isGatewayRole,
  MAX_ACTIVE_BOTS,
  now,
  nonCancelledSeriesCount,
  orderedBotPair,
  rematerializeScheduledInstances,
  sha256Hex,
  suppressOpenCalendarInstances,
  ThreadBridgeConflict,
  type McpTokenRow,
  type OpenbotDb,
  type OrgInboxRow,
  type TurnRow,
} from "@openbot/db";
import {
  McpError,
  createBotInput,
  browserSnapshotInput,
  clickBrowserInput,
  confirmSeriesInput,
  createEventInput,
  inboxInput,
  navigateBrowserInput,
  typeBrowserInput,
  waitBrowserInput,
  listCalendarInput,
  pauseSeriesInput,
  proposeRoutineInput,
  sendMessageInput,
  sendToAgentInput,
  sendToOrgInput,
  sendToThreadInput,
  type McpErrorCode,
  type SendMessageInput,
} from "@openbot/api-types";
import {
  CAL_CREATE_PER_HOUR,
  CAL_CREATE_PER_TURN,
  CAL_MAX_SERIES,
  CAL_MIN_INTERVAL_MS,
  RruleError,
  isValidTimeZone,
  localNineTomorrow,
  parseCalendarDtstart,
  parseRrule,
} from "@openbot/calendar";
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

function sendToAgentNotFound(input: { botId?: string; name?: string }): McpError {
  const wanted = input.name?.trim() || input.botId || "that name";
  return new McpError(
    "not_found",
    `target bot not found. "${wanted}" is not on this desk. Call CreateBot to hire a new teammate. Do not curl OpenBot HTTP or /auth/local.`,
    404,
  );
}

function sendToAgentArchived(name: string): McpError {
  return new McpError(
    "target_archived",
    `"${name}" is archived. Restore them or pick a live teammate.`,
    409,
  );
}

function resolveSendToAgentTarget(
  db: OpenbotDb,
  accountId: string,
  input: { botId?: string; name?: string },
): { id: string; name: string } {
  if (input.botId) {
    const row = db.get<{ id: string; name: string; status: string }>(
      "SELECT id, name, status FROM bots WHERE id = ? AND account_id = ?",
      [input.botId, accountId],
    );
    if (!row) throw sendToAgentNotFound(input);
    if (row.status === "archived") throw sendToAgentArchived(row.name);
    if (row.status !== "active") throw sendToAgentNotFound(input);
    return row;
  }
  const active = db.get<{ id: string; name: string }>(
    "SELECT id, name FROM bots WHERE account_id = ? AND status = 'active' AND lower(name) = lower(?)",
    [accountId, input.name!],
  );
  if (active) return active;
  const archived = db.get<{ id: string; name: string }>(
    `SELECT id, name FROM bots
     WHERE account_id = ? AND status = 'archived' AND lower(name) = lower(?)
     ORDER BY archived_at DESC LIMIT 1`,
    [accountId, input.name!],
  );
  if (archived) throw sendToAgentArchived(archived.name);
  throw sendToAgentNotFound(input);
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

      const target = resolveSendToAgentTarget(db, claims.accountId, input);
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
    "Send work to another named bot already on this desk. Compose a message for them; do not forward the human verbatim. Async: queued, not done — this turn is not resumed with their result. Completions land on the 1:1 handoff as a system line. Does not message the human. Typed errors: not_found, target_archived, target_busy. If they do not exist, CreateBot then SendToAgent. Do not curl OpenBot HTTP.",
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
    "Fallback roster lookup if the overlay is missing. Prefer the names already in your identity overlay. Creating a bot is CreateBot, not this tool.",
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

export const LIST_CALENDAR_TOOL = {
  name: "ListCalendar",
  description:
    "List this org's calendar series (title, kind, status, next fire, assignee). Proposed series do not fire (nextFire is null) until ConfirmSeries or Calendar Confirm. Use before CreateEvent.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["proposed", "active", "paused", "cancelled"] },
      kind: { type: "string", enum: ["schedule", "routine"] },
    },
  },
};

export const CREATE_EVENT_TOOL = {
  name: "CreateEvent",
  description:
    "Create a calendar schedule (one-shot or recurring) for a desk bot (you or another). Always status=proposed — it does not fire until ConfirmSeries (after the human agrees in chat) or they Confirm in Calendar. Never auto-activates. Min interval 2 minutes. Cap 32 non-cancelled series. SendMessage urgency=normal when telling them it is waiting. Do not curl OpenBot HTTP.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      prompt: { type: "string", description: "Work the assignee does when it fires" },
      botId: { type: "string" },
      name: { type: "string", description: "Assignee desk bot name" },
      dtstart: { type: "string", description: "ISO-8601 instant or local civil time" },
      timezone: { type: "string", description: "IANA tz; default org timezone" },
      rrule: { type: "string", description: "RFC 5545 subset; omit for one-shot" },
      threadId: { type: "string" },
      requireHumanApproval: { type: "boolean" },
    },
    required: ["title", "prompt"],
  },
};

export const PROPOSE_ROUTINE_TOOL = {
  name: "ProposeRoutine",
  description:
    "Draft a learned routine on the calendar as status=proposed. The human must confirm in Calendar. Not a CDP replay. Not CreateEvent.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      prompt: { type: "string" },
      botId: { type: "string" },
      name: { type: "string" },
      rrule: { type: "string" },
      dtstart: { type: "string" },
      timezone: { type: "string" },
      threadId: { type: "string" },
    },
    required: ["title", "prompt"],
  },
};

export const PAUSE_SERIES_TOOL = {
  name: "PauseSeries",
  description:
    "Pause or resume a calendar series by id. Pausing skips future fires. The human can also pause in the UI.",
  inputSchema: {
    type: "object",
    properties: {
      seriesId: { type: "string" },
      paused: { type: "boolean" },
    },
    required: ["seriesId", "paused"],
  },
};

export const NAVIGATE_TOOL = {
  name: "Navigate",
  description:
    "Open a URL in YOUR tab of the shared desk Chromium (cookies shared, one tab per desk bot). http(s) only. Then call BrowserSnapshot. Takeover is a separate human tab and does not block you.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "http(s) URL" } },
    required: ["url"],
  },
};

export const BROWSER_SNAPSHOT_TOOL = {
  name: "BrowserSnapshot",
  description:
    "Read YOUR tab of the shared desk Chromium (URL, title, visible text, max 12k). Not the human Takeover tab. Prefer this plus Click/Type over raw CDP.",
  inputSchema: { type: "object", properties: {} },
};

export const CLICK_TOOL = {
  name: "Click",
  description:
    "Click a control in YOUR tab of the shared desk Chromium. Pass visible text (preferred) or a CSS selector. nth picks among matches (0-based). Then BrowserSnapshot.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Visible label, e.g. Add to Cart" },
      selector: { type: "string", description: "CSS selector" },
      nth: { type: "number", description: "Which match, default 0" },
    },
  },
};

export const TYPE_TOOL = {
  name: "Type",
  description:
    "Type into the focused field in YOUR tab of the shared desk Chromium. Click the field first. clear=true empties it first. submit=true presses Enter.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      clear: { type: "boolean" },
      submit: { type: "boolean" },
    },
    required: ["text"],
  },
};

export const WAIT_TOOL = {
  name: "Wait",
  description:
    "Pause this turn so the shared page can settle after Click/Navigate. ms 0–15000, default 800.",
  inputSchema: {
    type: "object",
    properties: { ms: { type: "number", description: "Milliseconds, default 800" } },
  },
};

export const CONFIRM_SERIES_TOOL = {
  name: "ConfirmSeries",
  description:
    "Activate a proposed calendar series so it starts firing. Use when the human agrees in this thread (e.g. 'approved', 'confirm it'). Do not use SendMessage urgency=needs_user for calendar confirm. seriesId from ListCalendar or CreateEvent.",
  inputSchema: {
    type: "object",
    properties: {
      seriesId: { type: "string" },
    },
    required: ["seriesId"],
  },
};

export function mcpToolsForRole(role: string | null | undefined): unknown[] {
  const tools: unknown[] = [SEND_MESSAGE_TOOL, SEND_TO_AGENT_TOOL, SEND_TO_THREAD_TOOL, LIST_BOTS_TOOL];
  if (role === "gateway") tools.push(SEND_TO_ORG_TOOL, INBOX_TOOL);
  else
    tools.push(
      CREATE_BOT_TOOL,
      LIST_CALENDAR_TOOL,
      CREATE_EVENT_TOOL,
      PROPOSE_ROUTINE_TOOL,
      CONFIRM_SERIES_TOOL,
      PAUSE_SERIES_TOOL,
      NAVIGATE_TOOL,
      BROWSER_SNAPSHOT_TOOL,
      CLICK_TOOL,
      TYPE_TOOL,
      WAIT_TOOL,
    );
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
  onCalendarDue?: () => void;
  browserNavigate?: (
    accountId: string,
    botId: string,
    url: string,
  ) => Promise<{ ok: boolean; title?: string; error?: string }>;
  browserSnapshot?: (accountId: string, botId: string) => Promise<{
    ok: boolean;
    url?: string;
    title?: string;
    text?: string;
    error?: string;
  }>;
  browserClick?: (
    accountId: string,
    botId: string,
    input: { text?: string; selector?: string; nth?: number },
  ) => Promise<{ ok: boolean; text?: string; tag?: string; count?: number; error?: string }>;
  browserType?: (
    accountId: string,
    botId: string,
    input: { text: string; clear?: boolean; submit?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
  browserWait?: (accountId: string, botId: string, ms: number) => Promise<{ ok: boolean; ms?: number; error?: string }>;
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

function listActiveBotRows(db: OpenbotDb, accountId: string) {
  return db.all<{ id: string; name: string; description: string; role: string }>(
    `SELECT id, name, description, IFNULL(role, 'desk') AS role
     FROM bots WHERE account_id = ? AND status = 'active' ORDER BY created_at`,
    [accountId],
  );
}

export function loadOverlayRoster(
  db: OpenbotDb,
  accountId: string,
): {
  desks: Array<{ name: string; description: string }>;
  gateway: { name: string; description: string } | null;
} {
  const rows = listActiveBotRows(db, accountId);
  const desks = rows
    .filter((r) => r.role !== "gateway")
    .slice(0, MAX_ACTIVE_BOTS)
    .map(({ name, description }) => ({ name, description }));
  const gw = rows.find((r) => r.role === "gateway");
  return { desks, gateway: gw ? { name: gw.name, description: gw.description } : null };
}

export function listBots(
  db: OpenbotDb,
  _inflight: McpInflight,
  bearer: string | undefined,
): { bots: Array<{ id: string; name: string; description: string }>; gateway: { id: string; name: string } | null } {
  const claims = verifyMcpToken(db, bearer);
  const rows = listActiveBotRows(db, claims.accountId);
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

type CalendarSeriesRow = {
  id: string;
  account_id: string;
  title: string;
  prompt: string;
  assignee_bot_id: string | null;
  thread_id: string | null;
  kind: string;
  status: string;
  rrule: string | null;
  dtstart_utc: number;
  timezone: string;
  require_human_approval: number;
  created_by: string;
  created_by_bot_id: string | null;
  source_turn_id: string | null;
  source_thread_id: string | null;
  capture_summary: string | null;
  min_interval_ms: number;
  last_fired_at: number | null;
  next_due_at: number | null;
  created_at: number;
  updated_at: number;
};

function emptyToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = value.trim();
  return t ? t : null;
}

function orgTimezone(db: OpenbotDb): string {
  return db.get<{ timezone: string }>("SELECT timezone FROM org_meta WHERE id = 'current'")?.timezone ?? "UTC";
}

function isCalendarFiringThreadKind(kind: string | null | undefined): boolean {
  const k = kind || "human";
  return k === "human" || k === "group";
}

function countCalendarCreatesHourly(db: OpenbotDb, accountId: string): number {
  return (
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events
        WHERE type = 'calendar.create' AND account_id = ? AND created_at > ?`,
      [accountId, now() - 60 * 60 * 1000],
    )?.n ?? 0
  );
}

function countCalendarCreatesThisTurn(db: OpenbotDb, accountId: string, turnId: string): number {
  return (
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events
        WHERE type = 'calendar.create' AND account_id = ? AND json_extract(payload, '$.turnId') = ?`,
      [accountId, turnId],
    )?.n ?? 0
  );
}

function resolveMcpCalendarAssignee(
  db: OpenbotDb,
  claims: McpClaims,
  input: { botId?: string; name?: string },
): { id: string; name: string; require_human_approval: number } {
  const bot = input.botId
    ? db.get<{
        id: string;
        name: string;
        status: string;
        role: string | null;
        require_human_approval: number;
      }>("SELECT id, name, status, role, require_human_approval FROM bots WHERE id = ? AND account_id = ?", [
        input.botId,
        claims.accountId,
      ])
    : input.name
      ? db.get<{
          id: string;
          name: string;
          status: string;
          role: string | null;
          require_human_approval: number;
        }>(
          `SELECT id, name, status, role, require_human_approval FROM bots
           WHERE account_id = ? AND status = 'active' AND lower(name) = lower(?)`,
          [claims.accountId, input.name],
        )
      : db.get<{
          id: string;
          name: string;
          status: string;
          role: string | null;
          require_human_approval: number;
        }>("SELECT id, name, status, role, require_human_approval FROM bots WHERE id = ?", [claims.botId]);
  if (!bot) throw new McpError("not_found", "assignee bot not found", 404);
  if (isGatewayRole(bot.role)) throw new McpError("forbidden", "cannot target Gateway", 403);
  if (bot.status !== "active") throw new McpError("invalid_assignee", "assignee is not an active desk bot", 400);
  return { id: bot.id, name: bot.name, require_human_approval: bot.require_human_approval };
}

function resolveMcpCalendarThread(db: OpenbotDb, accountId: string, threadId: string): { id: string; kind: string } {
  const thread = db.get<{ id: string; kind: string; account_id: string }>(
    "SELECT id, kind, account_id FROM threads WHERE id = ?",
    [threadId],
  );
  if (!thread || thread.account_id !== accountId) throw new McpError("not_found", "thread not found", 404);
  if (!isCalendarFiringThreadKind(thread.kind)) {
    throw new McpError("invalid_thread", "calendar thread must be a human DM or group", 400);
  }
  return { id: thread.id, kind: thread.kind };
}

export function listCalendar(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
): {
  ok: true;
  timezone: string;
  series: Array<{
    id: string;
    title: string;
    kind: string;
    status: string;
    nextFire: number | null;
    assigneeBotId: string | null;
    assigneeName: string | null;
  }>;
} {
  const input = parseOrThrow(listCalendarInput, coerceToolArgs(rawInput));
  const claims = verifyMcpToken(db, bearer);
  inflight.add(claims.harnessSessionId);
  try {
    requireDesk(db, claims, "ListCalendar");
    const turn = lockRunningTurn(db, claims);
    if (!turn) throw new McpError("no_active_turn", "no running turn for this harness session", 409);
    const rows = db.all<{
      id: string;
      title: string;
      kind: string;
      status: string;
      next_due_at: number | null;
      assignee_bot_id: string | null;
      assignee_name: string | null;
    }>(
      `SELECT s.id, s.title, s.kind, s.status, s.next_due_at, s.assignee_bot_id, b.name AS assignee_name
       FROM calendar_series s
       LEFT JOIN bots b ON b.id = s.assignee_bot_id
       WHERE s.account_id = ?
         AND (? IS NULL OR s.status = ?)
         AND (? IS NULL OR s.kind = ?)
       ORDER BY s.created_at, s.id`,
      [claims.accountId, input.status ?? null, input.status ?? null, input.kind ?? null, input.kind ?? null],
    );
    return {
      ok: true,
      timezone: orgTimezone(db),
      series: rows.map((row) => ({
        id: row.id,
        title: row.title,
        kind: row.kind,
        status: row.status,
        nextFire: row.status === "active" ? row.next_due_at : null,
        assigneeBotId: row.assignee_bot_id,
        assigneeName: row.assignee_name,
      })),
    };
  } finally {
    inflight.remove(claims.harnessSessionId);
  }
}

function insertProposedSeries(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
  opts: { tool: "CreateEvent" | "ProposeRoutine"; kind: "schedule" | "routine" },
): { ok: true; seriesId: string; status: "proposed"; kind: "schedule" | "routine"; threadId: string; assigneeBotId: string } {
  const input = parseOrThrow(opts.tool === "CreateEvent" ? createEventInput : proposeRoutineInput, coerceToolArgs(rawInput));
  const claims = verifyMcpToken(db, bearer);
  requireDesk(db, claims, opts.tool);
  inflight.add(claims.harnessSessionId);
  try {
    return db.immediate(() => {
      const turn = lockRunningTurn(db, claims);
      if (!turn) throw new McpError("no_active_turn", "no running turn for this harness session", 409);
      if (countCalendarCreatesThisTurn(db, claims.accountId, turn.id) >= CAL_CREATE_PER_TURN) {
        throw new McpError("rate_limited", "per-turn calendar create limit", 429);
      }
      if (countCalendarCreatesHourly(db, claims.accountId) >= CAL_CREATE_PER_HOUR) {
        throw new McpError("rate_limited", "hourly calendar create limit", 429);
      }
      const assignee = resolveMcpCalendarAssignee(db, claims, input);
      const thread = resolveMcpCalendarThread(db, claims.accountId, input.threadId ?? turn.thread_id);
      const timezone = (input.timezone ?? orgTimezone(db)).trim();
      if (!isValidTimeZone(timezone)) throw new McpError("invalid_timezone", "invalid timezone", 400);
      const rrule = emptyToNull(input.rrule);
      if (rrule) {
        try {
          parseRrule(rrule);
        } catch (err) {
          const code = (err instanceof RruleError ? err.code : "invalid_rrule") as McpErrorCode;
          throw new McpError(code, code, 400);
        }
      }
      let dtstartUtc: number;
      try {
        dtstartUtc =
          input.dtstart != null ? parseCalendarDtstart(input.dtstart, timezone) : localNineTomorrow(timezone, now());
      } catch (err) {
        const code = (err instanceof RruleError ? err.code : "invalid_dtstart") as McpErrorCode;
        throw new McpError(code, code, 400);
      }
      if (nonCancelledSeriesCount(db, claims.accountId) >= CAL_MAX_SERIES) {
        throw new McpError("cap", `calendar cap ${CAL_MAX_SERIES} reached`, 409);
      }
      const requireHuman =
        Boolean("requireHumanApproval" in input && input.requireHumanApproval) ||
        thread.kind === "group" ||
        Boolean(assignee.require_human_approval);
      const seriesId = id();
      const t = now();
      db.run(
        `INSERT INTO calendar_series (
           id, account_id, title, prompt, assignee_bot_id, thread_id, kind, status, rrule,
           dtstart_utc, timezone, require_human_approval, created_by, created_by_bot_id,
           source_turn_id, source_thread_id, min_interval_ms, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, 'bot', ?, ?, ?, ?, ?, ?)`,
        [
          seriesId,
          claims.accountId,
          input.title,
          input.prompt,
          assignee.id,
          thread.id,
          opts.kind,
          rrule,
          dtstartUtc,
          timezone,
          requireHuman ? 1 : 0,
          claims.botId,
          turn.id,
          thread.id,
          CAL_MIN_INTERVAL_MS,
          t,
          t,
        ],
      );
      db.run(
        `INSERT INTO audit_events (id, account_id, actor, type, payload, created_at)
         VALUES (?, ?, 'harness', 'calendar.create', ?, ?)`,
        [
          id(),
          claims.accountId,
          JSON.stringify({ seriesId, title: input.title.slice(0, 200), turnId: turn.id, kind: opts.kind }),
          t,
        ],
      );
      return {
        ok: true as const,
        seriesId,
        status: "proposed" as const,
        kind: opts.kind,
        threadId: thread.id,
        assigneeBotId: assignee.id,
      };
    });
  } finally {
    inflight.remove(claims.harnessSessionId);
  }
}

export function createEvent(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
): { ok: true; seriesId: string; status: "proposed"; kind: "schedule"; threadId: string; assigneeBotId: string } {
  const result = insertProposedSeries(db, inflight, bearer, rawInput, { tool: "CreateEvent", kind: "schedule" });
  return { ...result, kind: "schedule" };
}

export function proposeRoutine(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
): { ok: true; seriesId: string; status: "proposed"; kind: "routine"; threadId: string; assigneeBotId: string } {
  const result = insertProposedSeries(db, inflight, bearer, rawInput, { tool: "ProposeRoutine", kind: "routine" });
  return { ...result, kind: "routine" };
}

export function pauseSeries(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
  hooks?: McpHooks,
): { ok: true; seriesId: string; status: string } {
  const input = parseOrThrow(pauseSeriesInput, coerceToolArgs(rawInput));
  const claims = verifyMcpToken(db, bearer);
  requireDesk(db, claims, "PauseSeries");
  inflight.add(claims.harnessSessionId);
  try {
    let tick = false;
    const result = db.immediate(() => {
      const turn = lockRunningTurn(db, claims);
      if (!turn) throw new McpError("no_active_turn", "no running turn for this harness session", 409);
      const series = db.get<CalendarSeriesRow>("SELECT * FROM calendar_series WHERE id = ? AND account_id = ?", [
        input.seriesId,
        claims.accountId,
      ]);
      if (!series) throw new McpError("not_found", "series not found", 404);
      if (input.paused) {
        if (series.status === "paused") {
          return { ok: true as const, seriesId: series.id, status: "paused" };
        }
        if (series.status === "cancelled") throw new McpError("cancelled", "series is cancelled", 409);
        if (series.status !== "active") {
          throw new McpError("not_active", "only an active series can be paused", 409);
        }
        db.run(`UPDATE calendar_series SET status = 'paused', updated_at = ? WHERE id = ?`, [now(), series.id]);
        suppressOpenCalendarInstances(db, series.id, "pause");
      } else {
        if (series.status === "active") {
          return { ok: true as const, seriesId: series.id, status: "active" };
        }
        if (series.status !== "paused") throw new McpError("not_paused", "series is not paused", 409);
        if (nonCancelledSeriesCount(db, claims.accountId, series.id) >= CAL_MAX_SERIES) {
          throw new McpError("cap", `calendar cap ${CAL_MAX_SERIES} reached`, 409);
        }
        db.run(`UPDATE calendar_series SET status = 'active', updated_at = ? WHERE id = ?`, [now(), series.id]);
        const updated = db.get<CalendarSeriesRow>("SELECT * FROM calendar_series WHERE id = ?", [series.id]);
        if (updated) rematerializeScheduledInstances(db, updated);
        tick = true;
      }
      const after = db.get<CalendarSeriesRow>("SELECT * FROM calendar_series WHERE id = ?", [series.id]);
      db.run(
        `INSERT INTO audit_events (id, account_id, actor, type, payload, created_at)
         VALUES (?, ?, 'harness', 'calendar.pause', ?, ?)`,
        [id(), claims.accountId, JSON.stringify({ seriesId: series.id, paused: input.paused }), now()],
      );
      return { ok: true as const, seriesId: series.id, status: after?.status ?? series.status };
    });
    if (tick) hooks?.onCalendarDue?.();
    return result;
  } finally {
    inflight.remove(claims.harnessSessionId);
  }
}

export function confirmSeries(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
  hooks?: McpHooks,
): { ok: true; seriesId: string; status: "active"; nextFire: number | null } {
  const input = parseOrThrow(confirmSeriesInput, coerceToolArgs(rawInput));
  const claims = verifyMcpToken(db, bearer);
  requireDesk(db, claims, "ConfirmSeries");
  inflight.add(claims.harnessSessionId);
  try {
    const result = db.immediate(() => {
      const turn = lockRunningTurn(db, claims);
      if (!turn) throw new McpError("no_active_turn", "no running turn for this harness session", 409);
      const series = db.get<CalendarSeriesRow>("SELECT * FROM calendar_series WHERE id = ? AND account_id = ?", [
        input.seriesId,
        claims.accountId,
      ]);
      if (!series) throw new McpError("not_found", "series not found", 404);
      if (series.status === "active") {
        return { ok: true as const, seriesId: series.id, status: "active" as const, nextFire: series.next_due_at };
      }
      if (series.status !== "proposed") throw new McpError("not_proposed", "series is not proposed", 409);
      if (series.assignee_bot_id !== claims.botId && series.created_by_bot_id !== claims.botId) {
        throw new McpError("forbidden", "ConfirmSeries is for series you own or created", 403);
      }
      if (nonCancelledSeriesCount(db, claims.accountId, series.id) >= CAL_MAX_SERIES) {
        throw new McpError("cap", `calendar cap ${CAL_MAX_SERIES} reached`, 409);
      }
      db.run(`UPDATE calendar_series SET status = 'active', updated_at = ? WHERE id = ?`, [now(), series.id]);
      const updated = db.get<CalendarSeriesRow>("SELECT * FROM calendar_series WHERE id = ?", [series.id]);
      if (updated) rematerializeScheduledInstances(db, updated);
      const after = db.get<CalendarSeriesRow>("SELECT * FROM calendar_series WHERE id = ?", [series.id]);
      db.run(
        `INSERT INTO audit_events (id, account_id, actor, type, payload, created_at)
         VALUES (?, ?, 'harness', 'calendar.confirm', ?, ?)`,
        [id(), claims.accountId, JSON.stringify({ seriesId: series.id, turnId: turn.id }), now()],
      );
      return {
        ok: true as const,
        seriesId: series.id,
        status: "active" as const,
        nextFire: after?.next_due_at ?? null,
      };
    });
    hooks?.onCalendarDue?.();
    return result;
  } finally {
    inflight.remove(claims.harnessSessionId);
  }
}

function httpUrlOrInvalid(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return raw;
  } catch {
    return null;
  }
}

export async function navigateBrowser(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
  hooks?: McpHooks,
): Promise<{ ok: boolean; title?: string; error?: string }> {
  const input = parseOrThrow(navigateBrowserInput, coerceToolArgs(rawInput));
  const claims = verifyMcpToken(db, bearer);
  requireDesk(db, claims, "Navigate");
  inflight.add(claims.harnessSessionId);
  try {
    const turn = lockRunningTurn(db, claims);
    if (!turn) throw new McpError("no_active_turn", "no running turn for this harness session", 409);
    const url = httpUrlOrInvalid(input.url.trim());
    if (!url) return { ok: false, error: "invalid_url" };
    if (!hooks?.browserNavigate) return { ok: false, error: "browser_unavailable" };
    return await hooks.browserNavigate(claims.accountId, claims.botId, url);
  } finally {
    inflight.remove(claims.harnessSessionId);
  }
}

export async function browserSnapshot(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
  hooks?: McpHooks,
): Promise<{ ok: boolean; url?: string; title?: string; text?: string; error?: string }> {
  parseOrThrow(browserSnapshotInput, coerceToolArgs(rawInput));
  const claims = verifyMcpToken(db, bearer);
  requireDesk(db, claims, "BrowserSnapshot");
  inflight.add(claims.harnessSessionId);
  try {
    const turn = lockRunningTurn(db, claims);
    if (!turn) throw new McpError("no_active_turn", "no running turn for this harness session", 409);
    if (!hooks?.browserSnapshot) return { ok: false, error: "browser_unavailable" };
    return await hooks.browserSnapshot(claims.accountId, claims.botId);
  } finally {
    inflight.remove(claims.harnessSessionId);
  }
}

export async function clickBrowser(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
  hooks?: McpHooks,
): Promise<{ ok: boolean; text?: string; tag?: string; count?: number; error?: string }> {
  const input = parseOrThrow(clickBrowserInput, coerceToolArgs(rawInput));
  const claims = verifyMcpToken(db, bearer);
  requireDesk(db, claims, "Click");
  inflight.add(claims.harnessSessionId);
  try {
    const turn = lockRunningTurn(db, claims);
    if (!turn) throw new McpError("no_active_turn", "no running turn for this harness session", 409);
    if (!hooks?.browserClick) return { ok: false, error: "browser_unavailable" };
    return await hooks.browserClick(claims.accountId, claims.botId, {
      text: input.text,
      selector: input.selector,
      nth: input.nth,
    });
  } finally {
    inflight.remove(claims.harnessSessionId);
  }
}

export async function typeBrowser(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
  hooks?: McpHooks,
): Promise<{ ok: boolean; error?: string }> {
  const input = parseOrThrow(typeBrowserInput, coerceToolArgs(rawInput));
  const claims = verifyMcpToken(db, bearer);
  requireDesk(db, claims, "Type");
  inflight.add(claims.harnessSessionId);
  try {
    const turn = lockRunningTurn(db, claims);
    if (!turn) throw new McpError("no_active_turn", "no running turn for this harness session", 409);
    if (!hooks?.browserType) return { ok: false, error: "browser_unavailable" };
    return await hooks.browserType(claims.accountId, claims.botId, {
      text: input.text,
      clear: input.clear,
      submit: input.submit,
    });
  } finally {
    inflight.remove(claims.harnessSessionId);
  }
}

export async function waitBrowser(
  db: OpenbotDb,
  inflight: McpInflight,
  bearer: string | undefined,
  rawInput: unknown,
  hooks?: McpHooks,
): Promise<{ ok: boolean; ms?: number; error?: string }> {
  const input = parseOrThrow(waitBrowserInput, coerceToolArgs(rawInput));
  const claims = verifyMcpToken(db, bearer);
  requireDesk(db, claims, "Wait");
  inflight.add(claims.harnessSessionId);
  try {
    const turn = lockRunningTurn(db, claims);
    if (!turn) throw new McpError("no_active_turn", "no running turn for this harness session", 409);
    const ms = input.ms ?? 800;
    if (!hooks?.browserWait) {
      await Bun.sleep(ms);
      return { ok: true, ms };
    }
    return await hooks.browserWait(claims.accountId, claims.botId, ms);
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
            serverInfo: { name: "openbot", version: "0.6.0" },
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
      } else if (name === "ListCalendar") {
        result = listCalendar(db, inflight, bearer, args);
      } else if (name === "CreateEvent") {
        result = createEvent(db, inflight, bearer, args);
      } else if (name === "ProposeRoutine") {
        result = proposeRoutine(db, inflight, bearer, args);
      } else if (name === "PauseSeries") {
        result = pauseSeries(db, inflight, bearer, args, hooks);
      } else if (name === "ConfirmSeries") {
        result = confirmSeries(db, inflight, bearer, args, hooks);
      } else if (name === "Navigate") {
        result = await navigateBrowser(db, inflight, bearer, args, hooks);
      } else if (name === "BrowserSnapshot") {
        result = await browserSnapshot(db, inflight, bearer, args, hooks);
      } else if (name === "Click") {
        result = await clickBrowser(db, inflight, bearer, args, hooks);
      } else if (name === "Type") {
        result = await typeBrowser(db, inflight, bearer, args, hooks);
      } else if (name === "Wait") {
        result = await waitBrowser(db, inflight, bearer, args, hooks);
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
          error: {
            code: -32000,
            message: err.message.startsWith(err.code + ":") ? err.message : `${err.code}: ${err.message}`,
            data: { code: err.code },
          },
        },
      };
    }
    throw err;
  }
}
