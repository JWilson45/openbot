import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

/** SPKI prefix for a 32-byte Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RAW_PUBKEY_BYTES = 32;
const SIG_BYTES = 64;
const MAX_TTL_SEC = 120;
const SKEW_SEC = 60;
const SCOPE = "fed.messages";

export class FedJwsError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "FedJwsError";
  }
}

export type GeneratedEd25519 = {
  privateKey: KeyObject;
  publicKey: KeyObject;
  privateKeyPem: string;
  publicKeyRawB64: string;
};

export type SignFedJwsOpts = {
  privateKey: KeyObject;
  fromOrgId: string;
  toOrgId: string;
  messageId: string;
  rawBody: string | Uint8Array;
  nowSec?: number;
  ttlSec?: number;
};

export type VerifyFedJwsOpts = {
  publicKey: KeyObject | string;
  expectedAud: string;
  expectedJti: string;
  rawBody: string | Uint8Array;
  nowSec?: number;
};

export type FedJwsPayload = {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  scope: string;
  bth: string;
};

export type DecodedFedJws = {
  kid: string;
  payload: FedJwsPayload;
  signingInput: string;
  signature: Buffer;
};

export const FED_MAX_REQUEST_BYTES = 65_536;
export const FED_MAX_BODY_CHARS = 32_000;

export function generateEd25519(): GeneratedEd25519 {
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  if (typeof privateKeyPem !== "string") throw new Error("ed25519 pem export failed");
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    privateKeyPem,
    publicKeyRawB64: rawPublicKeyB64(pair.publicKey),
  };
}

export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

export function rawPublicKeyB64(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  const buf = Buffer.isBuffer(der) ? der : Buffer.from(der);
  if (buf.length < RAW_PUBKEY_BYTES) throw new Error("invalid_pubkey");
  return buf.subarray(buf.length - RAW_PUBKEY_BYTES).toString("base64");
}

export function parseRawPublicKeyB64(b64: string): Buffer {
  const t = b64.trim();
  if (!t) throw new FedJwsError("invalid_pubkey", "invalid_pubkey");
  const buf = Buffer.from(t, "base64");
  if (buf.length !== RAW_PUBKEY_BYTES) throw new FedJwsError("invalid_pubkey", "invalid_pubkey");
  return buf;
}

export function publicKeyFromRawB64(b64: string): KeyObject {
  const raw = parseRawPublicKeyB64(b64);
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

export function bodyThumbprint(rawBody: string | Uint8Array): string {
  return createHash("sha256").update(asBytes(rawBody)).digest("hex");
}

export function compactEdDsaJws(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: KeyObject,
): string {
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = sign(null, Buffer.from(signingInput, "utf8"), privateKey);
  return `${signingInput}.${sig.toString("base64url")}`;
}

export function signFedJws(opts: SignFedJwsOpts): string {
  const ttl = opts.ttlSec ?? MAX_TTL_SEC;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_SEC) {
    throw new FedJwsError("ttl", "ttl must be 1..120 seconds");
  }
  const iat = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const exp = iat + ttl;
  return compactEdDsaJws(
    { alg: "EdDSA", typ: "JWT", kid: opts.fromOrgId },
    {
      iss: opts.fromOrgId,
      aud: opts.toOrgId,
      iat,
      exp,
      jti: opts.messageId,
      scope: SCOPE,
      bth: bodyThumbprint(opts.rawBody),
    },
    opts.privateKey,
  );
}

export function decodeFedJws(token: string): DecodedFedJws {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new FedJwsError("malformed", "malformed jws");
  }
  const header = parseB64urlJson(parts[0]);
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    throw new FedJwsError("malformed", "malformed jws header");
  }
  const hdr = header as Record<string, unknown>;
  if (hdr.alg !== "EdDSA") throw new FedJwsError("alg", "alg must be EdDSA");

  const signature = Buffer.from(parts[2], "base64url");
  if (signature.length !== SIG_BYTES) throw new FedJwsError("truncated", "truncated signature");

  const parsed = parseB64urlJson(parts[1]);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new FedJwsError("malformed", "malformed jws payload");
  }
  const p = parsed as Record<string, unknown>;
  const iss = reqString(p.iss, "iss");
  const aud = reqString(p.aud, "aud");
  const jti = reqString(p.jti, "jti");
  const scope = reqString(p.scope, "scope");
  const bth = reqString(p.bth, "bth");
  const iat = reqInt(p.iat, "iat");
  const exp = reqInt(p.exp, "exp");
  const kid = reqString(hdr.kid, "kid");
  if (iss !== kid) throw new FedJwsError("bind", "iss !== kid");
  return {
    kid,
    payload: { iss, aud, iat, exp, jti, scope, bth },
    signingInput: `${parts[0]}.${parts[1]}`,
    signature,
  };
}

export function verifyFedJws(token: string, opts: VerifyFedJwsOpts): FedJwsPayload {
  const decoded = decodeFedJws(token);
  const publicKey = typeof opts.publicKey === "string" ? publicKeyFromRawB64(opts.publicKey) : opts.publicKey;
  let ok = false;
  try {
    ok = verify(null, Buffer.from(decoded.signingInput, "utf8"), publicKey, decoded.signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new FedJwsError("signature", "bad_signature");

  const { payload } = decoded;
  if (payload.jti !== opts.expectedJti) throw new FedJwsError("bind", "jti !== body.id");
  if (payload.aud !== opts.expectedAud) throw new FedJwsError("aud", "aud mismatch");
  if (payload.scope !== SCOPE) throw new FedJwsError("scope", "scope must be fed.messages");
  if (payload.exp <= payload.iat) throw new FedJwsError("ttl", "exp <= iat");
  if (payload.exp - payload.iat > MAX_TTL_SEC) throw new FedJwsError("ttl", "exp - iat > 120");

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (payload.iat > nowSec + SKEW_SEC) throw new FedJwsError("iat", "iat in the future");
  if (payload.exp < nowSec - SKEW_SEC) throw new FedJwsError("exp", "expired");

  const expectedBth = bodyThumbprint(opts.rawBody);
  if (payload.bth !== expectedBth) throw new FedJwsError("bth", "bth mismatch");

  return payload;
}

function asBytes(raw: string | Uint8Array): Buffer {
  return typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseB64urlJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new FedJwsError("malformed", "malformed jws");
  }
}

function reqString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new FedJwsError("malformed", `missing ${field}`);
  return value;
}

function reqInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new FedJwsError("malformed", `missing ${field}`);
  }
  return value;
}
