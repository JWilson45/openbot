import { z } from "zod";
import { accountIdSchema, agentIdSchema } from "./ids.ts";
import { jsonObjectSchema, publicMetadataSchema } from "./json.ts";

export const stableNameSchema = z.string().trim().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/);

export const runtimeProviderConfigSchema = z
  .object({
    providerId: stableNameSchema,
    modelId: z.string().trim().min(1).max(256),
    options: jsonObjectSchema,
  })
  .strict();

export const runtimeCapabilitySchema = z.enum([
  "streaming",
  "resume",
  "cancellation",
  "actions",
  "interrupts",
  "reasoning_summaries",
  "attachments",
]);

export const runtimeCapabilitiesSchema = z
  .object({
    supported: z.array(runtimeCapabilitySchema),
    extensions: z.array(z.string().min(1).max(256).regex(/^x\.[a-z0-9][a-z0-9._-]*$/)),
  })
  .strict();

export const runtimeModelDescriptorSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    label: z.string().trim().min(1).max(256),
    description: z.string().max(2_000).optional(),
    reasoningEfforts: z.array(z.string().trim().min(1).max(64)),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const runtimeAuthMethodSchema = z
  .object({
    id: stableNameSchema,
    label: z.string().trim().min(1).max(128),
    kind: z.enum(["none", "api_key", "oauth2", "external"]),
    documentationUrl: z.string().url().optional(),
  })
  .strict();

export const runtimeAuthStateSchema = z
  .object({
    status: z.enum(["not_required", "ready", "missing", "error"]),
    methodId: z.string().min(1).max(128).optional(),
    message: z.string().max(2_000).optional(),
  })
  .strict();

export const runtimeProviderDescriptorSchema = z
  .object({
    id: stableNameSchema,
    label: z.string().trim().min(1).max(128),
    authMethods: z.array(runtimeAuthMethodSchema),
  })
  .strict();

export const agentSchema = z
  .object({
    id: agentIdSchema,
    accountId: accountIdSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().max(4_000),
    runtime: runtimeProviderConfigSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    metadata: publicMetadataSchema,
  })
  .strict();

export type RuntimeProviderConfig = z.infer<typeof runtimeProviderConfigSchema>;
export type RuntimeCapability = z.infer<typeof runtimeCapabilitySchema>;
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>;
export type RuntimeModelDescriptor = z.infer<typeof runtimeModelDescriptorSchema>;
export type RuntimeAuthMethod = z.infer<typeof runtimeAuthMethodSchema>;
export type RuntimeAuthState = z.infer<typeof runtimeAuthStateSchema>;
export type RuntimeProviderDescriptor = z.infer<typeof runtimeProviderDescriptorSchema>;
export type Agent = z.infer<typeof agentSchema>;
