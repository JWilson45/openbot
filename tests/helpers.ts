import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenbotDb, id, now, sha256Hex } from "@openbot/db";
import { persistMcpToken } from "@openbot/mcp-send-message";

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "openbot-test-"));
}

export function fakeAgentCommand(): string {
  const agent = join(import.meta.dir, "fixtures/acp/fake-agent.ts");
  return `${process.execPath} ${agent}`;
}

export type World = {
  db: OpenbotDb;
  accountId: string;
  userId: string;
  botId: string;
  threadId: string;
  computeId: string;
  harnessSessionId: string;
  token: string;
};

export function seedWorld(db: OpenbotDb): World {
  const userId = id();
  const accountId = id();
  const botId = id();
  const threadId = id();
  const computeId = id();
  const harnessSessionId = id();
  const token = "ob_sess_test_" + id().replaceAll("-", "");
  const t = now();
  db.run(
    `INSERT INTO users (id, github_login, created_at) VALUES (?, 'alice', ?)`,
    [userId, t],
  );
  db.run(`INSERT INTO accounts (id, auth_user_id, created_at) VALUES (?, ?, ?)`, [accountId, userId, t]);
  db.run(
    `INSERT INTO bots (id, account_id, name, description, status, permission_mode, created_at)
     VALUES (?, ?, 'Ada', 'teammate', 'active', 'auto', ?)`,
    [botId, accountId, t],
  );
  db.run(
    `INSERT INTO compute_instances (id, account_id, driver, workspace_path, state, created_at)
     VALUES (?, ?, 'localhost', '/tmp/desk', 'running', ?)`,
    [computeId, accountId, t],
  );
  db.run(
    `INSERT INTO threads (id, account_id, bot_id, title, created_at) VALUES (?, ?, ?, 't', ?)`,
    [threadId, accountId, botId, t],
  );
  db.run(
    `INSERT INTO harness_sessions (id, compute_id, bot_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`,
    [harnessSessionId, computeId, botId, t],
  );
  persistMcpToken(
    db,
    { accountId, botId, threadId, harnessSessionId },
    sha256Hex(token),
  );
  return { db, accountId, userId, botId, threadId, computeId, harnessSessionId, token };
}

export function insertTurn(
  db: OpenbotDb,
  w: World,
  status: string,
  extra?: { sent?: number; assistant?: string },
): string {
  const turnId = id();
  db.run(
    `INSERT INTO turns (id, thread_id, bot_id, harness_session_id, status, sent_message_count, assistant_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      turnId,
      w.threadId,
      w.botId,
      w.harnessSessionId,
      status,
      extra?.sent ?? 0,
      extra?.assistant ?? "",
      now(),
    ],
  );
  return turnId;
}
