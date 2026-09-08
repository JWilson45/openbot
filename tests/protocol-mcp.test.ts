import { describe, expect, test } from "bun:test";
import type {
  ActionDescriptor,
  ActionInvocationContext,
  ActionPort,
  ActionResult,
  ProtocolPrincipal,
} from "../packages/application/src/index.ts";
import {
  accountIdSchema,
  ApplicationError,
  attachmentIdSchema,
  type JsonObject,
} from "../packages/core/src/index.ts";
import {
  createMcpActionHandler,
  MCP_PROTOCOL_VERSION,
  type McpActionHandler,
} from "../packages/protocol-mcp/src/index.ts";
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const principal: ProtocolPrincipal = {
  accountId: accountIdSchema.parse("11111111-1111-4111-8111-111111111111"),
  subjectId: "user:test",
  kind: "user",
  scopes: ["actions:invoke"],
};

const echoAction: ActionDescriptor = {
  name: "echo",
  description: "Echo a message",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { echoed: { type: "string" } },
    required: ["echoed"],
    additionalProperties: false,
  },
};

type WireRequest = {
  method: string;
  headers: Headers;
  body: unknown;
};

async function connectOfficialClient(
  handler: McpActionHandler,
  wire: WireRequest[] = [],
  configure?: (client: Client) => void,
): Promise<Client> {
  const client = new Client(
    { name: "openbot-protocol-test", version: "1.0.0" },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
      supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
      enforceStrictCapabilities: true,
    },
  );
  configure?.(client);
  const transport = new StreamableHTTPClientTransport(new URL("http://openbot.test/mcp"), {
    requestInit: { headers: { Authorization: "Bearer test-token" } },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const bodyText = await request.clone().text();
      wire.push({
        method: request.method,
        headers: new Headers(request.headers),
        body: bodyText.length === 0 ? undefined : JSON.parse(bodyText),
      });
      return handler.fetch(request);
    },
  });
  await client.connect(transport);
  return client;
}

async function expectProtocolError(
  operation: Promise<unknown>,
  code: ProtocolErrorCode,
): Promise<void> {
  try {
    await operation;
    throw new Error("expected a protocol error");
  } catch (error) {
    expect(ProtocolError.isInstance(error)).toBe(true);
    expect((error as ProtocolError).code).toBe(code);
  }
}

describe("MCP 2026-07-28 action adapter", () => {
  test("serves a principal-scoped action catalog through the official client", async () => {
    const wire: WireRequest[] = [];
    const listedPrincipals: ProtocolPrincipal[] = [];
    const invoked: Array<{
      principal: ProtocolPrincipal;
      name: string;
      input: JsonObject;
      signal: AbortSignal | undefined;
    }> = [];
    const actions: ActionPort = {
      async list(requestPrincipal) {
        listedPrincipals.push(requestPrincipal);
        return [echoAction];
      },
      async invoke(requestPrincipal, name, input, context) {
        invoked.push({ principal: requestPrincipal, name, input, signal: context?.signal });
        const message = String(input.message);
        return {
          outcome: "success",
          data: { echoed: message },
          content: [
            { kind: "text", text: message },
            { kind: "data", data: { echoed: message }, mediaType: "application/json" },
            {
              kind: "file",
              attachment: {
                id: attachmentIdSchema.parse("22222222-2222-4222-8222-222222222222"),
                name: "report.txt",
                mediaType: "text/plain",
                size: 12,
                sha256: "a".repeat(64),
              },
            },
          ],
        };
      },
    };
    const handler = createMcpActionHandler({
      actions,
      resolvePrincipal(request) {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return principal;
      },
    });
    const client = await connectOfficialClient(handler, wire);

    try {
      const catalog = await client.listTools();
      expect(catalog.tools).toEqual([
        expect.objectContaining({
          name: "echo",
          description: "Echo a message",
          inputSchema: echoAction.inputSchema,
          outputSchema: echoAction.outputSchema,
        }),
      ]);

      const result = await client.callTool({
        name: "echo",
        arguments: { message: "hello" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ echoed: "hello" });
      expect(result.content).toEqual([
        { type: "text", text: "hello" },
        { type: "text", text: '{"echoed":"hello"}' },
        {
          type: "resource_link",
          uri: "urn:openbot:attachment:22222222-2222-4222-8222-222222222222",
          name: "report.txt",
          mimeType: "text/plain",
          size: 12,
          description: "OpenBot attachment reference; content is not embedded",
        },
      ]);

      expect(invoked).toHaveLength(1);
      expect(invoked[0]).toMatchObject({
        principal,
        name: "echo",
        input: { message: "hello" },
      });
      expect(invoked[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(listedPrincipals.length).toBeGreaterThanOrEqual(3);
      expect(listedPrincipals.every((value) => value === principal)).toBe(true);

      expect(wire.map(({ body }) => (body as { method?: string }).method)).toEqual([
        "server/discover",
        "tools/list",
        "tools/call",
      ]);
      for (const request of wire) {
        expect(request.method).toBe("POST");
        expect(request.headers.get("mcp-protocol-version")).toBe(MCP_PROTOCOL_VERSION);
        expect(request.headers.get("mcp-method")).toBe(
          (request.body as { method: string }).method,
        );
        expect(request.headers.has("mcp-session-id")).toBe(false);
      }

      const attachmentBlock = JSON.stringify(result.content[2]);
      expect(attachmentBlock).not.toContain("sha256");
      expect(attachmentBlock).not.toContain("aaaaaaaa");
      expect(attachmentBlock).not.toContain("path");
      expect(attachmentBlock).not.toContain("bytes");
    } finally {
      await client.close();
      await handler.close();
    }
  });

  test("keeps business failures in a successful tools/call result", async () => {
    const actions: ActionPort = {
      async list() {
        return [{ ...echoAction, outputSchema: undefined }];
      },
      async invoke(): Promise<ActionResult> {
        return {
          outcome: "failure",
          content: [{ kind: "text", text: "upstream rejected the request" }],
        };
      },
    };
    const handler = createMcpActionHandler({ actions, resolvePrincipal: () => principal });
    const client = await connectOfficialClient(handler);

    try {
      const result = await client.callTool({ name: "echo", arguments: { message: "hello" } });
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "upstream rejected the request" }],
      });
    } finally {
      await client.close();
      await handler.close();
    }
  });

  test("round-trips input-required elicitation through a neutral continuation", async () => {
    const contexts: Array<ActionInvocationContext | undefined> = [];
    const inputs: JsonObject[] = [];
    const actions: ActionPort = {
      async list() {
        return [{ ...echoAction, outputSchema: undefined }];
      },
      async invoke(_principal, _name, input, context): Promise<ActionResult> {
        inputs.push(input);
        contexts.push(context);
        if (!context?.continuation) {
          return {
            outcome: "input_required",
            requestState: "integrity-protected-state",
            requests: [
              {
                id: "approval",
                prompt: "Approve this action?",
                schema: {
                  type: "object",
                  properties: { approved: { type: "boolean" } },
                  required: ["approved"],
                },
              },
            ],
          };
        }
        return {
          outcome: "success",
          content: [{ kind: "text", text: "approved" }],
        };
      },
    };
    const wire: WireRequest[] = [];
    let elicitationParams: unknown;
    const handler = createMcpActionHandler({ actions, resolvePrincipal: () => principal });
    const client = await connectOfficialClient(handler, wire, (configuredClient) => {
      configuredClient.setRequestHandler("elicitation/create", async (request) => {
        elicitationParams = request.params;
        return { action: "accept", content: { approved: true } };
      });
    });

    try {
      const result = await client.callTool({
        name: "echo",
        arguments: { message: "requires approval" },
      });
      expect(result).toMatchObject({
        content: [{ type: "text", text: "approved" }],
      });
      expect(elicitationParams).toMatchObject({
        mode: "form",
        message: "Approve this action?",
        requestedSchema: {
          type: "object",
          properties: { approved: { type: "boolean" } },
          required: ["approved"],
        },
      });
      expect(inputs).toEqual([
        { message: "requires approval" },
        { message: "requires approval" },
      ]);
      expect(contexts[0]?.continuation).toBeUndefined();
      expect(contexts[1]?.continuation).toEqual({
        requestState: "integrity-protected-state",
        inputResponses: {
          approval: { status: "accepted", value: { approved: true } },
        },
      });
      expect(wire.map(({ body }) => (body as { method?: string }).method)).toEqual([
        "server/discover",
        "tools/call",
        "tools/call",
      ]);
    } finally {
      await client.close();
      await handler.close();
    }
  });

  test("returns protocol errors for malformed and unknown calls", async () => {
    let invokeCount = 0;
    const actions: ActionPort = {
      async list() {
        return [echoAction];
      },
      async invoke() {
        invokeCount += 1;
        return { outcome: "success", content: [] };
      },
    };
    const handler = createMcpActionHandler({ actions, resolvePrincipal: () => principal });
    const client = await connectOfficialClient(handler);

    try {
      // Deliberately exercises the low-level Server handlers. McpServer.registerTool in SDK 2.0
      // converts schema failures into isError tool results, while this boundary contract requires
      // malformed arguments and unknown actions to remain JSON-RPC InvalidParams errors.
      await expectProtocolError(
        client.callTool({ name: "echo", arguments: { message: 42 } }),
        ProtocolErrorCode.InvalidParams,
      );
      await expectProtocolError(
        client.callTool({ name: "missing", arguments: {} }),
        ProtocolErrorCode.InvalidParams,
      );
      expect(invokeCount).toBe(0);
    } finally {
      await client.close();
      await handler.close();
    }
  });

  test("rejects legacy and non-POST transport traffic", async () => {
    let resolutionCount = 0;
    const actions: ActionPort = {
      async list() {
        return [];
      },
      async invoke() {
        throw new Error("not reached");
      },
    };
    const handler = createMcpActionHandler({
      actions,
      resolvePrincipal() {
        resolutionCount += 1;
        return principal;
      },
    });

    try {
      const getResponse = await handler.fetch(new Request("http://openbot.test/mcp"));
      expect(getResponse.status).toBe(405);
      expect(getResponse.headers.get("allow")).toBe("POST");
      expect(resolutionCount).toBe(0);

      const legacyResponse = await handler.fetch(
        new Request("http://openbot.test/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "legacy-client", version: "1.0.0" },
            },
          }),
        }),
      );
      expect(legacyResponse.status).toBe(400);
      expect(await legacyResponse.json()).toMatchObject({
        jsonrpc: "2.0",
        id: 7,
        error: {
          code: ProtocolErrorCode.UnsupportedProtocolVersion,
          data: {
            requested: "2025-06-18",
            supported: [MCP_PROTOCOL_VERSION],
          },
        },
      });
      expect(resolutionCount).toBe(1);
    } finally {
      await handler.close();
    }
  });

  test("maps principal failures before reaching the action port", async () => {
    let listCount = 0;
    const actions: ActionPort = {
      async list() {
        listCount += 1;
        return [];
      },
      async invoke() {
        throw new Error("not reached");
      },
    };
    const handler = createMcpActionHandler({
      actions,
      resolvePrincipal() {
        throw new ApplicationError("unauthenticated", "secret verifier detail");
      },
    });

    try {
      const response = await handler.fetch(
        new Request("http://openbot.test/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(await response.text()).toBe("Unauthorized");
      expect(listCount).toBe(0);
    } finally {
      await handler.close();
    }
  });

  test("propagates request cancellation to ActionPort.invoke", async () => {
    let started!: () => void;
    const invocationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const actions: ActionPort = {
      async list() {
        return [{ ...echoAction, outputSchema: undefined }];
      },
      async invoke(_principal, _name, _input, context): Promise<ActionResult> {
        const signal = context?.signal;
        receivedSignal = signal;
        started();
        return new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(new ApplicationError("canceled", "already canceled"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new ApplicationError("canceled", "request canceled")),
            { once: true },
          );
          void resolve;
        });
      },
    };
    const handler = createMcpActionHandler({ actions, resolvePrincipal: () => principal });
    const client = await connectOfficialClient(handler);
    const controller = new AbortController();

    try {
      const pending = client.callTool(
        { name: "echo", arguments: { message: "wait" } },
        { signal: controller.signal },
      );
      await invocationStarted;
      controller.abort();
      await expect(pending).rejects.toThrow();
      await Promise.resolve();
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      await client.close();
      await handler.close();
    }
  });
});
