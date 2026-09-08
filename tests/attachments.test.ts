import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemAttachmentStore } from "@openbot/attachments";
import { accountIdSchema, attachmentIdSchema } from "@openbot/core";
import { OpenbotDb, id, now } from "@openbot/db";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "openbot-attachment-"));
  homes.push(home);
  const db = OpenbotDb.open(join(home, "db.sqlite"));
  const accountId = accountIdSchema.parse(id());
  const userId = id();
  db.run("INSERT INTO users (id, github_login, created_at) VALUES (?, ?, ?)", [userId, `attachment-${userId}`, now()]);
  db.run("INSERT INTO accounts (id, auth_user_id, created_at) VALUES (?, ?, ?)", [accountId, userId, now()]);
  const store = new FilesystemAttachmentStore({
    db,
    root: join(home, "attachments"),
    publicOrigin: "https://openbot.example",
    signingKey: new Uint8Array(32).fill(7),
  });
  const principal = { accountId, subjectId: "user:test", kind: "user" as const, scopes: ["attachments"] };
  return { store, principal };
}

describe("filesystem attachment port", () => {
  test("imports, deduplicates, opens, and signs tenant-scoped bytes", async () => {
    const { store, principal } = fixture();
    const first = await store.import(principal, {
      name: "hello.txt",
      mediaType: "text/plain",
      source: { kind: "bytes", bytes: new TextEncoder().encode("hello") },
      declaredSize: 5,
      declaredSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      idempotencyKey: "ag-ui:message-1:part-0",
    });
    const again = await store.import(principal, {
      name: "ignored-on-dedup.txt",
      mediaType: "text/plain",
      source: { kind: "bytes", bytes: new TextEncoder().encode("hello") },
    });
    expect(again.id).toBe(first.id);
    expect((await store.import(principal, {
      name: "hello.txt",
      mediaType: "text/plain",
      source: { kind: "bytes", bytes: new TextEncoder().encode("hello") },
      declaredSize: 5,
      declaredSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      idempotencyKey: "ag-ui:message-1:part-0",
    })).id).toBe(first.id);
    await expect(store.import(principal, {
      name: "hello.txt",
      mediaType: "text/plain",
      source: { kind: "bytes", bytes: new TextEncoder().encode("changed") },
      idempotencyKey: "ag-ui:message-1:part-0",
    })).rejects.toMatchObject({ code: "conflict" });
    const opened = await store.open(principal, first.id);
    expect(await new Response(opened.body).text()).toBe("hello");
    const expires = Date.now() + 60_000;
    const signed = new URL(await store.createDownloadUrl(principal, first.id, expires));
    expect(store.verifyDownload(first.id, principal.accountId, expires, signed.searchParams.get("sig")!)).toBe(true);
  });

  test("rejects digest mismatches and cross-tenant reads", async () => {
    const { store, principal } = fixture();
    await expect(store.import(principal, {
      mediaType: "text/plain",
      source: { kind: "bytes", bytes: new TextEncoder().encode("hello") },
      declaredSha256: "0".repeat(64),
    })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(store.open(
      { ...principal, accountId: accountIdSchema.parse(id()) },
      attachmentIdSchema.parse(id()),
    )).rejects.toMatchObject({ code: "not_found" });
  });
});
