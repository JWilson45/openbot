import type { ServerWebSocket } from "bun";
import type {
  EnsureHarnessRequest,
  EnsureHarnessResult,
  LiveWorkEvent,
  PromptResult,
  RunnerDisplay,
  RunnerHeartbeat,
  RunnerHello,
  RunnerHelloAck,
  RunnerSession,
} from "@openbot/compute-protocol";
import { JsonRpcPeer } from "@openbot/runner";

export type TakeoverBridge = {
  accountId: string;
  nonce: string;
  spaWs?: ServerWebSocket;
  mediaWs?: ServerWebSocket;
};

export class RemoteRunnerClient implements RunnerSession {
  harness: "down" | "starting" | "idle" | "in_turn" | "crashed" = "down";
  connected = true;
  workspacePath = "";
  hostname = "";
  platform = "";
  runnerVersion = "";
  lastHeartbeatAt = 0;
  uid = -1;
  browser: "down" | "up" = "down";
  bots: Array<{ id: string; acpAlive: boolean }> = [];
  grokCliSignedIn = false;
  onLiveWork?: (ev: LiveWorkEvent, botId?: string) => void;
  binaryOnControl = 0;

  constructor(
    readonly accountId: string,
    readonly peer: JsonRpcPeer,
    readonly closeSocket: () => void,
  ) {}

  close(): void {
    this.connected = false;
    this.peer.rejectAll(new Error("runner closed"));
    this.closeSocket();
  }

  applyHeartbeat(h: RunnerHeartbeat): void {
    this.harness = h.harness;
    this.browser = h.browser;
    this.bots = h.bots ?? [];
    this.lastHeartbeatAt = Date.now();
    if (typeof h.uid === "number") this.uid = h.uid;
    if (h.workspacePath) this.workspacePath = h.workspacePath;
  }

  workspaceRoot(): Promise<{ path: string }> {
    return this.peer.request("workspaceRoot") as Promise<{ path: string }>;
  }
  exec(req: {
    cmd: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.peer.request("exec", req) as Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }
  display(): Promise<RunnerDisplay> {
    return this.peer.request("display") as Promise<RunnerDisplay>;
  }
  lifecycle(
    req: { op: "start" } | { op: "stop" } | { op: "health" },
  ): Promise<{
    runner: "ok" | "degraded" | "disconnected";
    harness: typeof this.harness;
    browser: "down" | "up";
    diskFreeBytes: number;
    acpSessionId?: string;
  }> {
    return this.peer.request("lifecycle", req) as Promise<{
      runner: "ok" | "degraded" | "disconnected";
      harness: typeof this.harness;
      browser: "down" | "up";
      diskFreeBytes: number;
      acpSessionId?: string;
    }>;
  }
  takeoverUrl(): Promise<{ ready: true; screencastNonce: string }> {
    return this.peer.request("takeoverUrl") as Promise<{ ready: true; screencastNonce: string }>;
  }
  ensure(accountId: string): Promise<{ id: string; workspacePath: string }> {
    return this.peer.request("ensure", { accountId }) as Promise<{ id: string; workspacePath: string }>;
  }
  ensureHarness(req: EnsureHarnessRequest): Promise<EnsureHarnessResult> {
    return this.peer.request("ensureHarness", req) as Promise<EnsureHarnessResult>;
  }
  prompt(text: string, botId: string): Promise<PromptResult> {
    return this.peer.request("prompt", { text, botId }) as Promise<PromptResult>;
  }
  matchesHarness(
    botId: string,
    model?: string,
    reasoningEffort?: string,
    permissionMode?: EnsureHarnessRequest["permissionMode"],
  ): Promise<boolean> {
    return this.peer.request("matchesHarness", { botId, model, reasoningEffort, permissionMode }) as Promise<boolean>;
  }
  invalidateAcp(botId: string): Promise<void> {
    return this.peer.request("invalidateAcp", { botId }) as Promise<void>;
  }
  kill(botId: string): Promise<void> {
    return this.peer.request("kill", { botId }) as Promise<void>;
  }
  reapIdle(
    now?: number,
    opts?: { federationOff?: boolean; skipBotIds?: Iterable<string> },
  ): Promise<string[]> {
    return this.peer.request("reapIdle", { now, opts }) as Promise<string[]>;
  }
  cancel(botId: string): Promise<void> {
    return this.peer.request("cancel", { botId }) as Promise<void>;
  }
  respondPermission(reqId: string, allow: boolean): Promise<boolean> {
    return this.peer.request("respondPermission", { reqId, allow }) as Promise<boolean>;
  }
  ensureProject(botId: string, name: string): Promise<string> {
    return this.peer.request("ensureProject", { botId, name }) as Promise<string>;
  }
  ensureGatewayWorkspace(): Promise<string> {
    return this.peer.request("ensureGatewayWorkspace") as Promise<string>;
  }
  deleteProject(botId: string): Promise<void> {
    return this.peer.request("deleteProject", { botId }) as Promise<void>;
  }
  wipeDesk(): Promise<void> {
    return this.peer.request("wipeDesk") as Promise<void>;
  }
  ensureBrowser(): Promise<void> {
    return this.peer.request("ensureBrowser") as Promise<void>;
  }
  async startScreencast(
    _onFrame: (
      jpeg: Uint8Array,
      meta: { pageUrl?: string; pageOrigin?: string; viewport?: { width: number; height: number } },
    ) => void,
  ): Promise<void> {
    /* orch takeover handler uses TakeoverBridge; nonce passed via startScreencastNonce */
  }
  startScreencastNonce(nonce: string): Promise<void> {
    return this.peer.request("startScreencast", { nonce }) as Promise<void>;
  }
  stopTakeover(): Promise<void> {
    return this.peer.request("stopTakeover") as Promise<void>;
  }
  dispatchInput(event: Record<string, unknown>): Promise<void> {
    return this.peer.request("dispatchInput", event) as Promise<void>;
  }
  setScreencastViewport(width: number, height: number): Promise<void> {
    return this.peer.request("setScreencastViewport", { width, height }) as Promise<void>;
  }
  navigate(
    url: string,
    opts?: { duringTakeover?: boolean; owner?: string },
  ): Promise<{ ok: boolean; title?: string; error?: string }> {
    return this.peer.request("navigate", { url, opts }) as Promise<{
      ok: boolean;
      title?: string;
      error?: string;
    }>;
  }
  pageText(owner?: string): Promise<{
    ok: boolean;
    url?: string;
    title?: string;
    text?: string;
    error?: string;
  }> {
    return this.peer.request("pageText", { owner }) as Promise<{
      ok: boolean;
      url?: string;
      title?: string;
      text?: string;
      error?: string;
    }>;
  }
  click(
    input: { text?: string; selector?: string; nth?: number },
    owner?: string,
  ): Promise<{ ok: boolean; text?: string; tag?: string; count?: number; error?: string }> {
    return this.peer.request("click", { input, owner }) as Promise<{
      ok: boolean;
      text?: string;
      tag?: string;
      count?: number;
      error?: string;
    }>;
  }
  typeText(
    input: { text: string; clear?: boolean; submit?: boolean },
    owner?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.peer.request("typeText", { input, owner }) as Promise<{ ok: boolean; error?: string }>;
  }
  waitFor(ms?: number): Promise<{ ok: boolean; ms: number }> {
    return this.peer.request("waitFor", { ms }) as Promise<{ ok: boolean; ms: number }>;
  }
}

export type { RunnerHello, RunnerHelloAck };
