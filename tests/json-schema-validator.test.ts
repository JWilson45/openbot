import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@openbot/core";
import { validateJsonSchema } from "../apps/server/src/json-schema-validator.ts";

describe("application JSON Schema validator", () => {
  test("validates nested response schemas and local references", () => {
    const schema = {
      type: "object",
      properties: {
        choice: { $ref: "#/$defs/choice" },
        count: { type: "integer", minimum: 1 },
      },
      required: ["choice", "count"],
      additionalProperties: false,
      $defs: { choice: { enum: ["yes", "no"] } },
    } satisfies JsonObject;
    expect(validateJsonSchema(schema, { choice: "yes", count: 2 })).toBe(true);
    expect(validateJsonSchema(schema, { choice: "maybe", count: 2 })).toBe(false);
    expect(validateJsonSchema(schema, { choice: "yes", count: 0 })).toBe(false);
    expect(validateJsonSchema(schema, { choice: "yes", count: 2, extra: true })).toBe(false);
  });
});
