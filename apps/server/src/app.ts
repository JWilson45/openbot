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
  id,
  now,
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
import { approveMessage, handleMcpJsonRpc, McpInflight, rejectMessage } from "@openbot/mcp-send-message";
import { McpError, addThreadParticipantInput, createGroupThreadInput } from "@openbot/api-types";
import { insertMessage, parseLivePayload, promote, summarizeLiveEvent } from "@openbot/live-work";
import { sha256Hex } from "@openbot/db";
import { detectCliLogins, listGrokModels, resolveBotInference } from "@openbot/acp-grok";
import { SPA_HTML } from "./spa.ts";
import { TurnEngine } from "./engine.ts";
import { mountOpenAiCompat } from "./openai.ts";
import {
  clientRateKey,
  currentOrgMeta,
  ensureOrgMeta,
  fedInfoPayload,
  FED_INFO_RATE_LIMIT,
  FED_INFO_RATE_WINDOW_MS,
  orgMemberSnapshot,
  SlidingWindowRateLimiter,
} from "./org.ts";

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

const GROUP_MENTION_CAP = 3;
const VISIBLE_MESSAGES_SQL =
  "SELECT * FROM messages WHERE thread_id = ? AND origin != 'prompt' ORDER BY created_at";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseGroupMentions<T extends { name: string }>(
  body: string,
  members: T[],
): { mentioned: T[]; truncated: boolean } {
  const hits: { member: T; index: number }[] = [];
  for (const member of members) {
    if (!member.name || /\s/.test(member.name)) continue;
    const match = new RegExp(`(?:^|\\s)@${escapeRegExp(member.name)}\\b`, "i").exec(body);
    if (match) hits.push({ member, index: match.index });
  }
  hits.sort((a, b) => a.index - b.index);
  return {
    mentioned: hits.slice(0, GROUP_MENTION_CAP).map((h) => h.member),
    truncated: hits.length > GROUP_MENTION_CAP,
  };
}

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
  const master = loadOrCreateMasterKey(cfg.home, process.env.OPENBOT_MASTER_KEY);
  const allowlist = loadAllowlist(cfg.home, process.env.OPENBOT_GITHUB_ALLOWLIST);
  const log = cfg.logger ?? new RedactingLogger();
  const inflight = new McpInflight();
  const push = new Map<string, Set<ServerWebSocket>>();
  const fedInfoLimiter = new SlidingWindowRateLimiter(FED_INFO_RATE_LIMIT, FED_INFO_RATE_WINDOW_MS);

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
      if (ev.type === "message.created" && ev.message?.origin === "prompt") return;
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
  ctx.maintenanceTimer = setInterval(() => ctx.engine.maintenance(), 30_000);
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
    if (err instanceof McpError) {
      const status = err.httpStatus as 401;
      return c.json({ error: err.code, message: err.message }, status);
    }
    throw err;
  });

  function requireSession(c: { req: { header: (n: string) => string | undefined } }): SessionInfo {
    const s =
      sessionFromToken(db, cookies(c)) ?? sessionFromToken(db, parseBearer(c.req.header("authorization")));
    if (!s) throw new McpError("unauthorized", "unauthorized", 401);
    return s;
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

  app.get("/fed/v1/info", (c) => {
    const key = clientRateKey(bunRequestIp(c.env, c.req.raw), c.req.header("x-forwarded-for"));
    if (!fedInfoLimiter.take(key)) return c.json({ error: "rate_limited" }, 429);
    const row = currentOrgMeta(db);
    if (!row) return c.json({ error: "no_org" }, 500);
    return c.json(fedInfoPayload(row));
  });

  app.get("/", (c) => c.html(SPA_HTML));

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
      return c.json({
        githubLogin: s.githubLogin,
        accountId: s.accountId,
        userId: s.userId,
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

  app.post("/v1/bots", async (c) => {
    const s = requireSession(c);
    const body = await c.req.json();
    const name = String(body.name ?? "").trim();
    const description = String(body.description ?? "");
    if (!name) return c.json({ error: "name required" }, 400);
    const normalized = name.trim();
    const active = db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM bots WHERE account_id = ? AND status = 'active'",
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
    runner.ensureProject(botId, normalized);
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
    ctx.engine.purgeExpiredArchives(s.accountId);
    const bots = db.all("SELECT * FROM bots WHERE account_id = ? AND status = 'active' ORDER BY created_at", [
      s.accountId,
    ]);
    const archived = db.all(
      "SELECT * FROM bots WHERE account_id = ? AND status = 'archived' ORDER BY archived_at DESC",
      [s.accountId],
    );
    return c.json({
      bots: bots.map((b) => ({ ...(b as object), presence: botPresence(ctx, (b as { id: string }).id) })),
      archived,
      bot: bots[0] ?? null,
      archiveTtlMs: ARCHIVE_TTL_MS,
    });
  });

  app.post("/v1/bots/:id/archive", (c) => {
    const s = requireSession(c);
    const bot = db.get<{ id: string; name: string; status: string }>(
      "SELECT id, name, status FROM bots WHERE id = ? AND account_id = ?",
      [c.req.param("id"), s.accountId],
    );
    if (!bot) return c.json({ error: "not_found" }, 404);
    if (bot.status !== "active") return c.json({ error: "not_active" }, 409);
    const t = now();
    db.run("UPDATE bots SET status = 'archived', archived_at = ? WHERE id = ?", [t, bot.id]);
    db.run(
      "UPDATE turns SET status = 'cancelled', finished_at = ? WHERE bot_id = ? AND status IN ('queued', 'running')",
      [t, bot.id],
    );
    const runner = ctx.engine.runnerFor(s.accountId);
    void runner.acpFor(bot.id)?.kill();
    return c.json({ ok: true, archivedAt: t, deleteAfter: t + ARCHIVE_TTL_MS });
  });

  app.post("/v1/bots/:id/restore", (c) => {
    const s = requireSession(c);
    ctx.engine.purgeExpiredArchives(s.accountId);
    const bot = db.get<{ id: string; name: string; status: string }>(
      "SELECT id, name, status FROM bots WHERE id = ? AND account_id = ?",
      [c.req.param("id"), s.accountId],
    );
    if (!bot) return c.json({ error: "not_found" }, 404);
    if (bot.status !== "archived") return c.json({ error: "not_archived" }, 409);
    const active = db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM bots WHERE account_id = ? AND status = 'active'",
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
    const bot = db.get<{ id: string; status: string }>(
      "SELECT id, status FROM bots WHERE id = ? AND account_id = ?",
      [c.req.param("id"), accountId],
    );
    if (!bot) return { status: 404 as const, json: { error: "not_found" } };
    if (bot.status !== "archived") return { status: 409 as const, json: { error: "archive_first" } };
    void ctx.engine.runnerFor(accountId).acpFor(bot.id)?.kill();
    deleteBotPermanently(db, bot.id);
    try {
      ctx.engine.runnerFor(accountId).deleteProject(bot.id);
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
    const bot = db.get<{ id: string }>("SELECT id FROM bots WHERE id = ? AND account_id = ?", [
      c.req.param("id"),
      s.accountId,
    ]);
    if (!bot) return c.json({ error: "not_found" }, 404);
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
    }>("SELECT id, model, reasoning_effort FROM bots WHERE id = ? AND account_id = ?", [
      c.req.param("id"),
      s.accountId,
    ]);
    if (!bot) return c.json({ error: "not_found" }, 404);
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
      if (changed) ctx.engine.runnerFor(s.accountId).invalidateAcp(bot.id);
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
          "SELECT * FROM threads WHERE account_id = ? AND IFNULL(kind,'human') = 'human' ORDER BY created_at LIMIT 1",
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
    const remaining = db.all<{ id: string; bot_id: string | null }>(
      "SELECT id, bot_id FROM thread_participants WHERE thread_id = ? AND id != ?",
      [thread.id, participant.id],
    );
    const remainingBots = remaining.filter((p) => p.bot_id);
    if (remainingBots.length === 0 || !groupMeetsMinimum(remainingBots.length, remaining.length)) {
      return { error: "too_small" };
    }
    db.immediate(() => {
      if (participant.bot_id && participant.bot_id === thread.bot_id) {
        db.run("UPDATE threads SET bot_id = ? WHERE id = ?", [remainingBots[0]!.bot_id, thread.id]);
      }
      db.run("DELETE FROM thread_participants WHERE id = ?", [participant.id]);
    });
    return { ok: true };
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
        const raw = (await c.req.json()) as { body?: string };
        const text = String(raw.body ?? "").trim();
        if (!text) return c.json({ error: "empty" }, 400);
        const posted = db.immediate(() => {
          const userMessage = insertMessage(db, {
            threadId: thread.id,
            turnId: null,
            role: "user",
            origin: "user",
            body: text,
          });
          const members = db.all<{ id: string; name: string }>(
            `SELECT b.id, b.name FROM thread_participants tp
             JOIN bots b ON b.id = tp.bot_id
             WHERE tp.thread_id = ? AND tp.bot_id IS NOT NULL AND b.status = 'active'`,
            [thread.id],
          );
          const { mentioned, truncated } = parseGroupMentions(text, members);
          const turnIds: string[] = [];
          for (const bot of mentioned) {
            const queued = db.get<{ n: number }>(
              "SELECT COUNT(*) as n FROM turns WHERE bot_id = ? AND status = 'queued'",
              [bot.id],
            );
            if ((queued?.n ?? 0) >= 5) continue;
            const turnId = id();
            const t = now();
            db.run(
              `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, deadline_at, created_at)
               VALUES (?, ?, ?, 'queued', 0, '', ?, ?)`,
              [turnId, thread.id, bot.id, t + 2 * 60 * 60 * 1000, t],
            );
            insertMessage(db, {
              threadId: thread.id,
              turnId,
              role: "user",
              origin: "prompt",
              body: `You were @mentioned in ${thread.title}.\n${text}`,
            });
            turnIds.push(turnId);
          }
          return {
            userMessageId: userMessage.id,
            turnIds,
            mentioned: mentioned.map((m) => m.name),
            mentionedTruncated: truncated,
          };
        });
        if (posted.turnIds.length) ctx.engine.kick();
        return c.json(
          {
            turnIds: posted.turnIds,
            mentioned: posted.mentioned,
            userMessageId: posted.userMessageId,
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

  app.post("/v1/turns/:id/cancel", (c) => {
    const s = requireSession(c);
    const turn = db.get<TurnRow>(
      `SELECT t.* FROM turns t JOIN threads th ON th.id = t.thread_id
       WHERE t.id = ? AND th.account_id = ?`,
      [c.req.param("id"), s.accountId],
    );
    if (!turn) return c.json({ error: "not_found" }, 404);
    if (turn.status === "running") {
      void ctx.engine.runnerFor(s.accountId).acpFor(turn.bot_id)?.cancel();
      promote(db, turn.id, { kind: "cancel" });
    } else if (turn.status === "queued") {
      db.run("UPDATE turns SET status = 'cancelled', finished_at = ? WHERE id = ?", [now(), turn.id]);
    }
    return c.json({ ok: true });
  });

  app.post("/v1/turns/:id/permissions/:reqId", async (c) => {
    const s = requireSession(c);
    const body = await c.req.json();
    const allow = Boolean(body.allow);
    const ok = ctx.engine.runnerFor(s.accountId).respondPermission(c.req.param("reqId"), allow);
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
    await ctx.engine.runnerFor(s.accountId).takeoverUrl();
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
      const result = handleMcpJsonRpc(db, inflight, bearer, body, { onKick: () => ctx.engine.kick() });
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
    "/v1/takeover",
    upgradeWebSocket((c) => {
      let authed = false;
      let accountId: string | null = null;
      return {
        onMessage(evt, ws) {
          const data = typeof evt.data === "string" ? evt.data : "";
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
              const runner = ctx.engine.runnerFor(accountId);
              void (async () => {
                try {
                  await runner.ensureBrowser();
                  const d = await runner.display();
                  ws.send(
                    JSON.stringify({
                      type: "meta",
                      pageUrl: d.pageUrl,
                      pageOrigin: d.pageOrigin,
                      viewport: runner.browser?.viewport,
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
                          }),
                        );
                      }
                      const raw = (ws as { raw?: ServerWebSocket }).raw;
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
              const msg = JSON.parse(data) as Record<string, unknown>;
              void ctx.engine.runnerFor(accountId).dispatchInput(msg);
            } catch {
              /* ignore */
            }
          }
        },
        onClose() {
          if (accountId) ctx.engine.runnerFor(accountId).stopTakeover();
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
  for (const runner of ctx.engine.runners.values()) {
    const acp = runner.acpFor(botId);
    if (acp && !acp.closed) return { key: "idle", label: "Dormant" };
  }
  return { key: "idle", label: "Dormant" };
}

function activityForAccount(ctx: AppContext, accountId: string) {
  const bots = ctx.db.all<{ id: string; name: string }>(
    "SELECT id, name FROM bots WHERE account_id = ? AND status = 'active' ORDER BY created_at",
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
          "SELECT role, body, created_at FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
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

function healthPayload(ctx: AppContext, accountId: string) {
  const runner = ctx.engine.runners.get(accountId);
  const bots = ctx.db.all<{ id: string }>(
    "SELECT id FROM bots WHERE account_id = ? AND status = 'active'",
    [accountId],
  );
  return {
    driver: "localhost",
    state: runner?.harness === "crashed" ? "unhealthy" : "running",
    harness: runner?.harness ?? "down",
    browser: runner?.browser ? "up" : "down",
    workspacePath: join(ctx.home, "desk"),
    uid: process.getuid?.() ?? -1,
    bots: activityForAccount(ctx, accountId).map((b) => ({
      id: b.id,
      presence: b.presence,
      doing: b.doing,
    })),
  };
}

export { websocketOf };

function websocketOf(created: ReturnType<typeof createApp>): unknown {
  return (created as { websocket?: unknown }).websocket;
}
