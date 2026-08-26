import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const KEY_ID = "v1";

export function redactSecrets(text: string): string {
  return text
    .replace(/xai-[A-Za-z0-9_\-]{8,}/g, "xai-[redacted]")
    .replace(/XAI_API_KEY[=:\s]+[^\s"',}]+/gi, "XAI_API_KEY=[redacted]")
    .replace(/ob_sess_[A-Fa-f0-9]+/g, "ob_sess_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]");
}

export class RedactingLogger {
  readonly lines: string[] = [];

  constructor(private readonly sink: (line: string) => void = (l) => console.log(l)) {}

  private emit(level: string, msg: string, extra?: Record<string, unknown>): void {
    const payload = extra ? { level, msg, ...extra } : { level, msg };
    const line = redactSecrets(JSON.stringify(payload));
    this.lines.push(line);
    this.sink(line);
  }

  info(msg: string, extra?: Record<string, unknown>): void {
    this.emit("info", msg, extra);
  }

  error(msg: string, extra?: Record<string, unknown>): void {
    this.emit("error", msg, extra);
  }

  containsSecretLeak(): boolean {
    return this.lines.some((l) => /xai-[A-Za-z0-9_\-]{8,}/.test(l) && !l.includes("[redacted]"));
  }
}

export function loadOrCreateMasterKey(home: string, envKey?: string): Buffer {
  if (envKey && envKey.length >= 32) {
    return createHash("sha256").update(envKey).digest();
  }
  mkdirSync(home, { recursive: true });
  const path = join(home, "master.key");
  if (existsSync(path)) {
    return Buffer.from(readFileSync(path, "utf8").trim(), "hex");
  }
  const key = randomBytes(32);
  writeFileSync(path, key.toString("hex"), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
  return key;
}

export type Envelope = {
  ciphertext: Buffer;
  dekWrapped: Buffer;
  keyId: string;
  lastFour: string;
};

export function seal(master: Buffer, plaintext: string): Envelope {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([iv, tag, encrypted]);

  const wrapIv = randomBytes(12);
  const wrap = createCipheriv("aes-256-gcm", master, wrapIv);
  const wrapped = Buffer.concat([wrap.update(dek), wrap.final()]);
  const wrapTag = wrap.getAuthTag();
  const dekWrapped = Buffer.concat([wrapIv, wrapTag, wrapped]);

  const lastFour = plaintext.slice(-4);
  return { ciphertext, dekWrapped, keyId: KEY_ID, lastFour };
}

export function open(master: Buffer, envelope: Envelope): string {
  const wrapIv = envelope.dekWrapped.subarray(0, 12);
  const wrapTag = envelope.dekWrapped.subarray(12, 28);
  const wrapped = envelope.dekWrapped.subarray(28);
  const unwrap = createDecipheriv("aes-256-gcm", master, wrapIv);
  unwrap.setAuthTag(wrapTag);
  const dek = Buffer.concat([unwrap.update(wrapped), unwrap.final()]);

  const iv = envelope.ciphertext.subarray(0, 12);
  const tag = envelope.ciphertext.subarray(12, 28);
  const encrypted = envelope.ciphertext.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
