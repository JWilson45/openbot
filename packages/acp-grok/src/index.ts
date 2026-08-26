import { spawn, type Subprocess } from "bun";
import type { EnsureHarnessRequest, LiveWorkEvent, PromptResult } from "@openbot/compute-protocol";

type Rpc = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

export type AcpClientOptions = {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  onEvent?: (ev: LiveWorkEvent) => void;
  model?: string;
  reasoningEffort?: string;
};

function defaultCommand(opts?: { model?: string; reasoningEffort?: string }): string[] {
  const override = process.env.OPENBOT_ACP_COMMAND;
  if (override && override.trim()) {
    return splitCommand(override);
  }
  const cmd = ["grok", "agent", "--no-leader", "--always-approve"];
  if (opts?.model) cmd.push("--model", opts.model);
  if (opts?.reasoningEffort) cmd.push("--reasoning-effort", opts.reasoningEffort);
  cmd.push("stdio");
  return cmd;
}

export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export class AcpClient {
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private onEvent?: (ev: LiveWorkEvent) => void;
  private assistantText = "";
  private pendingPermissions = new Map<string, number>();
  sessionId: string | null = null;
  authMethods: { id: string }[] = [];
  mcpHttp = false;
  closed = false;
  lastStderr = "";
  lastInMethod = "";
  model = "";
  reasoningEffort = "";
  lastActivityAt = Date.now();

  get pid(): number | undefined {
    return this.proc.pid;
  }

  constructor(opts: AcpClientOptions) {
    this.onEvent = opts.onEvent;
    this.model = opts.model ?? "";
    this.reasoningEffort = opts.reasoningEffort ?? "";
    const [bin, ...args] = opts.command.length ? opts.command : defaultCommand(opts);
    this.proc = spawn({
      cmd: [bin, ...args],
      cwd: opts.cwd,
      env: opts.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.readLoop();
    void this.readStderr();
  }

  static launch(opts: Omit<AcpClientOptions, "command"> & { command?: string[] }): AcpClient {
    return new AcpClient({
      ...opts,
      command: opts.command ?? defaultCommand(opts),
    });
  }

  private async readLoop(): Promise<void> {
    const stdout = this.proc.stdout;
    if (!stdout || typeof stdout === "number") return;
    const reader = stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buf = Buffer.concat([this.buf, Buffer.from(value)]);
        this.consume();
      }
    } finally {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("ACP stdout closed"));
      this.pending.clear();
    }
  }

  private async readStderr(): Promise<void> {
    const stderr = this.proc.stderr;
    if (!stderr || typeof stderr === "number") return;
    const reader = stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = Buffer.from(value).toString("utf8");
        this.lastStderr = (this.lastStderr + text).slice(-8000);
        this.onEvent?.({ kind: "harness_stderr", payload: { text: text.slice(0, 500) } });
      }
    } catch {
      /* ignore */
    }
  }

  private consume(): void {
    while (this.buf.length) {
      const s = this.buf.toString("utf8");
      const trimmedStart = s.match(/^\s*/)?.[0].length ?? 0;
      const rest = s.slice(trimmedStart);
      if (!rest) return;
      if (/^Content-Length:/i.test(rest)) {
        const headerEnd = this.buf.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = this.buf.subarray(0, headerEnd).toString("utf8");
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          this.buf = this.buf.subarray(headerEnd + 4);
          continue;
        }
        const len = Number(match[1]);
        const start = headerEnd + 4;
        if (this.buf.length < start + len) return;
        this.dispatchJson(this.buf.subarray(start, start + len).toString("utf8"));
        this.buf = this.buf.subarray(start + len);
        continue;
      }
      const nl = this.buf.indexOf("\n");
      if (nl < 0) return;
      const line = this.buf.subarray(0, nl).toString("utf8").trim();
      this.buf = this.buf.subarray(nl + 1);
      if (line) this.dispatchJson(line);
    }
  }

  private dispatchJson(json: string): void {
    try {
      this.dispatch(JSON.parse(json) as Rpc);
    } catch {
      /* ignore non-JSON */
    }
  }

  private dispatch(msg: Rpc): void {
    if (msg.method) this.lastInMethod = msg.method;
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") {
      const params = msg.params as {
        sessionId?: string;
        update?: { sessionUpdate?: string; content?: unknown; title?: string };
      };
      const update = params?.update ?? {};
      const text = contentText(update.content);
      if (
        text &&
        (update.sessionUpdate === "agent_message_chunk" ||
          update.sessionUpdate === "agent_thought_chunk")
      ) {
        this.assistantText += text;
      }
      this.onEvent?.({
        kind: update.sessionUpdate ?? "update",
        payload: (params ?? {}) as Record<string, unknown>,
      });
      return;
    }
    if (msg.method === "session/request_permission") {
      const rpcId = msg.id;
      const reqId = rpcId != null ? String(rpcId) : crypto.randomUUID();
      if (rpcId != null) this.pendingPermissions.set(reqId, Number(rpcId));
      this.onEvent?.({
        kind: "permission_request",
        payload: { ...(msg.params as Record<string, unknown>), reqId, rpcId },
      });
      return;
    }
    if (msg.method && msg.id != null) {
      this.onEvent?.({ kind: "acp_request", payload: { method: msg.method, id: msg.id } });
      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `unsupported ${msg.method}` },
      });
      return;
    }
    if (msg.method) {
      this.onEvent?.({ kind: "acp_notify", payload: { method: msg.method } });
    }
  }

  respondPermission(reqId: string, allow: boolean): boolean {
    const rpcId = this.pendingPermissions.get(reqId);
    if (rpcId == null) return false;
    this.pendingPermissions.delete(reqId);
    this.send({
      jsonrpc: "2.0",
      id: rpcId,
      result: allow
        ? { outcome: { outcome: "selected", optionId: "allow-once" } }
        : { outcome: { outcome: "cancelled" } },
    });
    return true;
  }

  private send(msg: Rpc): void {
    const stdin = this.proc.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("ACP stdin closed");
    const line = JSON.stringify(msg) + "\n";
    const written = stdin.write(line);
    const flush = () => {
      if (typeof stdin.flush === "function") void stdin.flush();
    };
    if (written && typeof (written as Promise<number>).then === "function") {
      void (written as Promise<number>).then(flush);
    } else {
      flush();
    }
  }

  private request<T>(method: string, params?: unknown, timeoutMs = 45_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `ACP ${method} timed out after ${timeoutMs}ms (last inbound ${this.lastInMethod || "none"}). ${this.lastStderr.slice(-500)}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize(): Promise<void> {
    const result = await this.request<{
      protocolVersion?: string;
      agentCapabilities?: { mcpCapabilities?: { http?: boolean } };
      authMethods?: { id: string }[];
    }>("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "openbot", title: "OpenBot", version: "0.1.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }, 30_000);
    this.mcpHttp = result?.agentCapabilities?.mcpCapabilities?.http === true;
    this.authMethods = result?.authMethods ?? [];
  }

  async authenticate(opts?: { apiKey?: boolean }): Promise<void> {
    if (!this.authMethods.length) return;
    const apiKey = this.authMethods.find((m) => /api[_-]?key/i.test(m.id));
    const subscription = this.authMethods.find((m) =>
      /cached|grok\.com|oidc|session|env/i.test(m.id),
    );
    const method = opts?.apiKey
      ? (apiKey ?? this.authMethods[0])
      : (subscription ?? this.authMethods.find((m) => !/api[_-]?key/i.test(m.id)) ?? this.authMethods[0]);
    if (!method) return;
    try {
      await this.request("authenticate", { methodId: method.id, _meta: { headless: true } }, 30_000);
    } catch {
      /* CLI session in ~/.grok/auth.json is enough for grok */
    }
  }

  async newSession(req: EnsureHarnessRequest): Promise<string> {
    this.lastActivityAt = Date.now();
    this.assistantText = "";
    const mcpServers: unknown[] = [];
    if (this.mcpHttp) {
      mcpServers.push({
        type: "http",
        name: "openbot",
        url: req.mcpUrl,
        headers: [{ name: "Authorization", value: `Bearer ${req.mcpToken}` }],
      });
    } else {
      mcpServers.push({
        name: "openbot",
        command: process.execPath,
        args: [new URL("../mcp-bridge.ts", import.meta.url).pathname, req.mcpUrl, req.mcpToken],
        env: [],
      });
    }
    const result = await this.request<{ sessionId: string }>(
      "session/new",
      {
        cwd: req.cwd,
        mcpServers,
        _meta: {
          autoMode: req.permissionMode !== "ask",
          yoloMode: req.permissionMode !== "ask",
          rules: `You are ${req.botName}.\n${req.botDescription}\nThe only way to talk to the human is the SendMessage tool. You MUST call SendMessage to ask, report a result, report a blocker, or send status. Assistant text is a private work log and is not shown to the human unless you fail to call SendMessage.\nTo talk to another bot you MUST call SendToAgent. That does not notify the human.\nIf a prompt includes an "ACP session reset" block, that is restored chat memory from a harness restart. Continue as the same teammate. Never tell the human you are a new session or that you reconstructed context.`,
        },
      },
      90_000,
    );
    this.sessionId = result.sessionId;
    this.lastActivityAt = Date.now();
    return result.sessionId;
  }

  async prompt(text: string): Promise<PromptResult> {
    if (!this.sessionId) throw new Error("no ACP session");
    this.lastActivityAt = Date.now();
    this.assistantText = "";
    const result = await this.request<{ stopReason?: string }>(
      "session/prompt",
      {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      },
      10 * 60_000,
    );
    this.lastActivityAt = Date.now();
    return { stopReason: result.stopReason ?? "end_turn", assistantText: this.assistantText };
  }

  async cancel(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.request("session/cancel", { sessionId: this.sessionId });
    } catch {
      /* ignore */
    }
  }

  async kill(): Promise<void> {
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.closed = true;
  }
}

function contentText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("");
  if (typeof content === "object" && content !== null && "text" in content) {
    return String((content as { text?: unknown }).text ?? "");
  }
  return "";
}

export { defaultCommand };
export { detectCliLogins, grokCliSignedIn, type CliLoginStatus } from "./cli-auth.ts";
export { prepareIsolatedGrokHome, ISOLATED_GROK_CONFIG } from "./grok-home.ts";
export {
  DEFAULT_GROK_MODEL,
  DEFAULT_REASONING_EFFORT,
  listGrokModels,
  resolveBotInference,
  type GrokEffort,
  type GrokModelInfo,
} from "./models.ts";
export { PINNED_GROK_CLI, detectGrokCliVersion, grokCliPinStatus } from "./pin.ts";
