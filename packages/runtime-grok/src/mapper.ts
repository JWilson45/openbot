import type { LiveWorkEvent } from "@openbot/compute-protocol";
import {
  runtimeEventDraftSchema,
  type JsonObject,
  type JsonValue,
  type RuntimeEventDraft,
} from "@openbot/core";

type OpenTool = {
  runtimeRef: string;
  name: string;
  argumentsSent: boolean;
};

/** Strict, stateful ACP live-work mapper. Known malformed events fail closed. */
export class GrokLiveEventMapper {
  #messageRef?: string;
  #messageText = "";
  #messageCounter = 0;
  #toolCounter = 0;
  #openTools = new Map<string, OpenTool>();
  #closedTools = new Set<string>();
  #terminal = false;

  get terminal(): boolean {
    return this.#terminal;
  }

  map(event: LiveWorkEvent): RuntimeEventDraft[] {
    if (this.#terminal) throw new Error("ACP event received after terminal runtime event");
    if (!event || typeof event !== "object" || !isRecord(event.payload)) {
      throw new Error("malformed ACP live-work event");
    }
    switch (event.kind) {
      case "agent_message_chunk":
        return this.#messageChunk(event.payload);
      case "tool_call":
        return this.#toolCall(event.payload, false);
      case "tool_call_update":
        return this.#toolCall(event.payload, true);
      case "permission_request":
        return this.#permission(event.payload);
      case "agent_thought_chunk":
      case "harness_stderr":
      case "stderr":
      case "raw":
      case "acp_request":
      case "acp_notify":
        return [];
      default:
        // Unknown provider events remain diagnostics inside the host boundary.
        return [];
    }
  }

  complete(stopReason?: string): RuntimeEventDraft[] {
    this.#assertNotTerminal();
    if (this.#openTools.size > 0) {
      return this.fail("malformed_tool_stream", "Grok ended with an open tool call", false);
    }
    const events = this.#finishMessage();
    events.push(this.#checked({ type: "completed", data: { ...(stopReason ? { stopReason } : {}) } }));
    this.#terminal = true;
    return events;
  }

  fail(code: string, message: string, retryable: boolean): RuntimeEventDraft[] {
    this.#assertNotTerminal();
    const events = this.#finishMessage();
    for (const tool of this.#openTools.values()) {
      if (!tool.argumentsSent) {
        events.push(
          this.#checked({
            type: "action.arguments.delta",
            data: { providerCallRef: tool.runtimeRef, delta: "{}" },
          }),
        );
      }
      events.push(
        this.#checked({
          type: "action.finished",
          data: {
            providerCallRef: tool.runtimeRef,
            outcome: "failure",
            output: { error: "tool stream did not complete" },
          },
        }),
      );
    }
    this.#openTools.clear();
    events.push(this.#checked({ type: "failed", data: { code, message, retryable } }));
    this.#terminal = true;
    return events;
  }

  #messageChunk(payload: Record<string, unknown>): RuntimeEventDraft[] {
    const update = eventUpdate(payload);
    const delta = contentText(update.content);
    if (!delta) throw new Error("agent_message_chunk has no text content");
    const events: RuntimeEventDraft[] = [];
    if (this.#messageRef === undefined) {
      this.#messageCounter += 1;
      this.#messageRef = `grok-message-${this.#messageCounter}`;
      events.push(
        this.#checked({
          type: "message.started",
          data: { providerMessageRef: this.#messageRef, role: "agent" },
        }),
      );
    }
    this.#messageText += delta;
    events.push(
      this.#checked({
        type: "message.text.delta",
        data: { providerMessageRef: this.#messageRef, delta },
      }),
    );
    return events;
  }

  #toolCall(payload: Record<string, unknown>, updateOnly: boolean): RuntimeEventDraft[] {
    const update = eventUpdate(payload);
    const providerRef = requiredString(
      update.toolCallId ?? update.tool_call_id ?? update.id ?? payload.toolCallId,
      "tool call reference",
    );
    if (this.#closedTools.has(providerRef)) throw new Error("tool call emitted an update after completion");
    let tool = this.#openTools.get(providerRef);
    const events: RuntimeEventDraft[] = [];
    if (tool === undefined) {
      this.#toolCounter += 1;
      tool = {
        runtimeRef: `grok-call-${this.#toolCounter}`,
        name: safeToolName(update.kind ?? update.name ?? update.title),
        argumentsSent: false,
      };
      this.#openTools.set(providerRef, tool);
      events.push(
        this.#checked({
          type: "action.started",
          data: { providerCallRef: tool.runtimeRef, name: tool.name },
        }),
      );
    } else if (!updateOnly) {
      throw new Error("tool call started twice");
    }

    const input = update.rawInput ?? update.raw_input ?? update.input ?? update.arguments ?? update.args;
    if (!tool.argumentsSent && (input !== undefined || !updateOnly)) {
      events.push(
        this.#checked({
          type: "action.arguments.delta",
          data: { providerCallRef: tool.runtimeRef, delta: jsonArguments(input) },
        }),
      );
      tool.argumentsSent = true;
    }

    const status = typeof update.status === "string" ? update.status.toLowerCase() : "";
    if (["completed", "complete", "succeeded", "success", "failed", "error", "cancelled", "canceled"].includes(status)) {
      if (!tool.argumentsSent) {
        events.push(
          this.#checked({
            type: "action.arguments.delta",
            data: { providerCallRef: tool.runtimeRef, delta: "{}" },
          }),
        );
      }
      const failed = ["failed", "error", "cancelled", "canceled"].includes(status);
      const output = update.rawOutput ?? update.raw_output ?? update.output ?? safeToolContent(update.content);
      events.push(
        this.#checked({
          type: "action.finished",
          data: {
            providerCallRef: tool.runtimeRef,
            outcome: failed ? "failure" : "success",
            ...(output === undefined ? {} : { output: sanitizeJson(output) }),
          },
        }),
      );
      this.#openTools.delete(providerRef);
      this.#closedTools.add(providerRef);
      return events;
    }

    if (updateOnly) {
      events.push(
        this.#checked({
          type: "activity.updated",
          data: { label: "Grok tool is running" },
        }),
      );
    }
    return events;
  }

  #permission(payload: Record<string, unknown>): RuntimeEventDraft[] {
    const update = eventUpdate(payload);
    const providerRequestRef = requiredString(
      payload.reqId ?? payload.requestId ?? payload.rpcId ?? update.reqId,
      "permission request reference",
    );
    const toolCall = isRecord(payload.toolCall)
      ? payload.toolCall
      : isRecord(update.toolCall)
        ? update.toolCall
        : undefined;
    const title = toolCall === undefined ? undefined : optionalString(toolCall.title);
    const events = this.#finishMessage();
    for (const tool of this.#openTools.values()) {
      if (!tool.argumentsSent) {
        events.push(
          this.#checked({
            type: "action.arguments.delta",
            data: { providerCallRef: tool.runtimeRef, delta: "{}" },
          }),
        );
      }
      events.push(
        this.#checked({
          type: "action.finished",
          data: {
            providerCallRef: tool.runtimeRef,
            outcome: "failure",
            output: { status: "permission_required" },
          },
        }),
      );
    }
    this.#openTools.clear();
    events.push(
      this.#checked({
        type: "interrupt.requested",
        data: {
          providerRequestRef,
          kind: "permission",
          prompt: title ? `Allow Grok to ${title.slice(0, 1_900)}?` : "Allow the requested Grok action?",
          responseSchema: { type: "boolean" },
        },
      }),
    );
    return events;
  }

  #finishMessage(): RuntimeEventDraft[] {
    if (this.#messageRef === undefined) return [];
    const event = this.#checked({
      type: "message.finished",
      data: {
        providerMessageRef: this.#messageRef,
        parts: [{ kind: "text", text: this.#messageText }],
      },
    });
    this.#messageRef = undefined;
    this.#messageText = "";
    return [event];
  }

  #assertNotTerminal(): void {
    if (this.#terminal) throw new Error("duplicate terminal runtime event");
  }

  #checked(value: unknown): RuntimeEventDraft {
    return runtimeEventDraftSchema.parse(value);
  }
}

function eventUpdate(payload: Record<string, unknown>): Record<string, unknown> {
  return isRecord(payload.update) ? payload.update : payload;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("");
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return "";
}

function safeToolContent(content: unknown): JsonValue | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = contentText(content);
    return text || sanitizeJson(content);
  }
  return sanitizeJson(content);
}

function jsonArguments(value: unknown): string {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      const normalized = isRecord(parsed) ? parsed : { value: parsed };
      return JSON.stringify(sanitizeJson(normalized));
    } catch {
      return JSON.stringify({ value });
    }
  }
  return JSON.stringify(sanitizeJson(value === undefined ? {} : isRecord(value) ? value : { value }));
}

function sanitizeJson(value: unknown, key = "", depth = 0): JsonValue {
  if (/token|secret|password|authorization|cookie|api[_-]?key/i.test(key)) return "[redacted]";
  if (depth > 32) return "[truncated]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => sanitizeJson(item, "", depth + 1));
  if (isRecord(value)) {
    const output: JsonObject = {};
    for (const [entryKey, entryValue] of Object.entries(value).slice(0, 1_000)) {
      output[entryKey] = sanitizeJson(entryValue, entryKey, depth + 1);
    }
    return output;
  }
  return String(value);
}

function safeToolName(value: unknown): string {
  const candidate = optionalString(value)?.trim();
  return candidate ? candidate.slice(0, 512) : "grok_tool";
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result || result.length > 512) throw new Error(`${label} is missing or invalid`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
