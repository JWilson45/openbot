import { ENROLL_TTL_MS } from "@openbot/compute-protocol";
import { id, now, sha256Hex, type OpenbotDb } from "@openbot/db";
import { isLoopbackAddress } from "./org.ts";

export function hostIsLoopback(hostHeader: string | undefined | null): boolean {
  let host = (hostHeader ?? "").trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end >= 0 ? host.slice(1, end) : host;
  } else {
    host = host.split(":")[0] ?? "";
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Cookie-less enroll/revoke: loopback peer AND loopback Host. Ignore X-Forwarded-For. */
export function unauthenticatedRunnerAdminAllowed(peer: string, hostHeader: string | undefined | null): boolean {
  return isLoopbackAddress(peer) && hostIsLoopback(hostHeader);
}

export function mintRunnerSecret(prefix: "ob_enroll_" | "ob_run_"): string {
  return prefix + crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

export type RunnersRow = {
  id: string;
  account_id: string;
  hostname: string | null;
  platform: string | null;
  runner_version: string | null;
  workspace_path: string | null;
  machine_token_hash: string | null;
  status: string;
  grok_cli_signed_in: number;
  last_hello_at: number | null;
  last_heartbeat_at: number | null;
  last_disconnect_at: number | null;
  created_at: number;
  updated_at: number;
};

export function getRunnerRow(db: OpenbotDb, accountId: string): RunnersRow | undefined {
  return db.get<RunnersRow>("SELECT * FROM runners WHERE account_id = ?", [accountId]);
}

export function runnerAttached(row: RunnersRow | undefined): boolean {
  return Boolean(
    row && (row.status === "connected" || row.status === "disconnected") && row.machine_token_hash,
  );
}

export function enrollAccount(
  db: OpenbotDb,
  accountId: string,
  origin: string,
): { token: string; expiresAt: number; origin: string; join: string } {
  const row = getRunnerRow(db, accountId);
  if (runnerAttached(row)) {
    const err = new Error("runner_attached");
    (err as { code?: string }).code = "runner_attached";
    throw err;
  }
  const t = now();
  const token = mintRunnerSecret("ob_enroll_");
  const expiresAt = t + ENROLL_TTL_MS;
  db.immediate(() => {
    if (!row) {
      db.run(
        `INSERT INTO runners (id, account_id, status, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)`,
        [id(), accountId, t, t],
      );
    } else if (row.status === "revoked") {
      db.run(
        `UPDATE runners SET status = 'pending', machine_token_hash = NULL, updated_at = ? WHERE account_id = ?`,
        [t, accountId],
      );
    } else {
      db.run(`UPDATE runners SET status = 'pending', updated_at = ? WHERE account_id = ?`, [t, accountId]);
    }
    db.run(
      `INSERT INTO runner_enroll_tokens (id, account_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id(), accountId, sha256Hex(token), expiresAt, t],
    );
  });
  const join = `openbot runner join ${origin} --token ${token}`;
  return { token, expiresAt, origin, join };
}

export function revokeAccount(db: OpenbotDb, accountId: string): void {
  const t = now();
  db.run(
    `UPDATE runners SET status = 'revoked', machine_token_hash = NULL, updated_at = ? WHERE account_id = ?`,
    [t, accountId],
  );
}

export type EnrollLookup =
  | { kind: "invalid" }
  | { kind: "attached"; accountId: string }
  | { kind: "ok"; accountId: string };

/** Attached (live machine token) wins over used/expired so a second enroll hello is -32001. */
export function lookupEnrollToken(db: OpenbotDb, token: string): EnrollLookup {
  const hash = sha256Hex(token);
  const t = now();
  const row = db.get<{ id: string; account_id: string; expires_at: number; used_at: number | null }>(
    "SELECT id, account_id, expires_at, used_at FROM runner_enroll_tokens WHERE token_hash = ?",
    [hash],
  );
  if (!row) return { kind: "invalid" };
  const runner = getRunnerRow(db, row.account_id);
  if (runnerAttached(runner)) return { kind: "attached", accountId: row.account_id };
  if (row.used_at || row.expires_at < t) return { kind: "invalid" };
  return { kind: "ok", accountId: row.account_id };
}

export function consumeEnrollToken(
  db: OpenbotDb,
  token: string,
): { accountId: string } | null {
  const hash = sha256Hex(token);
  const t = now();
  return db.immediate(() => {
    const looked = lookupEnrollToken(db, token);
    if (looked.kind !== "ok") return null;
    const row = db.get<{ id: string; account_id: string }>(
      "SELECT id, account_id FROM runner_enroll_tokens WHERE token_hash = ?",
      [hash],
    );
    if (!row) return null;
    db.run("UPDATE runner_enroll_tokens SET used_at = ? WHERE id = ?", [t, row.id]);
    db.run(
      "UPDATE runner_enroll_tokens SET used_at = ? WHERE account_id = ? AND used_at IS NULL",
      [t, row.account_id],
    );
    return { accountId: row.account_id };
  });
}

export function lookupMachineToken(db: OpenbotDb, token: string): RunnersRow | undefined {
  if (!token.startsWith("ob_run_")) return undefined;
  return db.get<RunnersRow>("SELECT * FROM runners WHERE machine_token_hash = ?", [sha256Hex(token)]);
}

export function persistHello(
  db: OpenbotDb,
  accountId: string,
  hello: {
    hostname: string;
    platform: string;
    version: string;
    grokCliSignedIn: boolean;
    workspacePath: string;
  },
  machineToken?: string,
): void {
  const t = now();
  if (machineToken) {
    db.run(
      `UPDATE runners SET status = 'connected', hostname = ?, platform = ?, runner_version = ?,
         workspace_path = ?, grok_cli_signed_in = ?, machine_token_hash = ?, last_hello_at = ?,
         last_heartbeat_at = ?, updated_at = ? WHERE account_id = ?`,
      [
        hello.hostname,
        hello.platform,
        hello.version,
        hello.workspacePath,
        hello.grokCliSignedIn ? 1 : 0,
        sha256Hex(machineToken),
        t,
        t,
        t,
        accountId,
      ],
    );
  } else {
    db.run(
      `UPDATE runners SET status = 'connected', hostname = ?, platform = ?, runner_version = ?,
         workspace_path = ?, grok_cli_signed_in = ?, last_hello_at = ?, last_heartbeat_at = ?,
         updated_at = ? WHERE account_id = ?`,
      [
        hello.hostname,
        hello.platform,
        hello.version,
        hello.workspacePath,
        hello.grokCliSignedIn ? 1 : 0,
        t,
        t,
        t,
        accountId,
      ],
    );
  }
  db.run(
    `UPDATE compute_instances SET driver = 'runner', workspace_path = ?, state = 'running' WHERE account_id = ?`,
    [hello.workspacePath, accountId],
  );
}

export function persistHeartbeat(
  db: OpenbotDb,
  accountId: string,
  workspacePath?: string,
): void {
  const t = now();
  db.run(
    `UPDATE runners SET status = 'connected', last_heartbeat_at = ?,
       workspace_path = COALESCE(?, workspace_path), updated_at = ? WHERE account_id = ?`,
    [t, workspacePath ?? null, t, accountId],
  );
}

export function persistDisconnect(db: OpenbotDb, accountId: string): void {
  const t = now();
  db.run(
    `UPDATE runners SET status = 'disconnected', last_disconnect_at = ?, updated_at = ?
     WHERE account_id = ? AND status = 'connected'`,
    [t, t, accountId],
  );
}

export function publicRunnerSnapshot(row: RunnersRow | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    status: row.status,
    hostname: row.hostname,
    platform: row.platform,
    runnerVersion: row.runner_version,
    workspacePath: row.workspace_path,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastHelloAt: row.last_hello_at,
    grokCliSignedIn: Boolean(row.grok_cli_signed_in),
  };
}

