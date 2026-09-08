import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export const PUBLIC_METADATA_MAX_KEYS = 32;
export const PUBLIC_METADATA_MAX_BYTES = 16 * 1024;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(jsonValueSchema);

/** Small client-visible extensions only. Secrets and provider diagnostics never belong here. */
export const publicMetadataSchema: z.ZodType<JsonObject> = jsonObjectSchema.superRefine(
  (value, ctx) => {
    const keys = Object.keys(value);
    if (keys.length > PUBLIC_METADATA_MAX_KEYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "array",
        maximum: PUBLIC_METADATA_MAX_KEYS,
        inclusive: true,
        message: `metadata has more than ${PUBLIC_METADATA_MAX_KEYS} keys`,
      });
    }
    for (const key of keys) {
      if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "invalid metadata key" });
      }
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PUBLIC_METADATA_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `metadata exceeds ${PUBLIC_METADATA_MAX_BYTES} bytes`,
      });
    }
  },
);

export function isJsonValue(value: unknown): value is JsonValue {
  return jsonValueSchema.safeParse(value).success;
}
