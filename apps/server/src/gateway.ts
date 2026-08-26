import { join } from "node:path";
import { DEFAULT_GROK_MODEL, DEFAULT_REASONING_EFFORT } from "@openbot/acp-grok";
import { id, now, type OpenbotDb } from "@openbot/db";
import { ensureGatewayWorkspace } from "@openbot/runner";
import { currentOrgMeta } from "./org.ts";

export const GATEWAY_DESCRIPTION =
  "Diplomat for this org. Speaks to other orgs. Not a desk coder.";

const GATEWAY_NAMES = [
  "Gateway",
  "Gateway-1",
  "Gateway-2",
  "Gateway-3",
  "Gateway-4",
  "Gateway-5",
  "Gateway-6",
  "Gateway-7",
  "Gateway-8",
];

export function bindOrgAccountIfNeeded(db: OpenbotDb): string | null {
  const org = currentOrgMeta(db);
  if (!org) return null;
  if (org.account_id) return org.account_id;
  const oldest = db.get<{ id: string }>(
    "SELECT id FROM accounts ORDER BY created_at ASC, id ASC LIMIT 1",
  );
  if (!oldest) return null;
  db.run("UPDATE org_meta SET account_id = ? WHERE id = 'current'", [oldest.id]);
  return oldest.id;
}

export function ensureComputeInstance(db: OpenbotDb, accountId: string, workspacePath: string): string {
  const existing = db.get<{ id: string }>("SELECT id FROM compute_instances WHERE account_id = ?", [
    accountId,
  ]);
  if (existing) return existing.id;
  const computeId = id();
  db.run(
    `INSERT INTO compute_instances (id, account_id, driver, workspace_path, state, created_at)
     VALUES (?, ?, 'localhost', ?, 'running', ?)`,
    [computeId, accountId, workspacePath, now()],
  );
  return computeId;
}

export function findActiveGateway(
  db: OpenbotDb,
  accountId: string,
): { id: string; name: string } | undefined {
  return db.get<{ id: string; name: string }>(
    `SELECT id, name FROM bots
      WHERE account_id = ? AND IFNULL(role, 'desk') = 'gateway' AND status = 'active'`,
    [accountId],
  );
}

function pickGatewayName(db: OpenbotDb, accountId: string): string | null {
  for (const name of GATEWAY_NAMES) {
    const taken = db.get(
      "SELECT id FROM bots WHERE account_id = ? AND status = 'active' AND lower(name) = lower(?)",
      [accountId, name],
    );
    if (!taken) return name;
  }
  return null;
}

export function ensureGatewayBot(db: OpenbotDb, desk: string): { id: string; name: string } | null {
  const org = currentOrgMeta(db);
  if (!org?.account_id) return null;
  const accountId = org.account_id;
  let row: { id: string; name: string };
  try {
    row = db.immediate(() => {
      const existing = findActiveGateway(db, accountId);
      if (existing) return existing;
      ensureComputeInstance(db, accountId, desk);
      const name = pickGatewayName(db, accountId);
      if (!name) {
        throw new Error("gateway.provision failed: names Gateway through Gateway-8 are taken");
      }
      const botId = id();
      const threadId = id();
      const t = now();
      db.run(
        `INSERT INTO bots (id, account_id, name, description, status, permission_mode, harness, require_human_approval, model, reasoning_effort, role, created_at)
         VALUES (?, ?, ?, ?, 'active', 'ask', 'grok', 0, ?, ?, 'gateway', ?)`,
        [botId, accountId, name, GATEWAY_DESCRIPTION, DEFAULT_GROK_MODEL, DEFAULT_REASONING_EFFORT, t],
      );
      db.run(
        `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, 'New thread', 'human', ?)`,
        [threadId, accountId, botId, t],
      );
      return { id: botId, name };
    });
  } catch (err) {
    const again = findActiveGateway(db, accountId);
    if (again) {
      ensureGatewayWorkspace(desk);
      return again;
    }
    throw err;
  }
  ensureGatewayWorkspace(desk);
  return row;
}

export function provisionOrgGateway(db: OpenbotDb, home: string): { id: string; name: string } | null {
  bindOrgAccountIfNeeded(db);
  return ensureGatewayBot(db, join(home, "desk"));
}
