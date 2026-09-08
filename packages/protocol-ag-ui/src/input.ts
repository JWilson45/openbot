import type {
  AttachmentPort,
  ProtocolPrincipal,
  TaskInputMessage,
} from "@openbot/application";
import type { ContentPart, JsonValue } from "@openbot/core";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { AgUiIdentityMap } from "./identity.ts";
import { AgUiAdapterError, type AgUiLimits } from "./types.ts";

export type OpenBotForwardedProps = {
  taskId?: string;
};

export function readOpenBotForwardedProps(value: unknown): OpenBotForwardedProps {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new AgUiAdapterError("invalid_forwarded_props", "forwardedProps must be an object", 400);
  }
  const extension = value.openbot;
  if (extension === undefined || extension === null) return {};
  if (!isRecord(extension)) {
    throw new AgUiAdapterError(
      "invalid_forwarded_props",
      "forwardedProps.openbot must be an object",
      400,
    );
  }
  if (extension.taskId !== undefined && typeof extension.taskId !== "string") {
    throw new AgUiAdapterError(
      "invalid_forwarded_props",
      "forwardedProps.openbot.taskId must be a string",
      400,
    );
  }
  return extension.taskId === undefined ? {} : { taskId: extension.taskId };
}

/** Rejects values that the neutral application port cannot faithfully consume. */
export function assertSupportedRunInput(input: RunAgentInput): void {
  if (input.tools.length > 0) {
    throw new AgUiAdapterError(
      "unsupported_tools",
      "Client-declared AG-UI tools are not enabled for this agent",
      422,
    );
  }
  if (input.context.length > 0) {
    throw new AgUiAdapterError(
      "unsupported_context",
      "AG-UI context injection is not enabled for this agent",
      422,
    );
  }
  if (!isEmptyState(input.state)) {
    throw new AgUiAdapterError(
      "unsupported_state",
      "AG-UI client state is not enabled for this agent",
      422,
    );
  }
}

export function newestActionableMessage(messages: readonly Message[]): Message | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" || message.role === "tool") return message;
  }
  return null;
}

export type InputConversionDependencies = {
  principal: ProtocolPrincipal;
  identities: AgUiIdentityMap;
  attachments: AttachmentPort;
  limits: AgUiLimits;
  signal?: AbortSignal;
};

export async function toTaskInputMessage(
  message: Message,
  dependencies: InputConversionDependencies,
): Promise<TaskInputMessage> {
  if (message.role === "tool") {
    if (byteLength(message.content) > dependencies.limits.maxAccumulatedTextBytes) {
      throw new AgUiAdapterError("message_too_large", "Tool result exceeds the configured limit", 413);
    }
    return {
      role: "tool",
      actionCallId: message.toolCallId,
      parts: [{ kind: "text", text: message.content }],
    };
  }
  if (message.role !== "user") {
    throw new AgUiAdapterError(
      "invalid_input_message",
      "The newest actionable AG-UI message must have role user or tool",
      400,
    );
  }

  if (typeof message.content === "string") {
    if (byteLength(message.content) > dependencies.limits.maxAccumulatedTextBytes) {
      throw new AgUiAdapterError("message_too_large", "User message exceeds the configured limit", 413);
    }
    return { role: "user", parts: [{ kind: "text", text: message.content }] };
  }

  const parts: ContentPart[] = [];
  let attachmentCount = 0;
  let attachmentBytes = 0;
  let textBytes = 0;
  for (const [partIndex, content] of message.content.entries()) {
    if (content.type === "text") {
      textBytes += byteLength(content.text);
      if (textBytes > dependencies.limits.maxAccumulatedTextBytes) {
        throw new AgUiAdapterError("message_too_large", "User message text exceeds the configured limit", 413);
      }
      parts.push({ kind: "text", text: content.text });
      continue;
    }

    attachmentCount += 1;
    if (attachmentCount > dependencies.limits.maxAttachments) {
      throw new AgUiAdapterError("too_many_attachments", "Too many AG-UI attachments", 413);
    }

    if (content.type === "binary" && content.id !== undefined) {
      if (content.data !== undefined || content.url !== undefined) {
        throw new AgUiAdapterError(
          "ambiguous_attachment",
          "A binary attachment id cannot be combined with data or url",
          400,
        );
      }
      const binding = await dependencies.identities.resolve("attachment", content.id);
      if (binding === null || binding.ref.kind !== "attachment") {
        throw new AgUiAdapterError("attachment_not_found", "AG-UI attachment was not found", 404);
      }
      const opened = await dependencies.attachments.open(
        dependencies.principal,
        binding.internalId,
        dependencies.signal,
      );
      await opened.body.cancel("Attachment metadata resolved").catch(() => undefined);
      attachmentBytes += opened.attachment.size;
      assertAttachmentSizes(opened.attachment.size, attachmentBytes, dependencies.limits);
      parts.push({ kind: "file", attachment: opened.attachment });
      continue;
    }

    const source = {
      ...sourceForContent(content, dependencies.limits),
      idempotencyKey: await attachmentImportKey(
        dependencies.identities.namespace,
        message.id,
        partIndex,
      ),
    };
    const attachment = await dependencies.attachments.import(
      dependencies.principal,
      source,
      dependencies.signal,
    );
    attachmentBytes += attachment.size;
    assertAttachmentSizes(attachment.size, attachmentBytes, dependencies.limits);
    parts.push({ kind: "file", attachment });
  }
  if (parts.length === 0) {
    throw new AgUiAdapterError("empty_message", "User message content cannot be empty", 400);
  }
  return { role: "user", parts };
}

async function attachmentImportKey(
  namespace: string,
  messageId: string,
  partIndex: number,
): Promise<string> {
  const framed = `${namespace.length}:${namespace}:${messageId.length}:${messageId}:${partIndex}`;
  const readable = `ag-ui:${framed}`;
  if (readable.length <= 512) return readable;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(framed));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ag-ui:sha256:${hex}`;
}

function sourceForContent(
  content: Exclude<
    Exclude<Extract<Message, { role: "user" }>["content"], string>[number],
    { type: "text" }
  >,
  limits: AgUiLimits,
) {
  if (content.type === "binary") {
    if (content.data !== undefined && content.url !== undefined) {
      throw new AgUiAdapterError("ambiguous_attachment", "Binary content cannot contain both data and url", 400);
    }
    if (content.data !== undefined) {
      const bytes = decodeBase64(content.data, limits.maxAttachmentBytes);
      return {
        name: content.filename,
        mediaType: content.mimeType,
        source: { kind: "bytes" as const, bytes },
        declaredSize: bytes.byteLength,
      };
    }
    if (content.url !== undefined) {
      return {
        name: content.filename,
        mediaType: content.mimeType,
        source: { kind: "url" as const, url: safeRemoteUrl(content.url) },
      };
    }
    throw new AgUiAdapterError("invalid_attachment", "Binary content requires id, data, or url", 400);
  }

  const source = content.source;
  if (source.type === "data") {
    const bytes = decodeBase64(source.value, limits.maxAttachmentBytes);
    return {
      mediaType: source.mimeType,
      source: { kind: "bytes" as const, bytes },
      declaredSize: bytes.byteLength,
    };
  }
  return {
    mediaType: source.mimeType ?? defaultMediaType(content.type),
    source: { kind: "url" as const, url: safeRemoteUrl(source.value) },
  };
}

function defaultMediaType(type: "image" | "audio" | "video" | "document"): string {
  // AG-UI permits an omitted MIME type for URL sources. The attachment port
  // requires a concrete value; wildcard media ranges describe negotiation,
  // not representation metadata.
  void type;
  return "application/octet-stream";
}

function safeRemoteUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new AgUiAdapterError("invalid_attachment_url", "Attachment URL is invalid", 400, { cause });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AgUiAdapterError(
      "invalid_attachment_url",
      "Attachment URL must use http or https",
      400,
    );
  }
  if (parsed.username || parsed.password) {
    throw new AgUiAdapterError(
      "invalid_attachment_url",
      "Attachment URL credentials are not allowed",
      400,
    );
  }
  return parsed.toString();
}

function decodeBase64(value: string, maximumBytes: number): Uint8Array {
  if (value.length > Math.ceil(maximumBytes / 3) * 4 + 4) {
    throw new AgUiAdapterError("attachment_too_large", "Attachment exceeds the configured limit", 413);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new AgUiAdapterError("invalid_attachment_data", "Attachment data is not valid base64", 400);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch (cause) {
    throw new AgUiAdapterError("invalid_attachment_data", "Attachment data is not valid base64", 400, {
      cause,
    });
  }
  if (binary.length > maximumBytes) {
    throw new AgUiAdapterError("attachment_too_large", "Attachment exceeds the configured limit", 413);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function assertAttachmentSizes(size: number, total: number, limits: AgUiLimits): void {
  if (size > limits.maxAttachmentBytes) {
    throw new AgUiAdapterError("attachment_too_large", "Attachment exceeds the configured limit", 413);
  }
  if (total > limits.maxTotalAttachmentBytes) {
    throw new AgUiAdapterError(
      "attachments_too_large",
      "Combined attachments exceed the configured limit",
      413,
    );
  }
}

function isEmptyState(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (isRecord(value) && Object.keys(value).length === 0) ||
    (Array.isArray(value) && value.length === 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isProtocolJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isProtocolJsonValue);
  return isRecord(value) && Object.values(value).every(isProtocolJsonValue);
}
