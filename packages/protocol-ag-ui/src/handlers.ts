import { EventSchemas, EventType, RunAgentInputSchema, type AGUIEvent, type RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import type {
  ContinueTaskCommand,
  ExternalEntityRef,
  ProtocolPrincipal,
  ResumeTaskCommand,
  TaskRef,
} from "@openbot/application";
import { isApplicationError, type JsonValue, type TaskEventEnvelope } from "@openbot/core";
import { AgUiIdentityMap, agUiExternalRef } from "./identity.ts";
import {
  assertSupportedRunInput,
  isProtocolJsonValue,
  newestActionableMessage,
  readOpenBotForwardedProps,
  toTaskInputMessage,
} from "./input.ts";
import { AgUiEventMapper } from "./mapper.ts";
import {
  AG_UI_SDK_VERSION,
  AgUiAdapterError,
  OPENBOT_AG_UI_CANCEL_EXTENSION,
  OPENBOT_AG_UI_REPLAY_EXTENSION,
  resolveAgUiDependencies,
  type AgUiHandlerDependencies,
  type ResolvedAgUiHandlerDependencies,
} from "./types.ts";

export const AG_UI_RUN_PATH = "/ag-ui/v1/run" as const;

export type AgUiHandlers = {
  run(request: Request): Promise<Response>;
  replay(request: Request): Promise<Response>;
  cancel(request: Request): Promise<Response>;
  fetch(request: Request): Promise<Response>;
};

type PreparedRun = {
  principal: ProtocolPrincipal;
  identities: AgUiIdentityMap;
  input: RunAgentInput;
  task: TaskRef;
  afterSeq: number;
};

/** Creates framework-independent handlers suitable for Bun, Node, Deno, or edge routing. */
export function createAgUiHandlers(dependencies: AgUiHandlerDependencies): AgUiHandlers {
  const resolved = resolveAgUiDependencies(dependencies);
  let openResponses = 0;

  const run = async (request: Request): Promise<Response> => {
    try {
      assertMethod(request, "POST");
      assertJsonContentType(request);
      assertSseAccept(request);
      const input = await parseRunInput(request, resolved);
      assertSupportedRunInput(input);
      const prepared = await prepareRun(request, input, resolved);
      const mapper = new AgUiEventMapper({
        principal: prepared.principal,
        identities: prepared.identities,
        attachments: resolved.attachments,
        limits: resolved.limits,
        now: resolved.now,
        afterSeq: prepared.afterSeq,
        expectedThreadId: input.threadId,
        expectedRunId: input.runId,
        parentRunId: input.parentRunId,
      });
      const detached = new AbortController();
      const source = resolved.tasks.subscribe(
        prepared.principal,
        prepared.task,
        prepared.afterSeq,
        detached.signal,
      );
      return streamResponse(source, mapper, [], detached, resolved, () => openResponses, (v) => {
        openResponses = v;
      });
    } catch (error) {
      return errorResponse(error);
    }
  };

  const replay = async (request: Request): Promise<Response> => {
    try {
      assertMethod(request, "GET");
      assertSseAccept(request);
      const principal = await resolved.authenticate(request);
      const url = new URL(request.url);
      const runId = replayRunId(url);
      const afterSeq = nonNegativeIntegerQuery(url, "after", 0);
      const identities = new AgUiIdentityMap(resolved.identities, principal, resolved.namespace);
      const runBinding = await identities.resolve("run", runId);
      if (runBinding === null) throw new AgUiAdapterError("run_not_found", "Run was not found", 404);
      const task = { externalRef: identities.ref("run", runId) } as const;
      const view = await resolved.tasks.get(principal, task, { historyLength: 500 });
      if (view === null) throw new AgUiAdapterError("run_not_found", "Run was not found", 404);
      if (afterSeq > view.lastSeq) {
        throw new AgUiAdapterError("cursor_ahead", "Replay cursor is ahead of the task log", 409);
      }
      const mapper = new AgUiEventMapper({
        principal,
        identities,
        attachments: resolved.attachments,
        limits: resolved.limits,
        now: resolved.now,
        afterSeq: 0,
        expectedRunId: runId,
        targetRunInternalId: runBinding.internalId,
      });
      const detached = new AbortController();
      // Prime the mapper from sequence zero, but emit only committed mappings
      // after the caller's cursor. This preserves event-boundary state without
      // inventing snapshots or success events.
      const source = resolved.tasks.subscribe(principal, task, 0, detached.signal);
      return streamResponse(
        source,
        mapper,
        [],
        detached,
        resolved,
        () => openResponses,
        (v) => {
          openResponses = v;
        },
        replayHeaders(afterSeq),
        afterSeq,
      );
    } catch (error) {
      return errorResponse(error, {
        "X-OpenBot-Extension": OPENBOT_AG_UI_REPLAY_EXTENSION,
      });
    }
  };

  const cancel = async (request: Request): Promise<Response> => {
    try {
      assertMethod(request, "DELETE");
      const principal = await resolved.authenticate(request);
      const url = new URL(request.url);
      const runId = cancelRunId(url);
      const reason = optionalBoundedQuery(url, "reason", 2_000);
      const identities = new AgUiIdentityMap(resolved.identities, principal, resolved.namespace);
      const runBinding = await identities.resolve("run", runId);
      if (runBinding === null) throw new AgUiAdapterError("run_not_found", "Run was not found", 404);
      const task = { externalRef: identities.ref("run", runId) } as const;
      const before = await resolved.tasks.get(principal, task, { historyLength: 0 });
      if (before === null) throw new AgUiAdapterError("run_not_found", "Run was not found", 404);
      const selected = before.runs.find((candidate) => candidate.id === runBinding.internalId);
      const current = [...before.runs].sort((left, right) => right.attempt - left.attempt)[0];
      if (selected === undefined || current === undefined || selected.id !== current.id) {
        throw new AgUiAdapterError("run_not_current", "Only the task's current run can be cancelled", 409);
      }
      const view = await resolved.tasks.cancel(principal, task, reason);
      const externalTaskId = await identities.externalId({
        protocol: "ag-ui",
        namespace: identities.namespace,
        kind: "task",
        internalId: view.task.id,
      });
      return jsonResponse(
        { taskId: externalTaskId, runId, status: view.task.status },
        200,
        { "X-OpenBot-Extension": OPENBOT_AG_UI_CANCEL_EXTENSION },
      );
    } catch (error) {
      return errorResponse(error, {
        "X-OpenBot-Extension": OPENBOT_AG_UI_CANCEL_EXTENSION,
      });
    }
  };

  const fetch = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    if (pathname === AG_UI_RUN_PATH && request.method === "POST") return run(request);
    if (isReplayPath(pathname) && request.method === "GET") return replay(request);
    if (isCancelPath(pathname) && request.method === "DELETE") return cancel(request);
    if (pathname !== AG_UI_RUN_PATH && !isReplayPath(pathname) && !isCancelPath(pathname)) {
      return jsonResponse({ error: { code: "not_found", message: "Route not found" } }, 404);
    }
    return jsonResponse(
      { error: { code: "method_not_allowed", message: "Method not allowed" } },
      405,
      { Allow: "POST, GET, DELETE" },
    );
  };

  return { run, replay, cancel, fetch };
}

export function createAgUiHandler(
  dependencies: AgUiHandlerDependencies,
): (request: Request) => Promise<Response> {
  return createAgUiHandlers(dependencies).fetch;
}

async function prepareRun(
  request: Request,
  input: RunAgentInput,
  dependencies: ResolvedAgUiHandlerDependencies,
): Promise<PreparedRun> {
  const principal = await dependencies.authenticate(request);
  const agentId = await dependencies.resolveAgentId(request, input, principal);
  const threadId = await dependencies.resolveThreadId?.(request, input, principal, agentId);
  const identities = new AgUiIdentityMap(dependencies.identities, principal, dependencies.namespace);
  const extension = readOpenBotForwardedProps(input.forwardedProps);
  const latest = newestActionableMessage(input.messages);

  if (extension.taskId === undefined) {
    if (input.resume !== undefined && input.resume.length > 0) {
      throw new AgUiAdapterError(
        "task_id_required",
        "Resuming an interrupt requires forwardedProps.openbot.taskId",
        400,
      );
    }
    if (latest === null) {
      throw new AgUiAdapterError("message_required", "A new run requires a user or tool message", 400);
    }
    if (latest.role === "tool") {
      throw new AgUiAdapterError(
        "task_id_required",
        "A tool result requires forwardedProps.openbot.taskId",
        400,
      );
    }
    const message = await toTaskInputMessage(latest, {
      principal,
      identities,
      attachments: dependencies.attachments,
      limits: dependencies.limits,
      signal: request.signal,
    });
    const taskExternalId = input.runId;
    const view = await dependencies.tasks.submit({
      principal,
      agentId,
      ...(threadId === undefined ? {} : { threadId }),
      externalRefs: {
        thread: identities.ref("thread", input.threadId),
        task: identities.ref("task", taskExternalId),
        run: identities.ref("run", input.runId),
        message: identities.ref("message", latest.id),
      },
      message,
      idempotencyKey: input.runId,
      metadata: { "openbot.protocol": "ag-ui", "ag-ui.sdk-version": AG_UI_SDK_VERSION },
    });
    return {
      principal,
      identities,
      input,
      task: { taskId: view.task.id },
      afterSeq: 0,
    };
  }

  const task = { externalRef: identities.ref("task", extension.taskId) } as const;
  const before = await dependencies.tasks.get(principal, task, { historyLength: 1 });
  if (before === null) throw new AgUiAdapterError("task_not_found", "Task was not found", 404);
  const responses = resumeEntries(input, identities);
  let message: Awaited<ReturnType<typeof toTaskInputMessage>> | undefined;
  let externalMessage: (ExternalEntityRef & { kind: "message" }) | undefined;
  if (latest !== null) {
    const existing = await identities.resolve("message", latest.id);
    if (existing === null) {
      message = await toTaskInputMessage(latest, {
        principal,
        identities,
        attachments: dependencies.attachments,
        limits: dependencies.limits,
        signal: request.signal,
      });
      externalMessage = identities.ref("message", latest.id);
    }
  }
  if (responses.length === 0 && message === undefined) {
    throw new AgUiAdapterError(
      "resume_input_required",
      "Continuation requires a new user/tool message or interrupt response",
      409,
    );
  }
  if (responses.length === 0) {
    if (message === undefined) {
      throw new AgUiAdapterError("continuation_message_required", "Continuation requires a new message", 409);
    }
    const command: ContinueTaskCommand = {
      principal,
      task,
      externalRun: identities.ref("run", input.runId),
      ...(externalMessage === undefined ? {} : { externalMessage }),
      message,
      idempotencyKey: input.runId,
    };
    await dependencies.tasks.continue(command);
  } else {
    const command: ResumeTaskCommand = {
      principal,
      task,
      externalRun: identities.ref("run", input.runId),
      ...(externalMessage === undefined ? {} : { externalMessage }),
      responses,
      ...(message === undefined ? {} : { message }),
      idempotencyKey: input.runId,
    };
    await dependencies.tasks.resume(command);
  }
  return { principal, identities, input, task, afterSeq: before.lastSeq };
}

function resumeEntries(
  input: RunAgentInput,
  identities: AgUiIdentityMap,
): ResumeTaskCommand["responses"] {
  return (input.resume ?? []).map((entry) => {
    if (entry.payload !== undefined && !isProtocolJsonValue(entry.payload)) {
      throw new AgUiAdapterError(
        "invalid_interrupt_response",
        "Interrupt response must be a JSON value",
        400,
      );
    }
    return {
      interrupt: { externalRef: identities.ref("interrupt", entry.interruptId) },
      status: entry.status === "cancelled" ? ("canceled" as const) : ("resolved" as const),
      ...(entry.payload === undefined ? {} : { response: entry.payload as JsonValue }),
    };
  });
}

async function parseRunInput(
  request: Request,
  dependencies: ResolvedAgUiHandlerDependencies,
): Promise<RunAgentInput> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new AgUiAdapterError("invalid_content_length", "Content-Length is invalid", 400);
    }
    if (bytes > dependencies.limits.maxRequestBytes) {
      throw new AgUiAdapterError("request_too_large", "AG-UI request exceeds the configured limit", 413);
    }
  }
  if (request.body === null) throw new AgUiAdapterError("body_required", "Request body is required", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > dependencies.limits.maxRequestBytes) {
        await reader.cancel("Request too large").catch(() => undefined);
        throw new AgUiAdapterError("request_too_large", "AG-UI request exceeds the configured limit", 413);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (cause) {
    throw new AgUiAdapterError("invalid_json", "Request body must be valid UTF-8 JSON", 400, { cause });
  }
  const parsed = RunAgentInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgUiAdapterError("invalid_run_input", "Request does not match RunAgentInput", 400, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function streamResponse(
  source: AsyncIterable<TaskEventEnvelope> | null,
  mapper: AgUiEventMapper | null,
  prefix: readonly AGUIEvent[],
  detached: AbortController,
  dependencies: ResolvedAgUiHandlerDependencies,
  getOpenResponses: () => number,
  setOpenResponses: (value: number) => void,
  extraHeaders: HeadersInit = {},
  emitAfterSeq = 0,
): Response {
  if (getOpenResponses() >= dependencies.limits.maxOpenStreams) {
    throw new AgUiAdapterError("too_many_streams", "Too many concurrent AG-UI streams", 429);
  }
  setOpenResponses(getOpenResponses() + 1);
  const encoder = new EventEncoder();
  const textEncoder = new TextEncoder();
  let iterator: AsyncIterator<TaskEventEnvelope> | undefined;
  let settled = false;
  let cancelled = false;

  const finish = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    setOpenResponses(Math.max(0, getOpenResponses() - 1));
    if (iterator?.return !== undefined) await iterator.return().catch(() => undefined);
  };
  const enqueue = (controller: ReadableStreamDefaultController<Uint8Array>, event: AGUIEvent): void => {
    const parsed = EventSchemas.parse(event);
    if (parsed.type === EventType.RAW || parsed.rawEvent !== undefined) {
      throw new AgUiAdapterError("raw_event_forbidden", "RAW events cannot cross the AG-UI boundary", 500);
    }
    const frame = textEncoder.encode(encoder.encode(parsed));
    if (frame.byteLength > dependencies.limits.maxEventBytes) {
      throw new AgUiAdapterError("event_too_large", "Encoded AG-UI event exceeds the configured limit", 500);
    }
    controller.enqueue(frame);
  };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const event of prefix) enqueue(controller, event);
        if (prefix.some(isTerminalAgUiEvent) || source === null || mapper === null) {
          controller.close();
          await finish();
          return;
        }
        iterator = source[Symbol.asyncIterator]();
        while (!cancelled) {
          const next = await iterator.next();
          if (next.done) {
            for (const event of mapper.endOfStream()) enqueue(controller, event);
            controller.close();
            await finish();
            return;
          }
          const events = await mapper.map(next.value);
          if (next.value.seq > emitAfterSeq) {
            for (const event of events) enqueue(controller, event);
          }
          if (mapper.terminal) {
            controller.close();
            await finish();
            return;
          }
        }
      } catch (error) {
        if (!cancelled) {
          try {
            if (mapper !== null) {
              const code = error instanceof AgUiAdapterError ? error.code : "upstream_stream_error";
              const message =
                error instanceof AgUiAdapterError ? error.message : "The AG-UI event stream failed";
              for (const event of mapper.abortWithError(code, message)) enqueue(controller, event);
            }
            controller.close();
          } catch (terminalError) {
            controller.error(terminalError);
          }
        }
        await finish();
      }
    },
    async cancel() {
      cancelled = true;
      detached.abort("AG-UI consumer detached");
      await finish();
    },
  });
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", encoder.getContentType());
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Accel-Buffering", "no");
  return new Response(body, { status: 200, headers });
}

function replayHeaders(cursor: number): HeadersInit {
  return {
    "X-OpenBot-Extension": OPENBOT_AG_UI_REPLAY_EXTENSION,
    "X-OpenBot-Replay-Mode": "event-log",
    "X-OpenBot-Replay-Cursor": String(cursor),
  };
}

function isTerminalAgUiEvent(event: AGUIEvent): boolean {
  return event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR;
}

function assertMethod(request: Request, expected: string): void {
  if (request.method !== expected) {
    throw new AgUiAdapterError("method_not_allowed", `Expected ${expected}`, 405);
  }
}

function assertJsonContentType(request: Request): void {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new AgUiAdapterError("unsupported_media_type", "Content-Type must be application/json", 415);
  }
}

function assertSseAccept(request: Request): void {
  const accept = request.headers.get("accept");
  if (accept === null || accept.includes("*/*") || accept.includes("text/event-stream")) return;
  throw new AgUiAdapterError("not_acceptable", "Accept must allow text/event-stream", 406);
}

const REPLAY_PATH = /^\/ag-ui\/v1\/runs\/([^/]+)\/events$/;
const CANCEL_PATH = /^\/ag-ui\/v1\/runs\/([^/]+)$/;

function isReplayPath(pathname: string): boolean {
  return REPLAY_PATH.test(pathname);
}

function isCancelPath(pathname: string): boolean {
  return CANCEL_PATH.test(pathname);
}

function replayRunId(url: URL): string {
  return pathRunId(url.pathname, REPLAY_PATH);
}

function cancelRunId(url: URL): string {
  return pathRunId(url.pathname, CANCEL_PATH);
}

function pathRunId(pathname: string, pattern: RegExp): string {
  const encoded = pattern.exec(pathname)?.[1];
  if (encoded === undefined) throw new AgUiAdapterError("invalid_path", "Invalid AG-UI run path", 404);
  try {
    const value = decodeURIComponent(encoded);
    if (!value) throw new Error("empty run id");
    return value;
  } catch (cause) {
    throw new AgUiAdapterError("invalid_run_id", "Run path identifier is invalid", 400, { cause });
  }
}

function nonNegativeIntegerQuery(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new AgUiAdapterError("invalid_cursor", `Query parameter '${name}' must be a non-negative integer`, 400);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new AgUiAdapterError("invalid_cursor", `Query parameter '${name}' is too large`, 400);
  }
  return value;
}

function optionalBoundedQuery(url: URL, name: string, maximum: number): string | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  if (value.length > maximum) {
    throw new AgUiAdapterError("invalid_query", `Query parameter '${name}' is too long`, 400);
  }
  return value;
}

function errorResponse(error: unknown, headers: HeadersInit = {}): Response {
  if (error instanceof AgUiAdapterError) {
    return jsonResponse({ error: { code: error.code, message: error.message } }, error.status, headers);
  }
  if (isApplicationError(error)) {
    return jsonResponse(
      { error: { code: error.code, message: error.message, retryable: error.retryable } },
      applicationStatus(error.code),
      headers,
    );
  }
  return jsonResponse(
    { error: { code: "internal", message: "Internal AG-UI adapter error" } },
    500,
    headers,
  );
}

function applicationStatus(code: string): number {
  switch (code) {
    case "invalid_argument":
      return 400;
    case "unauthenticated":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "rate_limited":
      return 429;
    case "deadline_exceeded":
      return 504;
    case "unavailable":
      return 503;
    case "canceled":
      return 409;
    default:
      return 500;
  }
}

function jsonResponse(value: unknown, status: number, headers: HeadersInit = {}): Response {
  const outputHeaders = new Headers(headers);
  outputHeaders.set("Content-Type", "application/json; charset=utf-8");
  outputHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { status, headers: outputHeaders });
}
