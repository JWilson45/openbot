import {
  DefaultApplicationService,
  RuntimeCoordinator,
  type AgentTaskPort,
  type ConversationMessagePort,
  type ExternalIdentityPort,
  type ProtocolPrincipal,
  type RuntimeProvider,
} from "@openbot/application";
import { FilesystemAttachmentStore } from "@openbot/attachments";
import { parseBearer, parseCookie, sessionFromBearer, sessionFromToken } from "@openbot/auth";
import {
  ApplicationError,
  accountIdSchema,
  agentIdSchema,
  attachmentIdSchema,
  messageIdSchema,
  threadIdSchema,
  type AgentId,
  type Message,
  type Task,
  type ThreadId,
} from "@openbot/core";
import { OpenbotDb, SqliteApplicationStore, SqliteRunQueue, uuidIdGenerator } from "@openbot/db";
import { McpInflight, type McpHooks } from "@openbot/mcp-send-message";
import { createAgUiHandlers, type AgUiHandlers } from "@openbot/protocol-ag-ui";
import {
  A2A_RPC_PATH,
  A2A_VERSION,
  createA2AHandler,
  type CreateA2AHandlerOptions,
} from "@openbot/protocol-a2a";
import { createMcpActionHandler, type McpActionHandler } from "@openbot/protocol-mcp";
import { OpenbotActionPort } from "./protocol-actions.ts";
import { validateJsonSchema } from "./json-schema-validator.ts";
import { RuntimeProviderMap } from "./runtime.ts";

const MAX_MCP_BODY_BYTES = 1024 * 1024;
export const HUMAN_NOTIFICATION_OUTBOX_TOPIC = "human.notification.publish";

export type HumanNotificationIntent = {
  version: 1;
  accountId: string;
  agentId: string;
  legacyMessageId: string;
  legacyThreadId: string;
  body: string;
  createdAt: number;
};

/** Must be called in the same SQLite transaction that accepts the SendMessage. */
export function enqueueHumanNotification(db: OpenbotDb, input: HumanNotificationIntent): void {
  const accountId = accountIdSchema.parse(input.accountId);
  const agentId = agentIdSchema.parse(input.agentId);
  const legacyMessageId = messageIdSchema.parse(input.legacyMessageId);
  const legacyThreadId = threadIdSchema.parse(input.legacyThreadId);
  if (typeof input.body !== "string" || input.body.length === 0) {
    throw new ApplicationError("invalid_argument", "notification body is required");
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new ApplicationError("invalid_argument", "notification timestamp is invalid");
  }
  const payload: HumanNotificationIntent = {
    version: 1,
    accountId,
    agentId,
    legacyMessageId,
    legacyThreadId,
    body: input.body,
    createdAt: input.createdAt,
  };
  const outboxId = `${HUMAN_NOTIFICATION_OUTBOX_TOPIC}:${legacyMessageId}`;
  const encoded = JSON.stringify(payload);
  const existing = db.get<{ account_id: string; topic: string; payload_json: string }>(
    "SELECT account_id, topic, payload_json FROM application_outbox WHERE id = ?",
    [outboxId],
  );
  if (existing) {
    if (existing.account_id !== accountId || existing.topic !== HUMAN_NOTIFICATION_OUTBOX_TOPIC || existing.payload_json !== encoded) {
      throw new ApplicationError("conflict", "notification identity is already owned by another delivery");
    }
    return;
  }
  db.run(
    `INSERT INTO application_outbox
     (id, account_id, topic, payload_json, created_at, available_at, delivered_at, attempts)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`,
    [outboxId, accountId, HUMAN_NOTIFICATION_OUTBOX_TOPIC, encoded, input.createdAt, input.createdAt],
  );
}

export type ProtocolStack = {
  store: SqliteApplicationStore;
  tasks: AgentTaskPort;
  conversations: ConversationMessagePort;
  identities: ExternalIdentityPort;
  attachments: FilesystemAttachmentStore;
  mcp: McpActionHandler;
  agUi: AgUiHandlers;
  runtime: RuntimeCoordinator;
  fetchMcp(request: Request): Promise<Response>;
  fetchA2a(request: Request): Promise<Response>;
  fetchAgentConversation(request: Request, agentId: string): Promise<Response>;
  publishAgentNotification(input: {
    accountId: string;
    agentId: string;
    legacyMessageId: string;
    legacyThreadId: string;
    body: string;
    createdAt: number;
  }): Promise<Message>;
  processAgentNotifications(): Promise<number>;
  fetchAttachment(request: Request, attachmentId: string): Promise<Response>;
  close(): Promise<void>;
};

export type ProtocolStackOptions = {
  db: OpenbotDb;
  home: string;
  publicOrigin: string;
  signingKey: Uint8Array;
  inflight: McpInflight;
  mcpHooks: McpHooks;
  runtimeProviders: readonly RuntimeProvider[];
  onMcpResult?: (result: { status: number; json: unknown }) => void;
  onAgentConversationUpdated?: (event: { accountId: string; agentId: string; messageId: string }) => void;
  logError?: (error: Error) => void;
};

function userPrincipal(db: OpenbotDb, request: Request): ProtocolPrincipal {
  const cookie = parseCookie(request.headers.get("cookie") ?? undefined);
  const bearer = parseBearer(request.headers.get("authorization") ?? undefined);
  const session = sessionFromToken(db, cookie) ?? sessionFromToken(db, bearer);
  if (!session) throw new ApplicationError("unauthenticated", "authentication required");
  return {
    accountId: session.accountId as ProtocolPrincipal["accountId"],
    subjectId: `user:${session.userId}`,
    kind: "user",
    scopes: ["tasks:read", "tasks:write", "attachments"],
  };
}

function a2aPrincipal(db: OpenbotDb, request: Request): ProtocolPrincipal {
  if (request.headers.has("cookie")) {
    throw new ApplicationError("unauthenticated", "cookies are not accepted by A2A");
  }
  const session = sessionFromBearer(db, parseBearer(request.headers.get("authorization") ?? undefined));
  if (!session) throw new ApplicationError("unauthenticated", "valid bearer authentication is required");
  return {
    accountId: session.accountId as ProtocolPrincipal["accountId"],
    subjectId: `a2a:${session.sessionId}`,
    kind: "service",
    scopes: ["tasks:read", "tasks:write", "attachments"],
  };
}

function activeA2aAgent(db: OpenbotDb): { id: AgentId; name: string; description: string } | null {
  const row = db.get<{ id: string; name: string; description: string | null }>(
    `SELECT b.id, b.name, b.description
       FROM org_meta o
       JOIN bots b ON b.account_id = o.account_id
      WHERE o.id = 'current'
        AND IFNULL(b.role, 'desk') = 'gateway'
        AND b.status = 'active'
      ORDER BY b.created_at, b.id
      LIMIT 1`,
  );
  if (!row) return null;
  return {
    id: agentIdSchema.parse(row.id),
    name: row.name,
    description: row.description ?? "OpenBot organization gateway",
  };
}

function a2aCard(origin: URL, agent: { name: string; description: string }): CreateA2AHandlerOptions["agentCard"] {
  return {
    name: agent.name,
    description: agent.description,
    supportedInterfaces: [{
      url: new URL(A2A_RPC_PATH, origin).toString(),
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: A2A_VERSION,
    }],
    provider: undefined,
    version: "1.0.0",
    documentationUrl: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {
      bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            description: "OpenBot API key or user bearer token",
            scheme: "Bearer",
            bearerFormat: "opaque",
          },
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["text/plain", "application/json", "application/octet-stream"],
    defaultOutputModes: ["text/plain", "application/json", "application/octet-stream"],
    skills: [{
      id: "chat",
      name: "Organization gateway",
      description: "Send a task to this OpenBot organization's gateway agent",
      tags: ["chat", "agent-to-agent"],
      examples: ["Ask the organization gateway for help"],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    }],
    signatures: [],
    iconUrl: undefined,
  };
}

function resolveAgentId(db: OpenbotDb, request: Request, principal: ProtocolPrincipal): AgentId {
  const url = new URL(request.url);
  const value = request.headers.get("x-openbot-agent-id") ?? url.searchParams.get("agentId");
  if (!value) throw new ApplicationError("invalid_argument", "X-OpenBot-Agent-ID is required");
  const agentId = agentIdSchema.parse(value);
  const agent = db.get<{ id: string }>(
    "SELECT id FROM bots WHERE account_id = ? AND id = ? AND status = 'active' AND IFNULL(role, 'desk') = 'desk'",
    [principal.accountId, agentId],
  );
  if (!agent) throw new ApplicationError("not_found", "agent not found");
  return agentId;
}

function allowedMcpAuthority(request: Request, publicOrigin: URL): boolean {
  const host = (request.headers.get("host") ?? new URL(request.url).host).toLowerCase();
  const requestUrl = new URL(request.url);
  const localPort = requestUrl.port;
  const allowedHosts = new Set([
    publicOrigin.host.toLowerCase(),
    `127.0.0.1${localPort ? `:${localPort}` : ""}`,
    `localhost${localPort ? `:${localPort}` : ""}`,
    `[::1]${localPort ? `:${localPort}` : ""}`,
  ]);
  if (!allowedHosts.has(host)) return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.origin === publicOrigin.origin || ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function cappedRequest(request: Request, maximum: number): Promise<Request> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maximum) throw new ApplicationError("invalid_argument", "request body too large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximum) throw new ApplicationError("invalid_argument", "request body too large");
  return new Request(request, { body: bytes, signal: request.signal });
}

function attachmentHeaders(name: string | null): Headers {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (name) headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  return headers;
}

function browserMessageBody(message: Message): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.kind === "text") chunks.push(part.text);
    else if (part.kind === "data") chunks.push(JSON.stringify(part.data));
    else chunks.push(`[Attachment: ${part.attachment.name ?? part.attachment.mediaType}]`);
  }
  return chunks.join("\n").slice(0, 32_000);
}

function isAgUiTask(task: Task): boolean {
  return task.metadata["ag-ui.sdk-version"] === "0.0.59";
}

export function createProtocolStack(options: ProtocolStackOptions): ProtocolStack {
  const store = new SqliteApplicationStore(options.db);
  const tasks = new DefaultApplicationService({
    unitOfWork: store,
    eventLog: store,
    ids: uuidIdGenerator,
    clock: { now: Date.now },
    responseValidator: { validate: validateJsonSchema },
  });
  const publicOrigin = new URL(options.publicOrigin);
  const attachments = new FilesystemAttachmentStore({
    db: options.db,
    root: `${options.home}/attachments`,
    publicOrigin: publicOrigin.origin,
    signingKey: options.signingKey,
  });
  const actions = new OpenbotActionPort(
    options.db,
    options.inflight,
    options.mcpHooks,
    options.onMcpResult,
  );
  const mcp = createMcpActionHandler({
    actions,
    resolvePrincipal: (request) => actions.resolveMcpPrincipal(request),
    onerror: options.logError,
  });
  const agUi = createAgUiHandlers({
    tasks,
    identities: tasks,
    attachments,
    authenticate: (request) => userPrincipal(options.db, request),
    resolveAgentId: (request, _input, principal) => resolveAgentId(options.db, request, principal),
    resolveThreadId: async (_request, _input, principal, agentId) => {
      const legacy = options.db.get<{ id: string }>(
        "SELECT id FROM threads WHERE account_id = ? AND bot_id = ? AND kind = 'human' ORDER BY created_at, id LIMIT 1",
        [principal.accountId, agentId],
      );
      if (!legacy) throw new ApplicationError("not_found", "agent human conversation not found");
      const threadId = threadIdSchema.parse(legacy.id);
      await tasks.ensureConversation({
        principal,
        threadId,
        metadata: { "openbot.channel": "human", "openbot.agent-id": agentId },
      });
      return threadId;
    },
    namespace: publicOrigin.origin,
  });
  const runtime = new RuntimeCoordinator({
    unitOfWork: store,
    providers: new RuntimeProviderMap(options.runtimeProviders),
    actions,
    queue: new SqliteRunQueue(options.db),
    clock: { now: Date.now },
    ids: uuidIdGenerator,
  }, {
    workerId: `server:${crypto.randomUUID()}`,
    // The current Grok runner owns one mutable live-work stream. Serial claims
    // preserve that invariant while allowing other providers to scale later.
    claimLimit: 1,
    principalForWork: (work) => ({
      accountId: work.accountId,
      subjectId: work.kind === "execute" ? `agent:${work.agentId}:runtime` : "runtime:cancel",
      kind: "agent",
      scopes: ["actions:invoke"],
    }),
  });
  const runtimeAbort = new AbortController();
  let runtimeBusy = false;
  const pumpRuntime = (): void => {
    if (runtimeBusy || runtimeAbort.signal.aborted) return;
    runtimeBusy = true;
    void runtime.processOnce(runtimeAbort.signal)
      .catch((error) => options.logError?.(error instanceof Error ? error : new Error(String(error))))
      .finally(() => { runtimeBusy = false; });
  };
  const runtimeTimer = setInterval(pumpRuntime, 100);
  runtimeTimer.unref();
  queueMicrotask(pumpRuntime);

  const notificationWorkerId = `notification:${crypto.randomUUID()}`;
  let notificationBusy = false;
  const parseNotificationIntent = (raw: string, rowAccountId: string): HumanNotificationIntent => {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new ApplicationError("internal", "notification outbox payload is invalid JSON"); }
    if (!value || typeof value !== "object") throw new ApplicationError("internal", "notification outbox payload is invalid");
    const input = value as Record<string, unknown>;
    const accountId = accountIdSchema.parse(input.accountId);
    const body = input.body;
    const createdAt = input.createdAt;
    if (accountId !== accountIdSchema.parse(rowAccountId)) {
      throw new ApplicationError("internal", "notification outbox account identity is inconsistent");
    }
    if (input.version !== 1 || typeof body !== "string" || body.length === 0 ||
      !Number.isSafeInteger(createdAt) || (createdAt as number) < 0) {
      throw new ApplicationError("internal", "notification outbox payload is invalid");
    }
    return {
      version: 1,
      accountId,
      agentId: agentIdSchema.parse(input.agentId),
      legacyMessageId: messageIdSchema.parse(input.legacyMessageId),
      legacyThreadId: threadIdSchema.parse(input.legacyThreadId),
      body,
      createdAt: createdAt as number,
    };
  };

  const processAgentNotifications = async (): Promise<number> => {
    if (notificationBusy || runtimeAbort.signal.aborted) return 0;
    notificationBusy = true;
    let delivered = 0;
    try {
      while (!runtimeAbort.signal.aborted) {
        const claimedAt = Date.now();
        const row = options.db.immediate(() => {
          const candidate = options.db.get<{ id: string; account_id: string; payload_json: string; attempts: number }>(
            `SELECT id, account_id, payload_json, attempts FROM application_outbox
             WHERE topic = ? AND delivered_at IS NULL AND available_at <= ?
               AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
             ORDER BY created_at, id LIMIT 1`,
            [HUMAN_NOTIFICATION_OUTBOX_TOPIC, claimedAt, claimedAt],
          );
          if (!candidate) return null;
          options.db.run(
            `UPDATE application_outbox SET lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1
             WHERE id = ? AND delivered_at IS NULL`,
            [notificationWorkerId, claimedAt + 30_000, candidate.id],
          );
          return candidate;
        });
        if (!row) break;
        try {
          const intent = parseNotificationIntent(row.payload_json, row.account_id);
          const published = await protocolStack.publishAgentNotification(intent);
          options.db.run(
            `UPDATE application_outbox SET delivered_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
             WHERE id = ? AND lease_owner = ? AND delivered_at IS NULL`,
            [Date.now(), row.id, notificationWorkerId],
          );
          options.onAgentConversationUpdated?.({
            accountId: intent.accountId,
            agentId: intent.agentId,
            messageId: published.id,
          });
          delivered += 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const delay = Math.min(30_000, 250 * (2 ** Math.min(row.attempts, 7)));
          options.db.run(
            `UPDATE application_outbox SET available_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = ?
             WHERE id = ? AND lease_owner = ? AND delivered_at IS NULL`,
            [Date.now() + delay, reason.slice(0, 2_000), row.id, notificationWorkerId],
          );
          options.logError?.(error instanceof Error ? error : new Error(reason));
          break;
        }
      }
      return delivered;
    } finally {
      notificationBusy = false;
    }
  };
  const pumpNotifications = (): void => { void processAgentNotifications(); };
  const notificationTimer = setInterval(pumpNotifications, 100);
  notificationTimer.unref();
  queueMicrotask(pumpNotifications);

  const protocolStack: ProtocolStack = {
    store,
    tasks,
    conversations: tasks,
    identities: tasks,
    attachments,
    mcp,
    agUi,
    runtime,
    async fetchMcp(request): Promise<Response> {
      if (!allowedMcpAuthority(request, publicOrigin)) return new Response("Forbidden", { status: 403 });
      if (request.method !== "POST") return mcp.fetch(request);
      try {
        return await mcp.fetch(await cappedRequest(request, MAX_MCP_BODY_BYTES));
      } catch (error) {
        if (error instanceof ApplicationError && error.code === "invalid_argument") {
          return new Response("Request body too large", { status: 413 });
        }
        options.logError?.(error instanceof Error ? error : new Error(String(error)));
        return new Response("Internal server error", { status: 500 });
      }
    },
    async fetchA2a(request): Promise<Response> {
      const agent = activeA2aAgent(options.db);
      if (!agent) return new Response("A2A agent unavailable", { status: 503 });
      const handler = createA2AHandler({
        tasks,
        identities: tasks,
        attachments,
        agentId: agent.id,
        namespace: publicOrigin.origin,
        agentCard: a2aCard(publicOrigin, agent),
        resolvePrincipal: (incoming) => a2aPrincipal(options.db, incoming),
        onerror: options.logError,
      });
      return handler.fetch(request);
    },
    async fetchAgentConversation(request, rawAgentId): Promise<Response> {
      try {
        const principal = userPrincipal(options.db, request);
        const agentId = agentIdSchema.parse(rawAgentId);
        const agent = options.db.get<{ id: string }>(
          "SELECT id FROM bots WHERE account_id = ? AND id = ? AND status = 'active' AND IFNULL(role, 'desk') = 'desk'",
          [principal.accountId, agentId],
        );
        if (!agent) throw new ApplicationError("not_found", "agent not found");

        const legacy = options.db.get<{ id: string }>(
          "SELECT id FROM threads WHERE account_id = ? AND bot_id = ? AND kind = 'human' ORDER BY created_at, id LIMIT 1",
          [principal.accountId, agentId],
        );
        if (!legacy) throw new ApplicationError("not_found", "agent human conversation not found");
        const canonicalThreadId = threadIdSchema.parse(legacy.id);
        await tasks.ensureConversation({
          principal,
          threadId: canonicalThreadId,
          metadata: { "openbot.channel": "human", "openbot.agent-id": agentId },
        });
        const threadBinding = await tasks.getOrCreate(principal, {
          protocol: "ag-ui",
          namespace: publicOrigin.origin,
          kind: "thread",
          internalId: canonicalThreadId,
        });
        const page = await tasks.list({ principal, agentId, threadId: canonicalThreadId, limit: 100 });
        const taskItems = page.items.filter(isAgUiTask);
        const views = [];
        for (const task of taskItems) {
          const view = await tasks.get(principal, { taskId: task.id }, { historyLength: 200 });
          if (view) views.push(view);
        }
        const ordered = await tasks.listConversationMessages(principal, canonicalThreadId, 500);
        const messages = [];
        for (const message of ordered) {
          const binding = await tasks.getOrCreate(principal, {
            protocol: "ag-ui",
            namespace: publicOrigin.origin,
            kind: "message",
            internalId: message.id,
          });
          messages.push({
            id: binding.ref.externalId,
            role: message.role === "user" ? "user" : message.role === "tool" ? "tool" : "assistant",
            body: browserMessageBody(message),
            createdAt: message.createdAt,
          });
        }
        const pendingNotifications = options.db.all<{ id: string; body: string; created_at: number }>(
          `SELECT m.id, m.body, m.created_at FROM messages m
           JOIN threads th ON th.id = m.thread_id
           WHERE th.account_id = ? AND th.bot_id = ? AND th.kind = 'human'
             AND m.thread_id = ? AND m.from_bot_id = ? AND m.origin = 'pending_approval'
           ORDER BY m.created_at, m.id LIMIT 100`,
          [principal.accountId, agentId, legacy.id, agentId],
        ).map((message) => ({
          id: messageIdSchema.parse(message.id),
          body: message.body.slice(0, 32_000),
          createdAt: message.created_at,
        }));

        const activeView = views.find((view) =>
          ["submitted", "working", "input_required", "auth_required"].includes(view.task.status)
        );
        let active: null | Record<string, unknown> = null;
        if (activeView) {
          const run = activeView.runs.at(-1);
          const taskBinding = await tasks.getOrCreate(principal, {
            protocol: "ag-ui",
            namespace: publicOrigin.origin,
            kind: "task",
            internalId: activeView.task.id,
          });
          const runBinding = run
            ? await tasks.getOrCreate(principal, {
                protocol: "ag-ui",
                namespace: publicOrigin.origin,
                kind: "run",
                internalId: run.id,
              })
            : null;
          const interrupts = [];
          for (const interrupt of activeView.interrupts.filter((item) => item.status === "open")) {
            const binding = await tasks.getOrCreate(principal, {
              protocol: "ag-ui",
              namespace: publicOrigin.origin,
              kind: "interrupt",
              internalId: interrupt.id,
            });
            interrupts.push({
              id: binding.ref.externalId,
              reason: interrupt.kind,
              message: interrupt.prompt,
              responseSchema: interrupt.responseSchema,
            });
          }
          active = {
            taskId: taskBinding.ref.externalId,
            ...(runBinding ? { runId: runBinding.ref.externalId } : {}),
            status: activeView.task.status,
            lastSeq: activeView.lastSeq,
            interrupts,
          };
        }
        return Response.json({
          conversation: {
            threadId: threadBinding.ref.externalId,
            messages,
            pendingNotifications,
            active,
          },
        }, { headers: { "Cache-Control": "private, no-store" } });
      } catch (error) {
        if (error instanceof ApplicationError) {
          const status = error.code === "unauthenticated" ? 401
            : error.code === "forbidden" ? 403
              : error.code === "not_found" ? 404
                : 400;
          return Response.json({ error: { code: error.code, message: error.message } }, { status });
        }
        options.logError?.(error instanceof Error ? error : new Error(String(error)));
        return Response.json({ error: { code: "internal", message: "Internal server error" } }, { status: 500 });
      }
    },
    async publishAgentNotification(input): Promise<Message> {
      const accountId = accountIdSchema.parse(input.accountId);
      const agentId = agentIdSchema.parse(input.agentId);
      const principal = {
        accountId,
        subjectId: `agent:${agentId}:notification`,
        kind: "agent" as const,
        scopes: ["tasks:read", "tasks:write"],
      };
      const thread = options.db.get<{ id: string }>(
        `SELECT id FROM threads
         WHERE id = ? AND account_id = ? AND bot_id = ? AND kind = 'human'`,
        [input.legacyThreadId, accountId, agentId],
      );
      if (!thread) throw new ApplicationError("forbidden", "notification destination is not the agent's human conversation");
      const threadId: ThreadId = threadIdSchema.parse(thread.id);
      await tasks.ensureConversation({
        principal,
        threadId,
        metadata: { "openbot.channel": "human", "openbot.agent-id": agentId },
      });
      return tasks.publishAgentMessage({
        principal,
        agentId,
        threadId,
        messageId: messageIdSchema.parse(input.legacyMessageId),
        parts: [{ kind: "text", text: input.body }],
        createdAt: input.createdAt,
        metadata: {
          "openbot.delivery": "proactive",
          "openbot.legacy-message-id": input.legacyMessageId,
        },
      });
    },
    processAgentNotifications,
    async fetchAttachment(request, rawAttachmentId): Promise<Response> {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
      let attachmentId;
      try { attachmentId = attachmentIdSchema.parse(rawAttachmentId); } catch { return new Response("Not found", { status: 404 }); }
      const url = new URL(request.url);
      const accountId = url.searchParams.get("account") ?? "";
      const expiresAt = Number(url.searchParams.get("expires"));
      const signature = url.searchParams.get("sig") ?? "";
      if (!attachments.verifyDownload(attachmentId, accountId, expiresAt, signature)) {
        return new Response("Forbidden", { status: 403 });
      }
      const principal = {
        accountId: accountId as ProtocolPrincipal["accountId"],
        subjectId: "signed-attachment-url",
        kind: "service" as const,
        scopes: ["attachments"],
      };
      try {
        const opened = await attachments.open(principal, attachmentId, request.signal);
        const headers = attachmentHeaders(opened.attachment.name);
        headers.set("Content-Type", opened.attachment.mediaType);
        headers.set("Content-Length", String(opened.attachment.size));
        return new Response(opened.body, { status: 200, headers });
      } catch (error) {
        return new Response(error instanceof ApplicationError && error.code === "not_found" ? "Not found" : "Unavailable", {
          status: error instanceof ApplicationError && error.code === "not_found" ? 404 : 503,
        });
      }
    },
    async close(): Promise<void> {
      runtimeAbort.abort("protocol stack closing");
      clearInterval(runtimeTimer);
      clearInterval(notificationTimer);
      await runtime.shutdown();
      await mcp.close();
    },
  };
  return protocolStack;
}
