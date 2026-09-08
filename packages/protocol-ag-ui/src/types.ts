import type {
  AgentTaskPort,
  AttachmentPort,
  ExternalIdentityPort,
  ProtocolPrincipal,
} from "@openbot/application";
import type { AgentId, ThreadId } from "@openbot/core";
import type { RunAgentInput } from "@ag-ui/core";

export const AG_UI_PROTOCOL = "ag-ui" as const;
export const AG_UI_SDK_VERSION = "0.0.59" as const;
export const OPENBOT_AG_UI_REPLAY_EXTENSION = "openbot.ag-ui.replay.v1" as const;
export const OPENBOT_AG_UI_CANCEL_EXTENSION = "openbot.ag-ui.cancel.v1" as const;

export type MaybePromise<T> = T | Promise<T>;

export type AgUiLimits = {
  maxRequestBytes: number;
  maxEventBytes: number;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
  maxAttachments: number;
  maxOpenStreams: number;
  maxAccumulatedTextBytes: number;
  maxAccumulatedToolArgsBytes: number;
  maxPendingInterrupts: number;
  attachmentUrlTtlMs: number;
};

export const DEFAULT_AG_UI_LIMITS: Readonly<AgUiLimits> = Object.freeze({
  maxRequestBytes: 1024 * 1024,
  maxEventBytes: 512 * 1024,
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxTotalAttachmentBytes: 20 * 1024 * 1024,
  maxAttachments: 8,
  maxOpenStreams: 128,
  maxAccumulatedTextBytes: 4 * 1024 * 1024,
  maxAccumulatedToolArgsBytes: 1024 * 1024,
  maxPendingInterrupts: 64,
  attachmentUrlTtlMs: 5 * 60 * 1000,
});

export type AgUiHandlerDependencies = {
  tasks: AgentTaskPort;
  identities: ExternalIdentityPort;
  attachments: AttachmentPort;
  authenticate(request: Request): MaybePromise<ProtocolPrincipal>;
  resolveAgentId(
    request: Request,
    input: RunAgentInput,
    principal: ProtocolPrincipal,
  ): MaybePromise<AgentId>;
  /** Optionally pins a protocol thread to an application-owned conversation. */
  resolveThreadId?(
    request: Request,
    input: RunAgentInput,
    principal: ProtocolPrincipal,
    agentId: AgentId,
  ): MaybePromise<ThreadId>;
  /** Isolates AG-UI identities belonging to different mounted agents or deployments. */
  namespace: string;
  limits?: Partial<AgUiLimits>;
  now?: () => number;
};

export type ResolvedAgUiHandlerDependencies = Omit<AgUiHandlerDependencies, "limits" | "now"> & {
  limits: AgUiLimits;
  now: () => number;
};

export function resolveAgUiDependencies(
  dependencies: AgUiHandlerDependencies,
): ResolvedAgUiHandlerDependencies {
  const namespace = dependencies.namespace.trim();
  if (!namespace || namespace.length > 256) {
    throw new Error("AG-UI namespace must contain between 1 and 256 characters");
  }
  const limits = { ...DEFAULT_AG_UI_LIMITS, ...dependencies.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`AG-UI limit '${name}' must be a positive safe integer`);
    }
  }
  return {
    ...dependencies,
    namespace,
    limits,
    now: dependencies.now ?? Date.now,
  };
}

export class AgUiAdapterError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgUiAdapterError";
    this.code = code;
    this.status = status;
  }
}
