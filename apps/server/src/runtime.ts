import type {
  RuntimeProvider,
  RuntimeProviderRegistry,
  RuntimeSessionRequest,
} from "@openbot/application";
import {
  ApplicationError,
  type AccountId,
  type RuntimeCapabilities,
  type RuntimeProviderDescriptor,
} from "@openbot/core";
import {
  id,
  now,
  readNotes,
  scanMemoryText,
  type OpenbotDb,
} from "@openbot/db";
import {
  DEFAULT_GROK_MODEL,
  DEFAULT_REASONING_EFFORT,
  grokCliSignedIn,
  listGrokModels,
} from "@openbot/acp-grok";
import type { EnsureHarnessRequest, RunnerSession } from "@openbot/compute-protocol";
import { loadOverlayRoster, mintMcpToken, persistMcpToken } from "@openbot/mcp-send-message";
import {
  type GrokRuntimeHost,
  type GrokRuntimeReleaseOutcome,
  type PreparedGrokRunner,
} from "@openbot/runtime-grok";
import { acpIdleTtlMs, gatewayAcpIdleTtlMs } from "@openbot/runner";
import { open, type Envelope } from "@openbot/vault";
import type { TurnEngine } from "./engine.ts";
import { currentOrgMeta } from "./org.ts";

type Bridge = {
  accountId: string;
  botId: string;
  taskId: string;
  runIds: Set<string>;
  providerSessionRef: string | null;
  turnId: string;
  harnessSessionId: string;
  mcpTokenHash: string;
  prepared: PreparedGrokRunner;
  paused: boolean;
};

type BotRow = {
  id: string;
  account_id: string;
  name: string;
  description: string;
  permission_mode: string;
  role: string | null;
};

type CanonicalRunRow = {
  id: string;
  account_id: string;
  task_id: string;
  agent_id: string;
  status: string;
  provider_session_ref: string | null;
};

function bridgeKey(accountId: string, botId: string): string {
  return `${accountId}:${botId}`;
}

function safeStandingNotes(value: string): string {
  const scanned = scanMemoryText(value);
  return scanned.ok ? scanned.text : "";
}

export class RuntimeProviderMap implements RuntimeProviderRegistry {
  readonly #providers = new Map<string, RuntimeProvider>();

  constructor(providers: readonly RuntimeProvider[]) {
    for (const provider of providers) {
      if (this.#providers.has(provider.id)) {
        throw new ApplicationError("invalid_argument", `duplicate runtime provider: ${provider.id}`);
      }
      this.#providers.set(provider.id, provider);
    }
  }

  get(providerId: string): RuntimeProvider {
    const provider = this.#providers.get(providerId);
    if (!provider) throw new ApplicationError("not_found", `runtime provider is not registered: ${providerId}`);
    return provider;
  }

  async list(accountId: AccountId): Promise<readonly RuntimeProviderDescriptor[]> {
    return Promise.all([...this.#providers.values()].map((provider) => provider.describe(accountId)));
  }
}

export type OpenbotGrokRuntimeHostOptions = {
  db: OpenbotDb;
  engine: TurnEngine;
  home: string;
  master: Buffer;
  mcpPort(): number;
};

/** Infrastructure bridge kept outside the provider-neutral runtime package. */
export class OpenbotGrokRuntimeHost implements GrokRuntimeHost {
  readonly #bridges = new Map<string, Bridge>();

  constructor(private readonly options: OpenbotGrokRuntimeHostOptions) {}

  describe(): RuntimeProviderDescriptor {
    return {
      id: "grok",
      label: "Grok",
      authMethods: [
        { id: "grok-cli", label: "Grok CLI login", kind: "external" },
        { id: "xai-api-key", label: "xAI API key", kind: "api_key" },
      ],
    };
  }

  listModels() {
    return listGrokModels(this.options.home).map((model, index) => ({
      id: model.id,
      label: model.name,
      description: model.description,
      reasoningEfforts: model.reasoningEfforts.map((effort) => effort.value),
      ...(index === 0 ? { isDefault: true } : {}),
    }));
  }

  resolveCapabilities(_accountId: AccountId, config: RuntimeSessionRequest["config"]): RuntimeCapabilities {
    const model = listGrokModels(this.options.home).find((candidate) => candidate.id === config.modelId);
    if (!model) throw new ApplicationError("invalid_argument", `unknown Grok model: ${config.modelId}`);
    const requestedEffort = config.options.reasoningEffort;
    if (
      requestedEffort !== undefined &&
      (typeof requestedEffort !== "string" || !model.reasoningEfforts.some((effort) => effort.value === requestedEffort))
    ) {
      throw new ApplicationError("invalid_argument", "unsupported Grok reasoning effort");
    }
    return {
      supported: ["streaming", "resume", "cancellation", "actions", "interrupts", "reasoning_summaries"],
      extensions: [],
    };
  }

  authState(accountId: AccountId) {
    const credential = this.options.db.get<{ present: number }>(
      "SELECT 1 AS present FROM credentials WHERE account_id = ? AND kind = 'xai_api_key' LIMIT 1",
      [accountId],
    );
    if (credential || grokCliSignedIn() || Boolean(process.env.OPENBOT_ACP_COMMAND)) {
      return { status: "ready" as const, methodId: credential ? "xai-api-key" : "grok-cli" };
    }
    return {
      status: "missing" as const,
      methodId: "grok-cli",
      message: "Sign in with the Grok CLI or configure an xAI API key.",
    };
  }

  async prepare(request: RuntimeSessionRequest, signal?: AbortSignal): Promise<PreparedGrokRunner> {
    if (signal?.aborted) throw new ApplicationError("canceled", "runtime preparation canceled");
    const bot = this.options.db.get<BotRow>(
      `SELECT id, account_id, name, description, permission_mode, role
         FROM bots WHERE id = ? AND account_id = ? AND status = 'active'`,
      [request.agentId, request.accountId],
    );
    if (!bot) throw new ApplicationError("not_found", "runtime agent not found");
    const run = this.#canonicalRun(request);
    if (!["queued", "running"].includes(run.status)) {
      throw new ApplicationError("conflict", `runtime run is ${run.status}`);
    }

    const key = bridgeKey(bot.account_id, bot.id);
    const prior = this.#bridges.get(key);
    if (prior) {
      if (!prior.paused || !request.resumeSessionRef) {
        throw new ApplicationError("conflict", "agent already has an active runtime session", { retryable: true });
      }
      if (
        prior.accountId !== request.accountId || prior.botId !== request.agentId ||
        prior.taskId !== request.taskId || prior.providerSessionRef !== request.resumeSessionRef
      ) {
        throw new ApplicationError("conflict", "paused runtime session identity does not match");
      }
      if (run.provider_session_ref !== null && run.provider_session_ref !== prior.providerSessionRef) {
        throw new ApplicationError("conflict", "canonical run belongs to another provider session");
      }
      prior.runIds.add(request.runId);
      prior.paused = false;
      return prior.prepared;
    }
    if (request.resumeSessionRef) {
      const sessionOwner = this.options.db.get<{ present: number }>(
        `SELECT 1 AS present FROM agent_runs
         WHERE account_id = ? AND task_id = ? AND agent_id = ?
           AND provider_session_ref = ? LIMIT 1`,
        [request.accountId, request.taskId, request.agentId, request.resumeSessionRef],
      );
      if (!sessionOwner) {
        throw new ApplicationError("conflict", "provider session does not belong to the canonical task");
      }
      if (run.provider_session_ref !== null && run.provider_session_ref !== request.resumeSessionRef) {
        throw new ApplicationError("conflict", "canonical run belongs to another provider session");
      }
      // A process restart may still let the runner resume its ACP session. It
      // cannot, however, recover an in-memory permission prompt safely.
      const openInterrupt = this.options.db.get<{ present: number }>(
        `SELECT 1 AS present FROM agent_interrupts i
          JOIN agent_runs r ON r.id = i.run_id
         WHERE i.account_id = ? AND i.task_id = ? AND i.status = 'resolved'
           AND r.provider_session_ref = ? LIMIT 1`,
        [request.accountId, request.taskId, request.resumeSessionRef],
      );
      if (openInterrupt) {
        throw new ApplicationError("unavailable", "paused Grok permission session is no longer resident", {
          retryable: false,
        });
      }
    }
    if (!this.options.engine.beginExternalRun(bot.id)) {
      throw new ApplicationError("conflict", "agent is already running", { retryable: true });
    }

    try {
      const runner = this.options.engine.runnerFor(bot.account_id);
      await runner.ensure(bot.account_id);
      const isGateway = bot.role === "gateway";
      const cwd = isGateway
        ? await runner.ensureGatewayWorkspace()
        : await runner.ensureProject(bot.id, bot.name);
      const thread = this.options.db.get<{ id: string }>(
        `SELECT id FROM threads WHERE account_id = ? AND bot_id = ?
         ORDER BY CASE WHEN IFNULL(kind, 'human') = 'human' THEN 0 ELSE 1 END, created_at, id LIMIT 1`,
        [bot.account_id, bot.id],
      );
      if (!thread) throw new ApplicationError("internal", "runtime agent has no legacy action context");
      const compute = this.options.db.get<{ id: string }>(
        "SELECT id FROM compute_instances WHERE account_id = ?",
        [bot.account_id],
      );
      if (!compute) throw new ApplicationError("unavailable", "runtime compute is not provisioned", { retryable: true });
      const credential = this.options.db.get<{
        ciphertext: Uint8Array;
        dek_wrapped: Uint8Array;
        key_id: string;
      }>(
        "SELECT ciphertext, dek_wrapped, key_id FROM credentials WHERE account_id = ? AND kind = 'xai_api_key'",
        [bot.account_id],
      );
      let apiKey = "";
      if (credential) {
        const envelope: Envelope = {
          ciphertext: Buffer.from(credential.ciphertext),
          dekWrapped: Buffer.from(credential.dek_wrapped),
          keyId: credential.key_id,
          lastFour: "",
        };
        apiKey = open(this.options.master, envelope);
      }
      const notes = readNotes(this.options.db, bot.account_id, bot.id);
      const org = currentOrgMeta(this.options.db);
      const reasoningEffort = typeof request.config.options.reasoningEffort === "string"
        ? request.config.options.reasoningEffort
        : DEFAULT_REASONING_EFFORT;
      const roster = loadOverlayRoster(this.options.db, bot.account_id);
      const skillNames = isGateway ? [] : await runner.listDeskSkillNames(32);
      const idleTtlMs = isGateway ? gatewayAcpIdleTtlMs() : acpIdleTtlMs();
      const mcpPort = this.options.mcpPort();
      if (!Number.isSafeInteger(mcpPort) || mcpPort < 1 || mcpPort > 65_535) {
        throw new ApplicationError("internal", "runtime MCP port is invalid");
      }
      const minted = mintMcpToken();
      const ensureHarnessRequest: EnsureHarnessRequest = {
        botId: bot.id,
        env: apiKey ? { XAI_API_KEY: apiKey } : {},
        mcpUrl: `http://127.0.0.1:${mcpPort}/internal/runtime/mcp`,
        mcpToken: minted.token,
        cwd,
        botName: bot.name,
        botDescription: bot.description,
        permissionMode: ["ask", "auto", "always-approve"].includes(bot.permission_mode)
          ? bot.permission_mode as EnsureHarnessRequest["permissionMode"]
          : "ask",
        model: request.config.modelId || DEFAULT_GROK_MODEL,
        reasoningEffort,
        role: isGateway ? "gateway" : "desk",
        orgId: org?.org_id,
        orgSlug: org?.slug,
        idleTtlMs,
        omitCdp: isGateway,
        roster,
        skillNames,
        orgNotes: safeStandingNotes(notes.org),
        botNotes: safeStandingNotes(notes.bot),
      };
      if (signal?.aborted) throw new ApplicationError("canceled", "runtime preparation canceled");

      const turnId = id();
      const harnessSessionId = this.options.db.immediate(() => {
        const currentRun = this.#canonicalRun(request);
        if (!["queued", "running"].includes(currentRun.status)) {
          throw new ApplicationError("conflict", `runtime run is ${currentRun.status}`);
        }
        let harness = this.options.db.get<{ id: string }>(
          `SELECT id FROM harness_sessions
           WHERE bot_id = ? AND state = 'active' AND ended_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
          [bot.id],
        );
        if (!harness) {
          harness = { id: id() };
          this.options.db.run(
            `INSERT INTO harness_sessions(id, compute_id, bot_id, state, created_at)
             VALUES (?, ?, ?, 'active', ?)`,
            [harness.id, compute.id, bot.id, now()],
          );
        }
        // A warm ACP session retains the MCP credential supplied by its original
        // session/new call. Reactivate every credential for this harness only
        // while its next turn is running, so both a reused session and a freshly
        // spawned session can reach the private bridge. Terminal release revokes
        // the complete harness credential set again.
        this.options.db.run(
          `UPDATE mcp_tokens
              SET revoked_at = NULL
            WHERE harness_session_id = ? AND account_id = ? AND bot_id = ?`,
          [harness.id, bot.account_id, bot.id],
        );
        const createdAt = now();
        this.options.db.run(
          `INSERT INTO turns(
             id, thread_id, bot_id, harness_session_id, status, started_at, created_at,
             agent_task_id, agent_run_id
           ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
          [turnId, thread.id, bot.id, harness.id, createdAt, createdAt, request.taskId, request.runId],
        );
        persistMcpToken(this.options.db, {
          accountId: bot.account_id,
          botId: bot.id,
          threadId: thread.id,
          harnessSessionId: harness.id,
        }, minted.hash);
        return harness.id;
      });
      const prepared = { runner, ensureHarnessRequest } satisfies PreparedGrokRunner;
      this.#bridges.set(key, {
        accountId: bot.account_id,
        botId: bot.id,
        taskId: request.taskId,
        runIds: new Set([request.runId]),
        providerSessionRef: request.resumeSessionRef ?? null,
        turnId,
        harnessSessionId,
        mcpTokenHash: minted.hash,
        prepared,
        paused: false,
      });
      return prepared;
    } catch (error) {
      this.options.engine.endExternalRun(bot.id);
      throw error;
    }
  }

  release(request: RuntimeSessionRequest, outcome?: GrokRuntimeReleaseOutcome): void {
    const key = bridgeKey(request.accountId, request.agentId);
    const bridge = this.#bridges.get(key);
    if (!bridge) return;
    this.#assertReleaseIdentity(bridge, request);
    if (outcome === undefined || (outcome.status === "failed" && outcome.retryable && request.resumeSessionRef)) {
      this.#pauseBridge(bridge, request);
      return;
    }
    this.#finishBridge(bridge, outcome);
  }

  #canonicalRun(request: RuntimeSessionRequest): CanonicalRunRow {
    const run = this.options.db.get<CanonicalRunRow>(
      `SELECT id, account_id, task_id, agent_id, status, provider_session_ref
       FROM agent_runs
       WHERE id = ? AND account_id = ? AND task_id = ? AND agent_id = ?`,
      [request.runId, request.accountId, request.taskId, request.agentId],
    );
    if (!run) throw new ApplicationError("conflict", "canonical runtime run identity does not match");
    return run;
  }

  #assertReleaseIdentity(bridge: Bridge, request: RuntimeSessionRequest): void {
    if (
      bridge.accountId !== request.accountId || bridge.botId !== request.agentId ||
      bridge.taskId !== request.taskId || !bridge.runIds.has(request.runId)
    ) {
      throw new ApplicationError("conflict", "runtime release identity does not match the active bridge");
    }
    if (bridge.providerSessionRef !== null && request.resumeSessionRef !== bridge.providerSessionRef) {
      throw new ApplicationError("conflict", "runtime release provider session does not match the active bridge");
    }
  }

  #pauseBridge(bridge: Bridge, request: RuntimeSessionRequest): void {
    try {
      const run = this.#canonicalRun(request);
      const persisted = run.provider_session_ref;
      if (!persisted || persisted.length > 512) {
        throw new ApplicationError("conflict", "canonical run has no resumable provider session");
      }
      if (
        (bridge.providerSessionRef !== null && bridge.providerSessionRef !== persisted) ||
        (request.resumeSessionRef !== undefined && request.resumeSessionRef !== persisted)
      ) {
        throw new ApplicationError("conflict", "canonical provider session does not match the active bridge");
      }
      bridge.providerSessionRef = persisted;
      bridge.paused = true;
    } catch (error) {
      try {
        this.#finishBridge(bridge, {
          status: "failed",
          code: "runtime_session_identity_invalid",
          retryable: false,
        });
      } catch (cleanupError) {
        throw new ApplicationError("internal", "failed to close an invalid paused runtime bridge", {
          cause: cleanupError,
        });
      }
      throw error;
    }
  }

  #finishBridge(bridge: Bridge, outcome: GrokRuntimeReleaseOutcome): void {
    const finishedAt = now();
    const status = outcome.status === "completed" ? "completed"
      : outcome.status === "canceled" ? "cancelled"
        : "failed";
    const stopReason = outcome.status === "completed" ? outcome.stopReason ?? "end_turn"
      : outcome.status === "canceled" ? outcome.reason ?? "canceled"
        : outcome.code;
    const key = bridgeKey(bridge.accountId, bridge.botId);
    let cleanupError: unknown;
    try {
      this.options.db.immediate(() => {
        this.options.db.run(
          `UPDATE turns SET status = ?, stop_reason = ?, finished_at = ?
           WHERE id = ? AND status = 'running'`,
          [status, stopReason.slice(0, 2_000), finishedAt, bridge.turnId],
        );
        this.options.db.run(
          `UPDATE mcp_tokens SET revoked_at = ?
            WHERE harness_session_id = ? AND account_id = ? AND bot_id = ? AND revoked_at IS NULL`,
          [finishedAt, bridge.harnessSessionId, bridge.accountId, bridge.botId],
        );
      });
    } catch (error) {
      cleanupError = error;
      // The normal path above is atomic. If local storage faults midway, make
      // a second fail-closed effort so a released engine never leaves a usable
      // runtime credential attached to a legacy turn that still says running.
      try {
        this.options.db.run(
          "DELETE FROM mcp_tokens WHERE harness_session_id = ? AND account_id = ? AND bot_id = ?",
          [bridge.harnessSessionId, bridge.accountId, bridge.botId],
        );
        this.options.db.run(
          `UPDATE turns SET status = 'failed', stop_reason = 'runtime_cleanup_failed', finished_at = ?
           WHERE id = ? AND status = 'running'`,
          [finishedAt, bridge.turnId],
        );
      } catch (fallbackError) {
        cleanupError = new AggregateError(
          [error, fallbackError],
          "runtime bridge cleanup and fail-closed fallback both failed",
        );
      }
    } finally {
      if (this.#bridges.get(key) === bridge) this.#bridges.delete(key);
      this.options.engine.endExternalRun(bridge.botId);
    }
    if (cleanupError !== undefined) throw cleanupError;
  }
}
