import type {
  AgentTaskPort,
  AttachmentPort,
  ExternalIdentityPort,
  ProtocolPrincipal,
} from "@openbot/application";
import type { AgentId } from "@openbot/core";
import type { AgentCard } from "@a2a-js/sdk";

export const A2A_PROTOCOL = "a2a" as const;
export const A2A_VERSION = "1.0" as const;
export const A2A_RPC_PATH = "/a2a/v1" as const;
export const A2A_AGENT_CARD_PATH = "/.well-known/agent-card.json" as const;

export type ResolveA2APrincipal = (
  request: Request,
) => ProtocolPrincipal | Promise<ProtocolPrincipal>;

export type CreateA2AHandlerOptions = {
  tasks: AgentTaskPort;
  identities: ExternalIdentityPort;
  attachments: AttachmentPort;
  agentId: AgentId;
  /** Stable identity boundary for one advertised agent endpoint. */
  namespace: string;
  /** Must advertise only JSONRPC 1.0 at `/a2a/v1` and the capabilities implemented here. */
  agentCard: AgentCard;
  /** Authenticates the HTTP request and returns its tenant-scoped application principal. */
  resolvePrincipal: ResolveA2APrincipal;
  /** Optional A2A tenant value advertised by the interface. Empty by default. */
  tenant?: string;
  /** Lifetime of attachment download URLs emitted in A2A parts. Defaults to five minutes. */
  attachmentUrlTtlMs?: number;
  /** Maximum JSON-RPC request bytes, enforced while reading the stream. Defaults to 1 MiB. */
  maxRequestBodyBytes?: number;
  now?: () => number;
  onerror?: (error: Error) => void;
};

export type A2AHandler = {
  fetch(request: Request): Promise<Response>;
};
