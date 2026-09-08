import type { ProtocolPrincipal } from "@openbot/application";
import {
  accountIdSchema,
  agentIdSchema,
  isApplicationError,
} from "@openbot/core";
import {
  A2A_VERSION_HEADER,
  AgentCard,
  SSE_HEADERS,
  formatSSEErrorEvent,
  formatSSEEvent,
  type AgentCard as AgentCardType,
} from "@a2a-js/sdk";
import { JsonRpcTransportHandler, ServerCallContext, validateVersion } from "@a2a-js/sdk/server";
import {
  ContentTypeNotSupportedError,
  VersionNotSupportedError,
} from "@a2a-js/sdk/errors";
import { A2AIdentityMap } from "./identity.ts";
import { A2AMapper } from "./mapper.ts";
import { OpenBotA2ARequestHandler } from "./request-handler.ts";
import {
  A2A_AGENT_CARD_PATH,
  A2A_RPC_PATH,
  A2A_VERSION,
  type A2AHandler,
  type CreateA2AHandlerOptions,
} from "./types.ts";

const DEFAULT_ATTACHMENT_URL_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const JSON_CONTENT_TYPE = "application/json";

class RequestBodyTooLargeError extends Error {}

type JsonRpcResponse = {
  jsonrpc: string;
  id: string | number | null;
  result?: unknown;
  error?: unknown;
};

function report(onerror: ((error: Error) => void) | undefined, error: unknown): void {
  try {
    onerror?.(error instanceof Error ? error : new Error(String(error)));
  } catch {
    // Reporting must not change the response.
  }
}

function plain(status: number, message: string, headers?: HeadersInit): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}

function rpcError(error: unknown, id: string | number | null = null): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: JsonRpcTransportHandler.mapToJSONRPCError(error),
  };
}

function rpcResponse(value: JsonRpcResponse, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": JSON_CONTENT_TYPE,
      [A2A_VERSION_HEADER]: A2A_VERSION,
    },
  });
}

function contentTypeIsJson(request: Request): boolean {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === JSON_CONTENT_TYPE;
}

function declaredBodyTooLarge(request: Request, maximumBytes: number): boolean {
  const raw = request.headers.get("Content-Length");
  if (raw === null) return false;
  if (!/^\d+$/.test(raw)) return true;
  const length = Number(raw);
  return !Number.isSafeInteger(length) || length > maximumBytes;
}

async function readRequestBody(request: Request, maximumBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("A2A request body exceeds configured limit").catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function requestId(body: string): string | number | null {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const id = (value as Record<string, unknown>).id;
    if (typeof id === "string" || (typeof id === "number" && Number.isInteger(id)) || id === null) {
      return id;
    }
  } catch {
    // The official transport produces the malformed-request response.
  }
  return null;
}

function normalizePrincipal(value: ProtocolPrincipal): ProtocolPrincipal {
  const accountId = accountIdSchema.safeParse(value?.accountId);
  const valid =
    accountId.success &&
    typeof value?.subjectId === "string" &&
    value.subjectId.trim().length > 0 &&
    ["user", "agent", "service"].includes(value.kind) &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === "string" && scope.length > 0);
  if (!valid) throw new TypeError("Principal resolver returned an invalid principal");
  return { ...value, accountId: accountId.data, scopes: [...value.scopes] };
}

function authFailure(error: unknown, onerror?: (error: Error) => void): Response {
  if (isApplicationError(error)) {
    switch (error.code) {
      case "unauthenticated":
        return plain(401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
      case "forbidden":
        return plain(403, "Forbidden");
      case "rate_limited":
        return plain(429, "Too many requests");
      case "deadline_exceeded":
        return plain(504, "Gateway timeout");
      case "unavailable":
        return plain(503, "Service unavailable");
      case "canceled":
        return plain(408, "Request canceled");
      case "invalid_argument":
        return plain(400, "Bad request");
      case "not_found":
        return plain(404, "Not found");
      case "conflict":
        return plain(409, "Conflict");
      case "provider_error":
      case "internal":
        break;
    }
  }
  report(onerror, error);
  return plain(500, "Internal server error");
}

function validateConfiguration(options: CreateA2AHandlerOptions): AgentCardType {
  if (!agentIdSchema.safeParse(options.agentId).success) throw new TypeError("agentId is invalid");
  if (!options.namespace || options.namespace.trim() !== options.namespace || options.namespace.length > 2_048) {
    throw new TypeError("namespace must be a non-empty trimmed string of at most 2048 characters");
  }
  if (!Number.isSafeInteger(options.attachmentUrlTtlMs ?? DEFAULT_ATTACHMENT_URL_TTL_MS) ||
      (options.attachmentUrlTtlMs ?? DEFAULT_ATTACHMENT_URL_TTL_MS) <= 0) {
    throw new TypeError("attachmentUrlTtlMs must be a positive integer");
  }
  if (!Number.isSafeInteger(options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES) ||
      (options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES) <= 0) {
    throw new TypeError("maxRequestBodyBytes must be a positive integer");
  }

  const card = AgentCard.fromJSON(AgentCard.toJSON(options.agentCard));
  if (card.supportedInterfaces.length === 0 || card.supportedInterfaces.some((entry) => {
    if (entry.protocolBinding !== "JSONRPC" || entry.protocolVersion !== A2A_VERSION) return true;
    if (entry.tenant !== (options.tenant ?? "")) return true;
    try {
      const url = new URL(entry.url);
      return url.pathname !== A2A_RPC_PATH || url.search !== "" || url.hash !== "";
    } catch {
      return true;
    }
  })) {
    throw new TypeError(`Agent Card must advertise only JSONRPC ${A2A_VERSION} at ${A2A_RPC_PATH}`);
  }
  if (!card.capabilities?.streaming || card.capabilities.pushNotifications ||
      card.capabilities.extendedAgentCard || card.capabilities.extensions.length > 0) {
    throw new TypeError("Agent Card capabilities do not match the A2A adapter");
  }
  if (card.securityRequirements.length === 0 || Object.keys(card.securitySchemes).length === 0) {
    throw new TypeError("Agent Card must advertise the authentication enforced by the adapter");
  }
  for (const requirement of card.securityRequirements) {
    if (Object.keys(requirement.schemes).length === 0) {
      throw new TypeError("Agent Card cannot advertise anonymous access");
    }
    for (const scheme of Object.keys(requirement.schemes)) {
      if (!card.securitySchemes[scheme]) {
        throw new TypeError(`Agent Card security requirement references unknown scheme ${scheme}`);
      }
    }
  }
  return card;
}

function authenticatedUser(principal: ProtocolPrincipal) {
  return {
    get isAuthenticated() { return true; },
    get userName() { return `${principal.kind}:${principal.subjectId}`; },
  };
}

function isAsyncGenerator(
  value: JsonRpcResponse | AsyncGenerator<JsonRpcResponse, void, undefined>,
): value is AsyncGenerator<JsonRpcResponse, void, undefined> {
  return Symbol.asyncIterator in value;
}

function streamingResponse(
  iterator: AsyncGenerator<JsonRpcResponse, void, undefined>,
  first: IteratorResult<JsonRpcResponse, void>,
  id: string | number | null,
  onerror?: (error: Error) => void,
): Response {
  const encoder = new TextEncoder();
  let firstResult: IteratorResult<JsonRpcResponse, void> | undefined = first;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = firstResult ?? await iterator.next();
        firstResult = undefined;
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(formatSSEEvent(next.value)));
      } catch (error) {
        report(onerror, error);
        controller.enqueue(encoder.encode(formatSSEErrorEvent(rpcError(error, id))));
        controller.close();
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { ...SSE_HEADERS, [A2A_VERSION_HEADER]: A2A_VERSION },
  });
}

/** Fetch-native A2A entry point exposing the Agent Card and JSON-RPC 1.0 endpoint. */
export function createA2AHandler(options: CreateA2AHandlerOptions): A2AHandler {
  const card = validateConfiguration(options);
  const tenant = options.tenant ?? "";
  const attachmentUrlTtlMs = options.attachmentUrlTtlMs ?? DEFAULT_ATTACHMENT_URL_TTL_MS;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const now = options.now ?? Date.now;

  return {
    async fetch(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      const requestedVersion = request.headers.get(A2A_VERSION_HEADER);

      if (pathname === A2A_AGENT_CARD_PATH) {
        if (request.method.toUpperCase() !== "GET") {
          return plain(405, "Method not allowed", { Allow: "GET" });
        }
        if (requestedVersion !== A2A_VERSION) {
          return plain(400, new VersionNotSupportedError().message);
        }
        return new Response(JSON.stringify(AgentCard.toJSON(card)), {
          status: 200,
          headers: {
            "Content-Type": JSON_CONTENT_TYPE,
            "Cache-Control": "public, max-age=300",
            [A2A_VERSION_HEADER]: A2A_VERSION,
          },
        });
      }

      if (pathname !== A2A_RPC_PATH) return plain(404, "Not found");
      if (request.method.toUpperCase() !== "POST") {
        return plain(405, "Method not allowed", { Allow: "POST" });
      }
      if (requestedVersion !== A2A_VERSION) {
        return rpcResponse(rpcError(new VersionNotSupportedError(), null));
      }
      try {
        validateVersion(requestedVersion, card, "JSONRPC");
      } catch (error) {
        return rpcResponse(rpcError(error, null));
      }
      if (!contentTypeIsJson(request)) {
        return rpcResponse(rpcError(new ContentTypeNotSupportedError(), null), 400);
      }
      if (declaredBodyTooLarge(request, maxRequestBodyBytes)) {
        return plain(413, "Payload too large");
      }

      let principal: ProtocolPrincipal;
      try {
        principal = normalizePrincipal(await options.resolvePrincipal(request.clone()));
      } catch (error) {
        return authFailure(error, options.onerror);
      }

      let body: string;
      try {
        body = await readRequestBody(request, maxRequestBodyBytes);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return plain(413, "Payload too large");
        report(options.onerror, error);
        return rpcResponse(rpcError(error, null));
      }
      const id = requestId(body);
      let parsedBody: Record<string, unknown>;
      try {
        parsedBody = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return rpcResponse({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid JSON payload." },
        }, 400);
      }
      const identities = new A2AIdentityMap(options.identities, principal, options.namespace);
      const mapper = new A2AMapper({
        principal,
        identities,
        attachments: options.attachments,
        attachmentUrlTtlMs,
        now,
      });
      const requestHandler = new OpenBotA2ARequestHandler({
        tasks: options.tasks,
        principal,
        agentId: options.agentId,
        tenant,
        card,
        mapper,
        identities,
        signal: request.signal,
        onerror: options.onerror,
      });
      const transport = new JsonRpcTransportHandler(requestHandler);

      let result: JsonRpcResponse | AsyncGenerator<JsonRpcResponse, void, undefined>;
      try {
        result = await transport.handle(parsedBody, new ServerCallContext({
          requestedVersion: A2A_VERSION,
          tenant: tenant || undefined,
          user: authenticatedUser(principal),
          state: new Map<string, unknown>([["request", request], ["principal", principal]]),
        })) as JsonRpcResponse | AsyncGenerator<JsonRpcResponse, void, undefined>;
      } catch (error) {
        report(options.onerror, error);
        return rpcResponse(rpcError(new Error("Internal server error"), id));
      }
      if (!isAsyncGenerator(result)) return rpcResponse(result);
      let first: IteratorResult<JsonRpcResponse, void>;
      try {
        first = await result.next();
      } catch (error) {
        report(options.onerror, error);
        return rpcResponse(rpcError(error, id));
      }
      return streamingResponse(result, first, id, options.onerror);
    },
  };
}
