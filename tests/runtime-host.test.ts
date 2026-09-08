import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RuntimeProvider,
  RuntimeSessionRequest,
} from "../packages/application/src/ports.ts";
import {
  ApplicationError,
  accountIdSchema,
  agentIdSchema,
  runIdSchema,
  taskIdSchema,
  type AccountId,
  type RuntimeProviderDescriptor,
} from "../packages/core/src/index.ts";
import type { RunnerSession } from "../packages/compute-protocol/src/index.ts";
import { OpenbotDb, id, now, sha256Hex } from "../packages/db/src/index.ts";
import type { GrokRuntimeReleaseOutcome } from "../packages/runtime-grok/src/types.ts";
import { verifyMcpToken } from "../packages/mcp-send-message/src/index.ts";
import type { TurnEngine } from "../apps/server/src/engine.ts";
import {
  OpenbotGrokRuntimeHost,
  RuntimeProviderMap,
} from "../apps/server/src/runtime.ts";

type RecordingProvider = RuntimeProvider & { describedAccounts: AccountId[] };

function recordingProvider(providerId: string, label: string): RecordingProvider {
  const describedAccounts: AccountId[] = [];
  return {
    id: providerId,
    describedAccounts,
    async describe(accountId) {
      describedAccounts.push(accountId);
      return { id: providerId, label, authMethods: [] };
    },
    async listModels() { return []; },
    async resolveCapabilities() { return { supported: ["streaming"], extensions: [] }; },
    validateConfig(config) { return config; },
    async authState() { return { status: "ready" }; },
    async createSession(): Promise<never> { throw new Error("not used by registry tests"); },
  };
}

class FakeRunner {
  failEnsure: unknown;
  failSkillList: unknown;
  ensureAccounts: string[] = [];
  projects: { botId: string; name: string }[] = [];
  gatewayWorkspaces = 0;
  skillCaps: (number | undefined)[] = [];

  ensure(accountId: string): { id: string; workspacePath: string } {
    this.ensureAccounts.push(accountId);
    if (this.failEnsure !== undefined) throw this.failEnsure;
    return { id: "fake-compute", workspacePath: "/fake/workspace" };
  }

  ensureProject(botId: string, name: string): string {
    this.projects.push({ botId, name });
    return `/fake/projects/${botId}`;
  }

  ensureGatewayWorkspace(): string {
    this.gatewayWorkspaces += 1;
    return "/fake/gateway";
  }

  listDeskSkillNames(cap?: number): string[] {
    this.skillCaps.push(cap);
    if (this.failSkillList !== undefined) throw this.failSkillList;
    return ["calendar", "memory"];
  }

  asSession(): RunnerSession {
    return this as unknown as RunnerSession;
  }
}

class FakeEngine {
  readonly reserved = new Set<string>();
  readonly beginCalls: string[] = [];
  readonly endCalls: string[] = [];
  readonly runnerForAccounts: string[] = [];
  rejectReservations = false;

  constructor(readonly runner: FakeRunner) {}

  beginExternalRun(botId: string): boolean {
    this.beginCalls.push(botId);
    if (this.rejectReservations || this.reserved.has(botId)) return false;
    this.reserved.add(botId);
    return true;
  }

  endExternalRun(botId: string): void {
    this.endCalls.push(botId);
    this.reserved.delete(botId);
  }

  runnerFor(accountId: string): RunnerSession {
    this.runnerForAccounts.push(accountId);
    return this.runner.asSession();
  }

  asTurnEngine(): TurnEngine {
    return this as unknown as TurnEngine;
  }
}

type HostFixture = {
  db: OpenbotDb;
  host: OpenbotGrokRuntimeHost;
  runner: FakeRunner;
  engine: FakeEngine;
  accountId: AccountId;
  agentId: ReturnType<typeof agentIdSchema.parse>;
  threadId: string;
  canonicalThreadId: string;
  computeId: string;
  request: RuntimeSessionRequest;
};

function hostFixture(): HostFixture {
  const db = OpenbotDb.open(":memory:");
  const userId = id();
  const accountId = accountIdSchema.parse(id());
  const agentId = agentIdSchema.parse(id());
  const threadId = id();
  const canonicalThreadId = id();
  const computeId = id();
  const taskId = taskIdSchema.parse(id());
  const runId = runIdSchema.parse(id());
  const timestamp = now();
  db.run("INSERT INTO users(id, github_login, created_at) VALUES (?, ?, ?)", [userId, `runtime-${userId}`, timestamp]);
  db.run("INSERT INTO accounts(id, auth_user_id, created_at) VALUES (?, ?, ?)", [accountId, userId, timestamp]);
  db.run(
    `INSERT INTO bots(
       id, account_id, name, description, status, permission_mode, role,
       provider_id, runtime_config_json, created_at, updated_at
     ) VALUES (?, ?, 'Ada', 'Runtime host test', 'active', 'ask', 'desk', 'grok', ?, ?, ?)`,
    [
      agentId,
      accountId,
      JSON.stringify({ providerId: "grok", modelId: "grok-4.6", options: { reasoningEffort: "high" } }),
      timestamp,
      timestamp,
    ],
  );
  db.run(
    `INSERT INTO compute_instances(id, account_id, driver, workspace_path, state, created_at)
     VALUES (?, ?, 'localhost', '/fake/workspace', 'running', ?)`,
    [computeId, accountId, timestamp],
  );
  db.run(
    "INSERT INTO threads(id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, 'Runtime', 'human', ?)",
    [threadId, accountId, agentId, timestamp],
  );
  db.run(
    `INSERT INTO agent_conversations(id, account_id, title, metadata_json, created_at, updated_at)
     VALUES (?, ?, NULL, '{}', ?, ?)`,
    [canonicalThreadId, accountId, timestamp, timestamp],
  );
  db.run(
    `INSERT INTO agent_tasks(id, account_id, thread_id, agent_id, status, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'working', '{}', ?, ?)`,
    [taskId, accountId, canonicalThreadId, agentId, timestamp, timestamp],
  );
  db.run(
    `INSERT INTO agent_runs(
       id, account_id, task_id, thread_id, agent_id, attempt, status,
       provider_session_ref, metadata_json, created_at, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, 1, 'running', NULL, '{}', ?, ?, NULL)`,
    [runId, accountId, taskId, canonicalThreadId, agentId, timestamp, timestamp],
  );
  const runner = new FakeRunner();
  const engine = new FakeEngine(runner);
  const home = mkdtempSync(join(tmpdir(), "openbot-runtime-host-"));
  const host = new OpenbotGrokRuntimeHost({
    db,
    engine: engine.asTurnEngine(),
    home,
    master: Buffer.alloc(32, 7),
    mcpPort: () => 4317,
  });
  const request: RuntimeSessionRequest = {
    accountId,
    agentId,
    taskId,
    runId,
    config: { providerId: "grok", modelId: "grok-4.6", options: { reasoningEffort: "high" } },
    capabilities: [],
    metadata: { source: "runtime-host-test" },
  };
  return { db, host, runner, engine, accountId, agentId, threadId, canonicalThreadId, computeId, request };
}

function setProviderSession(fixture: HostFixture, request: RuntimeSessionRequest, providerSessionRef: string): void {
  fixture.db.run(
    `UPDATE agent_runs SET provider_session_ref = ?
     WHERE id = ? AND account_id = ? AND task_id = ? AND agent_id = ?`,
    [providerSessionRef, request.runId, request.accountId, request.taskId, request.agentId],
  );
}

function addResumedRun(fixture: HostFixture, attempt: number): RuntimeSessionRequest {
  const runId = runIdSchema.parse(id());
  const timestamp = now();
  fixture.db.run(
    `INSERT INTO agent_runs(
       id, account_id, task_id, thread_id, agent_id, attempt, status,
       provider_session_ref, metadata_json, created_at, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, '{}', ?, ?, NULL)`,
    [
      runId,
      fixture.accountId,
      fixture.request.taskId,
      fixture.canonicalThreadId,
      fixture.agentId,
      attempt,
      timestamp,
      timestamp,
    ],
  );
  return {
    ...fixture.request,
    runId,
    resumeSessionRef: "acp-session-1",
  };
}

function addNewTaskRun(fixture: HostFixture): RuntimeSessionRequest {
  const taskId = taskIdSchema.parse(id());
  const runId = runIdSchema.parse(id());
  const timestamp = now();
  fixture.db.run(
    `INSERT INTO agent_tasks(id, account_id, thread_id, agent_id, status, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'working', '{}', ?, ?)`,
    [taskId, fixture.accountId, fixture.canonicalThreadId, fixture.agentId, timestamp, timestamp],
  );
  fixture.db.run(
    `INSERT INTO agent_runs(
       id, account_id, task_id, thread_id, agent_id, attempt, status,
       provider_session_ref, metadata_json, created_at, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, 1, 'running', NULL, '{}', ?, ?, NULL)`,
    [runId, fixture.accountId, taskId, fixture.canonicalThreadId, fixture.agentId, timestamp, timestamp],
  );
  return { ...fixture.request, taskId, runId };
}

async function expectApplicationError(promise: Promise<unknown>, code: ApplicationError["code"]): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationError);
    expect((error as ApplicationError).code).toBe(code);
  }
}

function expectSyncApplicationError(operation: () => unknown, code: ApplicationError["code"]): void {
  try {
    operation();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationError);
    expect((error as ApplicationError).code).toBe(code);
  }
}

function count(db: OpenbotDb, table: "turns" | "harness_sessions" | "mcp_tokens"): number {
  return db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count ?? 0;
}

describe("runtime provider map", () => {
  test("rejects duplicate providers and reports missing providers with application errors", () => {
    const first = recordingProvider("fake", "First");
    const duplicate = recordingProvider("fake", "Duplicate");
    try {
      new RuntimeProviderMap([first, duplicate]);
      throw new Error("expected duplicate provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("invalid_argument");
      expect((error as Error).message).toContain("duplicate runtime provider");
    }

    const registry = new RuntimeProviderMap([first]);
    expect(registry.get("fake")).toBe(first);
    try {
      registry.get("missing");
      throw new Error("expected missing provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("not_found");
    }
  });

  test("lists provider descriptors for the requested tenant", async () => {
    const accountId = accountIdSchema.parse(id());
    const first = recordingProvider("first", "First");
    const second = recordingProvider("second", "Second");
    const registry = new RuntimeProviderMap([first, second]);

    const descriptors: readonly RuntimeProviderDescriptor[] = await registry.list(accountId);

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(["first", "second"]);
    expect(first.describedAccounts).toEqual([accountId]);
    expect(second.describedAccounts).toEqual([accountId]);
  });
});

describe("Openbot Grok runtime host", () => {
  test("looks up active agents tenant-safely before reserving an engine", async () => {
    const fixture = hostFixture();
    try {
      const otherAccount = accountIdSchema.parse(id());
      await expectApplicationError(
        fixture.host.prepare({ ...fixture.request, accountId: otherAccount }),
        "not_found",
      );
      await expectApplicationError(
        fixture.host.prepare({ ...fixture.request, agentId: agentIdSchema.parse(id()) }),
        "not_found",
      );
      fixture.db.run("UPDATE bots SET status = 'archived' WHERE id = ?", [fixture.agentId]);
      await expectApplicationError(fixture.host.prepare(fixture.request), "not_found");
      expect(fixture.engine.beginCalls).toEqual([]);
      expect(fixture.engine.runnerForAccounts).toEqual([]);

      fixture.db.run("UPDATE bots SET status = 'active' WHERE id = ?", [fixture.agentId]);
      await fixture.host.prepare(fixture.request);
      expect(fixture.engine.beginCalls).toEqual([fixture.agentId]);
      expect(fixture.engine.runnerForAccounts).toEqual([fixture.accountId]);
      fixture.host.release(fixture.request, { status: "canceled", reason: "test cleanup" });
    } finally {
      fixture.db.close();
    }
  });

  test("creates the legacy turn, harness, scoped MCP token, and runner request", async () => {
    const fixture = hostFixture();
    try {
      const prepared = await fixture.host.prepare(fixture.request);
      const harness = fixture.db.get<{ id: string; compute_id: string; bot_id: string; state: string }>(
        "SELECT id, compute_id, bot_id, state FROM harness_sessions WHERE bot_id = ?",
        [fixture.agentId],
      );
      const turn = fixture.db.get<{
        id: string;
        thread_id: string;
        bot_id: string;
        harness_session_id: string;
        status: string;
        agent_task_id: string;
        agent_run_id: string;
      }>("SELECT * FROM turns WHERE agent_run_id = ?", [fixture.request.runId]);
      const token = fixture.db.get<{
        token_hash: string;
        account_id: string;
        bot_id: string;
        thread_id: string;
        harness_session_id: string;
        revoked_at: number | null;
      }>("SELECT * FROM mcp_tokens WHERE token_hash = ?", [sha256Hex(prepared.ensureHarnessRequest.mcpToken)]);

      expect(harness).toMatchObject({ compute_id: fixture.computeId, bot_id: fixture.agentId, state: "active" });
      expect(turn).toMatchObject({
        thread_id: fixture.threadId,
        bot_id: fixture.agentId,
        harness_session_id: harness!.id,
        status: "running",
        agent_task_id: fixture.request.taskId,
        agent_run_id: fixture.request.runId,
      });
      expect(token).toMatchObject({
        account_id: fixture.accountId,
        bot_id: fixture.agentId,
        thread_id: fixture.threadId,
        harness_session_id: harness!.id,
        revoked_at: null,
      });
      expect(prepared.runner).toBe(fixture.runner.asSession());
      expect(prepared.ensureHarnessRequest).toMatchObject({
        botId: fixture.agentId,
        cwd: `/fake/projects/${fixture.agentId}`,
        mcpUrl: "http://127.0.0.1:4317/internal/runtime/mcp",
        botName: "Ada",
        botDescription: "Runtime host test",
        permissionMode: "ask",
        model: "grok-4.6",
        reasoningEffort: "high",
        role: "desk",
        skillNames: ["calendar", "memory"],
      });
      expect(prepared.ensureHarnessRequest.mcpToken).toMatch(/^ob_sess_/);
      expect(fixture.runner.ensureAccounts).toEqual([fixture.accountId]);
      expect(fixture.runner.projects).toEqual([{ botId: fixture.agentId, name: "Ada" }]);
      expect(fixture.runner.skillCaps).toEqual([32]);
      expect(fixture.engine.reserved.has(fixture.agentId)).toBe(true);
      fixture.host.release(fixture.request, { status: "completed" });
    } finally {
      fixture.db.close();
    }
  });

  test("reactivates a warm ACP session credential only for the next running turn", async () => {
    const fixture = hostFixture();
    try {
      const first = await fixture.host.prepare(fixture.request);
      const firstToken = first.ensureHarnessRequest.mcpToken;
      fixture.host.release(fixture.request, { status: "completed" });
      expect(() => verifyMcpToken(fixture.db, `Bearer ${firstToken}`)).toThrow("invalid token");

      const secondRequest = addNewTaskRun(fixture);
      await fixture.host.prepare(secondRequest);
      expect(verifyMcpToken(fixture.db, `Bearer ${firstToken}`)).toMatchObject({
        accountId: fixture.accountId,
        botId: fixture.agentId,
      });

      fixture.host.release(secondRequest, { status: "completed" });
      expect(() => verifyMcpToken(fixture.db, `Bearer ${firstToken}`)).toThrow("invalid token");
    } finally {
      fixture.db.close();
    }
  });

  test("retains one paused bridge across close and retryable resumed failures", async () => {
    const fixture = hostFixture();
    try {
      const prepared = await fixture.host.prepare(fixture.request);
      setProviderSession(fixture, fixture.request, "acp-session-1");
      fixture.host.release(fixture.request);
      expect(fixture.engine.reserved.has(fixture.agentId)).toBe(true);
      expect(fixture.engine.endCalls).toEqual([]);

      const resumedRequest = addResumedRun(fixture, 2);
      const firstResume = await fixture.host.prepare(resumedRequest);
      expect(firstResume).toBe(prepared);
      expect(fixture.engine.beginCalls).toEqual([fixture.agentId]);
      expect(count(fixture.db, "turns")).toBe(1);
      expect(count(fixture.db, "mcp_tokens")).toBe(1);

      setProviderSession(fixture, resumedRequest, "acp-session-1");
      fixture.host.release(resumedRequest, {
        status: "failed",
        code: "provider_unavailable",
        retryable: true,
      });
      expect(fixture.engine.reserved.has(fixture.agentId)).toBe(true);
      const secondResumedRequest = addResumedRun(fixture, 3);
      const secondResume = await fixture.host.prepare(secondResumedRequest);
      expect(secondResume).toBe(prepared);
      expect(count(fixture.db, "turns")).toBe(1);
      expect(count(fixture.db, "mcp_tokens")).toBe(1);
      expect(fixture.db.get<{ revoked_at: number | null }>("SELECT revoked_at FROM mcp_tokens")?.revoked_at).toBeNull();

      fixture.host.release(secondResumedRequest, { status: "completed", stopReason: "done" });
      expect(fixture.engine.reserved.has(fixture.agentId)).toBe(false);
    } finally {
      fixture.db.close();
    }
  });

  test("resumes a paused bridge only for the same task and provider session and tracks resumed run ids", async () => {
    const fixture = hostFixture();
    try {
      const prepared = await fixture.host.prepare(fixture.request);
      setProviderSession(fixture, fixture.request, "acp-session-1");
      fixture.host.release(fixture.request);

      const wrongTaskId = taskIdSchema.parse(id());
      const wrongRunId = runIdSchema.parse(id());
      const timestamp = now();
      fixture.db.run(
        `INSERT INTO agent_tasks(id, account_id, thread_id, agent_id, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'working', '{}', ?, ?)`,
        [wrongTaskId, fixture.accountId, fixture.canonicalThreadId, fixture.agentId, timestamp, timestamp],
      );
      fixture.db.run(
        `INSERT INTO agent_runs(
           id, account_id, task_id, thread_id, agent_id, attempt, status,
           provider_session_ref, metadata_json, created_at, started_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, 1, 'running', NULL, '{}', ?, ?, NULL)`,
        [wrongRunId, fixture.accountId, wrongTaskId, fixture.canonicalThreadId, fixture.agentId, timestamp, timestamp],
      );
      await expectApplicationError(fixture.host.prepare({
        ...fixture.request,
        taskId: wrongTaskId,
        runId: wrongRunId,
        resumeSessionRef: "acp-session-1",
      }), "conflict");

      const resumedRequest = addResumedRun(fixture, 2);
      await expectApplicationError(
        fixture.host.prepare({ ...resumedRequest, resumeSessionRef: "another-session" }),
        "conflict",
      );
      expect(await fixture.host.prepare(resumedRequest)).toBe(prepared);

      const unpreparedRequest = addResumedRun(fixture, 3);
      expectSyncApplicationError(
        () => fixture.host.release(unpreparedRequest, { status: "completed" }),
        "conflict",
      );
      expect(fixture.engine.reserved.has(fixture.agentId)).toBe(true);
      expect(count(fixture.db, "turns")).toBe(1);

      fixture.host.release(resumedRequest, { status: "completed" });
      expect(fixture.engine.endCalls).toEqual([fixture.agentId]);
      expect(fixture.engine.reserved.has(fixture.agentId)).toBe(false);
    } finally {
      fixture.db.close();
    }
  });

  test("fails a pause closed when the canonical run has no persisted provider session", async () => {
    const fixture = hostFixture();
    try {
      const prepared = await fixture.host.prepare(fixture.request);
      const tokenHash = sha256Hex(prepared.ensureHarnessRequest.mcpToken);

      expectSyncApplicationError(() => fixture.host.release(fixture.request), "conflict");

      expect(fixture.db.get<{ status: string; stop_reason: string }>(
        "SELECT status, stop_reason FROM turns WHERE agent_run_id = ?",
        [fixture.request.runId],
      )).toEqual({ status: "failed", stop_reason: "runtime_session_identity_invalid" });
      expect(fixture.db.get<{ revoked_at: number | null }>(
        "SELECT revoked_at FROM mcp_tokens WHERE token_hash = ?",
        [tokenHash],
      )?.revoked_at).toEqual(expect.any(Number));
      expect(fixture.engine.endCalls).toEqual([fixture.agentId]);
      expect(fixture.engine.reserved.has(fixture.agentId)).toBe(false);

      fixture.host.release(fixture.request, { status: "completed" });
      expect(fixture.engine.endCalls).toEqual([fixture.agentId]);
    } finally {
      fixture.db.close();
    }
  });

  test("fails a resumed pause closed when its canonical provider session changes", async () => {
    const fixture = hostFixture();
    try {
      await fixture.host.prepare(fixture.request);
      setProviderSession(fixture, fixture.request, "acp-session-1");
      fixture.host.release(fixture.request);
      const resumedRequest = addResumedRun(fixture, 2);
      await fixture.host.prepare(resumedRequest);
      setProviderSession(fixture, resumedRequest, "different-session");

      expectSyncApplicationError(() => fixture.host.release(resumedRequest, {
        status: "failed",
        code: "provider_unavailable",
        retryable: true,
      }), "conflict");

      expect(fixture.db.get<{ status: string; stop_reason: string }>(
        "SELECT status, stop_reason FROM turns WHERE agent_run_id = ?",
        [fixture.request.runId],
      )).toEqual({ status: "failed", stop_reason: "runtime_session_identity_invalid" });
      expect(fixture.db.get<{ revoked_at: number | null }>("SELECT revoked_at FROM mcp_tokens")?.revoked_at)
        .toEqual(expect.any(Number));
      expect(fixture.engine.endCalls).toEqual([fixture.agentId]);
      expect(fixture.engine.reserved.has(fixture.agentId)).toBe(false);
    } finally {
      fixture.db.close();
    }
  });

  const terminalCases: readonly [string, GrokRuntimeReleaseOutcome, string, string][] = [
    ["completed", { status: "completed", stopReason: "finished" }, "completed", "finished"],
    ["canceled", { status: "canceled", reason: "operator stop" }, "cancelled", "operator stop"],
    ["failed", { status: "failed", code: "provider_error", retryable: false }, "failed", "provider_error"],
  ];

  test.each(terminalCases)("terminal %s release finishes the turn, revokes the token, and releases the reservation", async (
    _name,
    outcome,
    expectedStatus,
    expectedReason,
  ) => {
    const fixture = hostFixture();
    try {
      const prepared = await fixture.host.prepare(fixture.request);
      const tokenHash = sha256Hex(prepared.ensureHarnessRequest.mcpToken);

      fixture.host.release(fixture.request, outcome);

      expect(fixture.db.get<{ status: string; stop_reason: string; finished_at: number | null }>(
        "SELECT status, stop_reason, finished_at FROM turns WHERE agent_run_id = ?",
        [fixture.request.runId],
      )).toMatchObject({ status: expectedStatus, stop_reason: expectedReason, finished_at: expect.any(Number) });
      expect(fixture.db.get<{ revoked_at: number | null }>(
        "SELECT revoked_at FROM mcp_tokens WHERE token_hash = ?",
        [tokenHash],
      )?.revoked_at).toEqual(expect.any(Number));
      expect(fixture.engine.endCalls).toEqual([fixture.agentId]);
      expect(fixture.engine.reserved.has(fixture.agentId)).toBe(false);

      fixture.host.release(fixture.request, outcome);
      expect(fixture.engine.endCalls).toEqual([fixture.agentId]);
    } finally {
      fixture.db.close();
    }
  });

  test("releases the engine reservation when preparation fails after it is acquired", async () => {
    const fixture = hostFixture();
    try {
      fixture.runner.failSkillList = new Error("skill discovery failed");
      await expect(fixture.host.prepare(fixture.request)).rejects.toThrow("skill discovery failed");
      expect(fixture.engine.beginCalls).toEqual([fixture.agentId]);
      expect(fixture.engine.endCalls).toEqual([fixture.agentId]);
      expect(fixture.engine.reserved.has(fixture.agentId)).toBe(false);
      expect(count(fixture.db, "harness_sessions")).toBe(0);
      expect(count(fixture.db, "turns")).toBe(0);
      expect(count(fixture.db, "mcp_tokens")).toBe(0);

      fixture.runner.failSkillList = undefined;
      await expect(fixture.host.prepare(fixture.request)).resolves.toBeDefined();
      expect(fixture.engine.beginCalls).toEqual([fixture.agentId, fixture.agentId]);
      fixture.host.release(fixture.request, { status: "canceled", reason: "test cleanup" });
    } finally {
      fixture.db.close();
    }
  });

  test("does not release a reservation that the host failed to acquire", async () => {
    const fixture = hostFixture();
    try {
      fixture.engine.rejectReservations = true;
      await expectApplicationError(fixture.host.prepare(fixture.request), "conflict");
      expect(fixture.engine.beginCalls).toEqual([fixture.agentId]);
      expect(fixture.engine.endCalls).toEqual([]);
      expect(count(fixture.db, "turns")).toBe(0);
      expect(count(fixture.db, "mcp_tokens")).toBe(0);
    } finally {
      fixture.db.close();
    }
  });

  test("rolls back every prepared DB resource when MCP token persistence fails", async () => {
    const fixture = hostFixture();
    const originalRun = fixture.db.run.bind(fixture.db);
    try {
      fixture.db.run = (sql, params = []) => {
        if (sql.includes("INSERT INTO mcp_tokens")) throw new Error("token persistence failed");
        originalRun(sql, params);
      };

      await expect(fixture.host.prepare(fixture.request)).rejects.toThrow("token persistence failed");

      expect(count(fixture.db, "harness_sessions")).toBe(0);
      expect(count(fixture.db, "turns")).toBe(0);
      expect(count(fixture.db, "mcp_tokens")).toBe(0);
      expect(fixture.engine.endCalls).toEqual([fixture.agentId]);
      expect(fixture.engine.reserved.has(fixture.agentId)).toBe(false);
    } finally {
      fixture.db.run = originalRun;
      fixture.db.close();
    }
  });

  test("falls closed and still clears the bridge and reservation when atomic revocation fails", async () => {
    const fixture = hostFixture();
    const originalRun = fixture.db.run.bind(fixture.db);
    try {
      await fixture.host.prepare(fixture.request);
      fixture.db.run = (sql, params = []) => {
        if (sql.includes("UPDATE mcp_tokens SET revoked_at")) throw new Error("token revocation failed");
        originalRun(sql, params);
      };

      expect(() => fixture.host.release(fixture.request, { status: "completed" }))
        .toThrow("token revocation failed");

      expect(fixture.db.get<{ status: string; stop_reason: string | null; finished_at: number | null }>(
        "SELECT status, stop_reason, finished_at FROM turns WHERE agent_run_id = ?",
        [fixture.request.runId],
      )).toEqual({ status: "failed", stop_reason: "runtime_cleanup_failed", finished_at: expect.any(Number) });
      expect(fixture.db.get("SELECT token_hash FROM mcp_tokens")).toBeNull();
      expect(fixture.engine.endCalls).toEqual([fixture.agentId]);
      expect(fixture.engine.reserved.has(fixture.agentId)).toBe(false);

      fixture.db.run = originalRun;
      fixture.host.release(fixture.request, { status: "completed" });
      expect(fixture.engine.endCalls).toEqual([fixture.agentId]);
    } finally {
      fixture.db.run = originalRun;
      fixture.db.close();
    }
  });
});
