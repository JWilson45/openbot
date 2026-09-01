import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import type {
  ComputeContract,
  ComputeDriver,
  EnsureHarnessRequest,
  EnsureHarnessResult,
  LiveWorkEvent,
  PromptResult,
} from "@openbot/compute-protocol";
import {
  AcpClient,
  DEFAULT_GROK_MODEL,
  DEFAULT_REASONING_EFFORT,
  defaultCommand,
  grokHomeDir,
  prepareIsolatedGrokHome,
  rosterFingerprint,
} from "@openbot/acp-grok";
import { botProjectDir, deleteBotProject, ensureBotProject, ensureGatewayWorkspace } from "./workspace.ts";
import { buildChromiumEnv, buildHarnessEnv, chromiumTmpDir, snapshotChildEnv, type ChildEnvSnapshot } from "./harness-env.ts";
import { denyGatewayExec, deskPathGuard } from "./permissions.ts";
import { wrapSandboxCommand, type SandboxWrap } from "./sandbox.ts";
import { DESK_SKILL_NAME_CAP, ensureDeskSkills, listDeskSkillNames as scanDeskSkillNames } from "./desk-skills.ts";

export const DEFAULT_ACP_IDLE_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_GATEWAY_ACP_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_ACP_COMPACT_TURNS = 20;
export const DEFAULT_ACP_COMPACT_CHARS = 48_000;
export const BROWSER_SNAPSHOT_MAX_CHARS = 12_000;
export const BROWSER_VIEWPORT_MIN = { width: 640, height: 400 };
export const BROWSER_VIEWPORT_MAX = { width: 2560, height: 1440 };
export const BROWSER_VIEWPORT_DEFAULT = { width: 1280, height: 720 };
export const BROWSER_WAIT_MAX_MS = 15_000;
export const BROWSER_WAIT_DEFAULT_MS = 800;
export const TAKEOVER_TAB = "takeover";

export type BrowserTab = {
  owner: string;
  id: string;
  wsUrl: string;
};

function clampViewport(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(BROWSER_VIEWPORT_MIN.width, Math.min(BROWSER_VIEWPORT_MAX.width, Math.round(width))),
    height: Math.max(BROWSER_VIEWPORT_MIN.height, Math.min(BROWSER_VIEWPORT_MAX.height, Math.round(height))),
  };
}

const NAMED_VK: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
};

for (let f = 1; f <= 12; f++) NAMED_VK[`F${f}`] = 111 + f;

function modifierBits(event: Record<string, unknown>): number {
  return (
    (event.altKey ? 1 : 0) + (event.ctrlKey ? 2 : 0) + (event.metaKey ? 4 : 0) + (event.shiftKey ? 8 : 0)
  );
}

export function cdpKeyEvent(event: Record<string, unknown>): Record<string, unknown> {
  const action = String(event.action ?? "rawKeyDown");
  const key = String(event.key ?? "");
  const code = String(event.code ?? "");
  let vk = NAMED_VK[key] ?? NAMED_VK[code] ?? 0;
  if (!vk && /^Digit[0-9]$/.test(code)) vk = code.charCodeAt(5);
  else if (!vk && /^Key[A-Z]$/.test(code)) vk = code.charCodeAt(3);
  else if (!vk && key.length === 1) vk = key.toUpperCase().charCodeAt(0);
  const params: Record<string, unknown> = {
    type: action,
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers: modifierBits(event),
    autoRepeat: Boolean(event.repeat),
  };
  const text = event.text != null ? String(event.text) : action === "char" && key.length === 1 ? key : "";
  if (text) {
    params.text = text;
    params.unmodifiedText = text;
  }
  return params;
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

export function acpCompactTurns(): number {
  return envTtlMs(process.env.OPENBOT_ACP_COMPACT_TURNS, DEFAULT_ACP_COMPACT_TURNS);
}

export function acpCompactChars(): number {
  return envTtlMs(process.env.OPENBOT_ACP_COMPACT_CHARS, DEFAULT_ACP_COMPACT_CHARS);
}

export function acpCompactOnSwitch(): boolean {
  return envTtlMs(process.env.OPENBOT_ACP_COMPACT_ON_SWITCH, 0) === 1;
}

/** "explicit" is a compactSession() caller, not a compactReason() return. */
export type CompactReason = "turns" | "chars" | "thread" | "overflow";

export function overflowStopReason(reason: string): boolean {
  return /max_tokens|max_length|context_length|overflow/i.test(reason);
}

export function overflowErrorText(text: string): boolean {
  return /context length|context window|prompt too long|maximum context/i.test(text);
}

function usageOccupancy(payload: Record<string, unknown>): number | undefined {
  const nodes: unknown[] = [payload, payload.update, payload.usage];
  const update = payload.update;
  if (update && typeof update === "object") nodes.push((update as Record<string, unknown>).usage);
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const rec = node as Record<string, unknown>;
    const used = Number(rec.used ?? rec.input_tokens ?? rec.prompt_tokens ?? rec.tokens ?? rec.occupied);
    const max = Number(rec.total ?? rec.max_tokens ?? rec.context_window ?? rec.limit ?? rec.max);
    if (Number.isFinite(used) && Number.isFinite(max) && max > 0) return used / max;
    const occ = Number(rec.occupancy ?? rec.percent);
    if (Number.isFinite(occ)) return occ > 1 ? occ / 100 : occ;
  }
  return undefined;
}

type AcpSlot = {
  client: AcpClient;
  botId: string;
  idleTtlMs: number;
  role: "desk" | "gateway";
  resumed?: boolean;
  /** True while this client is inside prompt(). Per-slot; not runner.harness. */
  inTurn?: boolean;
  /** Compared in matchesHarness. Warm overlay is this fingerprint. */
  rosterFingerprint: string;
  /** Last thread this child session/prompt'd. Cleared on kill/spawn. Compact resets then re-marks. */
  lastThreadId?: string;
  turnsSinceCompact: number;
  promptChars: number;
  needsCompact?: boolean;
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

export class LocalHostRunner implements ComputeContract, ComputeDriver {
  harness: "down" | "starting" | "idle" | "in_turn" | "crashed" = "down";
  acp: AcpClient | null = null;
  readonly acps = new Map<string, AcpSlot>();
  readonly tabs = new Map<string, BrowserTab>();
  browser: BrowserHandle | null = null;
  harnessSessionId?: string;
  acpSessionId?: string;
  lastResume = false;
  lastEnv: Record<string, string> = {};
  lastChildEnv: ChildEnvSnapshot | null = null;
  lastSandbox: Pick<SandboxWrap, "backend" | "reason"> | null = null;
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

  get connected(): boolean {
    return true;
  }

  get workspacePath(): string {
    return this.desk;
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
    ensureDeskSkills(this.desk);
    writeFileSync(
      join(this.desk, ".openbot", "runner-state.json"),
      JSON.stringify({ driver: "localhost", updatedAt: Date.now() }),
    );
    return { id: this.accountId, workspacePath: this.desk };
  }

  /** ASCII-sorted kebab names; cap after sort. Does not seed. */
  listDeskSkillNames(cap = DESK_SKILL_NAME_CAP): string[] {
    return scanDeskSkillNames(this.desk, cap);
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
        const tab = this.tabs.get(TAKEOVER_TAB);
        const info = tab
          ? await cdpTargetInfo(this.browser.cdpUrl, tab.id)
          : await cdpPageInfo(this.browser.cdpUrl);
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
    const tab = await this.ensureTab(TAKEOVER_TAB);
    const existing = await cdpTargetInfo(this.browser!.cdpUrl, tab.id).catch(() => ({} as { url?: string }));
    if (!existing.url || existing.url === "about:blank") {
      await cdpNavigate(this.browser!.cdpUrl, TAKEOVER_HOME, tab.wsUrl).catch(() => undefined);
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
      const info = await cdpTargetInfo(this.browser!.cdpUrl, tab.id).catch(() => ({}));
      this.onScreencastFrame?.(jpeg, info);
    }, tab.wsUrl);
    this.browser!.screencast = conn;
    await conn.send("Page.enable");
    await conn.send("Runtime.enable");
    await conn.send("Page.bringToFront").catch(() => undefined);
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
    mkdirSync(chromiumTmpDir(this.desk), { recursive: true });
    const port = await freePort();
    const launched = await launchChromium(port, userDataDir, buildChromiumEnv({ desk: this.desk }));
    this.browser = {
      ...launched,
      cdpPort: port,
      cdpUrl: `http://127.0.0.1:${port}`,
      userDataDir,
      takeoverActive: false,
      viewport: { ...BROWSER_VIEWPORT_DEFAULT },
    };
    this.tabs.clear();
    return this.browser;
  }

  async ensureTab(owner: string): Promise<BrowserTab> {
    await this.ensureBrowser();
    const key = owner.trim() || TAKEOVER_TAB;
    const existing = this.tabs.get(key);
    const list = await cdpList(this.browser!.cdpUrl);
    if (existing) {
      const still = list.find((p) => p.id === existing.id && p.webSocketDebuggerUrl);
      if (still?.webSocketDebuggerUrl) {
        existing.wsUrl = still.webSocketDebuggerUrl;
        return existing;
      }
      this.tabs.delete(key);
    }
    const owned = new Set([...this.tabs.values()].map((t) => t.id));
    const free = list.find((p) => p.type === "page" && p.id && p.webSocketDebuggerUrl && !owned.has(p.id));
    if (free?.id && free.webSocketDebuggerUrl) {
      const tab: BrowserTab = { owner: key, id: free.id, wsUrl: free.webSocketDebuggerUrl };
      this.tabs.set(key, tab);
      return tab;
    }
    const created = await cdpNewPage(this.browser!.cdpUrl);
    const tab: BrowserTab = { owner: key, id: created.id, wsUrl: created.webSocketDebuggerUrl };
    this.tabs.set(key, tab);
    return tab;
  }

  stopBrowser(): void {
    try {
      this.browser?.proc?.kill();
    } catch {
      /* ignore */
    }
    this.tabs.clear();
    this.browser = null;
  }

  acpFor(botId: string): AcpClient | null {
    return this.acps.get(botId)?.client ?? null;
  }

  hasWarmBot(botId: string): boolean {
    return this.acps.has(botId);
  }

  acpPid(botId: string): number | undefined {
    return this.acps.get(botId)?.client.pid;
  }

  lastPromptThread(botId: string): string | undefined {
    return this.acps.get(botId)?.lastThreadId;
  }

  markPromptThread(botId: string, threadId: string): void {
    const slot = this.acps.get(botId);
    if (slot) slot.lastThreadId = threadId;
  }

  canCompact(botId: string): boolean {
    const slot = this.acps.get(botId);
    return Boolean(slot && !slot.client.closed && slot.client.sessionId && !slot.inTurn);
  }

  compactReason(
    botId: string,
    opts: { threadId?: string; innerBodyChars: number; switched: boolean },
  ): CompactReason | undefined {
    const slot = this.acps.get(botId);
    if (!slot) return undefined;
    if (slot.needsCompact) return "overflow";
    if (acpCompactOnSwitch() && opts.switched) return "thread";
    const charLimit = acpCompactChars();
    if (charLimit > 0 && slot.promptChars + opts.innerBodyChars >= charLimit) return "chars";
    const turnLimit = acpCompactTurns();
    if (turnLimit > 0 && slot.turnsSinceCompact >= turnLimit) return "turns";
    return undefined;
  }

  compactCounters(botId: string): { turns: number; chars: number } {
    const slot = this.acps.get(botId);
    return { turns: slot?.turnsSinceCompact ?? 0, chars: slot?.promptChars ?? 0 };
  }

  setCompactCounters(botId: string, turns: number, chars: number): void {
    const slot = this.acps.get(botId);
    if (!slot) return;
    slot.turnsSinceCompact = turns;
    slot.promptChars = chars;
  }

  didOverflow(botId: string): boolean {
    return Boolean(this.acps.get(botId)?.needsCompact);
  }

  noteSuccessfulPrompt(botId: string, sentChars: number): { turns: number; chars: number } {
    const slot = this.acps.get(botId);
    if (!slot) return { turns: 0, chars: 0 };
    slot.turnsSinceCompact += 1;
    slot.promptChars += sentChars;
    return { turns: slot.turnsSinceCompact, chars: slot.promptChars };
  }

  async compactSession(
    botId: string,
    req: EnsureHarnessRequest,
  ): Promise<EnsureHarnessResult & { compacted: boolean; fallback?: "respawn" }> {
    if (!this.canCompact(botId)) {
      return { compacted: false, resumed: false };
    }
    const slot = this.acps.get(botId)!;
    const prevId = slot.client.sessionId;
    slot.lastThreadId = undefined;
    try {
      const acpSessionId = await slot.client.newSession(req);
      // session/new restamps overlay. Cancel the previous id so Grok does not keep
      // both sessions; ignore -32601 (Grok 1.0.5 has no session/compact).
      if (prevId && prevId !== acpSessionId) {
        await slot.client.cancelSession(prevId);
      }
      slot.turnsSinceCompact = 0;
      slot.promptChars = 0;
      slot.needsCompact = false;
      slot.resumed = false;
      slot.rosterFingerprint = rosterFingerprint(req.roster);
      this.acp = slot.client;
      this.acpSessionId = acpSessionId;
      this.lastResume = false;
      this.harness = "idle";
      return { compacted: true, acpSessionId, resumed: false };
    } catch {
      try {
        await slot.client.kill();
      } catch {
        /* ignore */
      }
      this.acps.delete(botId);
      if (this.acp === slot.client) {
        this.acp = null;
        this.acpSessionId = undefined;
      }
      const spawned = await this.ensureHarness({ ...req, resumeSessionId: undefined });
      return {
        compacted: true,
        acpSessionId: spawned.acpSessionId,
        resumed: false,
        fallback: "respawn",
      };
    }
  }

  async kill(botId: string): Promise<void> {
    const slot = this.acps.get(botId);
    if (!slot) return;
    await slot.client.kill();
    this.acps.delete(botId);
    if (this.acp === slot.client) {
      this.acp = null;
      this.acpSessionId = undefined;
      this.harness = "down";
    }
  }

  async cancel(botId: string): Promise<void> {
    const slot = this.acps.get(botId);
    if (!slot) return;
    await slot.client.cancel();
  }

  matchesHarness(
    botId: string,
    model?: string,
    reasoningEffort?: string,
    permissionMode?: EnsureHarnessRequest["permissionMode"],
    rosterFp = "",
  ): boolean {
    const slot = this.acps.get(botId);
    const existing = slot?.client;
    // Crash is per-slot (closed / missing). Process-global harness=crashed would poison Ada when Bob overflows.
    if (!existing || existing.closed || !existing.sessionId) return false;
    const wantModel = model || DEFAULT_GROK_MODEL;
    const wantEffort = reasoningEffort || DEFAULT_REASONING_EFFORT;
    if (existing.model !== wantModel || existing.reasoningEffort !== wantEffort) return false;
    if (permissionMode && existing.permissionMode !== permissionMode) return false;
    if ((slot?.rosterFingerprint ?? "") !== rosterFp) return false;
    return true;
  }

  invalidateAcp(botId: string): void {
    const slot = this.acps.get(botId);
    if (!slot) return;
    if (slot.inTurn) return;
    void slot.client.kill();
    this.acps.delete(botId);
    if (this.acp === slot.client) {
      this.acp = null;
      this.acpSessionId = undefined;
    }
  }

  reapIdle(now = Date.now(), opts?: { federationOff?: boolean; skipBotIds?: Iterable<string> }): string[] {
    const killed: string[] = [];
    const skipBotIds = opts?.skipBotIds ? new Set(opts.skipBotIds) : undefined;
    for (const [botId, slot] of this.acps) {
      const client = slot.client;
      if (client.closed) continue;
      if (slot.inTurn) continue;
      const federationKill = opts?.federationOff && slot.role === "gateway";
      // Desk OPENBOT_ACP_IDLE_MS=0 disables desk idle kill only.
      if (!federationKill && slot.idleTtlMs === 0) continue;
      if (!federationKill && skipBotIds?.has(botId)) continue;
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

  async ensureHarness(req: EnsureHarnessRequest): Promise<EnsureHarnessResult> {
    await this.ensure(this.accountId);
    // Overlay catalog is req.skillNames as passed; readdir order is not a stable catalog.
    const env = { ...req.env };
    this.lastEnv = { ...env };
    this.injectedKey = Boolean(env.XAI_API_KEY);
    const model = req.model || DEFAULT_GROK_MODEL;
    const reasoningEffort = req.reasoningEffort || DEFAULT_REASONING_EFFORT;
    const existing = this.acps.get(req.botId);
    const role = req.role === "gateway" ? "gateway" : "desk";
    const idleTtlMs = req.idleTtlMs ?? (role === "gateway" ? gatewayAcpIdleTtlMs() : acpIdleTtlMs());
    const fp = rosterFingerprint(req.roster);
    const grokHome = grokHomeDir(this.home);
    prepareIsolatedGrokHome(this.home, process.env.HOME, req.permissionMode);
    const permissionHandler =
      role === "gateway"
        ? denyGatewayExec
        : (ev: LiveWorkEvent) =>
            deskPathGuard(ev, {
              desk: this.desk,
              grokHome,
              openbotHome: this.home,
              cwd: req.cwd,
              operatorHome: process.env.HOME,
            });
    if (this.matchesHarness(req.botId, model, reasoningEffort, req.permissionMode, fp)) {
      const client = existing!.client;
      existing!.idleTtlMs = idleTtlMs;
      existing!.role = role;
      existing!.resumed = false;
      existing!.rosterFingerprint = fp;
      // lastThreadId stays: same child session, not a spawn.
      client.permissionMode = req.permissionMode;
      client.permissionHandler = permissionHandler;
      this.acp = client;
      this.acpSessionId = client.sessionId;
      this.lastResume = false;
      this.harness = "idle";
      client.lastActivityAt = Date.now();
      for (const k of Object.keys(this.lastEnv)) this.lastEnv[k] = "";
      return { acpSessionId: client.sessionId ?? undefined, resumed: false };
    }
    this.harness = "starting";
    try {
      if (existing) await existing.client.kill();
      const extras: Record<string, string> = {
        ...env,
        OPENBOT_MCP_URL: req.mcpUrl,
        GROK_CONFIG: JSON.stringify({
          models: { default: model, default_reasoning_effort: reasoningEffort },
        }),
      };
      if (req.omitCdp) extras.OPENBOT_CDP_URL = "";
      else extras.OPENBOT_CDP_URL = this.browser?.cdpUrl ?? "";
      const spawnEnv = buildHarnessEnv({ openbotHome: this.home, extras });
      this.lastChildEnv = snapshotChildEnv(spawnEnv);
      const command = defaultCommand({
        model,
        reasoningEffort,
        permissionMode: req.permissionMode,
      });
      const sandboxed = wrapSandboxCommand(command, {
        openbotHome: this.home,
        desk: this.desk,
        grokHome,
      });
      this.lastSandbox = { backend: sandboxed.backend, reason: sandboxed.reason };
      const client = AcpClient.launch({
        command: sandboxed.cmd,
        cwd: req.cwd,
        env: spawnEnv,
        model,
        reasoningEffort,
        permissionMode: req.permissionMode,
        permissionHandler,
        onEvent: (ev) => {
          this.observeAcpEvent(req.botId, ev);
          this.onLiveWork?.({ ...ev, botId: req.botId }, req.botId);
        },
      });
      this.acps.set(req.botId, {
        client,
        botId: req.botId,
        idleTtlMs,
        role,
        resumed: false,
        rosterFingerprint: fp,
        turnsSinceCompact: 0,
        promptChars: 0,
      });
      this.acp = client;
      for (const k of Object.keys(env)) {
        delete spawnEnv[k];
      }
      await client.initialize();
      await client.authenticate({ apiKey: Boolean(env.XAI_API_KEY) });
      let resumed = false;
      let acpSessionId: string;
      if (req.resumeSessionId) {
        try {
          acpSessionId = await client.resumeSession(req, req.resumeSessionId);
          resumed = true;
        } catch {
          acpSessionId = await client.newSession(req);
        }
      } else {
        acpSessionId = await client.newSession(req);
      }
      const slot = this.acps.get(req.botId);
      if (slot) slot.resumed = resumed;
      this.acpSessionId = acpSessionId;
      this.lastResume = resumed;
      this.harness = "idle";
      return { acpSessionId, resumed };
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
    const slot = botId
      ? this.acps.get(botId)
      : this.acp
        ? [...this.acps.values()].find((s) => s.client === this.acp)
        : undefined;
    const client = slot?.client ?? this.acp;
    if (!client) throw new Error("harness not started");
    client.lastActivityAt = Date.now();
    this.harness = "in_turn";
    this.acp = client;
    if (slot) slot.inTurn = true;
    try {
      const result = await client.prompt(text);
      this.harness = "idle";
      client.lastActivityAt = Date.now();
      if (slot && overflowStopReason(result.stopReason)) slot.needsCompact = true;
      return result;
    } catch (err) {
      const dump = `${err instanceof Error ? err.message : String(err)}\n${client.lastStderr}`;
      if (slot && !client.closed && overflowErrorText(dump)) {
        slot.needsCompact = true;
        this.harness = "idle";
        throw err;
      }
      if (slot) {
        this.acps.delete(slot.botId);
        if (this.acp === client) {
          this.acp = null;
          this.acpSessionId = undefined;
        }
      }
      this.harness = "idle";
      try {
        if (!client.closed) await client.kill();
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      if (slot) slot.inTurn = false;
    }
  }

  private observeAcpEvent(botId: string, ev: LiveWorkEvent): void {
    const slot = this.acps.get(botId);
    if (!slot) return;
    const blob = JSON.stringify(ev.payload ?? {});
    if (/auto_compact/i.test(blob)) {
      slot.needsCompact = true;
      return;
    }
    const occ = usageOccupancy((ev.payload ?? {}) as Record<string, unknown>);
    if (occ != null && occ >= 0.85) slot.needsCompact = true;
  }

  private tabOwner(owner?: string): string {
    return (owner ?? TAKEOVER_TAB).trim() || TAKEOVER_TAB;
  }

  private blocksHumanTab(owner: string, duringTakeover?: boolean): boolean {
    return Boolean(this.browser?.takeoverActive && owner === TAKEOVER_TAB && !duringTakeover);
  }

  async navigate(
    url: string,
    opts?: { duringTakeover?: boolean; owner?: string },
  ): Promise<{ ok: boolean; title?: string; error?: string }> {
    const owner = this.tabOwner(opts?.owner);
    if (this.blocksHumanTab(owner, opts?.duringTakeover)) {
      return { ok: false, error: "takeover_active" };
    }
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith("data:text/html")) {
      return { ok: false, error: "invalid_url" };
    }
    try {
      const tab = await this.ensureTab(owner);
      const page = await cdpNavigate(this.browser!.cdpUrl, trimmed, tab.wsUrl);
      return { ok: true, title: page.title };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async snapshot(owner?: string): Promise<{ ok: boolean; html?: string; error?: string }> {
    try {
      const tab = await this.ensureTab(this.tabOwner(owner));
      const html = await this.runtimeEval<string>("document.documentElement.outerHTML", tab);
      return { ok: true, html };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async pageText(owner?: string): Promise<{ ok: boolean; url?: string; title?: string; text?: string; error?: string }> {
    try {
      const tab = await this.ensureTab(this.tabOwner(owner));
      const page = await this.runtimeEval<{ url?: string; title?: string; text?: string }>(
        `(() => {
          const text = document.body ? String(document.body.innerText || document.body.textContent || "") : "";
          return {
            url: location.href,
            title: String(document.title || ""),
            text: text.slice(0, ${BROWSER_SNAPSHOT_MAX_CHARS}),
          };
        })()`,
        tab,
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

  async click(
    input: {
      text?: string;
      selector?: string;
      nth?: number;
    },
    owner?: string,
  ): Promise<{ ok: boolean; text?: string; tag?: string; count?: number; error?: string }> {
    const tabOwner = this.tabOwner(owner);
    if (this.blocksHumanTab(tabOwner)) return { ok: false, error: "takeover_active" };
    return this.withBrowser(async () => {
      let tab: BrowserTab;
      try {
        tab = await this.ensureTab(tabOwner);
      } catch (err) {
        return { ok: false, error: String(err) };
      }
      const spec = {
        text: input.text?.trim() || "",
        selector: input.selector?.trim() || "",
        nth: input.nth ?? 0,
      };
      if (!spec.text && !spec.selector) return { ok: false, error: "text or selector required" };
      try {
        const found = await this.runtimeEval<{
          ok: boolean;
          error?: string;
          x?: number;
          y?: number;
          w?: number;
          h?: number;
          tag?: string;
          text?: string;
          count?: number;
          method?: string;
        }>(clickFindExpr(spec), tab);
        if (!found?.ok) {
          return { ok: false, error: found?.error ?? "not_found", count: found?.count };
        }
        if ((found.w ?? 0) >= 1 && (found.h ?? 0) >= 1 && found.x != null && found.y != null) {
          await this.dispatchCssClick(found.x, found.y, tab);
        } else {
          await this.runtimeEval(
            "document.activeElement && document.activeElement.click && document.activeElement.click()",
            tab,
          );
        }
        return { ok: true, text: found.text, tag: found.tag, count: found.count };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });
  }

  async typeText(
    input: {
      text: string;
      clear?: boolean;
      submit?: boolean;
    },
    owner?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const tabOwner = this.tabOwner(owner);
    if (this.blocksHumanTab(tabOwner)) return { ok: false, error: "takeover_active" };
    return this.withBrowser(async () => {
      let tab: BrowserTab;
      try {
        tab = await this.ensureTab(tabOwner);
      } catch (err) {
        return { ok: false, error: String(err) };
      }
      try {
        const focus = await this.runtimeEval<{ ok: boolean; error?: string; tag?: string }>(
          `(() => {
            const el = document.activeElement;
            if (!el || el === document.body || el === document.documentElement) {
              return { ok: false, error: "no_focus" };
            }
            return { ok: true, tag: el.tagName };
          })()`,
          tab,
        );
        if (!focus?.ok) return { ok: false, error: focus?.error ?? "no_focus" };
        if (input.clear) {
          await this.runtimeEval(
            `(() => {
            const el = document.activeElement;
            if (!el) return false;
            if ("value" in el) {
              el.value = "";
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            } else if (el.isContentEditable) el.textContent = "";
            return true;
          })()`,
            tab,
          );
        }
        await this.cdpCall("Input.insertText", { text: input.text }, tab);
        if (input.submit) {
          await this.cdpCall("Input.dispatchKeyEvent", cdpKeyEvent({ action: "rawKeyDown", key: "Enter", code: "Enter" }), tab);
          await this.cdpCall("Input.dispatchKeyEvent", cdpKeyEvent({ action: "char", key: "Enter", code: "Enter", text: "\r" }), tab);
          await this.cdpCall("Input.dispatchKeyEvent", cdpKeyEvent({ action: "keyUp", key: "Enter", code: "Enter" }), tab);
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });
  }

  async waitFor(ms = BROWSER_WAIT_DEFAULT_MS): Promise<{ ok: boolean; ms: number }> {
    const n = Math.max(0, Math.min(BROWSER_WAIT_MAX_MS, Math.round(ms)));
    await Bun.sleep(n);
    return { ok: true, ms: n };
  }

  private async dispatchCssClick(x: number, y: number, tab: BrowserTab): Promise<void> {
    const at = { x, y, button: "left" };
    await this.cdpCall("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, buttons: 0, clickCount: 0 }, tab);
    await this.cdpCall("Input.dispatchMouseEvent", { type: "mousePressed", ...at, buttons: 1, clickCount: 1 }, tab);
    await this.cdpCall("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, buttons: 0, clickCount: 1 }, tab);
  }

  private async cdpCall(method: string, params?: unknown, tab?: BrowserTab): Promise<unknown> {
    if (!this.browser?.cdpUrl) throw new Error("browser down");
    if (!tab && this.browser.screencast) return this.browser.screencast.send(method, params);
    const { ws, send } = await cdpConnect(this.browser.cdpUrl, undefined, tab?.wsUrl);
    try {
      return await send(method, params);
    } finally {
      ws.close();
    }
  }

  private async runtimeEval<T>(expression: string, tab?: BrowserTab): Promise<T> {
    if (!this.browser?.cdpUrl) throw new Error("browser down");
    if (tab) return cdpEvaluate<T>(this.browser.cdpUrl, expression, tab.wsUrl);
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
      const params = cdpKeyEvent(event);
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
  env: Record<string, string>,
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
      "--use-mock-keychain",
      "--password-store=basic",
      `--window-size=${BROWSER_VIEWPORT_MAX.width},${BROWSER_VIEWPORT_MAX.height}`,
      "about:blank",
    ],
    env,
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

type CdpTarget = {
  id?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  title?: string;
};

async function cdpList(cdpHttp: string): Promise<CdpTarget[]> {
  const res = await fetch(`${cdpHttp}/json/list`);
  return (await res.json()) as CdpTarget[];
}

async function cdpNewPage(cdpHttp: string): Promise<{ id: string; webSocketDebuggerUrl: string }> {
  for (const method of ["PUT", "GET"] as const) {
    try {
      const res = await fetch(`${cdpHttp}/json/new?about:blank`, { method });
      if (!res.ok) continue;
      const created = (await res.json()) as CdpTarget;
      if (created.webSocketDebuggerUrl && created.id) {
        return { id: created.id, webSocketDebuggerUrl: created.webSocketDebuggerUrl };
      }
    } catch {
      /* try next */
    }
  }
  throw new Error("no cdp page websocket");
}

async function cdpPageWsUrl(cdpHttp: string): Promise<string> {
  const list = await cdpList(cdpHttp);
  const page = list.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
  if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
  const created = await cdpNewPage(cdpHttp);
  return created.webSocketDebuggerUrl;
}

async function cdpConnect(
  cdpHttp: string,
  onEvent?: (method: string, params: unknown) => void,
  pageWsUrl?: string,
): Promise<CdpConn> {
  const url = pageWsUrl ?? (await cdpPageWsUrl(cdpHttp));
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

function originOf(url?: string): string | undefined {
  try {
    if (url) return new URL(url).origin;
  } catch {
    /* ignore */
  }
  return undefined;
}

async function cdpPageInfo(cdpHttp: string): Promise<{ url?: string; origin?: string }> {
  const list = await cdpList(cdpHttp);
  const page = list.find((p) => p.type === "page") ?? list[0];
  return { url: page?.url, origin: originOf(page?.url) };
}

async function cdpTargetInfo(cdpHttp: string, targetId: string): Promise<{ url?: string; origin?: string }> {
  const list = await cdpList(cdpHttp);
  const page = list.find((p) => p.id === targetId) ?? list.find((p) => p.type === "page") ?? list[0];
  return { url: page?.url, origin: originOf(page?.url) };
}

async function cdpNavigate(cdpHttp: string, url: string, pageWsUrl?: string): Promise<{ title?: string }> {
  const { ws, send } = await cdpConnect(cdpHttp, undefined, pageWsUrl);
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

function clickFindExpr(spec: { text: string; selector: string; nth: number }): string {
  return `(() => {
    const spec = ${JSON.stringify(spec)};
    const nth = spec.nth || 0;
    let nodes = [];
    if (spec.selector) {
      try { nodes = Array.from(document.querySelectorAll(spec.selector)); }
      catch (e) { return { ok: false, error: "bad_selector" }; }
    } else {
      const needle = String(spec.text || "").trim().toLowerCase();
      const cand = Array.from(document.querySelectorAll('a, button, input, select, textarea, option, [role="button"], [role="link"], [role="menuitem"], label, summary'));
      const scored = [];
      for (const el of cand) {
        const label = String(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || "").replace(/\\s+/g, " ").trim();
        const n = label.toLowerCase();
        if (!n) continue;
        let score = -1;
        if (n === needle) score = 0;
        else if (n.startsWith(needle)) score = 1;
        else if (n.includes(needle)) score = 2;
        if (score >= 0) scored.push({ el: el, score: score, len: label.length });
      }
      scored.sort((a, b) => a.score - b.score || a.len - b.len);
      nodes = scored.map((s) => s.el);
    }
    if (!nodes.length) return { ok: false, error: "not_found", count: 0 };
    if (nth >= nodes.length) return { ok: false, error: "not_found", count: nodes.length };
    const el = nodes[nth];
    el.scrollIntoView({ block: "center", inline: "nearest" });
    if (typeof el.focus === "function") el.focus();
    const r = el.getBoundingClientRect();
    return {
      ok: true,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      w: r.width,
      h: r.height,
      tag: el.tagName,
      text: String(el.innerText || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 80),
      count: nodes.length,
    };
  })()`;
}

async function cdpEvaluate<T>(cdpHttp: string, expression: string, pageWsUrl?: string): Promise<T> {
  const { ws, send } = await cdpConnect(cdpHttp, undefined, pageWsUrl);
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
  DESK_SKILL_NAME_CAP,
  DESK_SKILL_NAME_RE,
  CONFIRM_SERIES_SKILL_MD,
  DESK_SKILLS_README_MD,
  SHARED_CHROMIUM_SKILL_MD,
  ensureDeskSkills,
  listDeskSkillNames,
} from "./desk-skills.ts";
export {
  botProjectDir,
  deleteBotProject,
  ensureBotProject,
  ensureGatewayWorkspace,
  gatewayWorkspaceDir,
  isInsideDesk,
  isInsideDir,
} from "./workspace.ts";
export {
  denyGatewayExec,
  deskPathGuard,
  extractPermissionPaths,
  pathIsDenied,
  resolvePermissionPath,
} from "./permissions.ts";
export {
  buildHarnessEnv,
  buildChromiumEnv,
  snapshotChildEnv,
  CHILD_ENV_PASSTHROUGH,
  chromiumTmpDir,
} from "./harness-env.ts";
export {
  wrapSandboxCommand,
  sandboxModeFromEnv,
  seatbeltProfile,
  bwrapArgs,
  SandboxRequiredError,
} from "./sandbox.ts";
export { JsonRpcPeer, RpcError } from "./rpc.ts";
export { startMcpProxy } from "./mcp-proxy.ts";
export { joinRunner, readMachineToken, writeMachineToken, machineTokenPath } from "./join.ts";
