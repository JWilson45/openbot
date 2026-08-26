import { z } from "zod";

export const sendMessageInput = z.object({
  body: z.string().min(1).max(32_000),
  urgency: z.enum(["normal", "needs_user"]).optional(),
});

export const sendToAgentInput = z.object({
  body: z.string().min(1).max(32_000),
  botId: z.string().optional(),
  name: z.string().min(1).max(80).optional(),
});

export type SendToAgentInput = z.infer<typeof sendToAgentInput>;

export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const createBotInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(4000).default(""),
});

export const patchBotInput = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(4000).optional(),
});

export const botSettingsInput = z.object({
  permissionMode: z.enum(["ask", "auto", "always-approve"]).optional(),
  requireHumanApproval: z.boolean().optional(),
  harness: z.enum(["grok", "codex"]).optional(),
});

export const postMessageInput = z.object({
  body: z.string().min(1).max(32_000),
});

export const credentialInput = z.object({
  key: z.string().min(8).max(4096),
});

export const permissionDecision = z.object({
  allow: z.boolean(),
});

export type PromoteCause =
  | { kind: "acp_done"; stopReason?: string; assistantText?: string; telemetrySentMessageCount?: number }
  | { kind: "crash"; assistantText?: string }
  | { kind: "cancel"; assistantText?: string }
  | { kind: "deadline"; assistantText?: string };

export class McpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 409,
  ) {
    super(message);
    this.name = "McpError";
  }
}
