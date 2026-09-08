import { z } from "zod";

export const accountIdSchema = z.string().uuid().brand<"AccountId">();
export const agentIdSchema = z.string().uuid().brand<"AgentId">();
export const threadIdSchema = z.string().uuid().brand<"ThreadId">();
export const taskIdSchema = z.string().uuid().brand<"TaskId">();
export const runIdSchema = z.string().uuid().brand<"RunId">();
export const messageIdSchema = z.string().uuid().brand<"MessageId">();
export const artifactIdSchema = z.string().uuid().brand<"ArtifactId">();
export const attachmentIdSchema = z.string().uuid().brand<"AttachmentId">();
export const interruptIdSchema = z.string().uuid().brand<"InterruptId">();
export const eventIdSchema = z.string().uuid().brand<"EventId">();

/** Protocol-owned identifiers are opaque and must never be treated as internal UUIDs. */
export const externalIdSchema = z.string().min(1).max(512).brand<"ExternalId">();

export type AccountId = z.infer<typeof accountIdSchema>;
export type AgentId = z.infer<typeof agentIdSchema>;
export type ThreadId = z.infer<typeof threadIdSchema>;
export type TaskId = z.infer<typeof taskIdSchema>;
export type RunId = z.infer<typeof runIdSchema>;
export type MessageId = z.infer<typeof messageIdSchema>;
export type ArtifactId = z.infer<typeof artifactIdSchema>;
export type AttachmentId = z.infer<typeof attachmentIdSchema>;
export type InterruptId = z.infer<typeof interruptIdSchema>;
export type EventId = z.infer<typeof eventIdSchema>;
export type ExternalId = z.infer<typeof externalIdSchema>;
