import type {
  ActionDescriptor,
  ActionInvocationContext,
  ActionPort,
  ActionResult,
  ProtocolPrincipal,
} from "@openbot/application";
import { ApplicationError, isJsonValue, type JsonObject } from "@openbot/core";
import type { OpenbotDb } from "@openbot/db";
import {
  McpInflight,
  handleMcpJsonRpc,
  mcpToolsForRole,
  verifyMcpToken,
  type McpHooks,
} from "@openbot/mcp-send-message";

type LegacyTool = { name: string; description?: string; inputSchema: JsonObject };

/**
 * Temporary composition adapter for OpenBot's existing business actions. The public MCP wire is
 * wholly owned by protocol-mcp; this class only reuses the already-tested action implementations.
 */
export class OpenbotActionPort implements ActionPort {
  private readonly authorizations = new WeakMap<ProtocolPrincipal, string>();

  constructor(
    private readonly db: OpenbotDb,
    private readonly inflight: McpInflight,
    private readonly hooks: McpHooks,
    private readonly onResult?: (result: { status: number; json: unknown }) => void,
  ) {}

  resolveMcpPrincipal(request: Request): ProtocolPrincipal {
    if (request.headers.has("cookie")) {
      throw new ApplicationError("unauthenticated", "cookies are not accepted by MCP");
    }
    const authorization = request.headers.get("authorization") ?? undefined;
    let claims: ReturnType<typeof verifyMcpToken>;
    try {
      claims = verifyMcpToken(this.db, authorization);
    } catch (cause) {
      throw new ApplicationError("unauthenticated", "invalid MCP credential", { cause });
    }
    const principal: ProtocolPrincipal = {
      accountId: claims.accountId as ProtocolPrincipal["accountId"],
      subjectId: `agent:${claims.botId}:${claims.harnessSessionId}`,
      kind: "agent",
      scopes: ["actions:invoke"],
    };
    this.authorizations.set(principal, authorization!);
    return principal;
  }

  async list(principal: ProtocolPrincipal): Promise<readonly ActionDescriptor[]> {
    const botId = principal.subjectId.split(":", 3)[1];
    if (principal.kind !== "agent" || !botId) throw new ApplicationError("forbidden", "agent action catalog required");
    const bot = this.db.get<{ role: string }>(
      "SELECT IFNULL(role, 'desk') AS role FROM bots WHERE account_id = ? AND id = ? AND status = 'active'",
      [principal.accountId, botId],
    );
    if (!bot) throw new ApplicationError("not_found", "agent not found");
    const role = bot.role;
    return (mcpToolsForRole(role) as LegacyTool[]).map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
    }));
  }

  async invoke(
    principal: ProtocolPrincipal,
    name: string,
    input: JsonObject,
    context?: ActionInvocationContext,
  ): Promise<ActionResult> {
    if (context?.signal?.aborted) throw new ApplicationError("canceled", "action invocation canceled");
    if (context?.continuation) {
      throw new ApplicationError("invalid_argument", "this action does not request continuation input");
    }
    const authorization = this.requireAuthorization(principal);
    const response = await handleMcpJsonRpc(
      this.db,
      this.inflight,
      authorization,
      { jsonrpc: "2.0", id: "application", method: "tools/call", params: { name, arguments: input } },
      this.hooks,
    );
    this.onResult?.(response);
    const body = response.json as {
      result?: { content?: Array<{ type?: string; text?: string }> };
      error?: { message?: string; data?: { code?: string } };
    };
    if (body.error) {
      const code = body.error.data?.code;
      const mapped = code === "unauthorized" ? "unauthenticated"
        : code === "forbidden" ? "forbidden"
          : code === "rate_limited" ? "rate_limited"
            : code === "no_active_turn" ? "conflict"
              : code === "unknown_tool" ? "not_found"
                : "invalid_argument";
      throw new ApplicationError(mapped, body.error.message ?? "action failed");
    }
    const text = body.result?.content?.find((part) => part.type === "text")?.text ?? "null";
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!isJsonValue(data)) throw new ApplicationError("internal", "action returned a non-JSON result");
    return { outcome: "success", content: [{ kind: "text", text }], data };
  }

  private requireAuthorization(principal: ProtocolPrincipal): string {
    const value = this.authorizations.get(principal);
    if (!value) throw new ApplicationError("unauthenticated", "action principal is no longer active");
    return value;
  }
}
