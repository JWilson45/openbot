import { Database } from "bun:sqlite";
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
    "thread_summaries",
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
    "calendar_series",
    "calendar_instances",
    "runners",
    "runner_enroll_tokens",
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
    "timezone",
    "created_at",
  ]) {
    expect(orgNames).toContain(col);
  }
  const fed = orgCols.find((c) => c.name === "federation_enabled");
  expect(fed?.notnull).toBe(1);
  expect(String(fed?.dflt_value)).toBe("0");
  const tz = orgCols.find((c) => c.name === "timezone");
  expect(tz?.notnull).toBe(1);
  expect(String(tz?.dflt_value)).toContain("UTC");
  const memberCols = db.all<{ name: string }>("PRAGMA table_info(org_members)").map((c) => c.name);
  for (const col of ["id", "org_id", "user_id", "account_id", "role", "created_at"]) {
    expect(memberCols).toContain(col);
  }
  const moreIndexes = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").map((i) => i.name);
  expect(moreIndexes).toContain("org_members_user");
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
  expect(moreIndexes).toContain("org_inbox_peer_msg");
  expect(moreIndexes).toContain("org_solicit_bucket_reason");
  expect(moreIndexes).toContain("thread_bridges_local");
  expect(moreIndexes).toContain("thread_bridges_peer_thread");
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
  const seriesCols = db.all<{ name: string }>("PRAGMA table_info(calendar_series)").map((c) => c.name);
  for (const col of [
    "id",
    "account_id",
    "title",
    "prompt",
    "assignee_bot_id",
    "thread_id",
    "kind",
    "status",
    "rrule",
    "dtstart_utc",
    "timezone",
    "require_human_approval",
    "created_by",
    "created_by_bot_id",
    "source_turn_id",
    "source_thread_id",
    "capture_summary",
    "min_interval_ms",
    "last_fired_at",
    "next_due_at",
    "created_at",
    "updated_at",
  ]) {
    expect(seriesCols).toContain(col);
  }
  expect(seriesCols).not.toContain("until_utc");
  expect(seriesCols).not.toContain("count");
  const instanceCols = db.all<{ name: string }>("PRAGMA table_info(calendar_instances)").map((c) => c.name);
  for (const col of [
    "id",
    "series_id",
    "scheduled_at",
    "status",
    "turn_id",
    "skipped_reason",
    "created_at",
    "started_at",
    "finished_at",
  ]) {
    expect(instanceCols).toContain(col);
  }
  expect(moreIndexes).toContain("calendar_series_account_status");
  expect(moreIndexes).toContain("calendar_series_next");
  expect(moreIndexes).toContain("calendar_instances_series_when");
  expect(moreIndexes).toContain("calendar_instances_status_when");
  expect(moreIndexes).toContain("calendar_instances_turn");
  const runnerCols = db.all<{ name: string }>("PRAGMA table_info(runners)").map((c) => c.name);
  for (const col of [
    "id",
    "account_id",
    "hostname",
    "platform",
    "runner_version",
    "workspace_path",
    "machine_token_hash",
    "status",
    "grok_cli_signed_in",
    "last_hello_at",
    "last_heartbeat_at",
    "last_disconnect_at",
    "created_at",
    "updated_at",
  ]) {
    expect(runnerCols).toContain(col);
  }
  const enrollCols = db.all<{ name: string }>("PRAGMA table_info(runner_enroll_tokens)").map((c) => c.name);
  for (const col of ["id", "account_id", "token_hash", "expires_at", "used_at", "created_at"]) {
    expect(enrollCols).toContain(col);
  }
  expect(moreIndexes).toContain("runner_enroll_account");
});

test("migrate adds bots.role on a pre-gateway sqlite", () => {
  const path = join(tempHome(), "openbot.sqlite");
  const raw = new Database(path);
  raw.exec(`CREATE TABLE bots (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'active',
    permission_mode text NOT NULL DEFAULT 'auto',
    harness text NOT NULL DEFAULT 'grok',
    require_human_approval integer NOT NULL DEFAULT 0,
    model text NOT NULL DEFAULT 'grok-4.6',
    reasoning_effort text NOT NULL DEFAULT 'high',
    created_at integer NOT NULL
  );`);
  raw.close();
  const db = OpenbotDb.open(path);
  const cols = db.all<{ name: string }>("PRAGMA table_info(bots)").map((c) => c.name);
  expect(cols).toContain("role");
  const indexes = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").map((i) => i.name);
  expect(indexes).toContain("bots_one_active_gateway");
  db.close();
});

test("migrate adds org_meta.timezone and calendar tables on a pre-calendar sqlite", () => {
  const path = join(tempHome(), "openbot.sqlite");
  const raw = new Database(path);
  raw.exec(`CREATE TABLE org_meta (
    id text PRIMARY KEY,
    account_id text,
    org_id text NOT NULL UNIQUE,
    slug text NOT NULL,
    name text NOT NULL,
    public_origin text,
    pubkey text NOT NULL DEFAULT '',
    federation_enabled integer NOT NULL DEFAULT 0,
    created_at integer NOT NULL
  );`);
  raw.exec(
    `INSERT INTO org_meta (id, org_id, slug, name, created_at) VALUES ('current', 'o', 'local', 'local', 0)`,
  );
  raw.close();
  const db = OpenbotDb.open(path);
  const tz = db.all<{ name: string; dflt_value: unknown; notnull: number }>("PRAGMA table_info(org_meta)").find(
    (c) => c.name === "timezone",
  );
  expect(tz?.notnull).toBe(1);
  expect(String(tz?.dflt_value)).toContain("UTC");
  expect(db.get<{ timezone: string }>("SELECT timezone FROM org_meta WHERE id = 'current'")?.timezone).toBe("UTC");
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
  expect(tables).toContain("calendar_series");
  expect(tables).toContain("calendar_instances");
  const indexes = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").map((i) => i.name);
  expect(indexes).toContain("calendar_series_account_status");
  expect(indexes).toContain("calendar_series_next");
  expect(indexes).toContain("calendar_instances_series_when");
  expect(indexes).toContain("calendar_instances_status_when");
  expect(indexes).toContain("calendar_instances_turn");
  db.close();
});
