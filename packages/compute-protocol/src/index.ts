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
};

export type PromptResult = {
  stopReason: string;
  assistantText: string;
};

export type LiveWorkEvent = {
  kind: string;
  payload: Record<string, unknown>;
  botId?: string;
};
