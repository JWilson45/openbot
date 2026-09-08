import { z } from "zod";
import {
  accountIdSchema,
  attachmentIdSchema,
  messageIdSchema,
  runIdSchema,
  taskIdSchema,
  threadIdSchema,
} from "./ids.ts";
import { jsonValueSchema, publicMetadataSchema } from "./json.ts";

export const CONTENT_PARTS_MAX = 64;
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

export const attachmentRefSchema = z
  .object({
    id: attachmentIdSchema,
    name: z.string().min(1).max(512).nullable(),
    mediaType: z.string().min(1).max(256),
    size: z.number().int().nonnegative().max(ATTACHMENT_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const contentPartSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      text: z.string().max(1_000_000),
      metadata: publicMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("data"),
      data: jsonValueSchema,
      mediaType: z.string().min(1).max(256).optional(),
      metadata: publicMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      attachment: attachmentRefSchema,
      metadata: publicMetadataSchema.optional(),
    })
    .strict(),
]);

export const messageRoleSchema = z.enum(["user", "agent", "system", "tool"]);

export const messageSchema = z
  .object({
    id: messageIdSchema,
    accountId: accountIdSchema,
    threadId: threadIdSchema,
    taskId: taskIdSchema.nullable(),
    runId: runIdSchema.nullable(),
    role: messageRoleSchema,
    parts: z.array(contentPartSchema).min(1).max(CONTENT_PARTS_MAX),
    createdAt: z.number().int().nonnegative(),
    metadata: publicMetadataSchema,
  })
  .strict();

export type ContentPart = z.infer<typeof contentPartSchema>;
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
export type MessageRole = z.infer<typeof messageRoleSchema>;
export type Message = z.infer<typeof messageSchema>;
