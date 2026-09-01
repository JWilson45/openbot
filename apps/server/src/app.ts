import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ARCHIVE_TTL_MS,
  MAX_ACTIVE_BOTS,
  OpenbotDb,
  deleteBotPermanently,
  humanThread,
  id,
  isGatewayRole,
  now,
  nonCancelledSeriesCount,
  pauseCalendarSeriesForAssignee,
  rematerializeScheduledInstances,
  suppressOpenCalendarInstances,
  type TurnRow,
} from "@openbot/db";
import {
  AuthDenied,
  SESSION_COOKIE,
  completeGithubLogin,
  cookieHeader,
  loadAllowlist,
  parseBearer,
  parseCookie,
  sessionFromToken,
  type SessionInfo,
} from "@openbot/auth";
import { loadOrCreateMasterKey, open, seal, RedactingLogger } from "@openbot/vault";
import {
  approveMessage,
  handleMcpJsonRpc,
  McpInflight,
  queueGroupMentions,
  rejectMessage,
  type McpHooks,
} from "@openbot/mcp-send-message";
import {
  McpError,
  addThreadParticipantInput,
  createCalendarSeriesInput,
  createGroupThreadInput,
  learnRoutineInput,
  patchCalendarSeriesInput,
  postMessageInput,
} from "@openbot/api-types";
import { insertMessage, parseLivePayload, promote, summarizeLiveEvent } from "@openbot/live-work";
import { sha256Hex } from "@openbot/db";
import { detectCliLogins, listGrokModels, resolveBotInference } from "@openbot/acp-grok";
import { FED_MAX_REQUEST_BYTES } from "@openbot/federation";
import {
  CAL_MAX_SERIES,
  CAL_MIN_INTERVAL_MS,
  RruleError,
  isValidTimeZone,
  localNineTomorrow,
  materializeHorizon,
  parseCalendarDtstart,
  parseRrule,
} from "@openbot/calendar";
import { SPA_CSS, SPA_HTML, SPA_JS } from "./spa.ts";
import { TurnEngine } from "./engine.ts";
import { reconcileCalendarInstance } from "./calendar-tick.ts";
import { mountOpenAiCompat } from "./openai.ts";
import {
  clientRateKey,
  currentOrgMeta,
  deleteOrgPeer,
  disableOrgPeer,
  ensureOrgAccount,
  ensureOrgKeypair,
  ensureOrgMeta,
  federationEffective,
  fedInfoPayload,
  FED_INFO_RATE_LIMIT,
  FED_INFO_RATE_WINDOW_MS,
  fetchPeerFedInfo,
  insertOrgPeer,
  listOrgPeers,
  loadOrgKeypair,
  OrgPeerError,
  orgMemberSnapshot,
  orgPeerPublic,
  parsePeerBaseUrl,
  setFederationEnabled,
  setOrgTimezone,
  SlidingWindowRateLimiter,
} from "./org.ts";
import { findActiveGateway, provisionOrgGateway } from "./gateway.ts";
import { handleFedInbound, parseContentLength, readCappedBody } from "./inbox.ts";
import {
  RunnerUnavailable,
  RPC_PROTOCOL,
  RPC_RUNNER_ATTACHED,
  RPC_UNAUTHORIZED,
  RUNNER_PROTOCOL,
  type RunnerHeartbeat,
  type RunnerHello,
  type RunnerHelloAck,
} from "@openbot/compute-protocol";
import { JsonRpcPeer, RpcError } from "@openbot/runner";
import { RemoteRunnerClient, type TakeoverBridge } from "./remote-runner.ts";
import {
  consumeEnrollToken,
  enrollAccount,
  getRunnerRow,
  lookupEnrollToken,
  lookupMachineToken,
  mintRunnerSecret,
  persistDisconnect,
  persistHeartbeat,
  persistHello,
  publicRunnerSnapshot,
  revokeAccount,
  unauthenticatedRunnerAdminAllowed,
} from "./runner-admin.ts";

export type HomeConfig = {
  home: string;
  port: number;
  githubClientId?: string;
  githubClientSecret?: string;
  publicOrigin?: string;
  logger?: RedactingLogger;
  devLogin?: boolean;
  env?: Record<string, string | undefined>;
};

export type AppContext = {
  db: OpenbotDb;
  home: string;
  master: Buffer;
  allowlist: Set<string>;
  inflight: McpInflight;
  engine: TurnEngine;
  log: RedactingLogger;
  port: number;
  githubClientId?: string;
  githubClientSecret?: string;
  publicOrigin: string;
  push: Map<string, Set<ServerWebSocket>>;
  devLogin: boolean;
  maintenanceTimer?: ReturnType<typeof setInterval>;
};

function cookies(c: { req: { header: (n: string) => string | undefined } }): string | undefined {
  return parseCookie(c.req.header("cookie"));
}

const VISIBLE_MESSAGES_SQL =
  "SELECT * FROM messages WHERE thread_id = ? AND origin NOT IN ('prompt', 'calendar') ORDER BY created_at";

function groupMeetsMinimum(botCount: number, principalCount: number): boolean {
  return botCount >= 2 || principalCount >= 3;
}

export function createApp(cfg: HomeConfig): {
  app: Hono;
  ctx: AppContext;
  ready: () => void;
  stop: () => void;
} {
  mkdirSync(cfg.home, { recursive: true });
  mkdirSync(join(cfg.home, "desk"), { recursive: true });
  const db = OpenbotDb.open(join(cfg.home, "openbot.sqlite"));
  const advertisedOrigin = cfg.publicOrigin ?? `http://127.0.0.1:${cfg.port}`;
  const org = ensureOrgMeta(db, {
    env: cfg.env ?? process.env,
    file: join(cfg.home, "org.json"),
    publicOrigin: cfg.publicOrigin,
    advertisedOrigin,
  });
  const log = cfg.logger ?? new RedactingLogger();
  ensureOrgAccount(db, log);
  provisionOrgGateway(db, cfg.home);
  const master = loadOrCreateMasterKey(cfg.home, process.env.OPENBOT_MASTER_KEY);
  ensureOrgKeypair(cfg.home, master, db);
  const allowlist = loadAllowlist(cfg.home, process.env.OPENBOT_GITHUB_ALLOWLIST);
  const inflight = new McpInflight();
  const push = new Map<string, Set<ServerWebSocket>>();
  const fedInfoLimiter = new SlidingWindowRateLimiter(FED_INFO_RATE_LIMIT, FED_INFO_RATE_WINDOW_MS);
  const fedUntrustedLimiter = new SlidingWindowRateLimiter(FED_INFO_RATE_LIMIT, FED_INFO_RATE_WINDOW_MS);

  const ctx: AppContext = {
    db,
    home: cfg.home,
    master,
    allowlist,
    inflight,
    engine: null as unknown as TurnEngine,
    log,
    port: cfg.port,
    githubClientId: cfg.githubClientId ?? process.env.OPENBOT_GITHUB_CLIENT_ID,
    githubClientSecret: cfg.githubClientSecret ?? process.env.OPENBOT_GITHUB_CLIENT_SECRET,
    publicOrigin: org.public_origin || advertisedOrigin,
    push,
    devLogin: cfg.devLogin ?? process.env.OPENBOT_DEV_LOGIN === "1",
  };

  const onPush = (accountId: string, event: unknown) => {
    if (event && typeof event === "object") {
      const ev = event as { type?: string; message?: { origin?: string } };
      // Group prompt clones are per-turn engine input, not transcript bubbles.
      if (ev.type === "message.created" && (ev.message?.origin === "prompt" || ev.message?.origin === "calendar")) {
        return;
      }
    }
    const set = push.get(accountId);
    if (!set) return;
    const payload = JSON.stringify(event);
    for (const ws of set) {
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  };

  ctx.engine = new TurnEngine({
    db,
    home: cfg.home,
    inflight,
    master,
    mcpPort: () => ctx.port,
    onPush,
  });
  ctx.engine.markRunnersDisconnectedOnBoot();
  ctx.maintenanceTimer = setInterval(() => {
    ctx.engine.tickCalendar();
    ctx.engine.kick();
  }, 30_000);
  ctx.maintenanceTimer.unref();

  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();
  const app = new Hono();

  app.use("/*", async (c, next) => {
    await next();
    const ct = c.res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) return;
    c.header("Cache-Control", "no-store");
  });

  app.onError((err, c) => {
    if (err instanceof RunnerUnavailable) {
      return c.json({ error: "computer_offline" }, 503);
    }
    if (err instanceof McpError) {
      const status = err.httpStatus as 401;
      return c.json({ error: err.code, message: err.message }, status);
    }
    throw err;
  });

  // Cookie or bearer session — not sk-ob_ keys (org credential for OpenAI clients).
  function requireSession(c: { req: { header: (n: string) => string | undefined } }): SessionInfo {
    const s =
      sessionFromToken(db, cookies(c)) ?? sessionFromToken(db, parseBearer(c.req.header("authorization")));
    if (!s) throw new McpError("unauthorized", "unauthorized", 401);
    return s;
  }

  function requireRunnerAdmin(c: {
    req: { header: (n: string) => string | undefined; raw: Request };
    env: unknown;
  }): SessionInfo | { accountId: string } {
    const s =
      sessionFromToken(db, cookies(c)) ?? sessionFromToken(db, parseBearer(c.req.header("authorization")));
    if (s) return s;
    const peer = bunRequestIp(c.env, c.req.raw);
    if (!unauthenticatedRunnerAdminAllowed(peer, c.req.header("host"))) {
      throw new McpError("forbidden", "forbidden", 403);
    }
    const accountId = currentOrgMeta(db)?.account_id;
    if (!accountId) throw new McpError("no_account", "no_account", 400);
    return { accountId };
  }

  function enrollJoinOrigin(): string {
    const meta = currentOrgMeta(db);
    const advertised = (meta?.public_origin && meta.public_origin.trim()) || "";
    if (advertised && !advertised.endsWith(":0") && !advertised.includes("://127.0.0.1:0")) return advertised;
    return `http://127.0.0.1:${ctx.port}`;
  }

  function emitMcpSideEffects(result: { status: number; json: unknown }): void {
    const json = result.json as { result?: { content?: unknown[] } };
    if (result.status === 200 && json?.result?.content) {
      const parsed = JSON.parse(String((json.result.content as { text?: string }[])[0]?.text ?? "{}")) as {
        messageId?: string;
      };
      if (parsed.messageId) {
        const msg = db.get("SELECT * FROM messages WHERE id = ?", [parsed.messageId]);
        if (msg) {
          const thread = db.get<{ account_id: string }>("SELECT account_id FROM threads WHERE id = ?", [
            (msg as { thread_id: string }).thread_id,
          ]);
          if (thread) onPush(thread.account_id, { type: "message.created", message: msg });
        }
      }
    }
  }

  function mcpHooks(): McpHooks {
    const browserOff = { ok: false as const, error: "browser_unavailable" };
    return {
      onKick: () => ctx.engine.kick(),
      federationEffective: () => federationEffective(currentOrgMeta(db)),
      orgPrivateKey: () => loadOrgKeypair(ctx.home, ctx.master).privateKey,
      onCreateBot: async ({ accountId, botId, name }) => {
        try {
          const runner = ctx.engine.runnerFor(accountId);
          await runner.ensure(accountId);
          await runner.ensureProject(botId, name);
          onPush(accountId, { type: "bots.updated" });
        } catch (err) {
          if (err instanceof RunnerUnavailable) throw new McpError("computer_offline", "computer_offline", 503);
          throw err;
        }
      },
      onCalendarDue: () => {
        ctx.engine.tickCalendar();
        ctx.engine.kick();
      },
      browserNavigate: async (accountId, botId, url) => {
        try {
          return await ctx.engine.runnerFor(accountId).navigate(url, { owner: botId });
        } catch (err) {
          if (err instanceof RunnerUnavailable) return browserOff;
          throw err;
        }
      },
      browserSnapshot: async (accountId, botId) => {
        try {
          return await ctx.engine.runnerFor(accountId).pageText(botId);
        } catch (err) {
          if (err instanceof RunnerUnavailable) return browserOff;
          throw err;
        }
      },
      browserClick: async (accountId, botId, input) => {
        try {
          return await ctx.engine.runnerFor(accountId).click(input, botId);
        } catch (err) {
          if (err instanceof RunnerUnavailable) return browserOff;
          throw err;
        }
      },
      browserType: async (accountId, botId, input) => {
        try {
          return await ctx.engine.runnerFor(accountId).typeText(input, botId);
        } catch (err) {
          if (err instanceof RunnerUnavailable) return browserOff;
          throw err;
        }
      },
      browserWait: async (accountId, _botId, ms) => {
        try {
          return await ctx.engine.runnerFor(accountId).waitFor(ms);
        } catch (err) {
          if (err instanceof RunnerUnavailable) return { ok: false, ms: 0, error: "browser_unavailable" };
          throw err;
        }
      },
    };
  }

  async function forwardMcp(params: unknown): Promise<{ status: number; json: unknown }> {
    const p = (params ?? {}) as { bearer?: string; body?: unknown };
    try {
      const result = await handleMcpJsonRpc(db, inflight, p.bearer, p.body ?? {}, mcpHooks());
      emitMcpSideEffects(result);
      return { status: result.status, json: result.json };
    } catch (err) {
      if (err instanceof McpError) {
        return { status: err.httpStatus, json: { error: err.code, message: err.message } };
      }
      throw err;
    }
  }

  mountOpenAiCompat(app, ctx, requireSession);

  app.get("/v1/healthz", (c) => c.json({ ok: true, process: "openbot-server" }));
  app.get("/v1/readyz", (c) => {
    try {
      db.get("SELECT 1 as n");
      mkdirSync(join(cfg.home, "desk"), { recursive: true });
      return c.json({ ok: true, home: cfg.home, desk: join(cfg.home, "desk") });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 503);
    }
  });

  app.post("/v1/runner/enroll", async (c) => {
    const admin = requireRunnerAdmin(c);
    try {
      const result = enrollAccount(db, admin.accountId, enrollJoinOrigin());
      await ctx.engine.detachLocal(admin.accountId);
      ctx.log.info("runner.enroll", { accountId: admin.accountId });
      return c.json(result);
    } catch (err) {
      if ((err as { code?: string }).code === "runner_attached") {
        return c.json({ error: "runner_attached" }, 409);
      }
      throw err;
    }
  });

  app.post("/v1/runner/revoke", (c) => {
    const admin = requireRunnerAdmin(c);
    revokeAccount(db, admin.accountId);
    ctx.engine.revokeRemote(admin.accountId);
    ctx.log.info("runner.revoke", { accountId: admin.accountId });
    return c.json({ ok: true });
  });

  app.get("/v1/runner", (c) => {
    const s = requireSession(c);
    return c.json({ runner: publicRunnerSnapshot(getRunnerRow(db, s.accountId)) });
  });

  app.get("/fed/v1/info", (c) => {
    const key = clientRateKey(bunRequestIp(c.env, c.req.raw), c.req.header("x-forwarded-for"));
    if (!fedInfoLimiter.take(key)) return c.json({ error: "rate_limited" }, 429);
    const row = currentOrgMeta(db);
    if (!row) return c.json({ error: "no_org" }, 500);
    const gw = row.account_id ? findActiveGateway(db, row.account_id) : undefined;
    return c.json(fedInfoPayload(row, gw ? { name: gw.name } : null));
  });

  app.post("/fed/v1/messages", async (c) => {
    if (c.req.header("cookie") && !parseBearer(c.req.header("authorization"))) {
      return c.json({ error: "cookies_not_accepted" }, 401);
    }
    const cl = parseContentLength(c.req.header("content-length"));
    if (cl == null || cl > FED_MAX_REQUEST_BYTES) {
      return c.json({ error: "too_large" }, 413);
    }
    const raw = await readCappedBody(c.req.raw, FED_MAX_REQUEST_BYTES);
    if (raw === "too_large") return c.json({ error: "too_large" }, 413);
    const rawBody = Buffer.from(raw).toString("utf8");
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      json = null;
      const key = clientRateKey(bunRequestIp(c.env, c.req.raw), c.req.header("x-forwarded-for"));
      if (!fedUntrustedLimiter.take(key)) return c.json({ error: "rate_limited" }, 429);
      return c.json({ error: "invalid_json" }, 400);
    }
    const clientIp = bunRequestIp(c.env, c.req.raw);
    const rateKey = clientRateKey(clientIp, c.req.header("x-forwarded-for"));
    const result = handleFedInbound(db, {
      rawBody,
      json,
      authorization: c.req.header("authorization"),
      idempotencyKey: c.req.header("idempotency-key"),
      clientIp,
      takeUntrusted: () => fedUntrustedLimiter.take(rateKey),
    });
    for (const msg of result.push) {
      if (msg.origin === "prompt") continue;
      if (result.accountId) onPush(result.accountId, { type: "message.created", message: msg });
    }
    if (result.kick) ctx.engine.kick();
    return c.json(
      result.body,
      result.status as 200 | 202 | 400 | 401 | 403 | 413 | 429 | 503,
    );
  });

  app.get("/", (c) => c.html(SPA_HTML));
  app.get("/ui/desk.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    return c.body(SPA_CSS);
  });
  app.get("/ui/desk.js", (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    return c.body(SPA_JS);
  });

  app.get("/auth/github", (c) => {
    if (!ctx.githubClientId) {
      return c.json(
        {
          error: "github_oauth_unconfigured",
          message: "Set OPENBOT_GITHUB_CLIENT_ID and OPENBOT_GITHUB_CLIENT_SECRET",
        },
        501,
      );
    }
    const redirect = `${ctx.publicOrigin}/auth/callback/github`;
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", ctx.githubClientId);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("scope", "read:user user:email");
    return c.redirect(url.toString());
  });

  app.get("/auth/callback/github", async (c) => {
    const code = c.req.query("code");
    if (!code || !ctx.githubClientId || !ctx.githubClientSecret) {
      return c.json({ error: "oauth_failed" }, 400);
    }
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: ctx.githubClientId,
        client_secret: ctx.githubClientSecret,
        code,
      }),
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    if (!tokenJson.access_token) return c.json({ error: "oauth_failed" }, 400);
    const userRes = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${tokenJson.access_token}`, "user-agent": "openbot" },
    });
    const user = (await userRes.json()) as { login: string; id: number; name?: string; email?: string };
    try {
      const session = completeGithubLogin(db, allowlist, {
        login: user.login,
        id: String(user.id),
        name: user.name,
        email: user.email,
      });
      provisionOrgGateway(db, cfg.home);
      c.header("Set-Cookie", cookieHeader(session.token, ctx.publicOrigin.startsWith("https")));
      return c.redirect("/");
    } catch (err) {
      if (err instanceof AuthDenied) return c.json({ error: "not_allowlisted", message: err.message }, 403);
      throw err;
    }
  });

  app.get("/v1/auth-options", (c) =>
    c.json({
      github: Boolean(ctx.githubClientId),
      local: ctx.devLogin,
    }),
  );

  app.get("/auth/local", (c) => {
    if (!ctx.devLogin) return c.json({ error: "dev_login_disabled" }, 403);
    const host = (c.req.header("host") ?? "").split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") {
      return c.json({ error: "loopback_only" }, 403);
    }
    const login = String(c.req.query("login") ?? "demo").trim().toLowerCase();
    try {
      const session = completeGithubLogin(db, allowlist, { login });
      provisionOrgGateway(db, cfg.home);
      c.header("Set-Cookie", cookieHeader(session.token, false));
      return c.redirect("/");
    } catch (err) {
      if (err instanceof AuthDenied) return c.json({ error: "not_allowlisted", message: err.message }, 403);
      throw err;
    }
  });

  app.get("/v1/me", (c) => {
    try {
      const s = requireSession(c);
      const org = currentOrgMeta(db);
      const member = db.get<{ role: string }>("SELECT role FROM org_members WHERE user_id = ?", [s.userId]);
      return c.json({
        githubLogin: s.githubLogin,
        accountId: s.accountId,
        userId: s.userId,
        orgId: org?.org_id ?? "",
        orgSlug: org?.slug ?? "",
        orgName: org?.name ?? "",
        pubkey: org?.pubkey ?? "",
        role: member?.role ?? "member",
      });
    } catch {
      return c.json({ error: "unauthorized" }, 401);
    }
  });

  app.get("/v1/org", (c) => {
    try {
      requireSession(c);
      const row = currentOrgMeta(db);
      if (!row) return c.json({ error: "no_org" }, 500);
      return c.json(orgMemberSnapshot(row));
    } catch {
      return c.json({ error: "unauthorized" }, 401);
    }
  });

  app.patch("/v1/org", async (c) => {
    requireSession(c);
    const body = (await c.req.json()) as { federationEnabled?: unknown; timezone?: unknown };
    if ("timezone" in body) {
      if (typeof body.timezone !== "string" || !isValidTimeZone(body.timezone.trim())) {
        return c.json({ error: "invalid_timezone" }, 400);
      }
    }
    if ("federationEnabled" in body) {
      if (typeof body.federationEnabled !== "boolean") {
        return c.json({ error: "invalid_federation" }, 400);
      }
      setFederationEnabled(db, body.federationEnabled);
      const after = currentOrgMeta(db);
      if (!federationEffective(after)) ctx.engine.stopGatewayAcps();
      else if (after?.account_id) {
        const gw = findActiveGateway(db, after.account_id);
        if (gw) ctx.engine.maybeKickGatewayDrain(gw.id);
      }
    }
    if ("timezone" in body && typeof body.timezone === "string") {
      setOrgTimezone(db, body.timezone.trim());
    }
    const row = currentOrgMeta(db);
    if (!row) return c.json({ error: "no_org" }, 500);
    return c.json(orgMemberSnapshot(row));
  });

  app.get("/v1/org/inbox", (c) => {
    requireSession(c);
    const rows = db.all<{
      id: string;
      message_id: string;
      from_org_id: string;
      from_slug: string;
      to_org_id: string;
      hop: number;
      urgency: string;
      body: string;
      status: string;
      acked_turn_id: string | null;
      acked_at: number | null;
      created_at: number;
    }>("SELECT * FROM org_inbox ORDER BY created_at DESC, id DESC LIMIT 100");
    return c.json({
      inbox: rows.map((r) => ({
        id: r.id,
        messageId: r.message_id,
        fromOrgId: r.from_org_id,
        fromSlug: r.from_slug,
        toOrgId: r.to_org_id,
        hop: r.hop,
        urgency: r.urgency,
        body: r.body,
        status: r.status,
        ackedTurnId: r.acked_turn_id,
        ackedAt: r.acked_at,
        createdAt: r.created_at,
      })),
    });
  });

  const peerEnv = cfg.env ?? process.env;

  function peerError(err: unknown) {
    if (err instanceof OrgPeerError) {
      const status = err.code.startsWith("duplicate") ? 409 : 400;
      return { error: err.code, status: status as 400 | 409 };
    }
    return null;
  }

  async function readObjectJson(c: { req: { json: () => Promise<unknown> } }) {
    try {
      const parsed = await c.req.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  app.get("/v1/org/peers", (c) => {
    requireSession(c);
    return c.json({ peers: listOrgPeers(db).map(orgPeerPublic) });
  });

  app.post("/v1/org/peers/from-info", async (c) => {
    requireSession(c);
    const body = await readObjectJson(c);
    if (!body) return c.json({ error: "invalid_json" }, 400);
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";
    let origin: string;
    try {
      origin = parsePeerBaseUrl(baseUrl, peerEnv);
    } catch (err) {
      const mapped = peerError(err);
      if (mapped) return c.json({ error: mapped.error }, mapped.status);
      throw err;
    }
    try {
      const info = await fetchPeerFedInfo(origin);
      return c.json(info);
    } catch (err) {
      const mapped = peerError(err);
      if (mapped) return c.json({ error: mapped.error }, mapped.status);
      return c.json({ error: "info_failed" }, 400);
    }
  });

  app.post("/v1/org/peers", async (c) => {
    requireSession(c);
    const body = await readObjectJson(c);
    if (!body) return c.json({ error: "invalid_json" }, 400);
    try {
      const row = insertOrgPeer(
        db,
        {
          slug: typeof body.slug === "string" ? body.slug : "",
          orgId: typeof body.orgId === "string" ? body.orgId : "",
          baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
          pubkey: typeof body.pubkey === "string" ? body.pubkey : "",
          name: typeof body.name === "string" ? body.name : "",
        },
        peerEnv,
      );
      return c.json(orgPeerPublic(row));
    } catch (err) {
      const mapped = peerError(err);
      if (mapped) return c.json({ error: mapped.error }, mapped.status);
      throw err;
    }
  });

  app.delete("/v1/org/peers/:orgId", (c) => {
    requireSession(c);
    const ok = deleteOrgPeer(db, c.req.param("orgId"));
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/v1/org/peers/:orgId/disable", (c) => {
    requireSession(c);
    const row = disableOrgPeer(db, c.req.param("orgId"));
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json(orgPeerPublic(row));
  });

  app.post("/v1/bots", async (c) => {
    const s = requireSession(c);
    provisionOrgGateway(db, cfg.home);
    const body = await c.req.json();
    if (body.role != null) return c.json({ error: "invalid_role" }, 400);
    const name = String(body.name ?? "").trim();
    const description = String(body.description ?? "");
    if (!name) return c.json({ error: "name required" }, 400);
    const normalized = name.trim();
    const active = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM bots WHERE account_id = ? AND status = 'active' AND IFNULL(role, 'desk') = 'desk'",
      [s.accountId],
    );
    if ((active?.n ?? 0) >= MAX_ACTIVE_BOTS) return c.json({ error: "cap" }, 409);
    const dup = db.get(
      "SELECT id FROM bots WHERE account_id = ? AND status = 'active' AND lower(name) = lower(?)",
      [s.accountId, normalized],
    );
    if (dup) return c.json({ error: "duplicate_name" }, 409);
    const inference = resolveBotInference(
      listGrokModels(cfg.home),
      body.model as string | undefined,
      (body.reasoningEffort ?? body.reasoning_effort) as string | undefined,
    );
    const botId = id();
    const threadId = id();
    const desk = join(cfg.home, "desk");
    db.immediate(() => {
      db.run(
        `INSERT INTO bots (id, account_id, name, description, status, permission_mode, model, reasoning_effort, created_at)
         VALUES (?, ?, ?, ?, 'active', 'auto', ?, ?, ?)`,
        [botId, s.accountId, normalized, description, inference.model, inference.reasoningEffort, now()],
      );
      const compute = db.get("SELECT id FROM compute_instances WHERE account_id = ?", [s.accountId]);
      if (!compute) {
        db.run(
          `INSERT INTO compute_instances (id, account_id, driver, workspace_path, state, created_at)
           VALUES (?, ?, 'localhost', ?, 'running', ?)`,
          [id(), s.accountId, desk, now()],
        );
      }
      db.run(
        `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, 'New thread', 'human', ?)`,
        [threadId, s.accountId, botId, now()],
      );
    });
    const runner = ctx.engine.runnerFor(s.accountId);
    await runner.ensure(s.accountId);
    await runner.ensureProject(botId, normalized);
    return c.json({
      bot: {
        id: botId,
        name: normalized,
        description,
        permissionMode: "auto",
        model: inference.model,
        reasoningEffort: inference.reasoningEffort,
      },
      threadId,
    });
  });

  app.get("/v1/bots", (c) => {
    const s = requireSession(c);
    provisionOrgGateway(db, cfg.home);
    ctx.engine.purgeExpiredArchives(s.accountId);
    const bots = db.all(
      "SELECT * FROM bots WHERE account_id = ? AND status = 'active' AND IFNULL(role, 'desk') = 'desk' ORDER BY created_at",
      [s.accountId],
    );
    const archived = db.all(
      "SELECT * FROM bots WHERE account_id = ? AND status = 'archived' AND IFNULL(role, 'desk') = 'desk' ORDER BY archived_at DESC",
      [s.accountId],
    );
    const gatewayRow = db.get(
      "SELECT * FROM bots WHERE account_id = ? AND IFNULL(role, 'desk') = 'gateway' AND status = 'active'",
      [s.accountId],
    ) as { id: string } | undefined;
    const org = currentOrgMeta(db);
    return c.json({
      bots: bots.map((b) => ({ ...(b as object), presence: botPresence(ctx, (b as { id: string }).id) })),
      gateway: gatewayRow
        ? {
            ...(gatewayRow as object),
            presence: botPresence(ctx, gatewayRow.id),
            enabled: federationEffective(org),
          }
        : null,
      archived,
      bot: bots[0] ?? null,
      archiveTtlMs: ARCHIVE_TTL_MS,
    });
  });

  app.post("/v1/bots/:id/archive", async (c) => {
    const s = requireSession(c);
    const bot = db.get<{ id: string; name: string; status: string; role: string | null }>(
      "SELECT id, name, status, role FROM bots WHERE id = ? AND account_id = ?",
      [c.req.param("id"), s.accountId],
    );
    if (!bot) return c.json({ error: "not_found" }, 404);
    if (isGatewayRole(bot.role)) return c.json({ error: "gateway_protected" }, 409);
    if (bot.status !== "active") return c.json({ error: "not_active" }, 409);
    const t = now();
    db.run("UPDATE bots SET status = 'archived', archived_at = ? WHERE id = ?", [t, bot.id]);
    db.run(
      "UPDATE turns SET status = 'cancelled', finished_at = ? WHERE bot_id = ? AND status IN ('queued', 'running')",
      [t, bot.id],
    );
    pauseCalendarSeriesForAssignee(db, bot.id);
    for (const row of db.all<{ id: string }>(
      "SELECT id FROM calendar_series WHERE assignee_bot_id = ? AND status = 'paused'",
      [bot.id],
    )) {
      suppressOpenCalendarInstances(db, row.id, "pause");
    }
    await ctx.engine.runnerFor(s.accountId).kill(bot.id);
    return c.json({ ok: true, archivedAt: t, deleteAfter: t + ARCHIVE_TTL_MS });
  });

  app.post("/v1/bots/:id/restore", (c) => {
    const s = requireSession(c);
    ctx.engine.purgeExpiredArchives(s.accountId);
    const bot = db.get<{ id: string; name: string; status: string; role: string | null }>(
      "SELECT id, name, status, role FROM bots WHERE id = ? AND account_id = ?",
      [c.req.param("id"), s.accountId],
    );
    if (!bot) return c.json({ error: "not_found" }, 404);
    if (isGatewayRole(bot.role)) return c.json({ error: "gateway_protected" }, 409);
    if (bot.status !== "archived") return c.json({ error: "not_archived" }, 409);
    const active = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM bots WHERE account_id = ? AND status = 'active' AND IFNULL(role, 'desk') = 'desk'",
      [s.accountId],
    );
    if ((active?.n ?? 0) >= MAX_ACTIVE_BOTS) return c.json({ error: "cap" }, 409);
    const dup = db.get(
      "SELECT id FROM bots WHERE account_id = ? AND status = 'active' AND lower(name) = lower(?)",
      [s.accountId, bot.name],
    );
    if (dup) return c.json({ error: "duplicate_name" }, 409);
    db.run("UPDATE bots SET status = 'active', archived_at = NULL WHERE id = ?", [bot.id]);
    return c.json({ ok: true });
  });

  app.get("/v1/calendar", (c) => {
    const s = requireSession(c);
    const fromRaw = c.req.query("from");
    const toRaw = c.req.query("to");
    if (fromRaw == null || fromRaw === "" || toRaw == null || toRaw === "") {
      return c.json({ error: "bad_request" }, 400);
    }
    const from = Number(fromRaw);
    const to = Number(toRaw);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return c.json({ error: "bad_request" }, 400);
    const status = c.req.query("status");
    const kind = c.req.query("kind");
    if (status && !CAL_SERIES_STATUSES.has(status)) return c.json({ error: "bad_request" }, 400);
    if (kind && !CAL_SERIES_KINDS.has(kind)) return c.json({ error: "bad_request" }, 400);
    const instances = db.all(
      `SELECT i.* FROM calendar_instances i
       JOIN calendar_series s ON s.id = i.series_id
       WHERE s.account_id = ? AND i.scheduled_at >= ? AND i.scheduled_at <= ?
         AND (? IS NULL OR s.status = ?)
         AND (? IS NULL OR s.kind = ?)
       ORDER BY i.scheduled_at, i.id`,
      [s.accountId, from, to, status ?? null, status ?? null, kind ?? null, kind ?? null],
    );
    const seriesById = new Map<string, CalendarSeriesRow>();
    const windowIds = [...new Set(instances.map((row) => (row as { series_id: string }).series_id))];
    if (windowIds.length) {
      const placeholders = windowIds.map(() => "?").join(",");
      for (const row of db.all<CalendarSeriesRow>(
        `SELECT * FROM calendar_series WHERE id IN (${placeholders})`,
        windowIds,
      )) {
        seriesById.set(row.id, row);
      }
    }
    if (!status || status === "proposed") {
      for (const row of db.all<CalendarSeriesRow>(
        `SELECT * FROM calendar_series WHERE account_id = ? AND status = 'proposed' AND (? IS NULL OR kind = ?)`,
        [s.accountId, kind ?? null, kind ?? null],
      )) {
        seriesById.set(row.id, row);
      }
    }
    const org = currentOrgMeta(db);
    return c.json({
      timezone: org?.timezone ?? "UTC",
      series: [...seriesById.values()],
      instances,
    });
  });

  app.get("/v1/calendar/series/:id", (c) => {
    const s = requireSession(c);
    const series = loadCalendarSeries(db, s.accountId, c.req.param("id"));
    if (!series) return c.json({ error: "not_found" }, 404);
    const instances = db.all(
      `SELECT * FROM calendar_instances WHERE series_id = ? ORDER BY scheduled_at DESC, id DESC LIMIT 20`,
      [series.id],
    );
    return c.json({ series, instances, nextFire: nextCalendarFireUtc(db, series) });
  });

  app.post("/v1/calendar/series", async (c) => {
    const s = requireSession(c);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    if (raw && typeof raw === "object" && "kind" in raw) return c.json({ error: "kind_not_allowed" }, 400);
    const parsed = createCalendarSeriesInput.safeParse(raw);
    if (!parsed.success) return c.json({ error: "bad_request" }, 400);
    const input = parsed.data;
    const bot = resolveCalendarAssignee(db, s.accountId, input.botId);
    if ("error" in bot) return c.json({ error: bot.error }, bot.status);
    const thread = resolveCalendarThread(db, s.accountId, bot.id, input.threadId);
    if ("error" in thread) return c.json({ error: thread.error }, thread.status);
    const timezone = (input.timezone ?? currentOrgMeta(db)?.timezone ?? "UTC").trim();
    if (!isValidTimeZone(timezone)) return c.json({ error: "invalid_timezone" }, 400);
    const rrule = emptyToNull(input.rrule);
    const rruleErr = validateCalendarRrule(rrule);
    if (rruleErr) return c.json({ error: rruleErr }, 400);
    let dtstartUtc: number;
    try {
      dtstartUtc = parseCalendarDtstart(input.dtstart, timezone);
    } catch (err) {
      return c.json({ error: err instanceof RruleError ? err.code : "invalid_dtstart" }, 400);
    }
    if (nonCancelledSeriesCount(db, s.accountId) >= CAL_MAX_SERIES) return c.json({ error: "cap" }, 409);
    const t = now();
    const seriesId = id();
    const requireHuman = calendarRequireHumanApproval(input.requireHumanApproval, thread.kind, bot.require_human_approval);
    db.immediate(() => {
      db.run(
        `INSERT INTO calendar_series (
           id, account_id, title, prompt, assignee_bot_id, thread_id, kind, status, rrule,
           dtstart_utc, timezone, require_human_approval, created_by, min_interval_ms,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'schedule', 'active', ?, ?, ?, ?, 'human', ?, ?, ?)`,
        [
          seriesId,
          s.accountId,
          input.title,
          input.prompt,
          bot.id,
          thread.id,
          rrule,
          dtstartUtc,
          timezone,
          requireHuman ? 1 : 0,
          CAL_MIN_INTERVAL_MS,
          t,
          t,
        ],
      );
      const series = loadCalendarSeries(db, s.accountId, seriesId);
      if (series) rematerializeScheduledInstances(db, series);
    });
    ctx.engine.tickCalendar();
    ctx.engine.kick();
    return c.json({ series: loadCalendarSeries(db, s.accountId, seriesId) }, 201);
  });

  app.patch("/v1/calendar/series/:id", async (c) => {
    const s = requireSession(c);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    if (raw && typeof raw === "object" && ("until" in raw || "count" in raw)) {
      return c.json({ error: "bad_request" }, 400);
    }
    const parsed = patchCalendarSeriesInput.safeParse(raw);
    if (!parsed.success) return c.json({ error: "bad_request" }, 400);
    const series = loadCalendarSeries(db, s.accountId, c.req.param("id"));
    if (!series) return c.json({ error: "not_found" }, 404);
    const input = parsed.data;
    let assigneeId = series.assignee_bot_id;
    if (input.botId) {
      const bot = resolveCalendarAssignee(db, s.accountId, input.botId);
      if ("error" in bot) return c.json({ error: bot.error }, bot.status);
      assigneeId = bot.id;
    }
    let threadId = input.threadId === undefined ? series.thread_id : input.threadId;
    if (input.threadId) {
      const thread = resolveCalendarThread(db, s.accountId, assigneeId ?? "", input.threadId);
      if ("error" in thread) return c.json({ error: thread.error }, thread.status);
      threadId = thread.id;
    }
    const timezone = input.timezone != null ? input.timezone.trim() : series.timezone;
    if (!isValidTimeZone(timezone)) return c.json({ error: "invalid_timezone" }, 400);
    const rrule = input.rrule === undefined ? series.rrule : emptyToNull(input.rrule);
    const rruleErr = validateCalendarRrule(rrule);
    if (rruleErr) return c.json({ error: rruleErr }, 400);
    let dtstartUtc = series.dtstart_utc;
    if (input.dtstart != null) {
      try {
        dtstartUtc = parseCalendarDtstart(input.dtstart, timezone);
      } catch (err) {
        return c.json({ error: err instanceof RruleError ? err.code : "invalid_dtstart" }, 400);
      }
    }
    const nextStatus = input.status ?? series.status;
    if (
      (nextStatus === "active" || nextStatus === "paused") &&
      nonCancelledSeriesCount(db, s.accountId, series.id) >= CAL_MAX_SERIES
    ) {
      return c.json({ error: "cap" }, 409);
    }
    const requireHuman =
      input.requireHumanApproval != null ? (input.requireHumanApproval ? 1 : 0) : series.require_human_approval;
    const scheduleChanged =
      rrule !== series.rrule || dtstartUtc !== series.dtstart_utc || timezone !== series.timezone;
    const t = now();
    db.immediate(() => {
      db.run(
        `UPDATE calendar_series SET
           title = ?, prompt = ?, assignee_bot_id = ?, thread_id = ?, rrule = ?,
           dtstart_utc = ?, timezone = ?, require_human_approval = ?, status = ?, updated_at = ?
         WHERE id = ?`,
        [
          input.title ?? series.title,
          input.prompt ?? series.prompt,
          assigneeId,
          threadId,
          rrule,
          dtstartUtc,
          timezone,
          requireHuman,
          nextStatus,
          t,
          series.id,
        ],
      );
      if (nextStatus === "paused" && series.status !== "paused") {
        suppressOpenCalendarInstances(db, series.id, "pause");
      } else if (nextStatus === "cancelled" && series.status !== "cancelled") {
        suppressOpenCalendarInstances(db, series.id, "cancel");
      } else if (nextStatus === "active") {
        const updated = loadCalendarSeries(db, s.accountId, series.id);
        if (updated && (scheduleChanged || series.status !== "active")) rematerializeScheduledInstances(db, updated);
      }
    });
    if (nextStatus === "active") {
      ctx.engine.tickCalendar();
      ctx.engine.kick();
    }
    return c.json({ series: loadCalendarSeries(db, s.accountId, series.id) });
  });

  app.post("/v1/calendar/series/:id/confirm", (c) => {
    const s = requireSession(c);
    const series = loadCalendarSeries(db, s.accountId, c.req.param("id"));
    if (!series) return c.json({ error: "not_found" }, 404);
    if (series.status !== "proposed") return c.json({ error: "not_proposed" }, 409);
    if (nonCancelledSeriesCount(db, s.accountId, series.id) >= CAL_MAX_SERIES) {
      return c.json({ error: "cap" }, 409);
    }
    db.immediate(() => {
      db.run(`UPDATE calendar_series SET status = 'active', updated_at = ? WHERE id = ?`, [now(), series.id]);
      const updated = loadCalendarSeries(db, s.accountId, series.id);
      if (updated) rematerializeScheduledInstances(db, updated);
    });
    ctx.engine.tickCalendar();
    ctx.engine.kick();
    return c.json({ series: loadCalendarSeries(db, s.accountId, series.id) });
  });

  app.post("/v1/calendar/series/:id/pause", async (c) => {
    const s = requireSession(c);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    if (!raw || typeof raw !== "object" || typeof (raw as { paused?: unknown }).paused !== "boolean") {
      return c.json({ error: "bad_request" }, 400);
    }
    const paused = (raw as { paused: boolean }).paused;
    const series = loadCalendarSeries(db, s.accountId, c.req.param("id"));
    if (!series) return c.json({ error: "not_found" }, 404);
    if (paused) {
      if (series.status === "cancelled") return c.json({ error: "cancelled" }, 409);
      if (series.status !== "paused") {
        db.immediate(() => {
          db.run(`UPDATE calendar_series SET status = 'paused', updated_at = ? WHERE id = ?`, [now(), series.id]);
          suppressOpenCalendarInstances(db, series.id, "pause");
        });
      }
    } else {
      if (series.status === "active") return c.json({ series });
      if (series.status !== "paused") return c.json({ error: "not_paused" }, 409);
      if (nonCancelledSeriesCount(db, s.accountId, series.id) >= CAL_MAX_SERIES) {
        return c.json({ error: "cap" }, 409);
      }
      db.immediate(() => {
        db.run(`UPDATE calendar_series SET status = 'active', updated_at = ? WHERE id = ?`, [now(), series.id]);
        const updated = loadCalendarSeries(db, s.accountId, series.id);
        if (updated) rematerializeScheduledInstances(db, updated);
      });
      ctx.engine.tickCalendar();
      ctx.engine.kick();
    }
    return c.json({ series: loadCalendarSeries(db, s.accountId, series.id) });
  });

  app.delete("/v1/calendar/series/:id", (c) => {
    const s = requireSession(c);
    const series = loadCalendarSeries(db, s.accountId, c.req.param("id"));
    if (!series) return c.json({ error: "not_found" }, 404);
    if (series.status !== "cancelled") {
      db.immediate(() => {
        db.run(`UPDATE calendar_series SET status = 'cancelled', updated_at = ? WHERE id = ?`, [now(), series.id]);
        suppressOpenCalendarInstances(db, series.id, "cancel");
      });
    }
    return c.json({ series: loadCalendarSeries(db, s.accountId, series.id) });
  });

  app.post("/v1/calendar/instances/:id/cancel", (c) => {
    const s = requireSession(c);
    const inst = db.get<CalendarInstanceRow & { account_id: string }>(
      `SELECT i.*, s.account_id FROM calendar_instances i
       JOIN calendar_series s ON s.id = i.series_id
       WHERE i.id = ? AND s.account_id = ?`,
      [c.req.param("id"), s.accountId],
    );
    if (!inst) return c.json({ error: "not_found" }, 404);
    if (inst.status === "running") return c.json({ error: "in_flight" }, 409);
    db.immediate(() => {
      if (inst.status === "queued" && inst.turn_id) {
        db.run(`UPDATE turns SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'`, [
          now(),
          inst.turn_id,
        ]);
      }
      db.run(`UPDATE calendar_instances SET status = 'cancelled' WHERE id = ?`, [inst.id]);
    });
    const instance = db.get("SELECT * FROM calendar_instances WHERE id = ?", [inst.id]);
    return c.json({ instance });
  });

  app.post("/v1/calendar/learn", async (c) => {
    const s = requireSession(c);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    const parsed = learnRoutineInput.safeParse(raw);
    if (!parsed.success) return c.json({ error: "bad_request" }, 400);
    const thread = db.get<{ id: string; bot_id: string; kind: string; title: string }>(
      "SELECT id, bot_id, kind, title FROM threads WHERE id = ? AND account_id = ?",
      [parsed.data.threadId, s.accountId],
    );
    if (!thread) return c.json({ error: "not_found" }, 404);
    if (!isCalendarFiringThreadKind(thread.kind)) return c.json({ error: "invalid_thread" }, 400);
    const assigneeId = parsed.data.botId ?? thread.bot_id;
    const bot = resolveCalendarAssignee(db, s.accountId, assigneeId);
    if ("error" in bot) return c.json({ error: bot.error }, bot.status);
    if (nonCancelledSeriesCount(db, s.accountId) >= CAL_MAX_SERIES) return c.json({ error: "cap" }, 409);
    const timezone = currentOrgMeta(db)?.timezone ?? "UTC";
    const t = now();
    const dtstartUtc = localNineTomorrow(timezone, t);
    const messages = db
      .all<{ role: string; origin: string; body: string }>(
        `SELECT role, origin, body FROM messages
         WHERE thread_id = ? AND origin NOT IN ('prompt', 'calendar')
         ORDER BY created_at DESC LIMIT 20`,
        [thread.id],
      )
      .reverse();
    const lastTurn = db.get<{ id: string }>(
      "SELECT id FROM turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
      [thread.id],
    );
    const liveWork: string[] = [];
    if (lastTurn) {
      const events = db.all<{ kind: string; payload: string }>(
        "SELECT kind, payload FROM live_work_events WHERE turn_id = ? ORDER BY seq ASC LIMIT 40",
        [lastTurn.id],
      );
      for (const ev of events) {
        const text = summarizeLiveEvent(ev.kind, parseLivePayload(ev.payload));
        if (text) liveWork.push(text);
      }
    }
    let pageUrl = "";
    try {
      const display = await ctx.engine.runnerFor(s.accountId).display();
      pageUrl = display.pageUrl ?? "";
    } catch (err) {
      if (err instanceof RunnerUnavailable) throw err;
      pageUrl = "";
    }
    const { prompt, captureSummary } = stitchLearnPrompt({ messages, liveWork, pageUrl });
    const title = thread.title.trim() || `Routine from ${bot.name}`;
    const seriesId = id();
    const requireHuman = calendarRequireHumanApproval(undefined, thread.kind, bot.require_human_approval);
    db.run(
      `INSERT INTO calendar_series (
         id, account_id, title, prompt, assignee_bot_id, thread_id, kind, status, rrule,
         dtstart_utc, timezone, require_human_approval, created_by, source_turn_id, source_thread_id,
         capture_summary, min_interval_ms, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'routine', 'proposed', NULL, ?, ?, ?, 'learn', ?, ?, ?, ?, ?, ?)`,
      [
        seriesId,
        s.accountId,
        title,
        prompt,
        bot.id,
        thread.id,
        dtstartUtc,
        timezone,
        requireHuman ? 1 : 0,
        lastTurn?.id ?? null,
        thread.id,
        captureSummary,
        CAL_MIN_INTERVAL_MS,
        t,
        t,
      ],
    );
    onPush(s.accountId, { type: "calendar.proposed", seriesId });
    return c.json({ series: loadCalendarSeries(db, s.accountId, seriesId) }, 201);
  });

  async function purgeBot(c: { req: { json: () => Promise<unknown>; param: (n: string) => string } }, accountId: string) {
    let body: { confirm?: unknown } = {};
    try {
      body = (await c.req.json()) as { confirm?: unknown };
    } catch {
      body = {};
    }
    if (String(body.confirm ?? "").trim().toUpperCase() !== "DELETE") {
      return { status: 400 as const, json: { error: "confirm", message: "Type DELETE to permanently delete" } };
    }
    const bot = db.get<{ id: string; status: string; role: string | null }>(
      "SELECT id, status, role FROM bots WHERE id = ? AND account_id = ?",
      [c.req.param("id"), accountId],
    );
    if (!bot) return { status: 404 as const, json: { error: "not_found" } };
    if (isGatewayRole(bot.role)) return { status: 409 as const, json: { error: "gateway_protected" } };
    if (bot.status !== "archived") return { status: 409 as const, json: { error: "archive_first" } };
    await ctx.engine.runnerFor(accountId).kill(bot.id);
    deleteBotPermanently(db, bot.id);
    try {
      await ctx.engine.runnerFor(accountId).deleteProject(bot.id);
    } catch (err) {
      ctx.log.error("delete bot project failed", { botId: bot.id, error: String(err) });
    }
    return { status: 200 as const, json: { ok: true } };
  }

  app.post("/v1/bots/:id/purge", async (c) => {
    const s = requireSession(c);
    const result = await purgeBot(c, s.accountId);
    return c.json(result.json, result.status);
  });

  app.delete("/v1/bots/:id", async (c) => {
    const s = requireSession(c);
    const result = await purgeBot(c, s.accountId);
    return c.json(result.json, result.status);
  });

  app.get("/v1/bots/:id", (c) => {
    const s = requireSession(c);
    const bot = db.get("SELECT * FROM bots WHERE id = ? AND account_id = ?", [c.req.param("id"), s.accountId]);
    if (!bot) return c.json({ error: "not_found" }, 404);
    return c.json({ bot, compute: healthPayload(ctx, s.accountId) });
  });

  app.patch("/v1/bots/:id", async (c) => {
    const s = requireSession(c);
    const body = await c.req.json();
    const bot = db.get<{ id: string; role: string | null }>(
      "SELECT id, role FROM bots WHERE id = ? AND account_id = ?",
      [c.req.param("id"), s.accountId],
    );
    if (!bot) return c.json({ error: "not_found" }, 404);
    if (isGatewayRole(bot.role) && body.name) return c.json({ error: "gateway_protected" }, 409);
    if (body.name) db.run("UPDATE bots SET name = ? WHERE id = ?", [String(body.name), bot.id]);
    if (body.description != null) db.run("UPDATE bots SET description = ? WHERE id = ?", [String(body.description), bot.id]);
    return c.json({ ok: true });
  });

  app.patch("/v1/bots/:id/settings", async (c) => {
    const s = requireSession(c);
    const body = await c.req.json();
    const bot = db.get<{
      id: string;
      model: string | null;
      reasoning_effort: string | null;
      role: string | null;
    }>("SELECT id, model, reasoning_effort, role FROM bots WHERE id = ? AND account_id = ?", [
      c.req.param("id"),
      s.accountId,
    ]);
    if (!bot) return c.json({ error: "not_found" }, 404);
    if (
      isGatewayRole(bot.role) &&
      (body.permissionMode != null || body.harness != null || body.requireHumanApproval != null)
    ) {
      return c.json({ error: "gateway_protected" }, 409);
    }
    const catalog = listGrokModels(cfg.home);
    let model = bot.model || "";
    let reasoningEffort = bot.reasoning_effort || "";
    if (body.model != null || body.reasoningEffort != null || body.reasoning_effort != null) {
      if (body.model != null && !catalog.some((m) => m.id === String(body.model).trim())) {
        return c.json({ error: "unknown_model", message: "Unknown model" }, 400);
      }
      const inference = resolveBotInference(
        catalog,
        (body.model ?? bot.model) as string | undefined,
        (body.reasoningEffort ?? body.reasoning_effort ?? bot.reasoning_effort) as string | undefined,
      );
      const changed = inference.model !== model || inference.reasoningEffort !== reasoningEffort;
      db.run("UPDATE bots SET model = ?, reasoning_effort = ? WHERE id = ?", [
        inference.model,
        inference.reasoningEffort,
        bot.id,
      ]);
      model = inference.model;
      reasoningEffort = inference.reasoningEffort;
      if (changed) {
        try {
          await ctx.engine.runnerFor(s.accountId).invalidateAcp(bot.id);
        } catch (err) {
          if (!(err instanceof RunnerUnavailable)) throw err;
        }
      }
    }
    if (body.permissionMode) {
      db.run("UPDATE bots SET permission_mode = ? WHERE id = ?", [String(body.permissionMode), bot.id]);
    }
    if (body.requireHumanApproval != null) {
      db.run("UPDATE bots SET require_human_approval = ? WHERE id = ?", [
        body.requireHumanApproval ? 1 : 0,
        bot.id,
      ]);
    }
    if (body.harness) {
      db.run("UPDATE bots SET harness = ? WHERE id = ?", [String(body.harness), bot.id]);
    }
    return c.json({ ok: true, model, reasoningEffort, applies: "next_turn" });
  });

  app.get("/v1/inference-models", (c) => {
    const s = requireSession(c);
    void s;
    return c.json({ models: listGrokModels(cfg.home) });
  });

  app.post("/v1/threads", async (c) => {
    const s = requireSession(c);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    const parsed = createGroupThreadInput.safeParse(raw);
    if (!parsed.success) return c.json({ error: "bad_request" }, 400);
    const body = parsed.data;
    if ((body.userIds ?? []).some((uid) => uid !== s.userId)) {
      return c.json({ error: "org_members_required" }, 400);
    }
    const addCaller = body.addCaller !== false;
    const bots: { id: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const botId of body.botIds) {
      if (seen.has(botId)) continue;
      seen.add(botId);
      const bot = db.get<{ id: string; name: string; status: string }>(
        "SELECT id, name, status FROM bots WHERE id = ? AND account_id = ?",
        [botId, s.accountId],
      );
      if (!bot || bot.status !== "active") continue;
      bots.push(bot);
    }
    const principalCount = bots.length + (addCaller ? 1 : 0);
    if (bots.length === 0 || !groupMeetsMinimum(bots.length, principalCount)) {
      return c.json({ error: "too_small" }, 400);
    }
    const title = (body.title ?? "").trim() || "New thread";
    const threadId = db.immediate(() => {
      const createdId = id();
      const t = now();
      db.run(
        `INSERT INTO threads (id, account_id, bot_id, title, kind, created_at)
         VALUES (?, ?, ?, ?, 'group', ?)`,
        [createdId, s.accountId, bots[0]!.id, title, t],
      );
      if (addCaller) {
        db.run(
          `INSERT INTO thread_participants (id, thread_id, kind, user_id, bot_id, created_at)
           VALUES (?, ?, 'human', ?, NULL, ?)`,
          [id(), createdId, s.userId, t],
        );
      }
      for (const bot of bots) {
        db.run(
          `INSERT INTO thread_participants (id, thread_id, kind, user_id, bot_id, created_at)
           VALUES (?, ?, 'bot', NULL, ?, ?)`,
          [id(), createdId, bot.id, t],
        );
      }
      return createdId;
    });
    const thread = db.get("SELECT * FROM threads WHERE id = ?", [threadId]);
    const participants = db.all("SELECT * FROM thread_participants WHERE thread_id = ? ORDER BY created_at", [
      threadId,
    ]);
    return c.json({ thread, participants }, 201);
  });

  app.get("/v1/threads", (c) => {
    const s = requireSession(c);
    const botId = c.req.query("botId");
    const kind = c.req.query("kind") ?? "human";
    if (kind === "a2a") {
      const threads = db.all(
        `SELECT * FROM threads WHERE account_id = ? AND kind = 'a2a'
         AND (bot_id = ? OR peer_bot_id = ?) ORDER BY created_at DESC`,
        [s.accountId, botId ?? "", botId ?? ""],
      );
      return c.json({ threads });
    }
    if (kind === "group") {
      const threads = db.all(
        `SELECT * FROM threads WHERE account_id = ? AND kind = 'group' ORDER BY created_at DESC`,
        [s.accountId],
      );
      return c.json({ threads });
    }
    const thread = botId
      ? db.get(
          "SELECT * FROM threads WHERE account_id = ? AND bot_id = ? AND IFNULL(kind,'human') = 'human'",
          [s.accountId, botId],
        )
      : db.get(
          `SELECT t.* FROM threads t
           JOIN bots b ON b.id = t.bot_id
           WHERE t.account_id = ? AND IFNULL(t.kind,'human') = 'human'
             AND IFNULL(b.role, 'desk') = 'desk'
           ORDER BY t.created_at LIMIT 1`,
          [s.accountId],
        );
    const messages = thread ? db.all(VISIBLE_MESSAGES_SQL, [(thread as { id: string }).id]) : [];
    const latestTurn = thread
      ? db.get<{ id: string }>(
          "SELECT id FROM turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
          [(thread as { id: string }).id],
        )
      : undefined;
    return c.json({ thread, messages, latestTurnId: latestTurn?.id ?? null });
  });

  app.get("/v1/threads/:id", (c) => {
    const s = requireSession(c);
    const thread = db.get("SELECT * FROM threads WHERE id = ? AND account_id = ?", [
      c.req.param("id"),
      s.accountId,
    ]);
    if (!thread) return c.json({ error: "not_found" }, 404);
    const messages = db.all(VISIBLE_MESSAGES_SQL, [c.req.param("id")]);
    const latestTurn = db.get<{ id: string }>(
      "SELECT id FROM turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
      [c.req.param("id")],
    );
    return c.json({ thread, messages, latestTurnId: latestTurn?.id ?? null });
  });

  type GroupThread = { id: string; bot_id: string; kind: string; title: string };

  function requireGroupThread(s: SessionInfo, threadId: string): GroupThread | { error: string; status: 400 | 404 } {
    const thread = db.get<GroupThread>("SELECT id, bot_id, kind, title FROM threads WHERE id = ? AND account_id = ?", [
      threadId,
      s.accountId,
    ]);
    if (!thread) return { error: "not_found", status: 404 };
    if (thread.kind !== "group") return { error: "not_group", status: 400 };
    return thread;
  }

  function removeGroupParticipant(
    thread: GroupThread,
    participant: { id: string; bot_id: string | null },
  ): { error: string } | { ok: true } {
    return db.immediate(() => {
      const remaining = db.all<{ id: string; bot_id: string | null }>(
        "SELECT id, bot_id FROM thread_participants WHERE thread_id = ? AND id != ?",
        [thread.id, participant.id],
      );
      const remainingBots = remaining.filter((p) => p.bot_id);
      if (remainingBots.length === 0 || !groupMeetsMinimum(remainingBots.length, remaining.length)) {
        return { error: "too_small" };
      }
      const current = db.get<{ bot_id: string }>("SELECT bot_id FROM threads WHERE id = ?", [thread.id]);
      if (participant.bot_id && participant.bot_id === current?.bot_id) {
        db.run("UPDATE threads SET bot_id = ? WHERE id = ?", [remainingBots[0]!.bot_id, thread.id]);
      }
      db.run("DELETE FROM thread_participants WHERE id = ?", [participant.id]);
      return { ok: true as const };
    });
  }

  app.post("/v1/threads/:id/participants", async (c) => {
    const s = requireSession(c);
    const thread = requireGroupThread(s, c.req.param("id"));
    if ("error" in thread) return c.json({ error: thread.error }, thread.status);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    const parsed = addThreadParticipantInput.safeParse(raw);
    if (!parsed.success) return c.json({ error: "bad_request" }, 400);
    const botId = parsed.data.botId;
    const userId = parsed.data.userId;
    if (Boolean(botId) === Boolean(userId)) return c.json({ error: "bad_request" }, 400);
    if (userId) {
      if (userId !== s.userId) return c.json({ error: "org_members_required" }, 400);
      const existing = db.get("SELECT id FROM thread_participants WHERE thread_id = ? AND user_id = ?", [
        thread.id,
        userId,
      ]);
      if (existing) return c.json({ error: "duplicate" }, 409);
      const participantId = id();
      db.run(
        `INSERT INTO thread_participants (id, thread_id, kind, user_id, bot_id, created_at)
         VALUES (?, ?, 'human', ?, NULL, ?)`,
        [participantId, thread.id, userId, now()],
      );
      return c.json({ ok: true, participant: { id: participantId, kind: "human", userId, botId: null } });
    }
    const bot = db.get<{ id: string; status: string }>(
      "SELECT id, status FROM bots WHERE id = ? AND account_id = ?",
      [botId!, s.accountId],
    );
    if (!bot || bot.status !== "active") return c.json({ error: "not_found" }, 404);
    const existing = db.get("SELECT id FROM thread_participants WHERE thread_id = ? AND bot_id = ?", [
      thread.id,
      bot.id,
    ]);
    if (existing) return c.json({ error: "duplicate" }, 409);
    const participantId = id();
    db.run(
      `INSERT INTO thread_participants (id, thread_id, kind, user_id, bot_id, created_at)
       VALUES (?, ?, 'bot', NULL, ?, ?)`,
      [participantId, thread.id, bot.id, now()],
    );
    return c.json({ ok: true, participant: { id: participantId, kind: "bot", userId: null, botId: bot.id } });
  });

  app.delete("/v1/threads/:id/participants/:participantId", (c) => {
    const s = requireSession(c);
    const thread = requireGroupThread(s, c.req.param("id"));
    if ("error" in thread) return c.json({ error: thread.error }, thread.status);
    const participant = db.get<{ id: string; bot_id: string | null }>(
      "SELECT id, bot_id FROM thread_participants WHERE id = ? AND thread_id = ?",
      [c.req.param("participantId"), thread.id],
    );
    if (!participant) return c.json({ error: "not_found" }, 404);
    const result = removeGroupParticipant(thread, participant);
    if ("error" in result) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  app.delete("/v1/threads/:id/participants", (c) => {
    const s = requireSession(c);
    const thread = requireGroupThread(s, c.req.param("id"));
    if ("error" in thread) return c.json({ error: thread.error }, thread.status);
    const botId = c.req.query("botId");
    if (!botId) return c.json({ error: "bad_request" }, 400);
    const participant = db.get<{ id: string; bot_id: string | null }>(
      "SELECT id, bot_id FROM thread_participants WHERE thread_id = ? AND bot_id = ?",
      [thread.id, botId],
    );
    if (!participant) return c.json({ error: "not_found" }, 404);
    const result = removeGroupParticipant(thread, participant);
    if ("error" in result) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  app.post("/v1/threads/:id/messages", async (c) => {
    const s = requireSession(c);
    const thread = db.get<{ id: string; bot_id: string; kind: string; title: string }>(
      "SELECT * FROM threads WHERE id = ? AND account_id = ?",
      [c.req.param("id"), s.accountId],
    );
    if (!thread) return c.json({ error: "not_found" }, 404);
    switch (thread.kind) {
      case "a2a":
        return c.json({ error: "a2a_readonly" }, 403);
      case "group": {
        let raw: unknown;
        try {
          raw = await c.req.json();
        } catch {
          return c.json({ error: "bad_request" }, 400);
        }
        const parsed = postMessageInput.safeParse(raw);
        if (!parsed.success) return c.json({ error: "bad_request" }, 400);
        const text = parsed.data.body.trim();
        if (!text) return c.json({ error: "empty" }, 400);
        const posted = db.immediate(() => {
          const userMessage = insertMessage(db, {
            threadId: thread.id,
            turnId: null,
            role: "user",
            origin: "user",
            body: text,
          });
          const fanout = queueGroupMentions(db, {
            threadId: thread.id,
            title: thread.title,
            body: text,
          });
          return {
            userMessage,
            turnIds: fanout.turnIds,
            mentioned: fanout.mentioned,
            mentionedTruncated: fanout.mentionedTruncated,
          };
        });
        onPush(s.accountId, { type: "message.created", message: posted.userMessage });
        if (posted.turnIds.length) ctx.engine.kick();
        return c.json(
          {
            turnIds: posted.turnIds,
            mentioned: posted.mentioned,
            userMessageId: posted.userMessage.id,
            ...(posted.mentionedTruncated ? { mentionedTruncated: true } : {}),
          },
          202,
        );
      }
      default: {
        const queued = db.get<{ n: number }>(
          "SELECT COUNT(*) as n FROM turns WHERE bot_id = ? AND status = 'queued'",
          [thread.bot_id],
        );
        if ((queued?.n ?? 0) >= 5) return c.json({ error: "queue_full" }, 429);
        const body = (await c.req.json()) as { body?: string };
        const text = String(body.body ?? "").trim();
        if (!text) return c.json({ error: "empty" }, 400);
        const turnId = id();
        const userMessage = db.immediate(() => {
          const turnCreated = now();
          db.run(
            `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, deadline_at, created_at)
             VALUES (?, ?, ?, 'queued', 0, '', ?, ?)`,
            [turnId, thread.id, thread.bot_id, turnCreated + 2 * 60 * 60 * 1000, turnCreated],
          );
          return insertMessage(db, {
            threadId: thread.id,
            turnId,
            role: "user",
            origin: "user",
            body: text,
          });
        });
        ctx.engine.kick();
        return c.json({ turnId, userMessageId: userMessage.id }, 202);
      }
    }
  });

  app.post("/v1/turns/:id/cancel", async (c) => {
    const s = requireSession(c);
    const turn = db.get<TurnRow>(
      `SELECT t.* FROM turns t JOIN threads th ON th.id = t.thread_id
       WHERE t.id = ? AND th.account_id = ?`,
      [c.req.param("id"), s.accountId],
    );
    if (!turn) return c.json({ error: "not_found" }, 404);
    let cancelled = false;
    if (turn.status === "running") {
      await ctx.engine.runnerFor(s.accountId).cancel(turn.bot_id);
      promote(db, turn.id, { kind: "cancel" });
      cancelled = true;
    } else if (turn.status === "queued") {
      db.run("UPDATE turns SET status = 'cancelled', finished_at = ? WHERE id = ?", [now(), turn.id]);
      cancelled = true;
    }
    if (cancelled) {
      reconcileCalendarInstance(db, turn.id);
      const bot = db.get<{ role: string | null }>("SELECT role FROM bots WHERE id = ?", [turn.bot_id]);
      if (isGatewayRole(bot?.role) && federationEffective(currentOrgMeta(db))) {
        ctx.engine.maybeKickGatewayDrain(turn.bot_id);
      }
    }
    return c.json({ ok: true });
  });

  app.post("/v1/turns/:id/permissions/:reqId", async (c) => {
    const s = requireSession(c);
    const body = await c.req.json();
    const allow = Boolean(body.allow);
    const ok = await ctx.engine.runnerFor(s.accountId).respondPermission(c.req.param("reqId"), allow);
    onPush(s.accountId, {
      type: "permission_response",
      reqId: c.req.param("reqId"),
      allow,
      answered: ok,
    });
    return c.json({ ok, answered: ok });
  });

  app.post("/v1/messages/:id/approve", (c) => {
    const s = requireSession(c);
    const ok = approveMessage(db, s.accountId, c.req.param("id"));
    if (!ok) return c.json({ error: "not_pending" }, 409);
    const msg = db.get("SELECT * FROM messages WHERE id = ?", [c.req.param("id")]);
    onPush(s.accountId, { type: "message.created", message: msg });
    return c.json({ ok: true, message: msg });
  });

  app.post("/v1/messages/:id/reject", (c) => {
    const s = requireSession(c);
    const ok = rejectMessage(db, s.accountId, c.req.param("id"));
    if (!ok) return c.json({ error: "not_pending" }, 409);
    const msg = db.get("SELECT * FROM messages WHERE id = ?", [c.req.param("id")]);
    onPush(s.accountId, { type: "message.created", message: msg });
    return c.json({ ok: true, message: msg });
  });

  app.get("/v1/turns/:id/live-work", (c) => {
    const s = requireSession(c);
    const events = db.all<{ payload: string; kind: string }>(
      `SELECT e.* FROM live_work_events e
       JOIN turns t ON t.id = e.turn_id
       JOIN threads th ON th.id = t.thread_id
       WHERE e.turn_id = ? AND th.account_id = ?
       ORDER BY e.seq`,
      [c.req.param("id"), s.accountId],
    );
    return c.json({
      events: events.map((e) => ({ ...e, payload: parseLivePayload(e.payload) })),
    });
  });

  app.get("/v1/harness-auth", (c) => {
    const s = requireSession(c);
    const vault = db.get("SELECT last_four FROM credentials WHERE account_id = ? AND kind = 'xai_api_key'", [
      s.accountId,
    ]);
    const logins = detectCliLogins().map(({ id, label, cliPath, signedIn, email, authMode }) => ({
      id,
      label,
      cliInstalled: Boolean(cliPath),
      signedIn,
      email,
      authMode,
    }));
    return c.json({
      logins,
      vaultKey: Boolean(vault),
      preferred: logins.find((l) => l.id === "grok" && l.signedIn)
        ? "grok-cli"
        : vault
          ? "api-key"
          : logins.find((l) => l.signedIn)
            ? "other-cli"
            : "none",
    });
  });

  app.get("/v1/credentials/xai", (c) => {
    const s = requireSession(c);
    const row = db.get<{ last_four: string }>(
      "SELECT last_four FROM credentials WHERE account_id = ? AND kind = 'xai_api_key'",
      [s.accountId],
    );
    return c.json({ configured: Boolean(row), lastFour: row?.last_four ?? null });
  });

  app.put("/v1/credentials/xai", async (c) => {
    const s = requireSession(c);
    const body = await c.req.json();
    const key = String(body.key ?? "");
    if (key.length < 8) return c.json({ error: "invalid_key" }, 400);
    const env = seal(master, key);
    db.run("DELETE FROM credentials WHERE account_id = ? AND kind = 'xai_api_key'", [s.accountId]);
    db.run(
      `INSERT INTO credentials (id, account_id, kind, ciphertext, dek_wrapped, key_id, last_four, created_at)
       VALUES (?, ?, 'xai_api_key', ?, ?, ?, ?, ?)`,
      [id(), s.accountId, env.ciphertext, env.dekWrapped, env.keyId, env.lastFour, now()],
    );
    log.info("stored xai credential", { accountId: s.accountId, lastFour: env.lastFour });
    return c.json({ ok: true, lastFour: env.lastFour });
  });

  app.delete("/v1/credentials/xai", (c) => {
    const s = requireSession(c);
    db.run("DELETE FROM credentials WHERE account_id = ? AND kind = 'xai_api_key'", [s.accountId]);
    return c.json({ ok: true });
  });

  app.get("/v1/compute", (c) => {
    const s = requireSession(c);
    return c.json(healthPayload(ctx, s.accountId));
  });

  app.get("/v1/activity", (c) => {
    const s = requireSession(c);
    return c.json({ bots: activityForAccount(ctx, s.accountId), now: now() });
  });

  app.post("/v1/compute/takeover", async (c) => {
    const s = requireSession(c);
    const compute = db.get<{ id: string }>("SELECT id FROM compute_instances WHERE account_id = ?", [
      s.accountId,
    ]);
    if (!compute) return c.json({ error: "no_compute" }, 404);
    db.run("DELETE FROM takeover_tickets WHERE account_id = ?", [s.accountId]);
    const ticket = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    db.run(
      `INSERT INTO takeover_tickets (id, account_id, compute_id, user_session_id, ticket_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id(), s.accountId, compute.id, s.sessionId, sha256Hex(ticket), now() + 10 * 60 * 1000, now()],
    );
    const { screencastNonce } = await ctx.engine.runnerFor(s.accountId).takeoverUrl();
    const prev = ctx.engine.takeoverByAccount.get(s.accountId);
    if (prev) ctx.engine.takeoverBridges.delete(prev.nonce);
    const bridge: TakeoverBridge = { accountId: s.accountId, nonce: screencastNonce };
    ctx.engine.takeoverBridges.set(screencastNonce, bridge);
    ctx.engine.takeoverByAccount.set(s.accountId, bridge);
    return c.json({ ticket });
  });

  async function wipeCompute(c: { req: { json: () => Promise<unknown> } }, accountId: string) {
    let body: { confirm?: unknown } = {};
    try {
      body = (await c.req.json()) as { confirm?: unknown };
    } catch {
      body = {};
    }
    if (String(body.confirm ?? "").trim().toUpperCase() !== "DELETE") {
      return { ok: false as const, error: "confirm" as const };
    }
    await ctx.engine.runnerFor(accountId).wipeDesk();
    return { ok: true as const };
  }

  app.post("/v1/compute/wipe", async (c) => {
    const s = requireSession(c);
    const result = await wipeCompute(c, s.accountId);
    if (!result.ok) return c.json({ error: "confirm", message: "Type DELETE to confirm" }, 400);
    return c.json({ ok: true });
  });

  app.delete("/v1/compute", async (c) => {
    const s = requireSession(c);
    const result = await wipeCompute(c, s.accountId);
    if (!result.ok) return c.json({ error: "confirm", message: "Type DELETE to confirm" }, 400);
    return c.json({ ok: true });
  });

  app.all("/mcp/v1", async (c) => {
    if (c.req.method === "GET") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(": connected\n\n"));
          const iv = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              clearInterval(iv);
            }
          }, 15_000);
          c.req.raw.signal.addEventListener("abort", () => {
            clearInterval(iv);
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }
    if (c.req.method !== "POST") return c.json({ error: "method" }, 405);
    const bearer = c.req.header("authorization");
    if (c.req.header("cookie") && !bearer) {
      return c.json({ error: "cookies_not_accepted" }, 401);
    }
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    try {
      const result = await handleMcpJsonRpc(db, inflight, bearer, body, mcpHooks());
      emitMcpSideEffects(result);
      return c.json(result.json as Record<string, unknown>, result.status as 200);
    } catch (err) {
      if (err instanceof McpError) return c.json({ error: err.code, message: err.message }, err.httpStatus as 409);
      throw err;
    }
  });

  app.get(
    "/v1/push",
    upgradeWebSocket((c) => {
      const s = sessionFromToken(db, cookies(c));
      return {
        onOpen(_evt, ws) {
          if (!s) {
            ws.close();
            return;
          }
          const raw = ws.raw as ServerWebSocket;
          let set = push.get(s.accountId);
          if (!set) {
            set = new Set();
            push.set(s.accountId, set);
          }
          set.add(raw);
        },
        onClose() {
          if (!s) return;
          const set = push.get(s.accountId);
          /* membership cleaned lazily */
        },
      };
    }),
  );

  app.get(
    "/runner/v1/screencast",
    upgradeWebSocket(() => {
      let bridge: TakeoverBridge | undefined;
      let authed = false;
      return {
        onMessage(evt, ws) {
          const raw = (ws as { raw?: ServerWebSocket }).raw;
          if (!authed) {
            if (typeof evt.data !== "string") {
              ws.close();
              return;
            }
            try {
              const msg = JSON.parse(evt.data) as { type?: string; nonce?: string; machineToken?: string };
              if (msg.type !== "auth" || !msg.nonce || !msg.machineToken) {
                ws.close();
                return;
              }
              const row = lookupMachineToken(db, msg.machineToken);
              if (!row) {
                ws.close();
                return;
              }
              const found = ctx.engine.takeoverBridges.get(msg.nonce);
              if (!found || found.accountId !== row.account_id) {
                ws.close();
                return;
              }
              authed = true;
              bridge = found;
              if (raw) found.mediaWs = raw;
            } catch {
              ws.close();
            }
            return;
          }
          if (!bridge?.spaWs) return;
          try {
            if (typeof evt.data === "string") {
              bridge.spaWs.send(evt.data);
            } else {
              const bytes = wsBinary(evt.data);
              if (bytes) bridge.spaWs.send(bytes);
            }
          } catch {
            /* spa gone */
          }
        },
        onClose() {
          if (bridge) bridge.mediaWs = undefined;
        },
      };
    }),
  );

  app.get(
    "/runner/v1",
    upgradeWebSocket((c) => {
      let accountId: string | null = null;
      let client: RemoteRunnerClient | null = null;
      let peer: JsonRpcPeer | null = null;
      let authed = false;
      return {
        onOpen(_evt, ws) {
          const raw = (ws as { raw?: ServerWebSocket }).raw;
          peer = new JsonRpcPeer(
            (text) => {
              try {
                if (raw) raw.send(text);
                else ws.send(text);
              } catch {
                /* ignore */
              }
            },
            async (method, params) => {
              if (method === "hello") {
                try {
                  const hello = (params ?? {}) as RunnerHello;
                  if (hello.protocol !== RUNNER_PROTOCOL) {
                    throw new RpcError(RPC_PROTOCOL, "protocol");
                  }
                  let machineToken: string;
                  let acct: string;
                  if (hello.enrollToken) {
                    const looked = lookupEnrollToken(db, hello.enrollToken);
                    if (looked.kind === "attached") throw new RpcError(RPC_RUNNER_ATTACHED, "runner_attached");
                    if (looked.kind === "invalid") throw new RpcError(RPC_UNAUTHORIZED, "unauthorized");
                    const consumed = consumeEnrollToken(db, hello.enrollToken);
                    if (!consumed) throw new RpcError(RPC_UNAUTHORIZED, "unauthorized");
                    acct = consumed.accountId;
                    machineToken = mintRunnerSecret("ob_run_");
                    persistHello(
                      db,
                      acct,
                      {
                        hostname: hello.hostname,
                        platform: hello.platform,
                        version: hello.version,
                        grokCliSignedIn: hello.grokCliSignedIn,
                        workspacePath: hello.workspacePath,
                      },
                      machineToken,
                    );
                  } else if (hello.machineToken) {
                    const row = lookupMachineToken(db, hello.machineToken);
                    if (!row || row.status === "revoked") throw new RpcError(RPC_UNAUTHORIZED, "unauthorized");
                    acct = row.account_id;
                    machineToken = hello.machineToken;
                    persistHello(db, acct, {
                      hostname: hello.hostname,
                      platform: hello.platform,
                      version: hello.version,
                      grokCliSignedIn: hello.grokCliSignedIn,
                      workspacePath: hello.workspacePath,
                    });
                  } else {
                    throw new RpcError(RPC_UNAUTHORIZED, "unauthorized");
                  }
                  const org = currentOrgMeta(db);
                  if (!org) throw new RpcError(RPC_UNAUTHORIZED, "unauthorized");
                  await ctx.engine.detachLocal(acct);
                  const remote = new RemoteRunnerClient(acct, peer!, () => {
                    try {
                      ws.close();
                    } catch {
                      /* ignore */
                    }
                  });
                  remote.workspacePath = hello.workspacePath;
                  remote.hostname = hello.hostname;
                  remote.platform = hello.platform;
                  remote.runnerVersion = hello.version;
                  remote.grokCliSignedIn = hello.grokCliSignedIn;
                  remote.lastHeartbeatAt = Date.now();
                  ctx.engine.attachRemote(acct, remote);
                  accountId = acct;
                  client = remote;
                  authed = true;
                  ctx.log.info("runner.hello", {
                    hostname: hello.hostname,
                    platform: hello.platform,
                    warmBotIds: hello.warmBotIds,
                  });
                  ctx.engine.kick();
                  const ack: RunnerHelloAck = {
                    machineToken,
                    orgId: org.org_id,
                    orgSlug: org.slug,
                    mcpProxy: true,
                  };
                  return ack;
                } catch (err) {
                  setTimeout(() => {
                    try {
                      ws.close();
                    } catch {
                      /* ignore */
                    }
                  }, 50);
                  throw err;
                }
              }
              if (!authed || !client || !accountId) throw new RpcError(RPC_UNAUTHORIZED, "unauthorized");
              if (method === "heartbeat") {
                const h = (params ?? {}) as RunnerHeartbeat;
                client.applyHeartbeat(h);
                persistHeartbeat(db, accountId, h.workspacePath);
                return;
              }
              if (method === "mcp.forward") return forwardMcp(params);
              if (method === "live_work") {
                const p = (params ?? {}) as { botId?: string; kind?: string; payload?: Record<string, unknown> };
                client.onLiveWork?.(
                  { kind: String(p.kind ?? ""), payload: p.payload ?? {}, botId: p.botId },
                  p.botId,
                );
                return;
              }
              if (method === "harness_state") {
                const p = (params ?? {}) as { harness?: RemoteRunnerClient["harness"] };
                if (p.harness) client.harness = p.harness;
                return;
              }
              throw new RpcError(-32601, `unknown ${method}`);
            },
          );
        },
        onMessage(evt) {
          if (!peer) return;
          if (typeof evt.data === "string") {
            peer.handleMessage(evt.data);
            return;
          }
          if (client) client.binaryOnControl += 1;
          peer.handleMessage(wsBinary(evt.data) ?? new Uint8Array());
        },
        onClose() {
          if (accountId && client && ctx.engine.disconnectRemote(accountId, client)) {
            persistDisconnect(db, accountId);
            ctx.log.info("runner.disconnect", { accountId });
          }
          peer?.rejectAll(new Error("runner ws closed"));
        },
        onError() {
          if (accountId && client && ctx.engine.disconnectRemote(accountId, client)) {
            persistDisconnect(db, accountId);
          }
        },
      };
    }),
  );

  app.get(
    "/v1/takeover",
    upgradeWebSocket(() => {
      let authed = false;
      let accountId: string | null = null;
      return {
        onMessage(evt, ws) {
          const data = typeof evt.data === "string" ? evt.data : "";
          const raw = (ws as { raw?: ServerWebSocket }).raw;
          if (!authed) {
            try {
              const msg = JSON.parse(data) as { type?: string; ticket?: string };
              if (msg.type !== "auth" || !msg.ticket) {
                ws.send(JSON.stringify({ error: "unauthorized" }));
                ws.close();
                return;
              }
              const row = db.get<{ account_id: string; expires_at: number }>(
                "SELECT account_id, expires_at FROM takeover_tickets WHERE ticket_hash = ?",
                [sha256Hex(msg.ticket)],
              );
              if (!row || row.expires_at < now()) {
                ws.send(JSON.stringify({ error: "invalid_ticket" }));
                ws.close();
                return;
              }
              authed = true;
              accountId = row.account_id;
              const live = ctx.engine.remotes.get(accountId);
              if (live?.connected) {
                const bridge = ctx.engine.takeoverByAccount.get(accountId);
                if (bridge && raw) bridge.spaWs = raw;
                void (async () => {
                  try {
                    if (bridge) await live.startScreencastNonce(bridge.nonce);
                  } catch (err) {
                    ws.send(JSON.stringify({ error: String(err) }));
                  }
                })();
                return;
              }
              const runner = ctx.engine.runnerFor(accountId);
              void (async () => {
                try {
                  await runner.ensureBrowser();
                  const d = await runner.display();
                  const viewport =
                    "browser" in runner && runner.browser && typeof runner.browser === "object"
                      ? (runner.browser as { viewport?: { width: number; height: number } }).viewport
                      : undefined;
                  ws.send(
                    JSON.stringify({
                      type: "meta",
                      pageUrl: d.pageUrl,
                      pageOrigin: d.pageOrigin,
                      viewport,
                    }),
                  );
                  await runner.startScreencast((jpeg, meta) => {
                    try {
                      if (meta.pageUrl || meta.pageOrigin) {
                        ws.send(
                          JSON.stringify({
                            type: "meta",
                            pageUrl: meta.pageUrl,
                            pageOrigin: meta.pageOrigin,
                            viewport: meta.viewport,
                          }),
                        );
                      }
                      if (raw) raw.send(jpeg);
                      else ws.send(jpeg);
                    } catch {
                      /* client gone */
                    }
                  });
                } catch (err) {
                  ws.send(JSON.stringify({ error: String(err) }));
                }
              })();
            } catch {
              ws.send(JSON.stringify({ error: "bad_auth" }));
              ws.close();
            }
            return;
          }
          if (accountId) {
            try {
              const live = ctx.engine.remotes.get(accountId);
              if (live?.connected) {
                const bridge = ctx.engine.takeoverByAccount.get(accountId);
                if (bridge?.mediaWs && typeof evt.data === "string") {
                  try {
                    bridge.mediaWs.send(evt.data);
                  } catch {
                    /* ignore */
                  }
                }
                return;
              }
              const msg = JSON.parse(data) as Record<string, unknown>;
              const runner = ctx.engine.runnerFor(accountId);
              if (msg.type === "navigate") {
                void runner.navigate(String(msg.url ?? ""), { duringTakeover: true, owner: "takeover" });
                return;
              }
              if (msg.type === "viewport") {
                void runner.setScreencastViewport(Number(msg.width), Number(msg.height));
                return;
              }
              void runner.dispatchInput(msg);
            } catch {
              /* ignore */
            }
          }
        },
        onClose() {
          if (!accountId) return;
          const live = ctx.engine.remotes.get(accountId);
          if (live?.connected) void live.stopTakeover().catch(() => undefined);
          else {
            try {
              void Promise.resolve(ctx.engine.runnerFor(accountId).stopTakeover()).catch(() => undefined);
            } catch {
              /* offline */
            }
          }
          const bridge = ctx.engine.takeoverByAccount.get(accountId);
          if (bridge) {
            ctx.engine.takeoverBridges.delete(bridge.nonce);
            ctx.engine.takeoverByAccount.delete(accountId);
          }
        },
      };
    }),
  );

  return {
    app,
    ctx,
    ready: () => undefined,
    websocket,
    stop: () => stopApp(ctx),
  } as { app: Hono; ctx: AppContext; ready: () => void; stop: () => void; websocket: typeof websocket };
}

function stopApp(ctx: AppContext): void {
  if (ctx.maintenanceTimer == null) return;
  clearInterval(ctx.maintenanceTimer);
  ctx.maintenanceTimer = undefined;
}

function bunRequestIp(env: unknown, req: Request): string {
  if (!env || typeof env !== "object") return "";
  const rec = env as {
    requestIP?: (r: Request) => { address?: string } | null;
    server?: { requestIP?: (r: Request) => { address?: string } | null };
  };
  try {
    const direct = rec.requestIP?.(req)?.address;
    if (direct) return direct;
  } catch {
    /* fetch adapter did not bind Bun.Server */
  }
  try {
    return rec.server?.requestIP?.(req)?.address ?? "";
  } catch {
    return "";
  }
}

function botPresence(ctx: AppContext, botId: string): { key: string; label: string } {
  const running = ctx.db.get(
    "SELECT id FROM turns WHERE bot_id = ? AND status = 'running' LIMIT 1",
    [botId],
  );
  if (running) return { key: "working", label: "Working" };
  const queued = ctx.db.get(
    "SELECT id FROM turns WHERE bot_id = ? AND status = 'queued' LIMIT 1",
    [botId],
  );
  if (queued) return { key: "queued", label: "Queued" };
  const pending = ctx.db.get(
    `SELECT m.id FROM messages m
     JOIN threads th ON th.id = m.thread_id
     WHERE th.bot_id = ? AND m.origin = 'pending_approval' LIMIT 1`,
    [botId],
  );
  if (pending) return { key: "attention", label: "Needs you" };
  const last = ctx.db.get<{ status: string; error: string | null }>(
    "SELECT status, error FROM turns WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1",
    [botId],
  );
  if (last && (last.status === "failed" || (last.error && last.status !== "completed"))) {
    return { key: "attention", label: "Needs you" };
  }
  const bot = ctx.db.get<{ account_id: string }>("SELECT account_id FROM bots WHERE id = ?", [botId]);
  if (bot && ctx.engine.enrolledRow(bot.account_id)) {
    const live = ctx.engine.remotes.get(bot.account_id);
    if (live?.bots.some((b) => b.id === botId && b.acpAlive)) return { key: "idle", label: "Dormant" };
    return { key: "idle", label: "Dormant" };
  }
  for (const runner of ctx.engine.runners.values()) {
    const acp = runner.acpFor(botId);
    if (acp && !acp.closed) return { key: "idle", label: "Dormant" };
  }
  return { key: "idle", label: "Dormant" };
}

function activityForAccount(ctx: AppContext, accountId: string) {
  const bots = ctx.db.all<{ id: string; name: string }>(
    "SELECT id, name FROM bots WHERE account_id = ? AND status = 'active' AND IFNULL(role, 'desk') = 'desk' ORDER BY created_at",
    [accountId],
  );
  return bots.map((b) => {
    const presence = botPresence(ctx, b.id);
    const turn = ctx.db.get<{
      id: string;
      status: string;
      started_at: number | null;
      created_at: number;
      error: string | null;
    }>(
      `SELECT id, status, started_at, created_at, error FROM turns
       WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1`,
      [b.id],
    );
    const queued = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM turns WHERE bot_id = ? AND status = 'queued'",
      [b.id],
    );
    let doing: string | null = null;
    if (turn) {
      const recent = ctx.db.all<{ kind: string; payload: string }>(
        "SELECT kind, payload FROM live_work_events WHERE turn_id = ? ORDER BY seq DESC LIMIT 12",
        [turn.id],
      );
      for (const row of recent) {
        doing = summarizeLiveEvent(row.kind, parseLivePayload(row.payload));
        if (doing) break;
      }
    }
    const thread = ctx.db.get<{ id: string }>(
      "SELECT id FROM threads WHERE bot_id = ? AND IFNULL(kind,'human') = 'human'",
      [b.id],
    );
    const lastMessage = thread
      ? ctx.db.get<{ role: string; body: string; created_at: number }>(
          `SELECT role, body, created_at FROM messages
           WHERE thread_id = ? AND origin NOT IN ('prompt', 'calendar')
           ORDER BY created_at DESC LIMIT 1`,
          [thread.id],
        )
      : undefined;
    return {
      id: b.id,
      name: b.name,
      presence,
      doing,
      queued: queued?.n ?? 0,
      turn: turn
        ? {
            id: turn.id,
            status: turn.status,
            startedAt: turn.started_at,
            createdAt: turn.created_at,
            error: turn.error,
          }
        : null,
      lastMessage: lastMessage
        ? {
            role: lastMessage.role,
            body: lastMessage.body.slice(0, 180),
            createdAt: lastMessage.created_at,
          }
        : null,
    };
  });
}

const CAL_SERIES_STATUSES = new Set(["proposed", "active", "paused", "cancelled"]);
const CAL_SERIES_KINDS = new Set(["schedule", "routine"]);

type CalendarSeriesRow = {
  id: string;
  account_id: string;
  title: string;
  prompt: string;
  assignee_bot_id: string | null;
  thread_id: string | null;
  kind: string;
  status: string;
  rrule: string | null;
  dtstart_utc: number;
  timezone: string;
  require_human_approval: number;
  created_by: string;
  created_by_bot_id: string | null;
  source_turn_id: string | null;
  source_thread_id: string | null;
  capture_summary: string | null;
  min_interval_ms: number;
  last_fired_at: number | null;
  next_due_at: number | null;
  created_at: number;
  updated_at: number;
};

type CalendarInstanceRow = {
  id: string;
  series_id: string;
  scheduled_at: number;
  status: string;
  turn_id: string | null;
  skipped_reason: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
};

type CalendarAssignee = {
  id: string;
  name: string;
  require_human_approval: number;
};

function emptyToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = value.trim();
  return t ? t : null;
}

function clipText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function validateCalendarRrule(rrule: string | null): string | null {
  if (rrule == null) return null;
  try {
    parseRrule(rrule);
    return null;
  } catch (err) {
    return err instanceof RruleError ? err.code : "invalid_rrule";
  }
}

function calendarRequireHumanApproval(
  requested: boolean | undefined,
  threadKind: string,
  botFlag: number,
): boolean {
  return Boolean(requested) || threadKind === "group" || Boolean(botFlag);
}

function loadCalendarSeries(db: OpenbotDb, accountId: string, seriesId: string): CalendarSeriesRow | undefined {
  return db.get<CalendarSeriesRow>("SELECT * FROM calendar_series WHERE id = ? AND account_id = ?", [
    seriesId,
    accountId,
  ]);
}

function resolveCalendarAssignee(
  db: OpenbotDb,
  accountId: string,
  botId: string,
): CalendarAssignee | { error: string; status: 400 | 404 } {
  const bot = db.get<{
    id: string;
    name: string;
    status: string;
    role: string | null;
    require_human_approval: number;
  }>("SELECT id, name, status, role, require_human_approval FROM bots WHERE id = ? AND account_id = ?", [
    botId,
    accountId,
  ]);
  if (!bot) return { error: "not_found", status: 404 };
  if (isGatewayRole(bot.role) || bot.status !== "active") return { error: "invalid_assignee", status: 400 };
  return { id: bot.id, name: bot.name, require_human_approval: bot.require_human_approval };
}

function isCalendarFiringThreadKind(kind: string | null | undefined): boolean {
  const k = kind || "human";
  return k === "human" || k === "group";
}

function resolveCalendarThread(
  db: OpenbotDb,
  accountId: string,
  botId: string,
  threadId?: string | null,
): { id: string; kind: string } | { error: string; status: 400 | 404 } {
  if (threadId) {
    const thread = db.get<{ id: string; kind: string }>(
      "SELECT id, kind FROM threads WHERE id = ? AND account_id = ?",
      [threadId, accountId],
    );
    if (!thread) return { error: "not_found", status: 404 };
    if (!isCalendarFiringThreadKind(thread.kind)) return { error: "invalid_thread", status: 400 };
    return thread;
  }
  const dm = humanThread(db, botId);
  if (!dm || dm.account_id !== accountId) return { error: "not_found", status: 404 };
  return { id: dm.id, kind: "human" };
}

function nextCalendarFireUtc(db: OpenbotDb, series: CalendarSeriesRow): number | null {
  if (series.status !== "active") return null;
  const inst = db.get<{ scheduled_at: number }>(
    `SELECT scheduled_at FROM calendar_instances
      WHERE series_id = ? AND status IN ('scheduled', 'due') AND scheduled_at >= ?
      ORDER BY scheduled_at LIMIT 1`,
    [series.id, now()],
  );
  if (inst) return inst.scheduled_at;
  try {
    const horizon = materializeHorizon({
      dtstartUtc: series.dtstart_utc,
      timezone: series.timezone,
      rrule: series.rrule,
      nowMs: now(),
    });
    if (horizon.future.length) return horizon.future[0]!;
    if (horizon.catchup != null && horizon.catchup >= now()) return horizon.catchup;
  } catch {
    /* fall through */
  }
  return series.dtstart_utc >= now() ? series.dtstart_utc : null;
}

function stitchLearnPrompt(opts: {
  messages: Array<{ role: string; origin: string; body: string }>;
  liveWork: string[];
  pageUrl: string;
}): { prompt: string; captureSummary: string } {
  const transcriptLines = opts.messages.map((m) => `${m.role}: ${clipText(m.body, 1500)}`);
  const prompt = clipText(
    [
      "Repeat this workflow:",
      "Transcript:",
      transcriptLines.join("\n") || "(none)",
      "Live work:",
      opts.liveWork.join("\n") || "(none)",
      `Page: ${opts.pageUrl}`,
    ].join("\n"),
    32_000,
  );
  const captureSummary = JSON.stringify({
    transcript: opts.messages.map((m) => ({
      role: m.role,
      origin: m.origin,
      body: clipText(m.body, 1500),
    })),
    liveWork: opts.liveWork,
    pageUrl: opts.pageUrl,
  });
  return { prompt, captureSummary };
}

function healthPayload(ctx: AppContext, accountId: string) {
  const bots = activityForAccount(ctx, accountId).map((b) => ({
    id: b.id,
    presence: b.presence,
    doing: b.doing,
  }));
  const row = getRunnerRow(ctx.db, accountId);
  if (!row || row.status === "revoked") {
    const runner = ctx.engine.runners.get(accountId);
    return {
      driver: "localhost",
      state: runner?.harness === "crashed" ? "unhealthy" : "running",
      harness: runner?.harness ?? "down",
      browser: runner?.browser ? "up" : "down",
      workspacePath: join(ctx.home, "desk"),
      uid: process.getuid?.() ?? -1,
      bots,
    };
  }
  const live = ctx.engine.remotes.get(accountId);
  const connected = Boolean(live?.connected);
  const connection =
    row.status === "pending" ? "pending" : connected ? "connected" : "disconnected";
  return {
    driver: row.machine_token_hash ? "runner" : "localhost",
    connection,
    state: connected ? (live?.harness === "crashed" ? "unhealthy" : "running") : "disconnected",
    harness: live?.harness ?? "down",
    browser: live?.browser ?? "down",
    workspacePath: live?.workspacePath || row.workspace_path || "",
    uid: live?.uid ?? -1,
    hostname: row.hostname,
    platform: row.platform,
    lastHeartbeatAt: row.last_heartbeat_at,
    runnerVersion: row.runner_version,
    bots,
  };
}

function wsBinary(data: unknown): Uint8Array | null {
  if (typeof data === "string") return null;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return data;
  return null;
}

export { websocketOf };

function websocketOf(created: ReturnType<typeof createApp>): unknown {
  return (created as { websocket?: unknown }).websocket;
}
