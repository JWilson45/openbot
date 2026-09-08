import type { IdGenerator } from "@openbot/application";
import {
  accountIdSchema,
  agentIdSchema,
  artifactIdSchema,
  attachmentIdSchema,
  eventIdSchema,
  externalIdSchema,
  interruptIdSchema,
  messageIdSchema,
  runIdSchema,
  taskIdSchema,
  threadIdSchema,
} from "@openbot/core";

export const uuidIdGenerator: IdGenerator = {
  accountId: () => accountIdSchema.parse(crypto.randomUUID()),
  agentId: () => agentIdSchema.parse(crypto.randomUUID()),
  threadId: () => threadIdSchema.parse(crypto.randomUUID()),
  taskId: () => taskIdSchema.parse(crypto.randomUUID()),
  runId: () => runIdSchema.parse(crypto.randomUUID()),
  messageId: () => messageIdSchema.parse(crypto.randomUUID()),
  artifactId: () => artifactIdSchema.parse(crypto.randomUUID()),
  attachmentId: () => attachmentIdSchema.parse(crypto.randomUUID()),
  interruptId: () => interruptIdSchema.parse(crypto.randomUUID()),
  eventId: () => eventIdSchema.parse(crypto.randomUUID()),
  externalId: () => externalIdSchema.parse(crypto.randomUUID()),
};
