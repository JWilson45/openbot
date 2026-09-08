import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import {
  type AttachmentContent,
  type AttachmentImport,
  type AttachmentPort,
  type ProtocolPrincipal,
} from "@openbot/application";
import {
  ApplicationError,
  ATTACHMENT_MAX_BYTES,
  attachmentIdSchema,
  attachmentRefSchema,
  type AttachmentId,
  type AttachmentRef,
} from "@openbot/core";
import type { OpenbotDb } from "@openbot/db";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_NAME_BYTES = 512;

export type AttachmentStoreOptions = {
  db: OpenbotDb;
  root: string;
  publicOrigin: string;
  signingKey: Uint8Array;
  timeoutMs?: number;
  /** Intended for tests and explicitly trusted same-host development only. */
  allowLoopbackUrls?: boolean;
  lookup?: typeof dnsLookup;
};

type AttachmentRow = {
  id: string;
  account_id: string;
  name: string | null;
  media_type: string;
  size: number;
  sha256: string;
  storage_ref: string;
};

type AttachmentReplayRow = AttachmentRow & { fingerprint: string };

function safeName(name: string | undefined): string | null {
  if (name == null) return null;
  const value = name.trim();
  if (!value || Buffer.byteLength(value) > MAX_NAME_BYTES || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApplicationError("invalid_argument", "invalid attachment name");
  }
  return value;
}

function validateMediaType(mediaType: string): string {
  const value = mediaType.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/.test(value)) {
    throw new ApplicationError("invalid_argument", "invalid attachment media type");
  }
  return value;
}

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

function isUnsafeIpv4(address: string): boolean {
  const p = parseIpv4(address);
  if (!p) return true;
  const [a, b, c] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224
  );
}

function isLoopback(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith("127.");
  const value = address.toLowerCase();
  return value === "::1" || value === "0:0:0:0:0:0:0:1";
}

function isUnsafeAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isUnsafeIpv4(address);
  if (version !== 6) return true;
  const value = address.toLowerCase();
  if (value === "::" || isLoopback(value)) return true;
  if (/^f[cd]/.test(value) || /^fe[89ab]/.test(value) || value.startsWith("ff")) return true;
  if (value.startsWith("2001:db8:")) return true;
  const mapped = /^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1];
  return mapped ? isUnsafeIpv4(mapped) : false;
}

function bodyTooLarge(): ApplicationError {
  return new ApplicationError("invalid_argument", `attachment exceeds ${ATTACHMENT_MAX_BYTES} bytes`);
}

async function readRemote(
  rawUrl: string,
  options: Pick<AttachmentStoreOptions, "allowLoopbackUrls" | "lookup" | "timeoutMs">,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApplicationError("invalid_argument", "invalid attachment URL");
  }
  if (url.username || url.password || url.hash) {
    throw new ApplicationError("invalid_argument", "attachment URL credentials and fragments are forbidden");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const explicitLoopback = hostname === "localhost" || isLoopback(hostname);
  if (url.protocol !== "https:" && !(options.allowLoopbackUrls && url.protocol === "http:" && explicitLoopback)) {
    throw new ApplicationError("invalid_argument", "remote attachments require HTTPS");
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await (options.lookup ?? dnsLookup)(hostname, { all: true, verbatim: true });
  } catch {
    throw new ApplicationError("unavailable", "attachment host could not be resolved", { retryable: true });
  }
  if (records.length === 0) throw new ApplicationError("unavailable", "attachment host has no address", { retryable: true });
  for (const record of records) {
    if (isUnsafeAddress(record.address) && !(options.allowLoopbackUrls && explicitLoopback && isLoopback(record.address))) {
      throw new ApplicationError("forbidden", "attachment URL resolves to a non-public address");
    }
  }
  const pin = records[0]!;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ApplicationError("invalid_argument", "invalid attachment URL port");
  }
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000));
  return await new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        hostname: pin.address,
        family: pin.family,
        port,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        servername: url.hostname,
        headers: { accept: "*/*", host: url.host },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          fail(new ApplicationError("unavailable", `attachment source returned ${status}`, { retryable: status >= 500 }));
          return;
        }
        const declared = Number(response.headers["content-length"] ?? 0);
        if (declared > ATTACHMENT_MAX_BYTES) {
          request.destroy();
          fail(bodyTooLarge());
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += value.length;
          if (size > ATTACHMENT_MAX_BYTES) {
            request.destroy();
            fail(bodyTooLarge());
            return;
          }
          chunks.push(value);
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          resolve(Buffer.concat(chunks));
        });
        response.on("error", () => fail(new ApplicationError("unavailable", "attachment download failed", { retryable: true })));
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      fail(new ApplicationError("unavailable", "attachment download timed out", { retryable: true }));
    });
    const abort = () => {
      request.destroy();
      fail(new ApplicationError("canceled", "attachment import canceled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    request.on("close", () => signal?.removeEventListener("abort", abort));
    request.on("error", () => fail(new ApplicationError("unavailable", "attachment download failed", { retryable: true })));
    request.end();
  });
}

function hmac(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}

export class FilesystemAttachmentStore implements AttachmentPort {
  private readonly blobs: string;

  constructor(private readonly options: AttachmentStoreOptions) {
    if (options.signingKey.byteLength < 32) throw new Error("attachment signing key must be at least 32 bytes");
    this.blobs = join(options.root, "blobs");
    mkdirSync(this.blobs, { recursive: true });
  }

  async import(principal: ProtocolPrincipal, input: AttachmentImport, signal?: AbortSignal): Promise<AttachmentRef> {
    const name = safeName(input.name);
    const mediaType = validateMediaType(input.mediaType);
    const idempotencyKey = input.idempotencyKey?.trim();
    if (input.idempotencyKey !== undefined && (!idempotencyKey || idempotencyKey.length > 512)) {
      throw new ApplicationError("invalid_argument", "invalid attachment idempotency key");
    }
    const sourceFingerprint = input.source.kind === "bytes"
      ? { kind: "bytes", size: input.source.bytes.byteLength, sha256: createHash("sha256").update(input.source.bytes).digest("hex") }
      : { kind: "url", url: input.source.url };
    const fingerprint = createHash("sha256").update(JSON.stringify({
      name,
      mediaType,
      declaredSize: input.declaredSize ?? null,
      declaredSha256: input.declaredSha256?.toLowerCase() ?? null,
      source: sourceFingerprint,
    })).digest("hex");
    if (idempotencyKey) {
      const replay = this.options.db.get<AttachmentReplayRow>(
        `SELECT a.*, i.fingerprint FROM attachment_import_idempotency i
         JOIN attachments a ON a.id = i.attachment_id AND a.account_id = i.account_id
         WHERE i.account_id = ? AND i.subject_id = ? AND i.idempotency_key = ?`,
        [principal.accountId, principal.subjectId, idempotencyKey],
      );
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          throw new ApplicationError("conflict", "attachment idempotency key was reused with different input");
        }
        return this.toRef(replay);
      }
    }
    const bytes = input.source.kind === "bytes"
      ? new Uint8Array(input.source.bytes)
      : await readRemote(input.source.url, this.options, signal);
    if (signal?.aborted) throw new ApplicationError("canceled", "attachment import canceled");
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES) throw bodyTooLarge();
    if (input.declaredSize != null && input.declaredSize !== bytes.byteLength) {
      throw new ApplicationError("invalid_argument", "attachment size does not match declaration");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (input.declaredSha256 != null && input.declaredSha256.toLowerCase() !== digest) {
      throw new ApplicationError("invalid_argument", "attachment digest does not match declaration");
    }

    let stored = this.options.db.get<AttachmentRow>(
      "SELECT * FROM attachments WHERE account_id = ? AND sha256 = ? AND size = ?",
      [principal.accountId, digest, bytes.byteLength],
    );
    if (!stored) {
      const id = attachmentIdSchema.parse(crypto.randomUUID());
      const accountDirectory = join(this.blobs, principal.accountId);
      mkdirSync(accountDirectory, { recursive: true });
      const storageRef = join(accountDirectory, digest);
      if (!existsSync(storageRef)) {
        const temporary = join(accountDirectory, `.${id}.tmp`);
        try {
          writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
          renameSync(temporary, storageRef);
        } catch (error) {
          try { unlinkSync(temporary); } catch { /* absent or already renamed */ }
          if (!existsSync(storageRef)) throw error;
        }
      }
      try {
        this.options.db.run(
          `INSERT INTO attachments (id, account_id, name, media_type, size, sha256, storage_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, principal.accountId, name, mediaType, bytes.byteLength, digest, storageRef, Date.now()],
        );
      } catch (error) {
        stored = this.options.db.get<AttachmentRow>(
          "SELECT * FROM attachments WHERE account_id = ? AND sha256 = ? AND size = ?",
          [principal.accountId, digest, bytes.byteLength],
        );
        if (!stored) throw error;
      }
      stored ??= { id, account_id: principal.accountId, name, media_type: mediaType, size: bytes.byteLength, sha256: digest, storage_ref: storageRef };
    }
    if (idempotencyKey) {
      try {
        this.options.db.run(
          `INSERT INTO attachment_import_idempotency
           (id, account_id, subject_id, idempotency_key, fingerprint, attachment_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), principal.accountId, principal.subjectId, idempotencyKey, fingerprint, stored.id, Date.now()],
        );
      } catch (error) {
        const replay = this.options.db.get<AttachmentReplayRow>(
          `SELECT a.*, i.fingerprint FROM attachment_import_idempotency i
           JOIN attachments a ON a.id = i.attachment_id AND a.account_id = i.account_id
           WHERE i.account_id = ? AND i.subject_id = ? AND i.idempotency_key = ?`,
          [principal.accountId, principal.subjectId, idempotencyKey],
        );
        if (!replay) throw error;
        if (replay.fingerprint !== fingerprint) {
          throw new ApplicationError("conflict", "attachment idempotency key was reused with different input");
        }
        stored = replay;
      }
    }
    return this.toRef(stored);
  }

  async open(principal: ProtocolPrincipal, attachmentId: AttachmentId, signal?: AbortSignal): Promise<AttachmentContent> {
    if (signal?.aborted) throw new ApplicationError("canceled", "attachment open canceled");
    const row = this.row(principal.accountId, attachmentId);
    const file = Bun.file(row.storage_ref);
    if (!(await file.exists()) || file.size !== row.size) {
      throw new ApplicationError("internal", "attachment blob is unavailable");
    }
    return { attachment: this.toRef(row), body: file.stream() };
  }

  async createDownloadUrl(principal: ProtocolPrincipal, attachmentId: AttachmentId, expiresAt: number): Promise<string> {
    this.row(principal.accountId, attachmentId);
    const now = Date.now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 15 * 60_000) {
      throw new ApplicationError("invalid_argument", "attachment URL expiry must be within 15 minutes");
    }
    const url = new URL(`/v1/attachments/${attachmentId}`, this.options.publicOrigin);
    url.searchParams.set("account", principal.accountId);
    url.searchParams.set("expires", String(expiresAt));
    url.searchParams.set("sig", hmac(this.options.signingKey, `${principal.accountId}\n${attachmentId}\n${expiresAt}`));
    return url.toString();
  }

  verifyDownload(attachmentId: AttachmentId, accountId: string, expiresAt: number, signature: string): boolean {
    if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) return false;
    const expected = hmac(this.options.signingKey, `${accountId}\n${attachmentId}\n${expiresAt}`);
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  }

  private row(accountId: string, attachmentId: AttachmentId): AttachmentRow {
    const row = this.options.db.get<AttachmentRow>(
      "SELECT * FROM attachments WHERE account_id = ? AND id = ?",
      [accountId, attachmentId],
    );
    if (!row) throw new ApplicationError("not_found", "attachment not found");
    return row;
  }

  private toRef(row: AttachmentRow): AttachmentRef {
    return attachmentRefSchema.parse({
      id: row.id,
      name: row.name,
      mediaType: row.media_type,
      size: row.size,
      sha256: row.sha256,
    });
  }
}
