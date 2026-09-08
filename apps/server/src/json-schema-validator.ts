import type { JsonObject, JsonValue } from "@openbot/core";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolves(root: JsonObject, pointer: string): unknown {
  if (!pointer.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const raw of pointer.slice(2).split("/")) {
    if (!record(current)) return undefined;
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    current = current[key];
  }
  return current;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "string": return typeof value === "string";
    case "array": return Array.isArray(value);
    case "object": return record(value);
    default: return false;
  }
}

/** Synchronous JSON Schema 2020-12 validator for the portable action/interrupt subset. */
export function validateJsonSchema(schema: JsonObject, value: JsonValue): boolean {
  const visit = (candidate: unknown, node: unknown, depth: number): boolean => {
    if (depth > 64 || !record(node)) return false;
    if (node.$ref !== undefined) {
      if (typeof node.$ref !== "string") return false;
      const target = resolves(schema, node.$ref);
      return target !== undefined && visit(candidate, target, depth + 1);
    }
    if (node.const !== undefined && !equal(candidate, node.const)) return false;
    if (Array.isArray(node.enum) && !node.enum.some((item) => equal(candidate, item))) return false;
    if (Array.isArray(node.allOf) && !node.allOf.every((item) => visit(candidate, item, depth + 1))) return false;
    if (Array.isArray(node.anyOf) && !node.anyOf.some((item) => visit(candidate, item, depth + 1))) return false;
    if (Array.isArray(node.oneOf) && node.oneOf.filter((item) => visit(candidate, item, depth + 1)).length !== 1) return false;
    if (record(node.not) && visit(candidate, node.not, depth + 1)) return false;

    const types = typeof node.type === "string" ? [node.type] : Array.isArray(node.type) ? node.type : [];
    if (types.length > 0 && !types.some((type) => typeof type === "string" && matchesType(type, candidate))) return false;

    if (typeof candidate === "string") {
      if (typeof node.minLength === "number" && candidate.length < node.minLength) return false;
      if (typeof node.maxLength === "number" && candidate.length > node.maxLength) return false;
      if (typeof node.pattern === "string") {
        try { if (!new RegExp(node.pattern, "u").test(candidate)) return false; } catch { return false; }
      }
    }
    if (typeof candidate === "number") {
      if (typeof node.minimum === "number" && candidate < node.minimum) return false;
      if (typeof node.maximum === "number" && candidate > node.maximum) return false;
      if (typeof node.exclusiveMinimum === "number" && candidate <= node.exclusiveMinimum) return false;
      if (typeof node.exclusiveMaximum === "number" && candidate >= node.exclusiveMaximum) return false;
      if (typeof node.multipleOf === "number" && (node.multipleOf <= 0 || Math.abs(candidate / node.multipleOf - Math.round(candidate / node.multipleOf)) > Number.EPSILON)) return false;
    }
    if (Array.isArray(candidate)) {
      if (typeof node.minItems === "number" && candidate.length < node.minItems) return false;
      if (typeof node.maxItems === "number" && candidate.length > node.maxItems) return false;
      if (node.uniqueItems === true && new Set(candidate.map((item) => JSON.stringify(item))).size !== candidate.length) return false;
      if (node.items !== undefined && !candidate.every((item) => visit(item, node.items, depth + 1))) return false;
    }
    if (record(candidate)) {
      const properties = record(node.properties) ? node.properties : {};
      if (Array.isArray(node.required)) {
        for (const key of node.required) if (typeof key !== "string" || !Object.hasOwn(candidate, key)) return false;
      }
      const keys = Object.keys(candidate);
      if (typeof node.minProperties === "number" && keys.length < node.minProperties) return false;
      if (typeof node.maxProperties === "number" && keys.length > node.maxProperties) return false;
      for (const [key, child] of Object.entries(properties)) {
        if (Object.hasOwn(candidate, key) && !visit(candidate[key], child, depth + 1)) return false;
      }
      for (const key of keys) {
        if (Object.hasOwn(properties, key)) continue;
        if (node.additionalProperties === false) return false;
        if (record(node.additionalProperties) && !visit(candidate[key], node.additionalProperties, depth + 1)) return false;
      }
    }
    return true;
  };
  return visit(value, schema, 0);
}
