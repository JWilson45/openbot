import { expect, test } from "bun:test";
import { join } from "node:path";
import { OpenbotDb } from "@openbot/db";
import { tempHome } from "./helpers.ts";

test("schema applies on a fresh sqlite file", () => {
  const db = OpenbotDb.open(join(tempHome(), "openbot.sqlite"));
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  );
  const names = tables.map((t) => t.name);
  for (const required of [
    "accounts",
    "bots",
    "threads",
    "turns",
    "messages",
    "harness_sessions",
    "mcp_tokens",
    "credentials",
    "takeover_tickets",
    "api_keys",
    "org_meta",
    "thread_participants",
    "org_members",
    "org_peers",
    "org_inbox",
    "org_solicit",
    "thread_bridges",
  ]) {
    expect(names).toContain(required);
  }
  const botCols = db.all<{ name: string }>("PRAGMA table_info(bots)").map((c) => c.name);
  expect(botCols).toContain("harness");
  expect(botCols).toContain("model");
  expect(botCols).toContain("reasoning_effort");
  expect(botCols).toContain("role");
  const roleCol = db.all<{ name: string; dflt_value: unknown }>("PRAGMA table_info(bots)").find((c) => c.name === "role");
  expect(String(roleCol?.dflt_value)).toContain("desk");
  const indexes = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").map((i) => i.name);
  expect(indexes).toContain("bots_one_active_gateway");
  expect(db.all<{ name: string }>("PRAGMA table_info(threads)").map((c) => c.name)).toContain("kind");
  const apiKeyCols = db.all<{ name: string }>("PRAGMA table_info(api_keys)").map((c) => c.name);
  for (const col of [
    "id",
    "account_id",
    "name",
    "token_hash",
    "prefix",
    "last_four",
    "created_at",
    "last_used_at",
    "revoked_at",
  ]) {
    expect(apiKeyCols).toContain(col);
  }
  const orgCols = db.all<{ name: string; dflt_value: unknown; notnull: number }>("PRAGMA table_info(org_meta)");
  const orgNames = orgCols.map((c) => c.name);
  for (const col of [
    "id",
    "account_id",
    "org_id",
    "slug",
    "name",
    "public_origin",
    "pubkey",
    "federation_enabled",
    "created_at",
  ]) {
    expect(orgNames).toContain(col);
  }
  const fed = orgCols.find((c) => c.name === "federation_enabled");
  expect(fed?.notnull).toBe(1);
  expect(String(fed?.dflt_value)).toBe("0");
  const memberCols = db.all<{ name: string }>("PRAGMA table_info(org_members)").map((c) => c.name);
  for (const col of ["id", "org_id", "user_id", "account_id", "role", "created_at"]) {
    expect(memberCols).toContain(col);
  }
  const indexes = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").map((i) => i.name);
  expect(indexes).toContain("org_members_user");
  const peerCols = db.all<{ name: string }>("PRAGMA table_info(org_peers)").map((c) => c.name);
  for (const col of ["id", "peer_org_id", "slug", "name", "base_url", "pubkey", "status", "created_at"]) {
    expect(peerCols).toContain(col);
  }
  const inboxCols = db.all<{ name: string }>("PRAGMA table_info(org_inbox)").map((c) => c.name);
  for (const col of [
    "id",
    "message_id",
    "from_org_id",
    "from_slug",
    "to_org_id",
    "hop",
    "urgency",
    "body",
    "envelope",
    "status",
    "acked_turn_id",
    "acked_at",
    "created_at",
  ]) {
    expect(inboxCols).toContain(col);
  }
  const solicitCols = db.all<{ name: string }>("PRAGMA table_info(org_solicit)").map((c) => c.name);
  for (const col of ["id", "bucket", "reason", "count", "host", "last_at", "last_notice_message_id"]) {
    expect(solicitCols).toContain(col);
  }
  expect(indexes).toContain("org_inbox_peer_msg");
  expect(indexes).toContain("org_solicit_bucket_reason");
  expect(indexes).toContain("thread_bridges_local");
  expect(indexes).toContain("thread_bridges_peer_thread");
  const bridgeCols = db.all<{ name: string; dflt_value: unknown; notnull: number }>(
    "PRAGMA table_info(thread_bridges)",
  );
  const bridgeNames = bridgeCols.map((c) => c.name);
  for (const col of [
    "id",
    "local_thread_id",
    "peer_org_id",
    "peer_thread_id",
    "auto_forward",
    "created_at",
  ]) {
    expect(bridgeNames).toContain(col);
  }
  const autoForward = bridgeCols.find((c) => c.name === "auto_forward");
  expect(autoForward?.notnull).toBe(1);
  expect(String(autoForward?.dflt_value)).toBe("0");
  const msgCols = db.all<{ name: string }>("PRAGMA table_info(messages)").map((c) => c.name);
  expect(msgCols).toContain("remote_org_id");
  expect(msgCols).toContain("remote_actor_name");
});
