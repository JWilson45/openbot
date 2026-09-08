import type {
  ActionDescriptor,
  ActionInvocationContext,
  ActionPort,
  ActionResult,
  ProtocolPrincipal,
} from "@openbot/application";
import {
  isApplicationError,
  isJsonValue,
  type ContentPart,
  type JsonObject,
  type JsonValue,
} from "@openbot/core";
import {
  createMcpHandler,
  fromJsonSchema,
  inputRequired,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type CallToolResult,
  type ContentBlock,
  type Implementation,
  type InputRequiredResult,
  type InputRequests,
  type JsonSchemaType,
  type ServerContext,
  type StandardSchemaWithJSON,
  type Tool,
} from "@modelcontextprotocol/server";

export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;

const DEFAULT_SERVER_INFO: Implementation = {
  name: "openbot",
  version: "1.0.0",
};

export type ResolveMcpPrincipal = (
  request: Request,
) => ProtocolPrincipal | Promise<ProtocolPrincipal>;

export type CreateMcpActionHandlerOptions = {
  actions: ActionPort;
  /** Authentication and principal construction happen before the action port is reached. */
  resolvePrincipal: ResolveMcpPrincipal;
  serverInfo?: Implementation;
  onerror?: (error: Error) => void;
};

export type CreateMcpActionServerOptions = {
  actions: ActionPort;
  principal: ProtocolPrincipal;
  serverInfo?: Implementation;
};

/** Fetch-native MCP entry point. Mount its `fetch` method at `POST /mcp`. */
export type McpActionHandler = {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
};

type CatalogEntry = {
  descriptor: ActionDescriptor;
  input: StandardSchemaWithJSON<unknown, JsonObject>;
  output?: StandardSchemaWithJSON<unknown, JsonValue>;
};

type CompleteActionResult = Extract<ActionResult, { outcome: "success" | "failure" }>;
type InputRequiredActionResult = Extract<ActionResult, { outcome: "input_required" }>;

function asJsonSchema(schema: JsonObject): JsonSchemaType {
  return schema as JsonSchemaType;
}

function asToolInputSchema(schema: JsonObject, actionName: string): Tool["inputSchema"] {
  if (schema.type !== "object") {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `Action ${actionName} must declare an object input schema`,
    );
  }
  return schema as Tool["inputSchema"];
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isJsonValue(value)
  );
}

async function validateInput(entry: CatalogEntry, value: unknown): Promise<JsonObject> {
  const result = await entry.input["~standard"].validate(value);
  if (result.issues) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid arguments for action ${entry.descriptor.name}`,
    );
  }
  if (!isJsonObject(result.value)) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Action ${entry.descriptor.name} requires an object input`,
    );
  }
  return result.value;
}

async function validateOutput(entry: CatalogEntry, result: CompleteActionResult): Promise<void> {
  if (!entry.output || result.outcome === "failure") return;
  if (result.data === undefined) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `Action ${entry.descriptor.name} returned no structured output`,
    );
  }
  const validation = await entry.output["~standard"].validate(result.data);
  if (validation.issues) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `Action ${entry.descriptor.name} returned invalid structured output`,
    );
  }
}

function attachmentUri(id: string): string {
  return `urn:openbot:attachment:${encodeURIComponent(id)}`;
}

/**
 * Convert public canonical content to MCP blocks. Attachment bytes and local paths are never
 * available at this boundary; file parts become opaque links to the attachment reference.
 */
export function toMcpContentBlock(part: ContentPart): ContentBlock {
  switch (part.kind) {
    case "text":
      return { type: "text", text: part.text };
    case "data":
      return { type: "text", text: JSON.stringify(part.data) };
    case "file":
      return {
        type: "resource_link",
        uri: attachmentUri(part.attachment.id),
        name: part.attachment.name ?? "attachment",
        mimeType: part.attachment.mediaType,
        size: part.attachment.size,
        description: "OpenBot attachment reference; content is not embedded",
      };
  }
}

function toCallToolResult(result: CompleteActionResult): CallToolResult {
  const translated: CallToolResult = {
    content: result.content.map(toMcpContentBlock),
    isError: result.outcome === "failure",
  };
  if (result.data !== undefined) translated.structuredContent = result.data;
  return translated;
}

function toInputRequiredResult(
  actionName: string,
  result: InputRequiredActionResult,
): InputRequiredResult {
  if (result.requests.length === 0) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `Action ${actionName} returned no input requests`,
    );
  }

  const inputRequests: InputRequests = Object.create(null) as InputRequests;
  try {
    for (const request of result.requests) {
      if (request.id.length === 0 || Object.hasOwn(inputRequests, request.id)) {
        throw new TypeError("input request ids must be non-empty and unique");
      }
      inputRequests[request.id] = inputRequired.elicit({
        message: request.prompt,
        requestedSchema: fromJsonSchema(asJsonSchema(request.schema)),
      });
    }
    return inputRequired({ inputRequests, requestState: result.requestState });
  } catch {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `Action ${actionName} returned an invalid input request`,
    );
  }
}

function invalidContinuation(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

function normalizeInputResponses(
  responses: Record<string, unknown>,
): NonNullable<ActionInvocationContext["continuation"]>["inputResponses"] {
  const normalized: Record<
    string,
    { status: "accepted"; value: JsonValue } | { status: "declined" | "canceled" }
  > = Object.create(null) as Record<
    string,
    { status: "accepted"; value: JsonValue } | { status: "declined" | "canceled" }
  >;

  for (const [id, response] of Object.entries(responses)) {
    if (!isJsonObject(response) || typeof response.action !== "string") {
      throw invalidContinuation(`Invalid input response for ${id}`);
    }
    switch (response.action) {
      case "accept":
        if (!("content" in response) || !isJsonValue(response.content)) {
          throw invalidContinuation(`Accepted input response ${id} has no valid content`);
        }
        normalized[id] = { status: "accepted", value: response.content };
        break;
      case "decline":
        normalized[id] = { status: "declined" };
        break;
      case "cancel":
        normalized[id] = { status: "canceled" };
        break;
      default:
        throw invalidContinuation(`Invalid input response action for ${id}`);
    }
  }
  return normalized;
}

function toActionInvocationContext(context: ServerContext): ActionInvocationContext {
  const requestState = context.mcpReq.requestState<unknown>();
  const inputResponses = context.mcpReq.inputResponses;
  const droppedKeys = context.mcpReq.droppedInputResponseKeys ?? [];
  const hasContinuation =
    requestState !== undefined || inputResponses !== undefined || droppedKeys.length > 0;

  if (!hasContinuation) return { signal: context.mcpReq.signal };
  if (typeof requestState !== "string") {
    throw invalidContinuation("Continuation is missing a valid requestState");
  }
  if (inputResponses === undefined || droppedKeys.length > 0) {
    throw invalidContinuation("Continuation contains invalid input responses");
  }
  return {
    signal: context.mcpReq.signal,
    continuation: {
      requestState,
      inputResponses: normalizeInputResponses(inputResponses),
    },
  };
}

function toTool(entry: CatalogEntry): Tool {
  return {
    name: entry.descriptor.name,
    description: entry.descriptor.description,
    inputSchema: asToolInputSchema(entry.descriptor.inputSchema, entry.descriptor.name),
    ...(entry.descriptor.outputSchema === undefined
      ? {}
      : { outputSchema: entry.descriptor.outputSchema }),
  };
}

function actionInvocationError(error: unknown, actionName: string): ProtocolError {
  if (isApplicationError(error)) {
    if (error.code === "invalid_argument") {
      return new ProtocolError(ProtocolErrorCode.InvalidParams, error.message);
    }
    if (error.code === "not_found") {
      return new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Action ${actionName} not found`,
      );
    }
    return new ProtocolError(
      ProtocolErrorCode.InternalError,
      error.code === "canceled" ? "Action invocation canceled" : "Action invocation failed",
    );
  }
  return new ProtocolError(ProtocolErrorCode.InternalError, "Action invocation failed");
}

function buildCatalog(descriptors: readonly ActionDescriptor[]): Map<string, CatalogEntry> {
  const catalog = new Map<string, CatalogEntry>();
  for (const descriptor of descriptors) {
    if (catalog.has(descriptor.name)) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Action catalog contains duplicate name ${descriptor.name}`,
      );
    }
    catalog.set(descriptor.name, {
      descriptor,
      input: fromJsonSchema<JsonObject>(asJsonSchema(descriptor.inputSchema)),
      ...(descriptor.outputSchema === undefined
        ? {}
        : {
            output: fromJsonSchema<JsonValue>(asJsonSchema(descriptor.outputSchema)),
          }),
    });
  }
  return catalog;
}

/** Build one modern MCP server and one principal-scoped action catalog for a single request. */
export async function createMcpActionServer({
  actions,
  principal,
  serverInfo = DEFAULT_SERVER_INFO,
}: CreateMcpActionServerOptions): Promise<Server> {
  const catalog = buildCatalog(await actions.list(principal));
  const server = new Server(serverInfo, {
    capabilities: { tools: {} },
    supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
    enforceStrictCapabilities: true,
  });

  server.setRequestHandler("tools/list", async () => ({
    tools: [...catalog.values()].map(toTool),
  }));

  server.setRequestHandler("tools/call", async (request, context) => {
    const actionName = request.params.name;
    const entry = catalog.get(actionName);
    if (!entry) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Action ${actionName} not found`,
      );
    }

    const input = await validateInput(entry, request.params.arguments ?? {});
    const invocationContext = toActionInvocationContext(context);
    let result: ActionResult;
    try {
      result = await actions.invoke(principal, actionName, input, invocationContext);
    } catch (error) {
      throw actionInvocationError(error, actionName);
    }
    if (result.outcome === "input_required") {
      return toInputRequiredResult(actionName, result);
    }
    await validateOutput(entry, result);
    return server.projectCallToolResult(toCallToolResult(result), entry.descriptor.outputSchema);
  });

  return server;
}

function errorResponse(status: number, message: string, challenge = false): Response {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  if (challenge) headers.set("WWW-Authenticate", "Bearer");
  return new Response(message, { status, headers });
}

function reportError(onerror: ((error: Error) => void) | undefined, error: unknown): void {
  try {
    onerror?.(error instanceof Error ? error : new Error(String(error)));
  } catch {
    // Reporting must not change the protocol response.
  }
}

function principalResolutionError(error: unknown, onerror?: (error: Error) => void): Response {
  if (!isApplicationError(error)) {
    reportError(onerror, error);
    return errorResponse(500, "Internal server error");
  }
  switch (error.code) {
    case "unauthenticated":
      return errorResponse(401, "Unauthorized", true);
    case "forbidden":
      return errorResponse(403, "Forbidden");
    case "invalid_argument":
      return errorResponse(400, "Bad request");
    case "not_found":
      return errorResponse(404, "Not found");
    case "conflict":
      return errorResponse(409, "Conflict");
    case "rate_limited":
      return errorResponse(429, "Too many requests");
    case "deadline_exceeded":
      return errorResponse(504, "Gateway timeout");
    case "unavailable":
      return errorResponse(503, "Service unavailable");
    case "canceled":
      return errorResponse(408, "Request canceled");
    case "provider_error":
    case "internal":
      reportError(onerror, error);
      return errorResponse(500, "Internal server error");
  }
}

/**
 * Create the reusable, modern-only transport boundary. The official SDK still constructs a fresh
 * Server from the factory for every POST, while the WeakMap safely carries the already-resolved
 * request principal into that factory without credentials or global mutable identity.
 */
export function createMcpActionHandler({
  actions,
  resolvePrincipal,
  serverInfo = DEFAULT_SERVER_INFO,
  onerror,
}: CreateMcpActionHandlerOptions): McpActionHandler {
  const principals = new WeakMap<Request, ProtocolPrincipal>();
  const handler = createMcpHandler(
    async (context) => {
      const request = context.requestInfo;
      const principal = request && principals.get(request);
      if (!principal) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          "Authenticated principal is unavailable",
        );
      }
      return createMcpActionServer({ actions, principal, serverInfo });
    },
    {
      legacy: "reject",
      responseMode: "auto",
      onerror,
    },
  );

  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method.toUpperCase() !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "POST", "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      let principal: ProtocolPrincipal;
      try {
        // Authentication never gets ownership of the protocol body stream.
        principal = await resolvePrincipal(request.clone());
      } catch (error) {
        return principalResolutionError(error, onerror);
      }

      principals.set(request, principal);
      try {
        return await handler.fetch(request);
      } finally {
        principals.delete(request);
      }
    },
    close: handler.close,
  };
}
