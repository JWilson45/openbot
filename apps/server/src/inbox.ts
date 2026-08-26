import {
  FED_RATE_INSTANCE_HOUR,
  FED_RATE_PEER_HOUR,
  FED_RATE_WINDOW_MS,
  humanThread,
  id,
  now,
  type MessageRow,
  type OpenbotDb,
  type OrgSolicitRow,
} from "@openbot/db";
import { fedMessageEnvelope, type FedMessageEnvelope } from "@openbot/api-types";
import { insertMessage } from "@openbot/live-work";
import { parseBearer } from "@openbot/auth";
import {
  decodeFedJws,
  FED_MAX_REQUEST_BYTES,
  FedJwsError,
  verifyFedJws,
} from "@openbot/federation";
import { currentOrgMeta, federationEffective, getOrgPeer, type OrgPeerRow } from "./org.ts";
import { findActiveGateway } from "./gateway.ts";

export const FED_SOLICIT_WINDOW_MS = 60 * 60 * 1000;
const AUDIT_CAP = 2000;
const ATTACHMENT_KEYS = new Set(["attachments", "files", "media", "binary"]);

export type FedInboundResult = {
  status: number;
  body: Record<string, unknown>;
  kick: boolean;
  accountId: string | null;
  push: MessageRow[];
};

export function parseContentLength(header: string | undefined | null): number | null {
  if (header == null) return null;
  const t = header.trim();
  if (!t || !/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export async function readCappedBody(req: Request, max = FED_MAX_REQUEST_BYTES): Promise<Uint8Array | "too_large"> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return "too_large";
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  if (chunks.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function gatewayHasActiveTurn(db: OpenbotDb, gatewayBotId: string): boolean {
  return Boolean(
    db.get(
      "SELECT id FROM turns WHERE bot_id = ? AND status IN ('queued', 'running') LIMIT 1",
      [gatewayBotId],
    ),
  );
}

export function pendingInboxCount(db: OpenbotDb): number {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM org_inbox WHERE status = 'pending'")?.n ?? 0;
}

export function pendingInboxIds(db: OpenbotDb, limit = 100): string[] {
  return db
    .all<{ id: string }>(
      "SELECT id FROM org_inbox WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?",
      [limit],
    )
    .map((r) => r.id);
}

function canon(value: string): string {
  return value.trim().toLowerCase();
}

function ipBucket(addr: string): string {
  const a = addr.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = a.startsWith("::ffff:") ? a.slice(7) : a;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped);
  if (v4) return `ip:${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  return `ip:${a || "unknown"}`;
}

function writeAudit(
  db: OpenbotDb,
  accountId: string | null,
  type: string,
  payload: Record<string, unknown>,
): void {
  let text = JSON.stringify(payload);
  if (text.length > AUDIT_CAP) text = text.slice(0, AUDIT_CAP);
  db.run(
    `INSERT INTO audit_events (id, account_id, actor, type, payload, created_at)
     VALUES (?, ?, 'federation', ?, ?, ?)`,
    [id(), accountId, type, text, now()],
  );
}

function parseEnvelope(json: unknown):
  | { ok: true; raw: Record<string, unknown>; envelope: FedMessageEnvelope }
  | { ok: false; error: string } {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, error: "invalid_json" };
  }
  const raw = json as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (ATTACHMENT_KEYS.has(key)) return { ok: false, error: "attachments" };
  }
  if ("body" in raw && typeof raw.body !== "string") return { ok: false, error: "non_text" };
  const parsed = fedMessageEnvelope.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_body" };
  return { ok: true, raw, envelope: parsed.data };
}

function renderFedEnvelope(env: FedMessageEnvelope): string {
  const actor = `${env.fromActor.name}, ${env.fromActor.type}`;
  const hop = env.hop ?? "missing";
  return `Inbound federation mail from ${env.fromSlug} (${actor}), urgency=${env.urgency}, hop=${hop}, id=${env.id}\n${env.body}`;
}

function insertGatewayNotice(db: OpenbotDb, threadId: string, body: string): MessageRow {
  return insertMessage(db, {
    threadId,
    role: "system",
    origin: "system",
    body,
  });
}

function recordSolicit(
  db: OpenbotDb,
  opts: {
    bucket: string;
    reason: string;
    host: string;
    threadId: string | null;
    copy: (count: number) => string;
  },
): MessageRow | null {
  const t = now();
  const existing = db.get<OrgSolicitRow>(
    "SELECT * FROM org_solicit WHERE bucket = ? AND reason = ?",
    [opts.bucket, opts.reason],
  );
  let count = 1;
  let lastNoticeId: string | null = existing?.last_notice_message_id ?? null;
  const coalesce = Boolean(existing && t - existing.last_at < FED_SOLICIT_WINDOW_MS);
  if (existing) {
    count = existing.count + 1;
    db.run(
      "UPDATE org_solicit SET count = ?, host = ?, last_at = ? WHERE id = ?",
      [count, opts.host, t, existing.id],
    );
  } else {
    db.run(
      `INSERT INTO org_solicit (id, bucket, reason, count, host, last_at, last_notice_message_id)
       VALUES (?, ?, ?, 1, ?, ?, NULL)`,
      [id(), opts.bucket, opts.reason, opts.host, t],
    );
  }
  if (!opts.threadId) return null;
  const body = opts.copy(count);
  if (coalesce && lastNoticeId) {
    const still = db.get("SELECT id FROM messages WHERE id = ?", [lastNoticeId]);
    if (still) {
      db.run("UPDATE messages SET body = ? WHERE id = ?", [body, lastNoticeId]);
      return db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", [lastNoticeId]) ?? null;
    }
  }
  const msg = insertGatewayNotice(db, opts.threadId, body);
  db.run("UPDATE org_solicit SET last_notice_message_id = ? WHERE bucket = ? AND reason = ?", [
    msg.id,
    opts.bucket,
    opts.reason,
  ]);
  return msg;
}

export function enqueueDrainTurn(db: OpenbotDb, gatewayBotId: string): MessageRow | null {
  if (gatewayHasActiveTurn(db, gatewayBotId)) return null;
  const n = pendingInboxCount(db);
  if (n === 0) return null;
  const thread = humanThread(db, gatewayBotId);
  if (!thread) return null;
  const ids = pendingInboxIds(db);
  const turnId = id();
  const t = now();
  db.run(
    `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, deadline_at, created_at)
     VALUES (?, ?, ?, 'queued', 0, '', ?, ?)`,
    [turnId, thread.id, gatewayBotId, t + 2 * 60 * 60 * 1000, t],
  );
  const body = `Inbox drain: ${n} pending.\nPending ids: ${ids.join(", ")}\nCall Inbox to list/ack them. Route locally. Do not ignore this prompt.`;
  return insertMessage(db, {
    threadId: thread.id,
    turnId,
    role: "user",
    origin: "prompt",
    body,
  });
}

export function maybeEnqueueGatewayDrain(
  db: OpenbotDb,
  gatewayBotId: string,
  finishedTurnId?: string,
): { kick: boolean; push: MessageRow[] } {
  if (!federationEffective(currentOrgMeta(db))) return { kick: false, push: [] };
  return db.immediate(() => {
    const pending = pendingInboxCount(db);
    if (pending === 0) return { kick: false, push: [] };
    if (gatewayHasActiveTurn(db, gatewayBotId)) return { kick: false, push: [] };
    if (finishedTurnId) {
      const ackedThisTurn =
        db.get<{ n: number }>("SELECT COUNT(*) AS n FROM org_inbox WHERE acked_turn_id = ?", [
          finishedTurnId,
        ])?.n ?? 0;
      const prompt = db.get<{ origin: string }>(
        "SELECT origin FROM messages WHERE turn_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1",
        [finishedTurnId],
      );
      const promptOrigin = prompt?.origin;
      if (promptOrigin === "user") {
        const row = enqueueDrainTurn(db, gatewayBotId);
        return { kick: Boolean(row), push: [] };
      }
      if (ackedThisTurn >= 1 && pending > 0) {
        const row = enqueueDrainTurn(db, gatewayBotId);
        return { kick: Boolean(row), push: [] };
      }
      const thread = humanThread(db, gatewayBotId);
      if (!thread) return { kick: false, push: [] };
      const notice = insertGatewayNotice(
        db,
        thread.id,
        `${pending} inbound messages still pending. Gateway acked none this turn. Waiting for you or a new inbound while idle.`,
      );
      return { kick: false, push: [notice] };
    }
    const row = enqueueDrainTurn(db, gatewayBotId);
    return { kick: Boolean(row), push: [] };
  });
}

function jwsHttpError(err: FedJwsError): string {
  if (err.code === "aud") return "audience";
  if (err.code === "signature") return "bad_signature";
  if (err.code === "bth") return "body_hash";
  if (err.code === "alg" || err.code === "malformed" || err.code === "truncated") return "unauthorized";
  return err.code;
}

function peerLabel(peer: OrgPeerRow | undefined, fromSlug: string | undefined, iss: string | undefined): string {
  if (peer?.slug) return peer.slug;
  if (fromSlug) return fromSlug;
  if (iss) return iss;
  return "unknown";
}

export function handleFedInbound(
  db: OpenbotDb,
  opts: {
    rawBody: string;
    json: unknown;
    authorization: string | undefined;
    idempotencyKey: string | undefined;
    clientIp: string;
  },
): FedInboundResult {
  const org = currentOrgMeta(db);
  const accountId = org?.account_id ?? null;
  const gw = accountId ? findActiveGateway(db, accountId) : undefined;
  const gwThread = gw ? humanThread(db, gw.id) : undefined;
  const push: MessageRow[] = [];
  const host = opts.clientIp || "unknown";

  const empty = (status: number, error: string, extra?: Record<string, unknown>): FedInboundResult => ({
    status,
    body: { error, ...extra },
    kick: false,
    accountId,
    push,
  });

  const parsed = parseEnvelope(opts.json);
  const fromSlug = parsed.ok ? parsed.envelope.fromSlug : undefined;
  const fromOrgBody = parsed.ok ? canon(parsed.envelope.fromOrg) : undefined;

  const solicit = (reason: string, iss?: string, claimedPeer?: OrgPeerRow) => {
    const bucket = iss ? `org:${canon(iss)}` : fromOrgBody ? `org:${fromOrgBody}` : ipBucket(host);
    const label = peerLabel(claimedPeer, fromSlug, iss ?? fromOrgBody);
    const originHint = claimedPeer?.base_url ? ` (${claimedPeer.base_url})` : "";
    const msg = recordSolicit(db, {
      bucket,
      reason,
      host,
      threadId: gwThread?.id ?? null,
      copy: (count) => {
        if (reason === "bad_signature") {
          return count > 1
            ? `${count} attempts claimed ${label} but the signature failed — ignored.`
            : `Claimed ${label} but the signature failed — ignored.`;
        }
        if (reason === "hop" || reason === "hop_limit") {
          return `Org ${label} sent hop≠1 — ignored.`;
        }
        if (reason === "bind" || reason === "audience") {
          return `Org ${label} sent a ${reason} mismatch — ignored.`;
        }
        return count > 1
          ? `${count} attempts from ${label}${originHint} — not on your peer list, ignored. Add them under Settings → Peers if you trust them.`
          : `Org ${label}${originHint} tried to send mail. Not on your peer list — ignored. Add them under Settings → Peers if you trust them.`;
      },
    });
    if (msg) push.push(msg);
    writeAudit(db, accountId, "fed.solicit", {
      fromOrg: iss ?? fromOrgBody ?? null,
      host,
      reason,
      count: db.get<OrgSolicitRow>("SELECT * FROM org_solicit WHERE bucket = ? AND reason = ?", [
        bucket,
        reason,
      ])?.count ?? 1,
    });
  };

  if (!parsed.ok) {
    return empty(400, parsed.error);
  }
  const envelope = parsed.envelope;

  const bearer = parseBearer(opts.authorization);
  if (!bearer) {
    solicit("unauthorized", fromOrgBody);
    return empty(401, "unauthorized");
  }

  let decoded: ReturnType<typeof decodeFedJws>;
  try {
    decoded = decodeFedJws(bearer);
  } catch (err) {
    const code = err instanceof FedJwsError ? jwsHttpError(err) : "unauthorized";
    solicit(code === "bind" ? "bind" : "unauthorized", fromOrgBody);
    return empty(401, code);
  }

  const iss = decoded.payload.iss;
  const kid = decoded.kid;
  if (canon(iss) !== canon(kid) || canon(iss) !== canon(envelope.fromOrg)) {
    solicit("bind", iss);
    return empty(401, "bind");
  }
  if (!org || canon(decoded.payload.aud) !== canon(envelope.toOrg) || canon(envelope.toOrg) !== canon(org.org_id)) {
    solicit("audience", iss);
    return empty(401, "audience");
  }
  const idem = (opts.idempotencyKey ?? "").trim();
  if (!idem || canon(decoded.payload.jti) !== canon(envelope.id) || canon(envelope.id) !== canon(idem)) {
    solicit("bind", iss);
    return empty(401, "bind");
  }

  const peer = getOrgPeer(db, iss);
  const allowed = peer?.status === "allowed" ? peer : undefined;
  if (!allowed) {
    solicit("unknown_peer", iss, peer);
    return empty(401, "unknown_peer");
  }

  try {
    verifyFedJws(bearer, {
      publicKey: allowed.pubkey,
      expectedAud: org.org_id,
      expectedJti: envelope.id,
      rawBody: opts.rawBody,
    });
  } catch (err) {
    if (err instanceof FedJwsError) {
      const code = jwsHttpError(err);
      if (code === "bad_signature") solicit("bad_signature", iss, allowed);
      else if (code === "bind" || code === "audience" || code === "body_hash") solicit(code, iss, allowed);
      return empty(401, code);
    }
    solicit("bad_signature", iss, allowed);
    return empty(401, "bad_signature");
  }

  if (envelope.hop !== 1) {
    solicit("hop", iss, allowed);
    return empty(400, "hop_limit");
  }

  const fromOrgId = allowed.peer_org_id;
  const messageId = canon(envelope.id);
  const stored = db.immediate(() => {
    const dup = db.get<{ id: string }>(
      "SELECT id FROM org_inbox WHERE from_org_id = ? AND message_id = ?",
      [fromOrgId, messageId],
    );
    if (dup) return { kind: "dup" as const };

    const hourAgo = now() - FED_RATE_WINDOW_MS;
    const peerN =
      db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM org_inbox WHERE from_org_id = ? AND created_at >= ?",
        [fromOrgId, hourAgo],
      )?.n ?? 0;
    const instN =
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM org_inbox WHERE created_at >= ?", [hourAgo])?.n ??
      0;
    if (peerN >= FED_RATE_PEER_HOUR || instN >= FED_RATE_INSTANCE_HOUR) {
      return { kind: "rate" as const };
    }

    const liveGw = accountId ? findActiveGateway(db, accountId) : undefined;
    const thread = liveGw ? humanThread(db, liveGw.id) : undefined;
    if (!liveGw || !thread) return { kind: "no_gateway" as const };

    const fedOn = federationEffective(currentOrgMeta(db));
    const inboxId = id();
    const t = now();
    const envJson = JSON.stringify(envelope);
    try {
      db.run(
        `INSERT INTO org_inbox (
           id, message_id, from_org_id, from_slug, to_org_id, hop, urgency, body, envelope, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          inboxId,
          messageId,
          fromOrgId,
          envelope.fromSlug,
          canon(org.org_id),
          1,
          envelope.urgency,
          envelope.body,
          envJson,
          fedOn ? "pending" : "held",
          t,
        ],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(msg)) return { kind: "dup" as const };
      throw err;
    }

    if (!fedOn) {
      const heldN =
        db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM org_inbox WHERE from_org_id = ? AND status = 'held'",
          [fromOrgId],
        )?.n ?? 1;
      const notice = recordSolicit(db, {
        bucket: `org:${fromOrgId}`,
        reason: "federation_disabled",
        host,
        threadId: thread.id,
        copy: (count) =>
          count > 1
            ? `Peer ${allowed.slug} tried to deliver while federation is off. ${heldN} held. Turn federation on to accept.`
            : `Peer ${allowed.slug} tried to deliver while federation is off. ${heldN} held. Turn federation on to accept.`,
      });
      return { kind: "held" as const, messages: notice ? [notice] : [], id: messageId };
    }

    const busy = gatewayHasActiveTurn(db, liveGw.id);
    let turnId: string | null = null;
    if (!busy) {
      turnId = id();
      db.run(
        `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, deadline_at, created_at)
         VALUES (?, ?, ?, 'queued', 0, '', ?, ?)`,
        [turnId, thread.id, liveGw.id, t + 2 * 60 * 60 * 1000, t],
      );
    }
    const bubble = insertMessage(db, {
      threadId: thread.id,
      turnId,
      role: "user",
      origin: "federation",
      body: renderFedEnvelope(envelope),
      urgency: envelope.urgency,
      remoteOrgId: fromOrgId,
      remoteActorName: envelope.fromActor.name,
    });
    return {
      kind: "ok" as const,
      queued: !busy,
      messages: [bubble],
      id: messageId,
    };
  });

  if (stored.kind === "dup") {
    writeAudit(db, accountId, "fed.inbound", {
      fromOrg: fromOrgId,
      jti: messageId,
      hop: 1,
      duplicate: true,
      queued: false,
    });
    return { status: 200, body: { duplicate: true, queued: false }, kick: false, accountId, push };
  }
  if (stored.kind === "rate") {
    return empty(429, "rate_limited");
  }
  if (stored.kind === "no_gateway") {
    return empty(503, "no_gateway");
  }
  if (stored.kind === "held") {
    push.push(...stored.messages);
    writeAudit(db, accountId, "fed.inbound", {
      fromOrg: fromOrgId,
      jti: messageId,
      hop: 1,
      duplicate: false,
      queued: false,
      held: true,
    });
    return {
      status: 403,
      body: { error: "federation_disabled" },
      kick: false,
      accountId,
      push,
    };
  }
  push.push(...stored.messages);
  writeAudit(db, accountId, "fed.inbound", {
    fromOrg: fromOrgId,
    jti: messageId,
    hop: 1,
    duplicate: false,
    queued: stored.queued,
  });
  return {
    status: 202,
    body: { id: stored.id, duplicate: false, queued: stored.queued },
    kick: stored.queued,
    accountId,
    push,
  };
}
