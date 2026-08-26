import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicKey, type KeyObject } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { id, now, type OpenbotDb } from "@openbot/db";
import { open, seal } from "@openbot/vault";
import {
  generateEd25519,
  parseRawPublicKeyB64,
  privateKeyFromPem,
  publicKeyFromRawB64,
  rawPublicKeyB64,
} from "@openbot/federation";

export const FED_INFO_RATE_LIMIT = 30;
export const FED_INFO_RATE_WINDOW_MS = 60_000;
export const ORG_ED25519_FILE = "org.ed25519";
export const FED_INFO_FETCH_TIMEOUT_MS = 3_000;
export const FED_INFO_FETCH_MAX_BYTES = 64 * 1024;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type OrgMetaRow = {
  id: string;
  account_id: string | null;
  org_id: string;
  slug: string;
  name: string;
  public_origin: string | null;
  pubkey: string;
  federation_enabled: number;
  created_at: number;
};

export type OrgFile = {
  orgId?: string;
  slug?: string;
  name?: string;
  publicOrigin?: string;
};

export type EnsureOrgMetaOpts = {
  env?: Record<string, string | undefined>;
  file?: string;
  publicOrigin?: string;
  advertisedOrigin?: string;
  slug?: string;
  name?: string;
};

function envStr(env: Record<string, string | undefined> | undefined, key: string): string | undefined {
  const v = env?.[key];
  if (v == null) return undefined;
  const t = String(v).trim();
  return t ? t : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t ? t : undefined;
}

export function readOrgFile(path: string): OrgFile {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid org.json at ${path}`);
  }
  const o = parsed as Record<string, unknown>;
  return {
    orgId: asString(o.orgId),
    slug: asString(o.slug),
    name: asString(o.name),
    publicOrigin: asString(o.publicOrigin),
  };
}

export function writeOrgJson(path: string, row: OrgMetaRow): void {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        orgId: row.org_id,
        slug: row.slug,
        name: row.name,
        publicOrigin: row.public_origin,
      },
      null,
      2,
    )}\n`,
  );
}

export function normalizeOrgSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `invalid org slug ${JSON.stringify(raw)} (use a single DNS label [a-z0-9-]; FQDNs do not auto-slug)`,
    );
  }
  return slug;
}

function optionalSlug(raw: string | undefined): string | undefined {
  const s = asString(raw);
  if (!s) return undefined;
  return normalizeOrgSlug(s);
}

export function deriveOrgSlug(publicOrigin: string | undefined | null): string {
  if (!publicOrigin) return "local";
  let hostname = "";
  try {
    hostname = new URL(publicOrigin).hostname.toLowerCase();
  } catch {
    return "local";
  }
  if (!hostname || hostname === "localhost") return "local";
  if (hostname.includes(":")) return "local";
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return "local";
  if (!SLUG_RE.test(hostname)) return "local";
  return hostname;
}

export function currentOrgMeta(db: OpenbotDb): OrgMetaRow | undefined {
  const row = db.get<OrgMetaRow>("SELECT * FROM org_meta WHERE id = 'current'");
  if (row == null) return undefined;
  return row;
}

function insertFoundingMember(db: OpenbotDb, orgId: string, userId: string, accountId: string): void {
  const member = db.get<{ id: string }>("SELECT id FROM org_members WHERE user_id = ?", [userId]);
  if (member != null) return;
  db.run(
    `INSERT INTO org_members (id, org_id, user_id, account_id, role, created_at)
     VALUES (?, ?, ?, ?, 'member', ?)`,
    [id(), orgId, userId, accountId, now()],
  );
}

/** Extra Phase 2 accounts keep their bots; founding member is backfilled so unmigrated DBs session after boot. */
export function ensureOrgAccount(
  db: OpenbotDb,
  log?: { info: (msg: string, extra?: Record<string, unknown>) => void },
): void {
  db.immediate(() => {
    const org = currentOrgMeta(db);
    if (org == null) return;

    let accountId = org.account_id;
    if (accountId == null) {
      const accounts = db.all<{ id: string; auth_user_id: string }>(
        "SELECT id, auth_user_id FROM accounts ORDER BY created_at ASC, id ASC",
      );
      const oldest = accounts[0];
      if (oldest == null) return;
      accountId = oldest.id;
      db.run("UPDATE org_meta SET account_id = ? WHERE id = 'current' AND account_id IS NULL", [accountId]);
      insertFoundingMember(db, org.org_id, oldest.auth_user_id, accountId);
      if (accounts.length > 1) {
        log?.info("multiple accounts on this instance; extra account bots remain", {
          orgAccountId: accountId,
          extra: accounts.length - 1,
        });
      }
      return;
    }

    const account = db.get<{ id: string; auth_user_id: string }>(
      "SELECT id, auth_user_id FROM accounts WHERE id = ?",
      [accountId],
    );
    if (account == null) return;
    insertFoundingMember(db, org.org_id, account.auth_user_id, account.id);
  });
}

/** DB flag AND env panic. Env `0` wins; env cannot force on. */
export function federationEffective(
  row?: OrgMetaRow | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!row || row.federation_enabled !== 1) return false;
  return env.OPENBOT_FEDERATION !== "0";
}

export const FEDERATION_OFF_NOTICE =
  "Federation is off. Turn it on in Settings to send or receive org mail.";

export function setFederationEnabled(db: OpenbotDb, enabled: boolean): OrgMetaRow {
  const stored = currentOrgMeta(db);
  if (!stored) throw new Error("org_meta missing");
  db.run("UPDATE org_meta SET federation_enabled = ? WHERE id = 'current'", [enabled ? 1 : 0]);
  const row = currentOrgMeta(db);
  if (!row) throw new Error("org_meta write failed");
  return row;
}

export function ensureOrgMeta(db: OpenbotDb, opts: EnsureOrgMetaOpts = {}): OrgMetaRow {
  const env = opts.env ?? process.env;
  const file = opts.file ? readOrgFile(opts.file) : {};
  const stored = currentOrgMeta(db);

  const envId = envStr(env, "OPENBOT_ORG_ID");
  let orgId: string;
  if (stored?.org_id) {
    // Identity is durable; a different env UUID means this home is not that org.
    if (envId && envId !== stored.org_id) {
      throw new Error(
        `OPENBOT_ORG_ID ${envId} does not match stored org_id ${stored.org_id}; refusing to boot`,
      );
    }
    orgId = stored.org_id;
  } else {
    orgId = envId || file.orgId || id();
  }

  const publicOrigin =
    asString(opts.publicOrigin) ||
    envStr(env, "OPENBOT_PUBLIC_ORIGIN") ||
    file.publicOrigin ||
    asString(stored?.public_origin) ||
    asString(opts.advertisedOrigin) ||
    "http://127.0.0.1:8787";

  const slug =
    optionalSlug(opts.slug) ||
    optionalSlug(envStr(env, "OPENBOT_ORG_SLUG")) ||
    optionalSlug(file.slug) ||
    asString(stored?.slug) ||
    deriveOrgSlug(publicOrigin);

  const name =
    asString(opts.name) || envStr(env, "OPENBOT_ORG_NAME") || file.name || asString(stored?.name) || slug;

  if (stored) {
    db.run("UPDATE org_meta SET slug = ?, name = ?, public_origin = ? WHERE id = 'current'", [
      slug,
      name,
      publicOrigin,
    ]);
  } else {
    db.run(
      `INSERT INTO org_meta (id, account_id, org_id, slug, name, public_origin, pubkey, federation_enabled, created_at)
       VALUES ('current', NULL, ?, ?, ?, ?, '', 0, ?)`,
      [orgId, slug, name, publicOrigin, now()],
    );
  }

  const row = currentOrgMeta(db);
  if (!row) throw new Error("org_meta write failed");
  return row;
}

export function orgMemberSnapshot(row: OrgMetaRow): {
  orgId: string;
  slug: string;
  name: string;
  publicOrigin: string | null;
  federationEnabled: boolean;
} {
  return {
    orgId: row.org_id,
    slug: row.slug,
    name: row.name,
    publicOrigin: row.public_origin,
    federationEnabled: federationEffective(row),
  };
}

export function orgCliSnapshot(
  row: OrgMetaRow,
  gateway: { id: string; name: string } | null = null,
): {
  orgId: string;
  slug: string;
  name: string;
  publicOrigin: string | null;
  pubkey: string;
  federationEnabled: boolean;
  gateway: { id: string; name: string } | null;
} {
  return {
    ...orgMemberSnapshot(row),
    federationEnabled: federationEffective(row),
    pubkey: row.pubkey || "",
    gateway,
  };
}

export function fedInfoPayload(
  row: OrgMetaRow,
  gateway: { name: string } | null = null,
): {
  orgId: string;
  slug: string;
  name: string;
  publicOrigin: string | null;
  pubkey: string;
  gateway: { name: string } | null;
  caps: {
    protocol: string;
    federation: "off" | "on";
    maxBodyBytes: number;
    maxRequestBytes: number;
    attachments: boolean;
    groupBridge: boolean;
    hopLimit: number;
  };
} {
  return {
    orgId: row.org_id,
    slug: row.slug,
    name: row.name,
    publicOrigin: row.public_origin,
    pubkey: row.pubkey || "",
    gateway,
    caps: {
      protocol: "openbot-fed/1",
      federation: federationEffective(row) ? "on" : "off",
      maxBodyBytes: 32_000,
      maxRequestBytes: 65_536,
      attachments: false,
      groupBridge: true,
      hopLimit: 1,
    },
  };
}

export function isLoopbackAddress(addr: string): boolean {
  const a = addr.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = a.startsWith("::ffff:") ? a.slice(7) : a;
  return mapped === "127.0.0.1" || a === "::1" || mapped === "::1";
}

export function clientRateKey(
  remoteAddress: string | undefined | null,
  forwardedFor: string | undefined | null,
): string {
  const remote = (remoteAddress ?? "").trim();
  if (forwardedFor && isLoopbackAddress(remote)) {
    const left = forwardedFor.split(",")[0]?.trim();
    if (left) return left;
  }
  return remote || "unknown";
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  get size(): number {
    return this.hits.size;
  }

  take(key: string): boolean {
    const t = this.clock();
    const start = t - this.windowMs;
    for (const [k, hits] of this.hits) {
      const kept = hits.filter((hit) => hit > start);
      if (kept.length === 0) this.hits.delete(k);
      else this.hits.set(k, kept);
    }
    const recent = this.hits.get(key) ?? [];
    if (recent.length >= this.limit) return false;
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

export type LoadedOrgKey = {
  keyId: string;
  pubkey: string;
  privateKey: KeyObject;
};

type OrgKeyFileV1 = {
  v: unknown;
  keyId: unknown;
  pubkey: unknown;
  ciphertext: unknown;
  dekWrapped: unknown;
};

export function orgEd25519Path(home: string): string {
  return join(home, ORG_ED25519_FILE);
}

export function loadOrgKeypair(home: string, master: Buffer): LoadedOrgKey {
  const path = orgEd25519Path(home);
  if (!existsSync(path)) throw new Error(`missing ${ORG_ED25519_FILE}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as OrgKeyFileV1;
  if (parsed.v !== 1) throw new Error(`unsupported ${ORG_ED25519_FILE} version`);
  if (typeof parsed.keyId !== "string" || !parsed.keyId) throw new Error(`invalid ${ORG_ED25519_FILE} keyId`);
  if (typeof parsed.pubkey !== "string" || !parsed.pubkey) throw new Error(`invalid ${ORG_ED25519_FILE} pubkey`);
  if (typeof parsed.ciphertext !== "string" || typeof parsed.dekWrapped !== "string") {
    throw new Error(`invalid ${ORG_ED25519_FILE} envelope`);
  }
  const pem = open(master, {
    ciphertext: Buffer.from(parsed.ciphertext, "base64"),
    dekWrapped: Buffer.from(parsed.dekWrapped, "base64"),
    keyId: parsed.keyId,
    lastFour: "",
  });
  const privateKey = privateKeyFromPem(pem);
  const derived = rawPublicKeyB64(createPublicKey(privateKey));
  if (derived !== parsed.pubkey) throw new Error(`${ORG_ED25519_FILE} pubkey does not match private key`);
  publicKeyFromRawB64(parsed.pubkey);
  return { keyId: parsed.keyId, pubkey: parsed.pubkey, privateKey };
}

export function ensureOrgKeypair(home: string, master: Buffer, db: OpenbotDb): LoadedOrgKey {
  const path = orgEd25519Path(home);
  if (!existsSync(path)) {
    const kp = generateEd25519();
    const sealed = seal(master, kp.privateKeyPem);
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          v: 1,
          keyId: sealed.keyId,
          pubkey: kp.publicKeyRawB64,
          ciphertext: sealed.ciphertext.toString("base64"),
          dekWrapped: sealed.dekWrapped.toString("base64"),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    try {
      chmodSync(path, 0o600);
    } catch {
      /* ignore */
    }
  }
  const loaded = loadOrgKeypair(home, master);
  const row = currentOrgMeta(db);
  if (!row) throw new Error("org_meta missing; call ensureOrgMeta first");
  if (row.pubkey !== loaded.pubkey) {
    db.run("UPDATE org_meta SET pubkey = ? WHERE id = 'current'", [loaded.pubkey]);
  }
  return loaded;
}

export class OrgPeerError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "OrgPeerError";
  }
}

export type OrgPeerRow = {
  id: string;
  peer_org_id: string;
  slug: string;
  name: string;
  base_url: string;
  pubkey: string;
  status: string;
  created_at: number;
};

export type OrgPeerPublic = {
  orgId: string;
  slug: string;
  name: string;
  baseUrl: string;
  pubkey: string;
  status: string;
  createdAt: number;
};

const PEER_ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function orgPeerPublic(row: OrgPeerRow): OrgPeerPublic {
  return {
    orgId: row.peer_org_id,
    slug: row.slug,
    name: row.name,
    baseUrl: row.base_url,
    pubkey: row.pubkey,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function parsePeerPubkey(raw: string): string {
  try {
    return parseRawPublicKeyB64(raw).toString("base64");
  } catch {
    throw new OrgPeerError("invalid_pubkey", "invalid_pubkey");
  }
}

export function parsePeerBaseUrl(raw: string, env?: Record<string, string | undefined>): string {
  const t = raw.trim();
  if (!t) throw new OrgPeerError("invalid_peer_url", "invalid_peer_url");
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    throw new OrgPeerError("invalid_peer_url", "invalid_peer_url");
  }
  if (url.username || url.password) throw new OrgPeerError("invalid_peer_url", "invalid_peer_url");
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OrgPeerError("invalid_peer_url", "invalid_peer_url");
  }
  const host = url.hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new OrgPeerError("invalid_peer_url", "invalid_peer_url");
  if (isBlockedPeerHost(host)) throw new OrgPeerError("invalid_peer_url", "invalid_peer_url");

  const loopbackHttp = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol === "http:") {
    if (!loopbackHttp) {
      const allowLan = (env ?? process.env).OPENBOT_FED_ALLOW_HTTP === "1";
      if (!allowLan || !isRfc1918Host(host)) {
        throw new OrgPeerError("invalid_peer_url", "invalid_peer_url");
      }
    }
  }
  return url.origin;
}

export function listOrgPeers(db: OpenbotDb): OrgPeerRow[] {
  return db.all<OrgPeerRow>("SELECT * FROM org_peers ORDER BY created_at, slug");
}

export function insertOrgPeer(
  db: OpenbotDb,
  input: { slug: string; orgId: string; baseUrl: string; pubkey: string; name?: string },
  env?: Record<string, string | undefined>,
): OrgPeerRow {
  let slug: string;
  try {
    slug = normalizeOrgSlug(input.slug);
  } catch {
    throw new OrgPeerError("invalid_slug", "invalid_slug");
  }
  const orgId = input.orgId.trim().toLowerCase();
  if (!PEER_ORG_ID_RE.test(orgId)) throw new OrgPeerError("invalid_org_id", "invalid_org_id");
  const baseUrl = parsePeerBaseUrl(input.baseUrl, env);
  const pubkey = parsePeerPubkey(input.pubkey);
  const name = (input.name ?? "").trim();
  return db.immediate(() => {
    if (db.get("SELECT id FROM org_peers WHERE slug = ?", [slug])) {
      throw new OrgPeerError("duplicate_slug", "duplicate_slug");
    }
    if (db.get("SELECT id FROM org_peers WHERE peer_org_id = ?", [orgId])) {
      throw new OrgPeerError("duplicate_org", "duplicate_org");
    }
    const row: OrgPeerRow = {
      id: id(),
      peer_org_id: orgId,
      slug,
      name,
      base_url: baseUrl,
      pubkey,
      status: "allowed",
      created_at: now(),
    };
    db.run(
      `INSERT INTO org_peers (id, peer_org_id, slug, name, base_url, pubkey, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.peer_org_id, row.slug, row.name, row.base_url, row.pubkey, row.status, row.created_at],
    );
    return row;
  });
}

export function getOrgPeer(db: OpenbotDb, peerOrgId: string): OrgPeerRow | undefined {
  return (
    db.get<OrgPeerRow>("SELECT * FROM org_peers WHERE peer_org_id = ?", [peerOrgId.trim().toLowerCase()]) ?? undefined
  );
}

export function deleteOrgPeer(db: OpenbotDb, peerOrgId: string): boolean {
  const row = getOrgPeer(db, peerOrgId);
  if (!row) return false;
  db.run("DELETE FROM org_peers WHERE peer_org_id = ?", [row.peer_org_id]);
  return getOrgPeer(db, row.peer_org_id) == null;
}

export function disableOrgPeer(db: OpenbotDb, peerOrgId: string): OrgPeerRow | undefined {
  const row = getOrgPeer(db, peerOrgId);
  if (!row) return undefined;
  db.run("UPDATE org_peers SET status = 'disabled' WHERE peer_org_id = ?", [row.peer_org_id]);
  const after = getOrgPeer(db, row.peer_org_id);
  if (!after || after.status !== "disabled") return undefined;
  return after;
}

export type PeerDnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export async function resolvePeerAddresses(
  host: string,
  lookup: PeerDnsLookup = defaultPeerLookup,
): Promise<string[]> {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized) throw new OrgPeerError("invalid_peer_url", "invalid_peer_url");
  if (parseIpv4(normalized) || expandIpv6(normalized)) {
    if (isBlockedPeerHost(normalized)) throw new OrgPeerError("invalid_peer_url", "invalid_peer_url");
    return [normalized];
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(normalized);
  } catch {
    throw new OrgPeerError("invalid_peer_url", "invalid_peer_url");
  }
  if (!records.length) throw new OrgPeerError("invalid_peer_url", "invalid_peer_url");
  const addrs = records.map((r) => r.address.trim().toLowerCase().replace(/^\[|\]$/g, ""));
  for (const addr of addrs) {
    if (!addr || isBlockedPeerHost(addr)) throw new OrgPeerError("invalid_peer_url", "invalid_peer_url");
  }
  return addrs;
}

export async function fetchPeerFedInfo(
  origin: string,
  opts?: { lookup?: PeerDnsLookup },
): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new OrgPeerError("invalid_peer_url", "invalid_peer_url");
  }
  const host = url.hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const deadlineAt = Date.now() + FED_INFO_FETCH_TIMEOUT_MS;
  const addrs = await raceDeadline(
    resolvePeerAddresses(host, opts?.lookup ?? defaultPeerLookup),
    deadlineAt,
  );
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port <= 0) throw new OrgPeerError("invalid_peer_url", "invalid_peer_url");
  for (const pin of addrs) {
    if (Date.now() >= deadlineAt) break;
    try {
      const { status, body } = await pinnedFedInfoGet({
        https: url.protocol === "https:",
        connectIp: pin,
        port,
        hostHeader: url.host,
        servername: host,
        deadlineAt,
      });
      if (status < 200 || status >= 300) throw new OrgPeerError("info_failed", "info_failed");
      try {
        return JSON.parse(body.toString("utf8"));
      } catch {
        throw new OrgPeerError("info_failed", "info_failed");
      }
    } catch (err) {
      if (err instanceof OrgPeerError && err.code === "info_connect") continue;
      throw err;
    }
  }
  throw new OrgPeerError("info_failed", "info_failed");
}

async function defaultPeerLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return dnsLookup(hostname, { all: true });
}

function raceDeadline<T>(p: Promise<T>, deadlineAt: number): Promise<T> {
  const ms = deadlineAt - Date.now();
  if (ms <= 0) return Promise.reject(new OrgPeerError("info_failed", "info_failed"));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new OrgPeerError("info_failed", "info_failed")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

function pinnedFedInfoGet(opts: {
  https: boolean;
  connectIp: string;
  port: number;
  hostHeader: string;
  servername: string;
  deadlineAt: number;
}): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let gotResponse = false;
    let kill: ReturnType<typeof setTimeout> | undefined;
    const fail = (err: OrgPeerError) => {
      if (settled) return;
      settled = true;
      if (kill) clearTimeout(kill);
      reject(err);
    };
    const remaining = opts.deadlineAt - Date.now();
    if (remaining <= 0) {
      reject(new OrgPeerError("info_connect", "info_failed"));
      return;
    }
    const family = expandIpv6(opts.connectIp) ? 6 : 4;
    const reqFn = opts.https ? httpsRequest : httpRequest;
    const req = reqFn(
      {
        hostname: opts.connectIp,
        port: opts.port,
        path: "/fed/v1/info",
        method: "GET",
        family,
        headers: { accept: "application/json", host: opts.hostHeader },
        ...(opts.https ? { servername: opts.servername } : {}),
      },
      (res) => {
        gotResponse = true;
        const cl = res.headers["content-length"];
        if (cl && Number(cl) > FED_INFO_FETCH_MAX_BYTES) {
          req.destroy();
          fail(new OrgPeerError("info_too_large", "info_too_large"));
          return;
        }
        const chunks: Buffer[] = [];
        let n = 0;
        res.on("data", (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          n += buf.length;
          if (n > FED_INFO_FETCH_MAX_BYTES) {
            req.destroy();
            fail(new OrgPeerError("info_too_large", "info_too_large"));
            return;
          }
          chunks.push(buf);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(kill);
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
        res.on("error", () => fail(new OrgPeerError("info_failed", "info_failed")));
      },
    );
    kill = setTimeout(() => {
      req.destroy();
      fail(new OrgPeerError(gotResponse ? "info_failed" : "info_connect", "info_failed"));
    }, remaining);
    req.on("error", () => fail(new OrgPeerError(gotResponse ? "info_failed" : "info_connect", "info_failed")));
    req.end();
  });
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p.startsWith("0")) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums as [number, number, number, number];
}

function expandIpv6(host: string): number[] | null {
  let s = host.toLowerCase();
  if (s.startsWith("::ffff:")) {
    const v4 = parseIpv4(s.slice(7));
    if (v4) return [0, 0, 0, 0, 0, 0xffff, (v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
  }
  if (s.includes(".")) {
    const idx = s.lastIndexOf(":");
    if (idx < 0) return null;
    const v4 = parseIpv4(s.slice(idx + 1));
    if (!v4) return null;
    s = `${s.slice(0, idx)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (h: string): number[] | null => {
    if (!h) return [];
    const out: number[] = [];
    for (const p of h.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };
  if (halves.length === 1) {
    const parts = parseHalf(halves[0]!);
    if (!parts || parts.length !== 8) return null;
    return parts;
  }
  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves[1]!);
  if (!left || !right || left.length + right.length > 8) return null;
  return [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}

function isRfc1918Host(host: string): boolean {
  const v4 = parseIpv4(host);
  if (!v4) return false;
  if (v4[0] === 10) return true;
  if (v4[0] === 192 && v4[1] === 168) return true;
  if (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) return true;
  return false;
}

function isBlockedIpv4(v4: [number, number, number, number]): boolean {
  if (v4[0] === 0 && v4[1] === 0 && v4[2] === 0 && v4[3] === 0) return true;
  if (v4[0] === 169 && v4[1] === 254) return true;
  return false;
}

function v6ToV4(hi: number, lo: number): [number, number, number, number] {
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

function isBlockedPeerHost(host: string): boolean {
  if (host === "0.0.0.0") return true;
  const v4 = parseIpv4(host);
  if (v4) return isBlockedIpv4(v4);
  const v6 = expandIpv6(host);
  if (!v6) return false;
  if (v6.every((g) => g === 0)) return true;
  if ((v6[0]! & 0xffc0) === 0xfe80) return true;
  if (
    v6[0] === 0xfd00 &&
    v6[1] === 0x0ec2 &&
    v6[2] === 0 &&
    v6[3] === 0 &&
    v6[4] === 0 &&
    v6[5] === 0 &&
    v6[6] === 0 &&
    v6[7] === 0x0254
  ) {
    return true;
  }
  if (v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0xffff) {
    if (isBlockedIpv4(v6ToV4(v6[6]!, v6[7]!))) return true;
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (v6[0] === 0x64 && v6[1] === 0xff9b && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0) {
    if (isBlockedIpv4(v6ToV4(v6[6]!, v6[7]!))) return true;
  }
  return false;
}
