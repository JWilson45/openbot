import { z } from "zod";
import { interruptKindSchema } from "./tasks.ts";
import { CONTENT_PARTS_MAX, contentPartSchema } from "./messages.ts";
import { jsonObjectSchema, jsonValueSchema } from "./json.ts";

const providerRefSchema = z.string().min(1).max(512);

/** Provider-emitted events before the application assigns durable identity and ordering. */
export const runtimeEventDraftSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message.started"),
    data: z.object({ providerMessageRef: providerRefSchema, role: z.enum(["agent", "tool"]) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("message.text.delta"),
    data: z.object({ providerMessageRef: providerRefSchema, delta: z.string().min(1).max(256_000) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("message.finished"),
    data: z.object({
      providerMessageRef: providerRefSchema,
      parts: z.array(contentPartSchema).max(CONTENT_PARTS_MAX),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("reasoning.summary.delta"),
    data: z.object({
      providerMessageRef: providerRefSchema.optional(),
      delta: z.string().min(1).max(256_000),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("action.started"),
    data: z.object({ providerCallRef: providerRefSchema, name: z.string().min(1).max(512) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("action.arguments.delta"),
    data: z.object({ providerCallRef: providerRefSchema, delta: z.string().min(1).max(256_000) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("action.finished"),
    data: z.object({
      providerCallRef: providerRefSchema,
      output: jsonValueSchema.optional(),
      outcome: z.enum(["success", "failure"]),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("interrupt.requested"),
    data: z.object({
      providerRequestRef: providerRefSchema,
      kind: interruptKindSchema,
      prompt: z.string().min(1).max(32_000),
      responseSchema: jsonObjectSchema,
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("activity.updated"),
    data: z.object({ label: z.string().min(1).max(2_000), progress: z.number().min(0).max(1).optional() }).strict(),
  }).strict(),
  z.object({
    type: z.literal("completed"),
    data: z.object({ stopReason: z.string().max(256).optional() }).strict(),
  }).strict(),
  z.object({
    type: z.literal("failed"),
    data: z.object({ code: z.string().min(1).max(128), message: z.string().max(8_000), retryable: z.boolean() }).strict(),
  }).strict(),
]);

export type RuntimeEventDraft = z.infer<typeof runtimeEventDraftSchema>;
