import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_MAX_BYTES,
  PUBLIC_METADATA_MAX_BYTES,
  attachmentRefSchema,
  agentSchema,
  contentPartSchema,
  isJsonValue,
  publicMetadataSchema,
  runtimeEventDraftSchema,
  runtimeProviderConfigSchema,
  taskSchema,
} from "../packages/core/src/index.ts";

const uuid = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;

describe("provider-neutral core contracts", () => {
  test("provider configuration has one stable shape", () => {
    const parsed = runtimeProviderConfigSchema.parse({
      providerId: "scripted",
      modelId: "test-model",
      options: { temperature: 0, flags: [true, null] },
    });
    expect(parsed.providerId).toBe("scripted");
    expect(() => runtimeProviderConfigSchema.parse({ harness: "grok", model: "grok-3" })).toThrow();
  });

  test("agent and task identifiers cannot accept arbitrary external ids", () => {
    expect(() =>
      agentSchema.parse({
        id: "external-agent",
        accountId: uuid("9"),
        name: "Ada",
        description: "",
        runtime: { providerId: "scripted", modelId: "test", options: {} },
        createdAt: 1,
        updatedAt: 1,
        metadata: {},
      }),
    ).toThrow();

    expect(
      taskSchema.parse({
        id: uuid("1"),
        accountId: uuid("9"),
        threadId: uuid("2"),
        agentId: uuid("3"),
        status: "submitted",
        createdAt: 1,
        updatedAt: 1,
        metadata: {},
      }).status,
    ).toBe("submitted");
  });

  test("content is multipart and JSON values reject non-finite or undefined values", () => {
    expect(contentPartSchema.parse({ kind: "text", text: "hello" })).toEqual({ kind: "text", text: "hello" });
    expect(isJsonValue({ nested: [1, true, null] })).toBe(true);
    expect(isJsonValue({ bad: undefined })).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
  });

  test("attachments are stored references and public metadata is bounded", () => {
    const attachment = attachmentRefSchema.parse({
      id: uuid("8"),
      name: "report.txt",
      mediaType: "text/plain",
      size: ATTACHMENT_MAX_BYTES,
      sha256: "a".repeat(64),
    });
    expect(contentPartSchema.parse({ kind: "file", attachment }).kind).toBe("file");
    expect(() =>
      contentPartSchema.parse({ kind: "file", source: { kind: "uri", uri: "http://169.254.169.254" } }),
    ).toThrow();
    expect(() => attachmentRefSchema.parse({ ...attachment, size: ATTACHMENT_MAX_BYTES + 1 })).toThrow();
    expect(publicMetadataSchema.parse({ "io.openbot.trace": "ok" })).toEqual({ "io.openbot.trace": "ok" });
    expect(() => publicMetadataSchema.parse({ BadKey: "no" })).toThrow();
    expect(() => publicMetadataSchema.parse({ data: "x".repeat(PUBLIC_METADATA_MAX_BYTES) })).toThrow();
  });

  test("runtime drafts contain provider events but no durable sequence fields", () => {
    const draft = runtimeEventDraftSchema.parse({
      type: "message.text.delta",
      data: { providerMessageRef: "assistant-1", delta: "hi" },
    });
    expect(draft.type).toBe("message.text.delta");
    expect(() =>
      runtimeEventDraftSchema.parse({
        type: "message.text.delta",
        data: { providerMessageRef: "assistant-1", delta: "hi" },
        seq: 1,
      }),
    ).toThrow();
    expect(() =>
      runtimeEventDraftSchema.parse({
        type: "reasoning.delta",
        data: { delta: "private", visibility: "private" },
      }),
    ).toThrow();
  });

  test("every frozen runtime draft variant validates", () => {
    const drafts = [
      { type: "message.started", data: { providerMessageRef: "m1", role: "agent" } },
      { type: "message.text.delta", data: { providerMessageRef: "m1", delta: "hello" } },
      { type: "message.finished", data: { providerMessageRef: "m1", parts: [{ kind: "text", text: "hello" }] } },
      { type: "reasoning.summary.delta", data: { providerMessageRef: "m1", delta: "summary" } },
      { type: "action.started", data: { providerCallRef: "c1", name: "search" } },
      { type: "action.arguments.delta", data: { providerCallRef: "c1", delta: "{}" } },
      { type: "action.finished", data: { providerCallRef: "c1", outcome: "success", output: {} } },
      { type: "interrupt.requested", data: { providerRequestRef: "i1", kind: "input", prompt: "Value?", responseSchema: { type: "string" } } },
      { type: "activity.updated", data: { label: "Working", progress: 0.5 } },
      { type: "completed", data: { stopReason: "end_turn" } },
      { type: "failed", data: { code: "provider", message: "failed", retryable: false } },
    ];
    expect(drafts.map((draft) => runtimeEventDraftSchema.parse(draft).type)).toHaveLength(11);
  });
});
