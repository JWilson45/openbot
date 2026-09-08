import { describe, expect, test } from "bun:test";
import {
  canonicalEventSchema,
  messageIdSchema,
  taskEventEnvelopeSchema,
  type CanonicalEvent,
} from "../packages/core/src/index.ts";

const uuid = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;

function envelope(event: CanonicalEvent) {
  return {
    version: 1,
    eventId: uuid("1"),
    accountId: uuid("9"),
    taskId: uuid("2"),
    runId: uuid("3"),
    agentId: uuid("4"),
    threadId: uuid("5"),
    seq: 1,
    time: 1_700_000_000_000,
    metadata: {},
    ...event,
  };
}

describe("canonical event contracts", () => {
  test("event discriminants validate their own data", () => {
    expect(
      canonicalEventSchema.parse({ type: "run.status.changed", data: { from: "queued", to: "running" } }).type,
    ).toBe("run.status.changed");
    expect(() =>
      canonicalEventSchema.parse({ type: "run.status.changed", data: { from: "queued", to: "unknown" } }),
    ).toThrow();
    expect(() => canonicalEventSchema.parse({ type: "unknown", data: {} })).toThrow();
  });

  test("every frozen canonical event variant validates", () => {
    const accountId = uuid("9");
    const taskId = uuid("2");
    const runId = uuid("3");
    const fixtures: unknown[] = [
      { type: "task.status.changed", data: { from: null, to: "submitted" } },
      { type: "run.status.changed", data: { from: "running", to: "interrupted" } },
      { type: "message.started", data: { messageId: uuid("6"), role: "agent" } },
      { type: "message.text.delta", data: { messageId: uuid("6"), delta: "hello" } },
      { type: "message.finished", data: { messageId: uuid("6"), parts: [{ kind: "text", text: "hello" }] } },
      { type: "reasoning.summary.delta", data: { messageId: uuid("6"), delta: "summary" } },
      { type: "action.started", data: { actionCallId: "c1", name: "search" } },
      { type: "action.arguments.delta", data: { actionCallId: "c1", delta: "{}" } },
      { type: "action.finished", data: { actionCallId: "c1", outcome: "success", output: {} } },
      {
        type: "artifact.updated",
        data: {
          artifact: {
            id: uuid("7"),
            accountId,
            taskId,
            name: "result",
            description: null,
            parts: [{ kind: "text", text: "done" }],
            createdAt: 1,
            updatedAt: 1,
            metadata: {},
          },
        },
      },
      {
        type: "interrupt.requested",
        data: {
          interrupt: {
            id: uuid("8"),
            accountId,
            taskId,
            runId,
            kind: "permission",
            prompt: "Allow?",
            responseSchema: { type: "boolean" },
            status: "open",
            createdAt: 1,
            expiresAt: null,
            resolvedAt: null,
            metadata: {},
          },
        },
      },
      { type: "interrupt.resolved", data: { interruptId: uuid("8"), response: true, status: "resolved" } },
      { type: "activity.updated", data: { label: "Working", progress: 0.5 } },
    ];
    const parsed = fixtures.map((fixture) => canonicalEventSchema.parse(fixture));
    expect(parsed).toHaveLength(13);
    for (const event of parsed) expect(taskEventEnvelopeSchema.parse(envelope(event)).type).toBe(event.type);
  });

  test("durable envelope enforces identity, ordering, and event payload", () => {
    expect(
      taskEventEnvelopeSchema.parse(
        envelope({
          type: "message.text.delta",
          data: { messageId: messageIdSchema.parse(uuid("6")), delta: "ok" },
        }),
      ).seq,
    ).toBe(1);
    expect(() =>
      taskEventEnvelopeSchema.parse({
        ...envelope({ type: "run.status.changed", data: { from: "queued", to: "running" } }),
        seq: 0,
      }),
    ).toThrow();
    expect(() =>
      taskEventEnvelopeSchema.parse({
        ...envelope({ type: "run.status.changed", data: { from: "queued", to: "running" } }),
        runId: null,
      }),
    ).toThrow();
  });

  test("raw reasoning is not a canonical event", () => {
    expect(() => canonicalEventSchema.parse({ type: "reasoning.delta", data: { delta: "private" } })).toThrow();
    expect(
      canonicalEventSchema.parse({ type: "reasoning.summary.delta", data: { delta: "safe summary" } }).type,
    ).toBe("reasoning.summary.delta");
  });

  test("embedded aggregate identities must match the envelope", () => {
    const event = canonicalEventSchema.parse({
      type: "artifact.updated",
      data: {
        artifact: {
          id: uuid("7"),
          accountId: uuid("9"),
          taskId: uuid("8"),
          name: null,
          description: null,
          parts: [],
          createdAt: 1,
          updatedAt: 1,
          metadata: {},
        },
      },
    });
    expect(() => taskEventEnvelopeSchema.parse(envelope(event))).toThrow("artifact taskId does not match envelope");
  });
});
