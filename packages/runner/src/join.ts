import { hostname as osHostname } from "node:os";
import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RUNNER_HEARTBEAT_MS,
  RUNNER_PROTOCOL,
  type EnsureHarnessRequest,
  type RunnerHelloAck,
} from "@openbot/compute-protocol";
import { grokCliSignedIn } from "@openbot/acp-grok";
import { LocalHostRunner } from "./index.ts";
import { JsonRpcPeer, RpcError } from "./rpc.ts";
import { startMcpProxy } from "./mcp-proxy.ts";

const FAKE_JPEG = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc40014100100000000000000000000000000000000ffda00080001000100003f00d2cf20ffd9",
  "hex",
);

export function machineTokenPath(runnerHome: string): string {
  return join(runnerHome, "machine.token");
}

export function writeMachineToken(runnerHome: string, token: string): void {
  mkdirSync(runnerHome, { recursive: true });
  const p = machineTokenPath(runnerHome);
  writeFileSync(p, token, { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* ignore */
  }
}

export function readMachineToken(runnerHome: string): string | null {
  const p = machineTokenPath(runnerHome);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").trim() || null;
}

function wsOrigin(httpOrigin: string): string {
  return httpOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "");
}

export type JoinOpts = {
  origin: string;
  token?: string;
  home: string;
  version?: string;
};

export async function joinRunner(opts: JoinOpts): Promise<{ stop: () => void; pid: number; closed: Promise<void> }> {
  const home = opts.home;
  mkdirSync(join(home, "desk"), { recursive: true });
  const stored = readMachineToken(home);
  const enrollToken = opts.token?.startsWith("ob_enroll_") ? opts.token : undefined;
  const machineToken = opts.token?.startsWith("ob_run_") ? opts.token : stored;
  const local = new LocalHostRunner(home, "runner");
  let proxyPort: number | null = null;
  let stopProxy: (() => void) | null = null;
  let machine = machineToken ?? "";
  let mediaWs: WebSocket | null = null;
  let fakeCast: ReturnType<typeof setInterval> | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let resolveClosed: () => void = () => undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const base = wsOrigin(opts.origin);
  const ws = new WebSocket(`${base}/runner/v1`);

  const dispatch = async (method: string, params: unknown): Promise<unknown> => {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "workspaceRoot":
        return local.workspaceRoot();
      case "exec":
        return local.exec(p as { cmd: string[] });
      case "display": {
        const d = await local.display();
        return {
          browserAlive: d.browserAlive,
          pageUrl: d.pageUrl,
          pageOrigin: d.pageOrigin,
          uid: d.uid,
          chromeNotRoot: d.chromeNotRoot,
          viewport: local.browser?.viewport,
        };
      }
      case "lifecycle":
        return local.lifecycle(p as { op: "start" | "stop" | "health" });
      case "takeoverUrl":
        return local.takeoverUrl();
      case "ensure":
        return local.ensure(String(p.accountId ?? "runner"));
      case "ensureHarness": {
        const req = { ...(p as EnsureHarnessRequest) };
        if (proxyPort != null) req.mcpUrl = `http://127.0.0.1:${proxyPort}/mcp/v1`;
        return local.ensureHarness(req);
      }
      case "prompt":
        return local.prompt(String(p.text ?? ""), String(p.botId ?? ""));
      case "matchesHarness":
        return local.matchesHarness(
          String(p.botId ?? ""),
          p.model as string | undefined,
          p.reasoningEffort as string | undefined,
          p.permissionMode as EnsureHarnessRequest["permissionMode"],
          typeof p.rosterFp === "string" ? p.rosterFp : "",
        );
      case "hasWarmBot":
        return local.hasWarmBot(String(p.botId ?? ""));
      case "invalidateAcp":
        local.invalidateAcp(String(p.botId ?? ""));
        return {};
      case "kill":
        await local.kill(String(p.botId ?? ""));
        return {};
      case "reapIdle":
        return local.reapIdle(
          Number(p.now ?? Date.now()),
          p.opts as { federationOff?: boolean; skipBotIds?: Iterable<string> },
        );
      case "cancel":
        await local.cancel(String(p.botId ?? ""));
        return {};
      case "respondPermission":
        return local.respondPermission(String(p.reqId ?? ""), Boolean(p.allow));
      case "ensureProject":
        return local.ensureProject(String(p.botId ?? ""), String(p.name ?? ""));
      case "ensureGatewayWorkspace":
        return local.ensureGatewayWorkspace();
      case "deleteProject":
        local.deleteProject(String(p.botId ?? ""));
        return {};
      case "wipeDesk":
        await local.wipeDesk();
        return {};
      case "ensureBrowser":
        await local.ensureBrowser();
        return {};
      case "startScreencast": {
        const nonce = String(p.nonce ?? "");
        await dialMedia(nonce);
        return {};
      }
      case "stopTakeover":
        local.stopTakeover();
        if (fakeCast) {
          clearInterval(fakeCast);
          fakeCast = null;
        }
        try {
          mediaWs?.close();
        } catch {
          /* ignore */
        }
        mediaWs = null;
        return {};
      case "dispatchInput":
        await local.dispatchInput(p);
        return {};
      case "setScreencastViewport":
        await local.setScreencastViewport(Number(p.width), Number(p.height));
        return {};
      case "navigate":
        return local.navigate(String(p.url ?? ""), p.opts as { duringTakeover?: boolean; owner?: string });
      case "pageText":
        return local.pageText(p.owner as string | undefined);
      case "click":
        return local.click(p.input as { text?: string }, p.owner as string | undefined);
      case "typeText":
        return local.typeText(p.input as { text: string }, p.owner as string | undefined);
      case "waitFor":
        return local.waitFor(p.ms as number | undefined);
      default:
        throw new RpcError(-32601, `unknown ${method}`);
    }
  };

  const peer = new JsonRpcPeer((text) => ws.send(text), dispatch);

  async function dialMedia(nonce: string): Promise<void> {
    const mws = new WebSocket(`${base}/runner/v1/screencast`);
    mediaWs = mws;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("screencast timeout")), 10_000);
      mws.addEventListener("open", () => {
        clearTimeout(t);
        mws.send(JSON.stringify({ type: "auth", nonce, machineToken: machine }));
        resolve();
      });
      mws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("screencast error"));
      });
    });
    mws.addEventListener("message", (ev) => {
      const data = ev.data;
      if (typeof data !== "string") return;
      try {
        const msg = JSON.parse(data) as Record<string, unknown>;
        if (msg.type === "navigate") {
          void local.navigate(String(msg.url ?? ""), { duringTakeover: true, owner: "takeover" });
        } else if (msg.type === "viewport") {
          void local.setScreencastViewport(Number(msg.width), Number(msg.height));
        } else {
          void local.dispatchInput(msg);
        }
      } catch {
        /* ignore */
      }
    });
    try {
      await local.ensureBrowser();
      await local.startScreencast((jpeg, meta) => {
        if (mws.readyState !== WebSocket.OPEN) return;
        if (meta.pageUrl || meta.pageOrigin) {
          mws.send(
            JSON.stringify({
              type: "meta",
              pageUrl: meta.pageUrl,
              pageOrigin: meta.pageOrigin,
              viewport: local.browser?.viewport,
            }),
          );
        }
        mws.send(jpeg);
      });
    } catch {
      mws.send(JSON.stringify({ type: "meta", pageUrl: "about:blank", fake: true }));
      mws.send(FAKE_JPEG);
      fakeCast = setInterval(() => {
        if (mws.readyState === WebSocket.OPEN) mws.send(FAKE_JPEG);
      }, 500);
    }
  }

  local.onLiveWork = (ev, botId) => {
    peer.notify("live_work", { botId, kind: ev.kind, payload: ev.payload });
  };

  const stop = (): void => {
    if (closed) return;
    closed = true;
    if (fakeCast) clearInterval(fakeCast);
    if (beat) clearInterval(beat);
    stopProxy?.();
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    try {
      mediaWs?.close();
    } catch {
      /* ignore */
    }
    void local.lifecycle({ op: "stop" });
    resolveClosed();
  };

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("runner ws timeout")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("runner ws error"));
    });
  });

  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") peer.handleMessage(ev.data);
    else peer.handleMessage(ev.data as ArrayBuffer);
  });
  ws.addEventListener("close", () => {
    setTimeout(() => {
      peer.rejectAll(new Error("runner ws closed"));
      stop();
    }, 0);
  });

  const hello = {
    protocol: RUNNER_PROTOCOL,
    hostname: osHostname(),
    platform: process.platform,
    version: opts.version ?? "0.6.0",
    grokCliSignedIn: grokCliSignedIn(),
    warmBotIds: [...local.acps.keys()],
    inFlightPromptBotIds: [],
    workspacePath: local.desk,
    needsCredentials: true,
    enrollToken,
    machineToken: enrollToken ? undefined : machine,
  };
  let ack: RunnerHelloAck;
  try {
    ack = (await peer.request("hello", hello)) as RunnerHelloAck;
  } catch (err) {
    stop();
    throw err;
  }
  machine = ack.machineToken;
  writeMachineToken(home, machine);
  if (ack.mcpProxy && proxyPort == null) {
    const proxy = await startMcpProxy(peer);
    proxyPort = proxy.port;
    stopProxy = proxy.stop;
  }

  const sendHeartbeat = (): void => {
    if (closed) return;
    const bots = [...local.acps.entries()].map(([id, slot]) => ({
      id,
      acpAlive: Boolean(slot.client && !slot.client.closed),
    }));
    peer.notify("heartbeat", {
      harness: local.harness,
      browser: local.browser ? "up" : "down",
      bots,
      diskFreeBytes: 0,
      uid: local.uid,
      workspacePath: local.desk,
    });
  };
  sendHeartbeat();
  beat = setInterval(sendHeartbeat, RUNNER_HEARTBEAT_MS);
  beat.unref();

  console.log(
    JSON.stringify({
      msg: "openbot runner",
      pid: process.pid,
      origin: opts.origin,
      home,
      workspacePath: local.desk,
    }),
  );

  return { stop, pid: process.pid, closed: closedPromise };
}
