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

export const sendToThreadInput = z.object({
  body: z.string().min(1).max(32_000),
  threadId: z.string().uuid().optional(),
  name: z.string().min(1).max(80).optional(),
  urgency: z.enum(["normal", "needs_user"]).optional(),
});

export type SendToThreadInput = z.infer<typeof sendToThreadInput>;

export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const sendToOrgInput = z.object({
  org: z.string().min(1).max(80),
  body: z.string().min(1).max(32_000),
  urgency: z.enum(["normal", "needs_user"]).optional(),
  threadId: z.string().min(1).max(64).optional(),
});

export type SendToOrgInput = z.infer<typeof sendToOrgInput>;

export const inboxInput = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  ack: z.string().min(1).max(64).optional(),
});

export type InboxInput = z.infer<typeof inboxInput>;

export const createBotInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(4000).optional().default(""),
  model: z.string().min(1).max(80).optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "extra high"]).optional(),
});

export type CreateBotInput = z.infer<typeof createBotInput>;

export const patchBotInput = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(4000).optional(),
});

export const botSettingsInput = z.object({
  permissionMode: z.enum(["ask", "auto", "always-approve"]).optional(),
  requireHumanApproval: z.boolean().optional(),
  requireMemoryApproval: z.boolean().optional(),
  harness: z.enum(["grok", "codex"]).optional(),
});

export const memoryInput = z.object({
  action: z.enum(["read", "replace", "add", "remove"]),
  scope: z.enum(["self", "org"]),
  text: z.string().max(2000).optional(),
});

export type MemoryInput = z.infer<typeof memoryInput>;

export const searchMessagesInput = z.object({
  query: z.string().min(1).max(500),
  threadId: z.string().optional(),
  limit: z.number().int().min(1).max(20).optional(),
  since: z.number().int().optional(),
});

export type SearchMessagesInput = z.infer<typeof searchMessagesInput>;

export const searchThreadsInput = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(20).optional(),
});

export type SearchThreadsInput = z.infer<typeof searchThreadsInput>;

export const patchOrgMemoryInput = z.object({
  org: z.string().max(1200).optional(),
});

export const patchBotMemoryInput = z.object({
  body: z.string().max(2000),
});

export const postMessageInput = z.object({
  body: z.string().min(1).max(32_000),
});

export const createCalendarSeriesInput = z.object({
  title: z.string().trim().min(1).max(200),
  prompt: z.string().min(1).max(32_000),
  botId: z.string().min(1),
  dtstart: z.union([z.number().int(), z.string().min(1)]),
  timezone: z.string().min(1).max(80).optional(),
  rrule: z.string().max(512).nullable().optional(),
  threadId: z.string().min(1).optional(),
  requireHumanApproval: z.boolean().optional(),
});

export type CreateCalendarSeriesInput = z.infer<typeof createCalendarSeriesInput>;

export const patchCalendarSeriesInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().min(1).max(32_000).optional(),
  botId: z.string().min(1).optional(),
  dtstart: z.union([z.number().int(), z.string().min(1)]).optional(),
  timezone: z.string().min(1).max(80).optional(),
  rrule: z.string().max(512).nullable().optional(),
  threadId: z.string().min(1).nullable().optional(),
  requireHumanApproval: z.boolean().optional(),
  status: z.enum(["active", "paused", "cancelled"]).optional(),
});

export type PatchCalendarSeriesInput = z.infer<typeof patchCalendarSeriesInput>;

export const learnRoutineInput = z.object({
  threadId: z.string().min(1),
  botId: z.string().min(1).optional(),
});

export type LearnRoutineInput = z.infer<typeof learnRoutineInput>;

export const listCalendarInput = z.object({
  status: z.enum(["proposed", "active", "paused", "cancelled"]).optional(),
  kind: z.enum(["schedule", "routine"]).optional(),
});

export type ListCalendarInput = z.infer<typeof listCalendarInput>;

export const createEventInput = z.object({
  title: z.string().trim().min(1).max(200),
  prompt: z.string().min(1).max(32_000),
  botId: z.string().min(1).optional(),
  name: z.string().min(1).max(80).optional(),
  dtstart: z.union([z.number().int(), z.string().min(1)]).optional(),
  timezone: z.string().min(1).max(80).optional(),
  rrule: z.string().max(512).nullable().optional(),
  threadId: z.string().min(1).optional(),
  requireHumanApproval: z.boolean().optional(),
});

export type CreateEventInput = z.infer<typeof createEventInput>;

export const proposeRoutineInput = z.object({
  title: z.string().trim().min(1).max(200),
  prompt: z.string().min(1).max(32_000),
  botId: z.string().min(1).optional(),
  name: z.string().min(1).max(80).optional(),
  rrule: z.string().max(512).nullable().optional(),
  dtstart: z.union([z.number().int(), z.string().min(1)]).optional(),
  timezone: z.string().min(1).max(80).optional(),
  threadId: z.string().min(1).optional(),
});

export type ProposeRoutineInput = z.infer<typeof proposeRoutineInput>;

export const pauseSeriesInput = z.object({
  seriesId: z.string().min(1),
  paused: z.boolean(),
});

export type PauseSeriesInput = z.infer<typeof pauseSeriesInput>;

export const confirmSeriesInput = z.object({
  seriesId: z.string().min(1),
});

export type ConfirmSeriesInput = z.infer<typeof confirmSeriesInput>;

export const navigateBrowserInput = z.object({
  url: z.string().trim().min(1).max(2048),
});

export type NavigateBrowserInput = z.infer<typeof navigateBrowserInput>;

export const browserSnapshotInput = z.object({});

export type BrowserSnapshotInput = z.infer<typeof browserSnapshotInput>;

export const clickBrowserInput = z
  .object({
    text: z.string().trim().min(1).max(200).optional(),
    selector: z.string().trim().min(1).max(500).optional(),
    nth: z.number().int().min(0).max(20).optional(),
  })
  .refine((v) => Boolean(v.text || v.selector), { message: "text or selector required" });

export type ClickBrowserInput = z.infer<typeof clickBrowserInput>;

export const typeBrowserInput = z.object({
  text: z.string().min(1).max(8000),
  clear: z.boolean().optional(),
  submit: z.boolean().optional(),
});

export type TypeBrowserInput = z.infer<typeof typeBrowserInput>;

export const waitBrowserInput = z.object({
  ms: z.number().int().min(0).max(15_000).optional(),
});

export type WaitBrowserInput = z.infer<typeof waitBrowserInput>;

export const createGroupThreadInput = z.object({
  kind: z.literal("group"),
  title: z.string().max(200).optional(),
  botIds: z.array(z.string()).default([]),
  userIds: z.array(z.string()).optional(),
  addCaller: z.boolean().optional(),
});

export type CreateGroupThreadInput = z.infer<typeof createGroupThreadInput>;

export const addThreadParticipantInput = z.object({
  botId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
});

export type AddThreadParticipantInput = z.infer<typeof addThreadParticipantInput>;

export const fedFromActor = z.object({
  type: z.enum(["human", "bot", "gateway"]),
  name: z.string().min(1).max(80),
  botId: z.string().uuid().optional(),
});

export const fedThreadHint = z.object({
  kind: z.enum(["dm", "group", "bridge"]),
  localThreadId: z.string().optional(),
  peerThreadId: z.string().optional(),
});

/** Extra keys are stripped. hop === 1 is enforced after MUST-bind, not here. */
export const fedMessageEnvelope = z.object({
  id: z.string().uuid(),
  fromOrg: z.string().uuid(),
  fromSlug: z.string().min(1).max(80),
  fromActor: fedFromActor,
  toOrg: z.string().uuid(),
  urgency: z.enum(["normal", "needs_user"]),
  hop: z.number().int().optional(),
  createdAt: z.number().int(),
  inReplyTo: z.string().uuid().optional(),
  body: z.string().min(1).max(32_000),
  threadHint: fedThreadHint.optional(),
});

export type FedMessageEnvelope = z.infer<typeof fedMessageEnvelope>;

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

export type A2aCompleteCode =
  | "ok"
  | "no_send_message"
  | "empty_turn"
  | "crash"
  | "cancel"
  | "deadline"
  | "target_archived";

export type A2aCompleteEvent = {
  event: "a2a_complete";
  code: A2aCompleteCode;
  status: string;
  from: string;
  fromBotId: string;
  toBotId: string;
  turnId: string;
  sentMessage: boolean;
  promoteReason: string | null;
};

export type McpErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "no_active_turn"
  | "no_human_thread"
  | "not_found"
  | "bad_request"
  | "forbidden"
  | "target_busy"
  | "target_archived"
  | "runtime_offline"
  | "unsafe_memory"
  | "federation_off"
  | "conflict"
  | "no_forward"
  | "no_org_key"
  | "timeout"
  | "outbound_failed"
  | "peer_error"
  | "unknown_tool"
  | "reserved_name"
  | "cap"
  | "duplicate_name"
  | "invalid_assignee"
  | "invalid_thread"
  | "invalid_timezone"
  | "invalid_rrule"
  | "invalid_dtstart"
  | "unsupported_rrule"
  | "min_interval"
  | "cancelled"
  | "not_active"
  | "not_paused"
  | "not_proposed";

export class McpError extends Error {
  constructor(
    public readonly code: McpErrorCode,
    message: string,
    public readonly httpStatus = 409,
  ) {
    super(message);
    this.name = "McpError";
  }
}
