import type { Context, Hono } from "hono";
import { id, now, humanThread, type OpenbotDb } from "@openbot/db";
import {
  listApiKeys,
  mintApiKey,
  parseBearer,
  revokeApiKey,
  sessionFromBearer,
  type SessionInfo,
} from "@openbot/auth";
import { insertMessage } from "@openbot/live-work";

export type OpenAiCtx = {
  db: OpenbotDb;
  engine: { kick: () => void };
};

type SessionGate = (c: { req: { header: (n: string) => string | undefined } }) => SessionInfo;

class OpenAiError extends Error {
  constructor(
    public readonly httpStatus: 400 | 401 | 404 | 429,
    public readonly type: "invalid_request_error" | "authentication_error" | "not_found_error",
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "OpenAiError";
  }
}

type BotRow = {
  id: string;
  account_id: string;
  name: string;
  created_at: number;
};

const TURN_WAIT_MS = 120_000;
const TURN_POLL_MS = 50;

function applyCors(c: Context): void {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function corsPreflight(c: Context) {
  applyCors(c);
  return c.body(null, 204);
}

function openaiErrorBody(err: OpenAiError) {
  return { error: { message: err.message, type: err.type, code: err.code } };
}

function requireOpenAiAuth(c: Context, db: OpenbotDb): SessionInfo {
  const token = parseBearer(c.req.header("authorization"));
  if (!token) {
    throw new OpenAiError(401, "authentication_error", "Missing bearer token", "missing_api_key");
  }
  const s = sessionFromBearer(db, token);
  if (!s) {
    throw new OpenAiError(401, "authentication_error", "Invalid API key", "invalid_api_key");
  }
  return s;
}

function slugBotName(name: string): string {
  return name.trim().replace(/\s+/g, "-");
}

function listedModelId(name: string): string {
  return `openbot/${slugBotName(name)}`;
}

function resolveBot(db: OpenbotDb, accountId: string, model: string): BotRow | undefined {
  const requested = model.trim();
  if (!requested) return undefined;
  const rest = requested.replace(/^openbot\//i, "");
  const active = db.all<BotRow>(
    "SELECT id, account_id, name, created_at FROM bots WHERE account_id = ? AND status = 'active'",
    [accountId],
  );
  const lower = rest.toLowerCase();
  return active.find(
    (b) =>
      b.id === requested ||
      b.id === rest ||
      b.name.toLowerCase() === lower ||
      slugBotName(b.name).toLowerCase() === lower,
  );
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text: unknown }).text ?? "");
      }
      return "";
    })
    .join("");
}

function lastUserText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: unknown; content?: unknown };
    if (msg && msg.role === "user") return flattenContent(msg.content);
  }
  return null;
}

function enqueueUserTurn(
  db: OpenbotDb,
  thread: { id: string; bot_id: string },
  text: string,
): { turnId: string } | { error: "queue_full" } {
  const queued = db.get<{ n: number }>(
    "SELECT COUNT(*) as n FROM turns WHERE bot_id = ? AND status = 'queued'",
    [thread.bot_id],
  );
  if ((queued?.n ?? 0) >= 5) return { error: "queue_full" };
  const turnId = id();
  db.immediate(() => {
    const turnCreated = now();
    db.run(
      `INSERT INTO turns (id, thread_id, bot_id, status, sent_message_count, assistant_text, deadline_at, created_at)
       VALUES (?, ?, ?, 'queued', 0, '', ?, ?)`,
      [turnId, thread.id, thread.bot_id, turnCreated + 2 * 60 * 60 * 1000, turnCreated],
    );
    insertMessage(db, {
      threadId: thread.id,
      turnId,
      role: "user",
      origin: "user",
      body: text,
    });
  });
  return { turnId };
}

async function waitTurnDone(
  db: OpenbotDb,
  turnId: string,
  signal?: AbortSignal,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < TURN_WAIT_MS) {
    if (signal?.aborted) return;
    const turn = db.get<{ status: string }>("SELECT status FROM turns WHERE id = ?", [turnId]);
    if (turn && turn.status !== "queued" && turn.status !== "running") return;
    await Bun.sleep(TURN_POLL_MS);
  }
}

function assistantTextForTurn(db: OpenbotDb, turnId: string): string {
  const row = db.get<{ body: string }>(
    `SELECT body FROM messages
     WHERE turn_id = ?
       AND origin IN ('send_message', 'fallback', 'system')
       AND role IN ('assistant', 'system')
     ORDER BY created_at DESC
     LIMIT 1`,
    [turnId],
  );
  return row?.body ?? "";
}

function completionId(): string {
  return `chatcmpl-${id().replaceAll("-", "")}`;
}

function completionObject(params: { id: string; created: number; model: string; content: string }) {
  return {
    id: params.id,
    object: "chat.completion" as const,
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: params.content },
        finish_reason: "stop" as const,
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sseChunk(params: {
  id: string;
  created: number;
  model: string;
  delta: Record<string, unknown>;
  finish_reason: string | null;
}): string {
  return `data: ${JSON.stringify({
    id: params.id,
    object: "chat.completion.chunk",
    created: params.created,
    model: params.model,
    choices: [{ index: 0, delta: params.delta, finish_reason: params.finish_reason }],
  })}\n\n`;
}

async function handleModels(c: Context, ctx: OpenAiCtx) {
  applyCors(c);
  try {
    const s = requireOpenAiAuth(c, ctx.db);
    // GET /v1/bots hides Gateway in a sidecar; models must still list every active bot.
    const bots = ctx.db.all<BotRow>(
      "SELECT id, account_id, name, created_at FROM bots WHERE account_id = ? AND status = 'active' ORDER BY created_at",
      [s.accountId],
    );
    const data = bots.flatMap((b) => {
      const created = Math.floor(b.created_at / 1000);
      return [
        { id: listedModelId(b.name), object: "model" as const, created, owned_by: "openbot" },
        { id: b.id, object: "model" as const, created, owned_by: "openbot" },
      ];
    });
    return c.json({ object: "list", data });
  } catch (err) {
    if (err instanceof OpenAiError) return c.json(openaiErrorBody(err), err.httpStatus);
    throw err;
  }
}

async function handleChatCompletions(c: Context, ctx: OpenAiCtx) {
  applyCors(c);
  try {
    const s = requireOpenAiAuth(c, ctx.db);
    let body: {
      model?: unknown;
      messages?: unknown;
      stream?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      throw new OpenAiError(400, "invalid_request_error", "Invalid JSON body", "invalid_request");
    }
    const model = typeof body.model === "string" ? body.model : "";
    if (!model.trim()) {
      throw new OpenAiError(400, "invalid_request_error", "model is required", "invalid_request");
    }
    const prompt = lastUserText(body.messages);
    if (prompt === null) {
      throw new OpenAiError(400, "invalid_request_error", "messages must include a user message", "invalid_request");
    }
    const text = prompt.trim();
    if (!text) {
      throw new OpenAiError(400, "invalid_request_error", "user message is empty", "invalid_request");
    }
    const bot = resolveBot(ctx.db, s.accountId, model);
    if (!bot) {
      throw new OpenAiError(404, "not_found_error", `The model '${model}' does not exist`, "model_not_found");
    }
    const thread = humanThread(ctx.db, bot.id);
    if (!thread) {
      throw new OpenAiError(404, "not_found_error", "Bot has no human thread", "thread_not_found");
    }
    const queued = enqueueUserTurn(ctx.db, thread, text);
    if ("error" in queued) {
      throw new OpenAiError(429, "invalid_request_error", "Bot queue is full", "queue_full");
    }
    ctx.engine.kick();
    await waitTurnDone(ctx.db, queued.turnId, c.req.raw.signal);
    const content = assistantTextForTurn(ctx.db, queued.turnId);
    const created = Math.floor(now() / 1000);
    const chatId = completionId();
    const stream = body.stream === true;
    if (!stream) {
      return c.json(completionObject({ id: chatId, created, model, content }));
    }
    const encoder = new TextEncoder();
    const payload =
      sseChunk({ id: chatId, created, model, delta: { role: "assistant" }, finish_reason: null }) +
      sseChunk({ id: chatId, created, model, delta: { content }, finish_reason: null }) +
      sseChunk({ id: chatId, created, model, delta: {}, finish_reason: "stop" }) +
      "data: [DONE]\n\n";
    return new Response(encoder.encode(payload), {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "Authorization, Content-Type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      },
    });
  } catch (err) {
    if (err instanceof OpenAiError) return c.json(openaiErrorBody(err), err.httpStatus);
    throw err;
  }
}

export function mountOpenAiCompat(app: Hono, ctx: OpenAiCtx, requireSession: SessionGate): void {
  app.get("/v1/api-keys", (c) => {
    const s = requireSession(c);
    return c.json({ keys: listApiKeys(ctx.db, s.accountId) });
  });

  app.post("/v1/api-keys", async (c) => {
    const s = requireSession(c);
    let name: string | undefined;
    try {
      const body = await c.req.json();
      if (body && typeof body === "object" && typeof (body as { name?: unknown }).name === "string") {
        name = (body as { name: string }).name;
      }
    } catch {
      /* empty body is fine */
    }
    const minted = mintApiKey(ctx.db, s.accountId, name);
    return c.json(minted);
  });

  app.delete("/v1/api-keys/:id", (c) => {
    const s = requireSession(c);
    const ok = revokeApiKey(ctx.db, s.accountId, c.req.param("id"));
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  for (const prefix of ["/v1", "/openai/v1"]) {
    app.options(`${prefix}/models`, corsPreflight);
    app.options(`${prefix}/chat/completions`, corsPreflight);
    app.get(`${prefix}/models`, (c) => handleModels(c, ctx));
    app.post(`${prefix}/chat/completions`, (c) => handleChatCompletions(c, ctx));
  }
}
