import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import type {
  ComputeContract,
  ComputeDriver,
  EnsureHarnessRequest,
  LiveWorkEvent,
  PromptResult,
} from "@openbot/compute-protocol";
import { AcpClient, DEFAULT_GROK_MODEL, DEFAULT_REASONING_EFFORT, prepareIsolatedGrokHome } from "@openbot/acp-grok";
import { botProjectDir, deleteBotProject, ensureBotProject, ensureGatewayWorkspace } from "./workspace.ts";

export const DEFAULT_ACP_IDLE_MS = 10 * 60 * 1000;
export const DEFAULT_GATEWAY_ACP_IDLE_MS = 30 * 60 * 1000;
export const BROWSER_SNAPSHOT_MAX_CHARS = 12_000;
export const BROWSER_VIEWPORT_MIN = { width: 640, height: 400 };
export const BROWSER_VIEWPORT_MAX = { width: 2560, height: 1440 };
export const BROWSER_VIEWPORT_DEFAULT = { width: 1280, height: 720 };

function clampViewport(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(BROWSER_VIEWPORT_MIN.width, Math.min(BROWSER_VIEWPORT_MAX.width, Math.round(width))),
    height: Math.max(BROWSER_VIEWPORT_MIN.height, Math.min(BROWSER_VIEWPORT_MAX.height, Math.round(height))),
  };
}

function envTtlMs(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function acpIdleTtlMs(): number {
  return envTtlMs(process.env.OPENBOT_ACP_IDLE_MS, DEFAULT_ACP_IDLE_MS);
}

export function gatewayAcpIdleTtlMs(): number {
  return envTtlMs(process.env.OPENBOT_GATEWAY_ACP_IDLE_MS, DEFAULT_GATEWAY_ACP_IDLE_MS);
}

type AcpSlot = {
  client: AcpClient;
  botId: string;
  idleTtlMs: number;
  role: "desk" | "gateway";
};

type CdpConn = {
  ws: WebSocket;
  send: (method: string, params?: unknown) => Promise<unknown>;
};

export type BrowserHandle = {
  proc?: ReturnType<typeof spawn>;
  cdpPort: number;
  cdpUrl: string;
  wsUrl?: string;
  userDataDir: string;
  takeoverActive: boolean;
  screencastNonce?: string;
  screencast?: CdpConn;
  viewport: { width: number; height: number };
  /** Last screencast frame's CSS viewport; mouse/wheel map through this, not the requested stage. */
  inputViewport?: { width: number; height: number };
  pid?: number;
};

export type PermissionHandler = (req: LiveWorkEvent) => Promise<{ allow: boolean }>;

/** Gateway spike: deny execute/shell. Not isolation; ACP-native bash can still exist. */
export function denyGatewayExec(ev: LiveWorkEvent): Promise<{ allow: boolean }> {
  const toolCall = ev.payload.toolCall as { kind?: string } | undefined;
  const kind = String(toolCall?.kind ?? "").toLowerCase();
  if (kind === "execute" || kind === "shell") return Promise.resolve({ allow: false });
  return Promise.resolve({ allow: false });
}

export class LocalHostRunner implements ComputeContract, ComputeDriver {
  harness: "down" | "starting" | "idle" | "in_turn" | "crashed" = "down";
  acp: AcpClient | null = null;
  readonly acps = new Map<string, AcpSlot>();
  browser: BrowserHandle | null = null;
  harnessSessionId?: string;
  acpSessionId?: string;
  lastEnv: Record<string, string> = {};
  injectedKey = false;
  permissionMode: "ask" | "auto" | "always-approve" = "auto";
  lastDispatchedInput: Record<string, unknown> | null = null;
  screencastFrames = 0;
  viewportTimer: ReturnType<typeof setTimeout> | null = null;
  browserLock: Promise<void> = Promise.resolve();
  onScreencastFrame?: (jpeg: Uint8Array, meta: { pageUrl?: string; pageOrigin?: string }) => void;
  onLiveWork?: (ev: LiveWorkEvent, botId?: string) => void;
  permissionHandler?: PermissionHandler;
  uid: number;

  constructor(
    public readonly home: string,
    public readonly accountId: string,
  ) {
    this.uid = process.getuid?.() ?? -1;
  }

  get desk(): string {
    return join(this.home, "desk");
  }

  projectDir(botId: string): string {
    return botProjectDir(this.desk, botId);
  }

  ensureProject(botId: string, name: string): string {
    return ensureBotProject(this.desk, botId, name);
  }

  ensureGatewayWorkspace(): string {
    return ensureGatewayWorkspace(this.desk);
  }

  deleteProject(botId: string): void {
    deleteBotProject(this.desk, botId);
  }

  async ensure(_accountId: string): Promise<{ id: string; workspacePath: string }> {
    mkdirSync(join(this.desk, "projects"), { recursive: true });
    mkdirSync(join(this.desk, ".openbot", "chromium"), { recursive: true });
    writeFileSync(
      join(this.desk, ".openbot", "runner-state.json"),
      JSON.stringify({ driver: "localhost", updatedAt: Date.now() }),
    );
    return { id: this.accountId, workspacePath: this.desk };
  }

  async describe(): Promise<{
    driver: "localhost";
    workspacePath: string;
    state: "running" | "unhealthy";
  }> {
    return {
      driver: "localhost",
      workspacePath: this.desk,
      state: this.harness === "crashed" ? "unhealthy" : "running",
    };
  }

  async wipeDesk(): Promise<void> {
    await this.lifecycle({ op: "stop" });
    await Bun.sleep(200);
    if (existsSync(this.desk)) {
      let last: unknown;
      for (let i = 0; i < 8; i++) {
        try {
          rmSync(this.desk, { recursive: true, force: true });
          last = undefined;
          break;
        } catch (err) {
          last = err;
          await Bun.sleep(150);
        }
      }
      if (existsSync(this.desk) && last) throw last;
    }
    await this.ensure(this.accountId);
  }

  async workspaceRoot(): Promise<{ path: string }> {
    mkdirSync(this.desk, { recursive: true });
    return { path: this.desk };
  }

  async exec(req: {
    cmd: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const timeoutMs = Math.min(req.timeoutMs ?? 30_000, 120_000);
    const cwd = req.cwd ?? this.desk;
    if (!cwd.startsWith(this.desk)) {
      throw new Error("cwd must be under workspaceRoot");
    }
    const proc = spawn({
      cmd: req.cmd,
      cwd,
      env: { ...process.env, ...req.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const exitCode = (await proc.exited) ?? 1;
    clearTimeout(timer);
    const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    return { exitCode, stdout, stderr };
  }

  async display(): Promise<{
    cdpUrl: string;
    browserAlive: boolean;
    pageUrl?: string;
    pageOrigin?: string;
    uid: number;
    chromeNotRoot: boolean;
  }> {
    const alive = Boolean(this.browser?.cdpUrl);
    let pageUrl: string | undefined;
    let pageOrigin: string | undefined;
    if (this.browser?.cdpUrl) {
      try {
        const info = await cdpPageInfo(this.browser.cdpUrl);
        pageUrl = info.url;
        pageOrigin = info.origin;
      } catch {
        /* ignore */
      }
    }
    return {
      cdpUrl: this.browser?.cdpUrl ?? "http://127.0.0.1:0",
      browserAlive: alive,
      pageUrl,
      pageOrigin,
      uid: this.uid,
      chromeNotRoot: this.uid !== 0,
    };
  }

  async lifecycle(req: { op: "start" } | { op: "stop" } | { op: "health" }): Promise<{
    runner: "ok" | "degraded";
    harness: typeof this.harness;
    browser: "down" | "up";
    diskFreeBytes: number;
    harnessSessionId?: string;
    acpSessionId?: string;
  }> {
    if (req.op === "start") {
      await this.ensureBrowser();
      if (this.harness === "down" || this.harness === "crashed") this.harness = "idle";
    }
    if (req.op === "stop") {
      for (const slot of this.acps.values()) await slot.client.kill();
      this.acps.clear();
      this.acp = null;
      this.harness = "down";
      this.stopBrowser();
    }
    return {
      runner: "ok",
      harness: this.harness,
      browser: this.browser ? "up" : "down",
      diskFreeBytes: 1_000_000_000,
      harnessSessionId: this.harnessSessionId,
      acpSessionId: this.acpSessionId,
    };
  }

  async takeoverUrl(): Promise<{ ready: true; screencastNonce: string }> {
    try {
      await this.ensureBrowser();
      this.browser!.takeoverActive = true;
    } catch {
      /* Chromium may be unavailable; ticket still mints */
    }
    const nonce = crypto.randomUUID().replaceAll("-", "");
    if (this.browser) this.browser.screencastNonce = nonce;
    return { ready: true, screencastNonce: nonce };
  }

  async startScreencast(
    onFrame: (jpeg: Uint8Array, meta: { pageUrl?: string; pageOrigin?: string }) => void,
  ): Promise<void> {
    await this.ensureBrowser();
    this.browser!.takeoverActive = true;
    const existing = await cdpPageInfo(this.browser!.cdpUrl).catch(() => ({} as { url?: string }));
    if (!existing.url || existing.url === "about:blank") {
      await cdpNavigate(this.browser!.cdpUrl, TAKEOVER_HOME).catch(() => undefined);
    }
    this.onScreencastFrame = onFrame;
    this.screencastFrames = 0;
    if (this.browser!.screencast) {
      try {
        await this.browser!.screencast.send("Page.stopScreencast");
        this.browser!.screencast.ws.close();
      } catch {
        /* ignore */
      }
    }
    const conn = await cdpConnect(this.browser!.cdpUrl, async (method, params) => {
      if (method !== "Page.screencastFrame") return;
      const p = params as {
        data?: string;
        sessionId?: number;
        metadata?: { deviceWidth?: number; deviceHeight?: number };
      };
      if (p.sessionId != null) {
        void conn.send("Page.screencastFrameAck", { sessionId: p.sessionId });
      }
      if (!p.data) return;
      const jpeg = Buffer.from(p.data, "base64");
      this.screencastFrames += 1;
      if (p.metadata?.deviceWidth && p.metadata?.deviceHeight) {
        this.browser!.inputViewport = {
          width: p.metadata.deviceWidth,
          height: p.metadata.deviceHeight,
        };
      }
      const info = await cdpPageInfo(this.browser!.cdpUrl).catch(() => ({}));
      this.onScreencastFrame?.(jpeg, info);
    });
    this.browser!.screencast = conn;
    await conn.send("Page.enable");
    await conn.send("Runtime.enable");
    const vp = this.browser!.viewport ?? BROWSER_VIEWPORT_DEFAULT;
    await this.applyViewportToCdp(conn, vp.width, vp.height);
    await conn.send("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: BROWSER_VIEWPORT_MAX.width,
      maxHeight: BROWSER_VIEWPORT_MAX.height,
      everyNthFrame: 1,
    });
  }

  async setScreencastViewport(width: number, height: number): Promise<void> {
    const vp = clampViewport(width, height);
    if (!this.browser) return;
    const same =
      this.browser.viewport.width === vp.width && this.browser.viewport.height === vp.height;
    this.browser.viewport = vp;
    const conn = this.browser.screencast;
    if (!conn) return;
    if (same) return;
    if (this.viewportTimer) clearTimeout(this.viewportTimer);
    this.viewportTimer = setTimeout(() => {
      this.viewportTimer = null;
      if (this.browser?.screencast !== conn) return;
      void this.applyViewportToCdp(conn, vp.width, vp.height);
    }, 80);
  }

  private async applyViewportToCdp(conn: CdpConn, width: number, height: number): Promise<void> {
    await conn.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  stopTakeover(): void {
    this.onScreencastFrame = undefined;
    if (this.viewportTimer) {
      clearTimeout(this.viewportTimer);
      this.viewportTimer = null;
    }
    if (this.browser) {
      this.browser.takeoverActive = false;
      const conn = this.browser.screencast;
      this.browser.screencast = undefined;
      if (conn) {
        void conn.send("Page.stopScreencast").catch(() => undefined);
        try {
          conn.ws.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  async ensureBrowser(): Promise<BrowserHandle> {
    if (this.browser?.cdpUrl) return this.browser;
    const userDataDir = join(this.desk, ".openbot", "chromium");
    mkdirSync(userDataDir, { recursive: true });
    const port = await freePort();
    const launched = await launchChromium(port, userDataDir);
    this.browser = {
      ...launched,
      cdpPort: port,
      cdpUrl: `http://127.0.0.1:${port}`,
      userDataDir,
      takeoverActive: false,
      viewport: { ...BROWSER_VIEWPORT_DEFAULT },
    };
    return this.browser;
  }

  stopBrowser(): void {
    try {
      this.browser?.proc?.kill();
    } catch {
      /* ignore */
    }
    this.browser = null;
  }

  acpFor(botId: string): AcpClient | null {
    return this.acps.get(botId)?.client ?? null;
  }

  acpPid(botId: string): number | undefined {
    return this.acps.get(botId)?.client.pid;
  }

  matchesHarness(botId: string, model?: string, reasoningEffort?: string): boolean {
    const existing = this.acps.get(botId)?.client;
    if (!existing || existing.closed || !existing.sessionId || this.harness === "crashed") return false;
    const wantModel = model || DEFAULT_GROK_MODEL;
    const wantEffort = reasoningEffort || DEFAULT_REASONING_EFFORT;
    return existing.model === wantModel && existing.reasoningEffort === wantEffort;
  }

  invalidateAcp(botId: string): void {
    const slot = this.acps.get(botId);
    if (!slot) return;
    if (this.acp === slot.client && this.harness === "in_turn") return;
    void slot.client.kill();
    this.acps.delete(botId);
    if (this.acp === slot.client) {
      this.acp = null;
      this.acpSessionId = undefined;
    }
  }

  reapIdle(now = Date.now(), opts?: { federationOff?: boolean }): string[] {
    const killed: string[] = [];
    for (const [botId, slot] of this.acps) {
      const client = slot.client;
      if (client.closed) continue;
      if (this.acp === client && this.harness === "in_turn") continue;
      const federationKill = opts?.federationOff && slot.role === "gateway";
      // Desk OPENBOT_ACP_IDLE_MS=0 disables desk idle kill only.
      if (!federationKill && slot.idleTtlMs === 0) continue;
      if (!federationKill && client.lastActivityAt + slot.idleTtlMs > now) continue;
      void client.kill();
      this.acps.delete(botId);
      if (this.acp === client) {
        this.acp = null;
        this.acpSessionId = undefined;
      }
      killed.push(botId);
    }
    return killed;
  }

  async ensureHarness(req: EnsureHarnessRequest): Promise<void> {
    await this.ensure(this.accountId);
    const env = { ...req.env };
    this.lastEnv = { ...env };
    this.injectedKey = Boolean(env.XAI_API_KEY);
    const model = req.model || DEFAULT_GROK_MODEL;
    const reasoningEffort = req.reasoningEffort || DEFAULT_REASONING_EFFORT;
    const existing = this.acps.get(req.botId);
    const role = req.role === "gateway" ? "gateway" : "desk";
    const idleTtlMs = req.idleTtlMs ?? (role === "gateway" ? gatewayAcpIdleTtlMs() : acpIdleTtlMs());
    const permissionHandler = role === "gateway" ? denyGatewayExec : undefined;
    if (this.matchesHarness(req.botId, model, reasoningEffort)) {
      const client = existing!.client;
      existing!.idleTtlMs = idleTtlMs;
      existing!.role = role;
      client.permissionMode = req.permissionMode;
      client.permissionHandler = permissionHandler;
      this.acp = client;
      this.acpSessionId = client.sessionId;
      this.harness = "idle";
      client.lastActivityAt = Date.now();
      for (const k of Object.keys(this.lastEnv)) this.lastEnv[k] = "";
      return;
    }
    this.harness = "starting";
    try {
      if (existing) await existing.client.kill();
      const grokHome = prepareIsolatedGrokHome(this.home);
      const spawnEnv: Record<string, string> = {
        ...processEnvSansSecrets(),
        ...env,
        HOME: process.env.HOME ?? this.home,
        GROK_HOME: grokHome,
        GROK_DISABLE_AUTOUPDATER: "1",
        GROK_CURSOR_MCPS_ENABLED: "0",
        GROK_CLAUDE_MCPS_ENABLED: "0",
        GROK_SUBAGENTS: "0",
        OPENBOT_MCP_URL: req.mcpUrl,
        OPENBOT_MCP_TOKEN: req.mcpToken,
        GROK_CONFIG: JSON.stringify({
          models: { default: model, default_reasoning_effort: reasoningEffort },
        }),
      };
      if (req.omitCdp) delete spawnEnv.OPENBOT_CDP_URL;
      else spawnEnv.OPENBOT_CDP_URL = this.browser?.cdpUrl ?? "";
      const client = AcpClient.launch({
        cwd: req.cwd,
        env: spawnEnv,
        model,
        reasoningEffort,
        permissionMode: req.permissionMode,
        permissionHandler,
        onEvent: (ev) => this.onLiveWork?.({ ...ev, botId: req.botId }, req.botId),
      });
      this.acps.set(req.botId, { client, botId: req.botId, idleTtlMs, role });
      this.acp = client;
      for (const k of Object.keys(env)) {
        delete spawnEnv[k];
      }
      await client.initialize();
      await client.authenticate({ apiKey: Boolean(env.XAI_API_KEY) });
      this.acpSessionId = await client.newSession(req);
      this.harness = "idle";
    } catch (err) {
      this.harness = "crashed";
      throw err;
    } finally {
      for (const k of Object.keys(this.lastEnv)) {
        this.lastEnv[k] = "";
      }
    }
  }

  async prompt(text: string, botId?: string): Promise<PromptResult> {
    const client = botId ? this.acps.get(botId)?.client : this.acp;
    if (!client) throw new Error("harness not started");
    client.lastActivityAt = Date.now();
    this.harness = "in_turn";
    this.acp = client;
    try {
      const result = await client.prompt(text);
      this.harness = "idle";
      client.lastActivityAt = Date.now();
      return result;
    } catch (err) {
      this.harness = "crashed";
      try {
        await client.kill();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  async navigate(
    url: string,
    opts?: { duringTakeover?: boolean },
  ): Promise<{ ok: boolean; title?: string; error?: string }> {
    if (this.browser?.takeoverActive && !opts?.duringTakeover) {
      return { ok: false, error: "takeover_active" };
    }
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith("data:text/html")) {
      return { ok: false, error: "invalid_url" };
    }
    await this.ensureBrowser();
    try {
      const page = await cdpNavigate(this.browser!.cdpUrl, trimmed);
      return { ok: true, title: page.title };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async snapshot(): Promise<{ ok: boolean; html?: string; error?: string }> {
    if (!this.browser?.cdpUrl) return { ok: false, error: "browser down" };
    try {
      const html = await this.runtimeEval<string>("document.documentElement.outerHTML");
      return { ok: true, html };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async pageText(): Promise<{ ok: boolean; url?: string; title?: string; text?: string; error?: string }> {
    try {
      await this.ensureBrowser();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    try {
      const page = await this.runtimeEval<{ url?: string; title?: string; text?: string }>(
        `(() => {
          const text = document.body ? String(document.body.innerText || document.body.textContent || "") : "";
          return {
            url: location.href,
            title: String(document.title || ""),
            text: text.slice(0, ${BROWSER_SNAPSHOT_MAX_CHARS}),
          };
        })()`,
      );
      return {
        ok: true,
        url: page?.url,
        title: page?.title,
        text: String(page?.text ?? "").slice(0, BROWSER_SNAPSHOT_MAX_CHARS),
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  private async runtimeEval<T>(expression: string): Promise<T> {
    if (!this.browser?.cdpUrl) throw new Error("browser down");
    const conn = this.browser.screencast;
    if (conn) {
      await conn.send("Runtime.enable").catch(() => undefined);
      const result = (await conn.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
      })) as { result?: { value?: T } };
      return result.result?.value as T;
    }
    return cdpEvaluate<T>(this.browser.cdpUrl, expression);
  }

  private inputSize(): { width: number; height: number } {
    return this.browser?.inputViewport ?? this.browser?.viewport ?? BROWSER_VIEWPORT_DEFAULT;
  }

  async dispatchInput(event: Record<string, unknown>): Promise<void> {
    if (!this.browser?.cdpUrl) return;
    this.lastDispatchedInput = event;
    const conn = this.browser.screencast;
    const type = String(event.type ?? "mouse");
    const vp = this.inputSize();
    const fracX = Math.min(1, Math.max(0, Number(event.x ?? 0)));
    const fracY = Math.min(1, Math.max(0, Number(event.y ?? 0)));
    const cssX = fracX * vp.width;
    const cssY = fracY * vp.height;
    if (type === "mouse") {
      const action = String(event.action ?? "pressed");
      const cdpType =
        action === "released" ? "mouseReleased" : action === "moved" ? "mouseMoved" : "mousePressed";
      const params = {
        type: cdpType,
        x: cssX,
        y: cssY,
        button: String(event.button ?? "left"),
        buttons: action === "released" ? 0 : 1,
        clickCount: action === "moved" ? 0 : 1,
      };
      if (conn) await conn.send("Input.dispatchMouseEvent", params);
      else await cdpInput(this.browser.cdpUrl, { type: "mouse", params });
      return;
    }
    if (type === "wheel") {
      const params = {
        type: "mouseWheel",
        x: cssX,
        y: cssY,
        deltaX: Number(event.deltaX ?? 0),
        deltaY: Number(event.deltaY ?? 0),
      };
      if (conn) await conn.send("Input.dispatchMouseEvent", params);
      else await cdpInput(this.browser.cdpUrl, { type: "mouse", params });
      return;
    }
    if (type === "key") {
      const action = String(event.action ?? "rawKeyDown");
      const params = {
        type: action,
        key: String(event.key ?? ""),
        code: String(event.code ?? ""),
        text: event.text ? String(event.text) : undefined,
      };
      if (conn) await conn.send("Input.dispatchKeyEvent", params);
      else await cdpInput(this.browser.cdpUrl, { type: "key", params });
    }
  }

  respondPermission(reqId: string, allow: boolean): boolean {
    for (const slot of this.acps.values()) {
      if (slot.client.respondPermission(reqId, allow)) return true;
    }
    return this.acp?.respondPermission(reqId, allow) ?? false;
  }

  async withBrowser<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.browserLock;
    let release!: () => void;
    this.browserLock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function processEnvSansSecrets(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

export async function freePort(): Promise<number> {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  const port = server.port;
  server.stop(true);
  return port;
}

const TAKEOVER_HOME =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"><title>Desk browser</title></head><body style="margin:0;background:#eef3fa;color:#081018;font:20px/1.5 system-ui,sans-serif;padding:48px"><h1 style="margin:0 0 12px">Desk browser</h1><p>This is the shared Chromium. Type a URL in the bar above.</p></body></html>`,
  );

async function launchChromium(
  port: number,
  userDataDir: string,
): Promise<{ proc?: ReturnType<typeof spawn>; pid?: number }> {
  const exe = await findChrome();
  if (!exe) {
    throw new Error("chromium_unavailable");
  }
  const proc = spawn({
    cmd: [
      exe,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--disable-extensions",
      `--window-size=${BROWSER_VIEWPORT_MAX.width},${BROWSER_VIEWPORT_MAX.height}`,
      "about:blank",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 15_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return { proc, pid: proc.pid };
    } catch (err) {
      lastErr = err;
    }
    if (proc.exitCode != null) {
      const err = proc.stderr ? await new Response(proc.stderr).text() : String(lastErr);
      throw new Error(`chromium_exited: ${err}`);
    }
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error(`chromium_timeout: ${String(lastErr)}`);
}

async function findChrome(): Promise<string | null> {
  const candidates = [
    process.env.OPENBOT_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean) as string[];
  try {
    const pw = await import("playwright-core");
    const path = pw.chromium.executablePath();
    if (path) candidates.unshift(path);
  } catch {
    /* optional */
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

async function cdpPageWsUrl(cdpHttp: string): Promise<string> {
  const res = await fetch(`${cdpHttp}/json/list`);
  const list = (await res.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
  const page = list.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
  if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
  const created = (await fetch(`${cdpHttp}/json/new?about:blank`).then((r) => r.json())) as {
    webSocketDebuggerUrl?: string;
  };
  if (!created.webSocketDebuggerUrl) throw new Error("no cdp page websocket");
  return created.webSocketDebuggerUrl;
}

async function cdpConnect(
  cdpHttp: string,
  onEvent?: (method: string, params: unknown) => void,
): Promise<CdpConn> {
  const url = await cdpPageWsUrl(cdpHttp);
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
  });
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string };
    };
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) onEvent?.(msg.method, msg.params);
  };
  const send = (method: string, params?: unknown) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send };
}

async function cdpPageInfo(cdpHttp: string): Promise<{ url?: string; origin?: string }> {
  const res = await fetch(`${cdpHttp}/json/list`);
  const list = (await res.json()) as Array<{ url?: string; type?: string }>;
  const page = list.find((p) => p.type === "page") ?? list[0];
  const url = page?.url;
  let origin: string | undefined;
  try {
    if (url) origin = new URL(url).origin;
  } catch {
    /* ignore */
  }
  return { url, origin };
}

async function cdpNavigate(cdpHttp: string, url: string): Promise<{ title?: string }> {
  const { ws, send } = await cdpConnect(cdpHttp);
  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url });
    await Bun.sleep(300);
    const title = (await send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    })) as { result?: { value?: string } };
    return { title: title.result?.value };
  } finally {
    ws.close();
  }
}

async function cdpEvaluate<T>(cdpHttp: string, expression: string): Promise<T> {
  const { ws, send } = await cdpConnect(cdpHttp);
  try {
    const result = (await send("Runtime.evaluate", { expression, returnByValue: true })) as {
      result?: { value?: T };
    };
    return result.result?.value as T;
  } finally {
    ws.close();
  }
}

async function cdpInput(cdpHttp: string, event: Record<string, unknown>): Promise<void> {
  const { ws, send } = await cdpConnect(cdpHttp);
  try {
    const type = String(event.type ?? "mouse");
    if (type === "mouse") {
      await send("Input.dispatchMouseEvent", event.params ?? event);
    } else {
      await send("Input.dispatchKeyEvent", event.params ?? event);
    }
  } finally {
    ws.close();
  }
}

export { findChrome };
export {
  botProjectDir,
  deleteBotProject,
  ensureBotProject,
  ensureGatewayWorkspace,
  gatewayWorkspaceDir,
  isInsideDesk,
} from "./workspace.ts";
