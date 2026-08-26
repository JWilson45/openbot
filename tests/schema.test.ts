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
  ]) {
    expect(names).toContain(required);
  }
  const botCols = db.all<{ name: string }>("PRAGMA table_info(bots)").map((c) => c.name);
  expect(botCols).toContain("harness");
  expect(botCols).toContain("model");
  expect(botCols).toContain("reasoning_effort");
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
});
