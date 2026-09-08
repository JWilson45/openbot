import { z } from "zod";
import {
  agentIdSchema,
  accountIdSchema,
  artifactIdSchema,
  interruptIdSchema,
  runIdSchema,
  taskIdSchema,
  threadIdSchema,
} from "./ids.ts";
import { jsonObjectSchema, jsonValueSchema, publicMetadataSchema } from "./json.ts";
import { CONTENT_PARTS_MAX, contentPartSchema } from "./messages.ts";

export const taskStatusSchema = z.enum([
  "submitted",
  "working",
  "input_required",
  "auth_required",
  "completed",
  "failed",
  "canceled",
  "rejected",
]);

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "interrupted",
  "completed",
  "failed",
  "canceled",
]);

export const conversationSchema = z
  .object({
    id: threadIdSchema,
    accountId: accountIdSchema,
    title: z.string().max(200).nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    metadata: publicMetadataSchema,
  })
  .strict();

export const taskSchema = z
  .object({
    id: taskIdSchema,
    accountId: accountIdSchema,
    threadId: threadIdSchema,
    agentId: agentIdSchema,
    status: taskStatusSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    metadata: publicMetadataSchema,
  })
  .strict();

export const runSchema = z
  .object({
    id: runIdSchema,
    accountId: accountIdSchema,
    taskId: taskIdSchema,
    threadId: threadIdSchema,
    agentId: agentIdSchema,
    attempt: z.number().int().positive(),
    status: runStatusSchema,
    providerSessionRef: z.string().min(1).max(512).nullable(),
    createdAt: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative().nullable(),
    finishedAt: z.number().int().nonnegative().nullable(),
    metadata: publicMetadataSchema,
  })
  .strict();

export const artifactSchema = z
  .object({
    id: artifactIdSchema,
    accountId: accountIdSchema,
    taskId: taskIdSchema,
    name: z.string().min(1).max(512).nullable(),
    description: z.string().max(4_000).nullable(),
    parts: z.array(contentPartSchema).max(CONTENT_PARTS_MAX),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    metadata: publicMetadataSchema,
  })
  .strict();

export const interruptKindSchema = z.enum(["permission", "input", "auth"]);
export const interruptStatusSchema = z.enum(["open", "resolved", "expired", "canceled"]);

export const interruptSchema = z
  .object({
    id: interruptIdSchema,
    accountId: accountIdSchema,
    taskId: taskIdSchema,
    runId: runIdSchema,
    kind: interruptKindSchema,
    prompt: z.string().min(1).max(32_000),
    responseSchema: jsonObjectSchema,
    status: interruptStatusSchema,
    response: jsonValueSchema.optional(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
    resolvedAt: z.number().int().nonnegative().nullable(),
    metadata: publicMetadataSchema,
  })
  .strict();

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Run = z.infer<typeof runSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type InterruptKind = z.infer<typeof interruptKindSchema>;
export type InterruptStatus = z.infer<typeof interruptStatusSchema>;
export type Interrupt = z.infer<typeof interruptSchema>;
