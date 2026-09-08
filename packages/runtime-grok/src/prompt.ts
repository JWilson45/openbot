import { ApplicationError, type ContentPart, type JsonValue } from "@openbot/core";
import type { RuntimePromptRequest } from "@openbot/application";

export function composeGrokPrompt(request: RuntimePromptRequest, maximumBytes: number): string {
  const payload = {
    version: 1,
    instruction:
      "Process the canonical conversation. Use only advertised actions. Put only user-facing content in the assistant response: do not narrate plans, tool bookkeeping, or delivery mechanics.",
    messages: request.messages.map((message) => ({
      role: message.role,
      parts: message.parts.map(publicPromptPart),
    })),
    actions: request.actions.map((action) => ({
      name: action.name,
      ...(action.description === undefined ? {} : { description: action.description }),
      inputSchema: action.inputSchema,
      ...(action.outputSchema === undefined ? {} : { outputSchema: action.outputSchema }),
    })),
  };
  const prompt = `OpenBot canonical runtime request (JSON):\n${JSON.stringify(payload)}`;
  if (new TextEncoder().encode(prompt).byteLength > maximumBytes) {
    throw new ApplicationError("invalid_argument", "runtime prompt exceeds the Grok adapter limit");
  }
  return prompt;
}

function publicPromptPart(part: ContentPart): JsonValue {
  switch (part.kind) {
    case "text":
      return { kind: "text", text: part.text };
    case "data":
      return {
        kind: "data",
        data: part.data,
        ...(part.mediaType === undefined ? {} : { mediaType: part.mediaType }),
      };
    case "file":
      return {
        kind: "attachment",
        name: part.attachment.name,
        mediaType: part.attachment.mediaType,
        size: part.attachment.size,
        sha256: part.attachment.sha256,
      };
  }
}
