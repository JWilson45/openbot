import type { EnsureHarnessRequest, MaybePromise, RunnerSession } from "@openbot/compute-protocol";
import type {
  RuntimeAuthState,
  RuntimeCapabilities,
  RuntimeModelDescriptor,
  RuntimeProviderDescriptor,
} from "@openbot/core";
import type { RuntimeSessionRequest } from "@openbot/application";

export type PreparedGrokRunner = {
  runner: RunnerSession;
  ensureHarnessRequest: EnsureHarnessRequest;
};

export type GrokRuntimeReleaseOutcome =
  | { status: "completed"; stopReason?: string }
  | { status: "failed"; code: string; retryable: boolean }
  | { status: "canceled"; reason?: string };

/**
 * Infrastructure-owned host boundary. Database lookups, paths, environment,
 * credentials, MCP tokens, and runner selection are completed before the
 * provider receives this prepared value.
 */
export interface GrokRuntimeHost {
  prepare(
    request: RuntimeSessionRequest,
    signal?: AbortSignal,
  ): MaybePromise<PreparedGrokRunner>;
  describe(accountId: RuntimeSessionRequest["accountId"]): MaybePromise<RuntimeProviderDescriptor>;
  listModels(accountId: RuntimeSessionRequest["accountId"]): MaybePromise<readonly RuntimeModelDescriptor[]>;
  resolveCapabilities(
    accountId: RuntimeSessionRequest["accountId"],
    config: RuntimeSessionRequest["config"],
  ): MaybePromise<RuntimeCapabilities>;
  authState(accountId: RuntimeSessionRequest["accountId"]): MaybePromise<RuntimeAuthState>;
  /**
   * Releases request-scoped infrastructure prepared by the host. A created
   * session invokes this at most once, from close(), after recording its final
   * outcome. Initialization failures are released before createSession rejects.
   */
  release?(
    request: RuntimeSessionRequest,
    outcome?: GrokRuntimeReleaseOutcome,
  ): MaybePromise<void>;
}

export type GrokRuntimeProviderOptions = {
  id?: string;
  maximumPromptBytes?: number;
};

export const DEFAULT_MAXIMUM_GROK_PROMPT_BYTES = 8 * 1024 * 1024;
