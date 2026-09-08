import { z } from "zod";
import {
  accountIdSchema,
  agentIdSchema,
  eventIdSchema,
  interruptIdSchema,
  messageIdSchema,
  runIdSchema,
  taskIdSchema,
  threadIdSchema,
} from "./ids.ts";
import { jsonObjectSchema, jsonValueSchema, publicMetadataSchema, type JsonObject } from "./json.ts";
import { contentPartSchema, messageRoleSchema } from "./messages.ts";
import { artifactSchema, interruptSchema, runStatusSchema, taskStatusSchema } from "./tasks.ts";

export const OPENBOT_EVENT_VERSION = 1 as const;

export const canonicalEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task.status.changed"),
    data: z.object({ from: taskStatusSchema.nullable(), to: taskStatusSchema, reason: z.string().max(2_000).optional() }).strict(),
  }).strict(),
  z.object({
    type: z.literal("run.status.changed"),
    data: z.object({
      from: runStatusSchema.nullable(),
      to: runStatusSchema,
      reason: z.string().max(2_000).optional(),
      error: z.object({
        code: z.string().min(1).max(128),
        message: z.string().max(8_000),
        retryable: z.boolean(),
      }).strict().optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("message.started"),
    data: z.object({ messageId: messageIdSchema, role: messageRoleSchema }).strict(),
  }).strict(),
  z.object({
    type: z.literal("message.text.delta"),
    data: z.object({ messageId: messageIdSchema, delta: z.string().min(1).max(256_000) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("message.finished"),
    data: z.object({ messageId: messageIdSchema, parts: z.array(contentPartSchema).min(1).max(64) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("reasoning.summary.delta"),
    data: z.object({ messageId: messageIdSchema.optional(), delta: z.string().min(1).max(256_000) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("action.started"),
    data: z.object({ actionCallId: z.string().min(1).max(512), name: z.string().min(1).max(512) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("action.arguments.delta"),
    data: z.object({ actionCallId: z.string().min(1).max(512), delta: z.string().min(1).max(256_000) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("action.finished"),
    data: z.object({
      actionCallId: z.string().min(1).max(512),
      output: jsonValueSchema.optional(),
      outcome: z.enum(["success", "failure"]),
    }).strict(),
  }).strict(),
  z.object({ type: z.literal("artifact.updated"), data: z.object({ artifact: artifactSchema }).strict() }).strict(),
  z.object({
    type: z.literal("interrupt.requested"),
    data: z.object({ interrupt: interruptSchema }).strict(),
  }).strict(),
  z.object({
    type: z.literal("interrupt.resolved"),
    data: z.object({
      interruptId: interruptIdSchema,
      response: jsonValueSchema.optional(),
      status: z.enum(["resolved", "expired", "canceled"]),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("activity.updated"),
    data: z.object({ label: z.string().min(1).max(2_000), progress: z.number().min(0).max(1).optional() }).strict(),
  }).strict(),
]);

export const canonicalEventTypeSchema = z.enum([
  "task.status.changed",
  "run.status.changed",
  "message.started",
  "message.text.delta",
  "message.finished",
  "reasoning.summary.delta",
  "action.started",
  "action.arguments.delta",
  "action.finished",
  "artifact.updated",
  "interrupt.requested",
  "interrupt.resolved",
  "activity.updated",
]);

export type CanonicalEvent = z.infer<typeof canonicalEventSchema>;

type TaskEventEnvelopeBase = {
  version: typeof OPENBOT_EVENT_VERSION;
  eventId: z.infer<typeof eventIdSchema>;
  accountId: z.infer<typeof accountIdSchema>;
  taskId: z.infer<typeof taskIdSchema>;
  agentId: z.infer<typeof agentIdSchema>;
  threadId: z.infer<typeof threadIdSchema>;
  seq: number;
  time: number;
  metadata: JsonObject;
};

type RunlessCanonicalEvent = Extract<CanonicalEvent, { type: "task.status.changed" | "artifact.updated" }>;
type RunCanonicalEvent = Exclude<CanonicalEvent, RunlessCanonicalEvent>;

export type TaskEventEnvelope = TaskEventEnvelopeBase &
  ((RunlessCanonicalEvent & { runId: z.infer<typeof runIdSchema> | null }) |
    (RunCanonicalEvent & { runId: z.infer<typeof runIdSchema> }));

const uncheckedTaskEventEnvelopeSchema = z.object({
  version: z.literal(OPENBOT_EVENT_VERSION),
  eventId: eventIdSchema,
  accountId: accountIdSchema,
  taskId: taskIdSchema,
  runId: runIdSchema.nullable(),
  agentId: agentIdSchema,
  threadId: threadIdSchema,
  seq: z.number().int().positive(),
  time: z.number().int().nonnegative(),
  type: canonicalEventTypeSchema,
  data: jsonObjectSchema,
  metadata: publicMetadataSchema,
}).strict();

const runRequired = new Set<CanonicalEvent["type"]>([
  "run.status.changed",
  "message.started",
  "message.text.delta",
  "message.finished",
  "reasoning.summary.delta",
  "action.started",
  "action.arguments.delta",
  "action.finished",
  "interrupt.requested",
  "interrupt.resolved",
  "activity.updated",
]);

export const taskEventEnvelopeSchema = uncheckedTaskEventEnvelopeSchema
  .superRefine((value, ctx) => {
    const parsed = canonicalEventSchema.safeParse({ type: value.type, data: value.data });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          ...issue,
          path: issue.path[0] === "data" ? ["data", ...issue.path.slice(1)] : issue.path,
        });
      }
      return;
    }
    if (runRequired.has(parsed.data.type) && value.runId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runId"], message: "runId is required for this event" });
    }
    if (parsed.data.type === "artifact.updated") {
      if (parsed.data.data.artifact.taskId !== value.taskId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data", "artifact", "taskId"], message: "artifact taskId does not match envelope" });
      }
      if (parsed.data.data.artifact.accountId !== value.accountId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data", "artifact", "accountId"], message: "artifact accountId does not match envelope" });
      }
    }
    if (parsed.data.type === "interrupt.requested") {
      const interrupt = parsed.data.data.interrupt;
      if (interrupt.taskId !== value.taskId || interrupt.runId !== value.runId || interrupt.accountId !== value.accountId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data", "interrupt"], message: "interrupt identity does not match envelope" });
      }
    }
  })
  .transform((value) => value as TaskEventEnvelope);
