export type ComputeId = string;

export interface ComputeContract {
  workspaceRoot(): Promise<{ path: string }>;

  exec(req: {
    cmd: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;

  display(): Promise<{
    cdpUrl: string;
    browserAlive: boolean;
    pageUrl?: string;
    pageOrigin?: string;
  }>;

  lifecycle(
    req: { op: "start" } | { op: "stop" } | { op: "health" },
  ): Promise<{
    runner: "ok" | "degraded";
    harness: "down" | "starting" | "idle" | "in_turn" | "crashed";
    browser: "down" | "up";
    diskFreeBytes: number;
    harnessSessionId?: string;
    acpSessionId?: string;
  }>;

  takeoverUrl(): Promise<{ ready: true; screencastNonce: string }>;
}

export interface ComputeDriver {
  ensure(accountId: string): Promise<{ id: string; workspacePath: string }>;
  describe(id: string): Promise<{
    driver: "localhost";
    workspacePath: string;
    state: "running" | "unhealthy";
  }>;
  wipeDesk(id: string): Promise<void>;
}

export type OverlayRoster = {
  desks: Array<{ name: string; description: string }>;
  gateway?: { name: string; description: string } | null;
};

export type EnsureHarnessRequest = {
  botId: string;
  env: Record<string, string>;
  mcpUrl: string;
  mcpToken: string;
  cwd: string;
  botName: string;
  botDescription: string;
  permissionMode: "ask" | "auto" | "always-approve";
  model?: string;
  reasoningEffort?: string;
  role?: "desk" | "gateway";
  orgId?: string;
  orgSlug?: string;
  idleTtlMs?: number;
  omitCdp?: boolean;
  resumeSessionId?: string;
  roster?: OverlayRoster;
  /** Desk only. Engine lists; ensureHarness must not re-scan. */
  skillNames?: string[];
  orgNotes?: string;
  botNotes?: string;
};

export type EnsureHarnessResult = {
  acpSessionId?: string;
  resumed: boolean;
};

export type CompactReason = "turns" | "chars" | "thread" | "overflow";

export type PromptResult = {
  stopReason: string;
  assistantText: string;
};

export type LiveWorkEvent = {
  kind: string;
  payload: Record<string, unknown>;
  botId?: string;
};

/** ACP session/request_permission decision. `defer` means follow the bot's ask/auto/always-approve setting. */
export type PermissionDecision = { allow: true } | { allow: false } | { defer: true };

export type PermissionHandler = (req: LiveWorkEvent) => Promise<PermissionDecision>;

export type MaybePromise<T> = T | Promise<T>;

export const RUNNER_PROTOCOL = 1;
export const RUNNER_HEARTBEAT_MS = 5_000;
export const RUNNER_DISCONNECT_MS = 15_000;
export const RUNNER_GRACE_MS = 120_000;
export const RUNNER_JSON_MAX_BYTES = 1_048_576;
export const ENROLL_TTL_MS = 15 * 60 * 1000;

export const RPC_RUNNER_ATTACHED = -32001;
export const RPC_UNAUTHORIZED = -32002;
export const RPC_PROTOCOL = -32003;
export const RPC_PROMPT_GONE = -32004;

export type RpcId = number | string;
export type RpcReq = { jsonrpc: "2.0"; id: RpcId; method: string; params?: unknown };
export type RpcRes = {
  jsonrpc: "2.0";
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};
export type RpcNote = { jsonrpc: "2.0"; method: string; params?: unknown };

export type RunnerHello = {
  protocol: 1;
  hostname: string;
  platform: string;
  version: string;
  grokCliSignedIn: boolean;
  warmBotIds: string[];
  inFlightPromptBotIds: string[];
  workspacePath: string;
  needsCredentials: boolean;
  enrollToken?: string;
  machineToken?: string;
};

export type RunnerHelloAck = {
  machineToken: string;
  orgId: string;
  orgSlug: string;
  env?: Record<string, string>;
  envOmitted?: "tls_required";
  mcpProxy: true;
};

export type RunnerDisplay = {
  browserAlive: boolean;
  pageUrl?: string;
  pageOrigin?: string;
  uid: number;
  chromeNotRoot: boolean;
  viewport?: { width: number; height: number };
  cdpUrl?: string;
};

export type RunnerHeartbeat = {
  harness: "down" | "starting" | "idle" | "in_turn" | "crashed";
  browser: "down" | "up";
  bots: Array<{ id: string; acpAlive: boolean }>;
  diskFreeBytes: number;
  uid?: number;
  workspacePath?: string;
};

export interface RunnerSession {
  workspaceRoot(): MaybePromise<{ path: string }>;
  exec(req: {
    cmd: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): MaybePromise<{ exitCode: number; stdout: string; stderr: string }>;
  display(): MaybePromise<RunnerDisplay>;
  lifecycle(
    req: { op: "start" } | { op: "stop" } | { op: "health" },
  ): MaybePromise<{
    runner: "ok" | "degraded" | "disconnected";
    harness: "down" | "starting" | "idle" | "in_turn" | "crashed";
    browser: "down" | "up";
    diskFreeBytes: number;
    acpSessionId?: string;
  }>;
  takeoverUrl(): MaybePromise<{ ready: true; screencastNonce: string }>;

  ensure(accountId: string): MaybePromise<{ id: string; workspacePath: string }>;
  ensureHarness(req: EnsureHarnessRequest): MaybePromise<EnsureHarnessResult>;
  prompt(text: string, botId: string): Promise<PromptResult>;
  matchesHarness(
    botId: string,
    model?: string,
    reasoningEffort?: string,
    permissionMode?: EnsureHarnessRequest["permissionMode"],
    rosterFp?: string,
  ): MaybePromise<boolean>;
  hasWarmBot(botId: string): MaybePromise<boolean>;
  listDeskSkillNames(cap?: number): MaybePromise<string[]>;
  lastPromptThread(botId: string): MaybePromise<string | undefined>;
  markPromptThread(botId: string, threadId: string): MaybePromise<void>;
  canCompact(botId: string): MaybePromise<boolean>;
  compactReason(
    botId: string,
    opts: { threadId?: string; innerBodyChars: number; switched: boolean },
  ): MaybePromise<CompactReason | undefined>;
  compactSession(
    botId: string,
    req: EnsureHarnessRequest,
  ): Promise<EnsureHarnessResult & { compacted: boolean; fallback?: "respawn" }>;
  setCompactCounters(botId: string, turns: number, chars: number): MaybePromise<void>;
  noteSuccessfulPrompt(botId: string, sentChars: number): MaybePromise<{ turns: number; chars: number }>;
  didOverflow(botId: string): MaybePromise<boolean>;
  invalidateAcp(botId: string): MaybePromise<void>;
  kill(botId: string): MaybePromise<void>;
  reapIdle(
    now?: number,
    opts?: { federationOff?: boolean; skipBotIds?: Iterable<string> },
  ): MaybePromise<string[]>;
  cancel(botId: string): MaybePromise<void>;
  respondPermission(reqId: string, allow: boolean): MaybePromise<boolean>;

  ensureProject(botId: string, name: string): MaybePromise<string>;
  ensureGatewayWorkspace(): MaybePromise<string>;
  deleteProject(botId: string): MaybePromise<void>;
  wipeDesk(): MaybePromise<void>;

  ensureBrowser(): MaybePromise<void>;
  startScreencast(
    onFrame: (
      jpeg: Uint8Array,
      meta: { pageUrl?: string; pageOrigin?: string; viewport?: { width: number; height: number } },
    ) => void,
  ): Promise<void>;
  stopTakeover(): MaybePromise<void>;
  dispatchInput(event: Record<string, unknown>): MaybePromise<void>;
  setScreencastViewport(width: number, height: number): MaybePromise<void>;
  navigate(
    url: string,
    opts?: { duringTakeover?: boolean; owner?: string },
  ): MaybePromise<{ ok: boolean; title?: string; error?: string }>;
  pageText(owner?: string): MaybePromise<{
    ok: boolean;
    url?: string;
    title?: string;
    text?: string;
    error?: string;
  }>;
  click(
    input: { text?: string; selector?: string; nth?: number },
    owner?: string,
  ): MaybePromise<{ ok: boolean; text?: string; tag?: string; count?: number; error?: string }>;
  typeText(
    input: { text: string; clear?: boolean; submit?: boolean },
    owner?: string,
  ): MaybePromise<{ ok: boolean; error?: string }>;
  waitFor(ms?: number): MaybePromise<{ ok: boolean; ms: number }>;

  onLiveWork?: (ev: LiveWorkEvent, botId?: string) => void;
  readonly harness: "down" | "starting" | "idle" | "in_turn" | "crashed";
  readonly connected: boolean;
  readonly workspacePath: string;
}

export class RunnerUnavailable extends Error {
  readonly code = "computer_offline";
  readonly httpStatus = 503;
  constructor(message = "computer_offline") {
    super(message);
    this.name = "RunnerUnavailable";
  }
}
