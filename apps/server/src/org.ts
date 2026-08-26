import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { id, now, type OpenbotDb } from "@openbot/db";

export const FED_INFO_RATE_LIMIT = 30;
export const FED_INFO_RATE_WINDOW_MS = 60_000;

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
    federationEnabled: row.federation_enabled === 1,
  };
}

export function orgCliSnapshot(row: OrgMetaRow): {
  orgId: string;
  slug: string;
  name: string;
  publicOrigin: string | null;
  pubkey: string;
  federationEnabled: boolean;
  gateway: null;
} {
  return {
    ...orgMemberSnapshot(row),
    pubkey: row.pubkey || "",
    gateway: null,
  };
}

export function fedInfoPayload(row: OrgMetaRow): {
  orgId: string;
  slug: string;
  name: string;
  publicOrigin: string | null;
  pubkey: string;
  gateway: null;
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
    gateway: null,
    caps: {
      protocol: "openbot-fed/1",
      federation: "off",
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
