import type { AttachmentPort, ProtocolPrincipal, TaskInputMessage, TaskView } from "@openbot/application";
import {
  CONTENT_PARTS_MAX,
  isApplicationError,
  isJsonValue,
  type Artifact as CanonicalArtifact,
  type ContentPart,
  type Interrupt,
  type JsonObject,
  type Message as CanonicalMessage,
  type MessageRole,
  type TaskEventEnvelope,
  type TaskStatus as CanonicalTaskStatus,
} from "@openbot/core";
import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Part,
  type StreamResponse,
  type Task,
  type TaskStatus,
  type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import {
  A2AError,
  InvalidAgentResponseError,
  RequestMalformedError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { A2AIdentityMap } from "./identity.ts";

const FILE_MEDIA_TYPE = "application/octet-stream";
const JSON_MEDIA_TYPE = "application/json";
const TEXT_MEDIA_TYPE = "text/plain";

export function optionalJsonObject(value: unknown, label: string): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !isJsonValue(value)
  ) {
    throw new RequestMalformedError(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

export function normalizeHistoryLength(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RequestMalformedError("historyLength must be a non-negative integer");
  }
  return value;
}

export function isSettledStatus(status: CanonicalTaskStatus): boolean {
  return [
    "input_required",
    "auth_required",
    "completed",
    "failed",
    "canceled",
    "rejected",
  ].includes(status);
}

export function toA2ATaskState(status: CanonicalTaskStatus): TaskState {
  switch (status) {
    case "submitted": return TaskState.TASK_STATE_SUBMITTED;
    case "working": return TaskState.TASK_STATE_WORKING;
    case "completed": return TaskState.TASK_STATE_COMPLETED;
    case "failed": return TaskState.TASK_STATE_FAILED;
    case "canceled": return TaskState.TASK_STATE_CANCELED;
    case "input_required": return TaskState.TASK_STATE_INPUT_REQUIRED;
    case "rejected": return TaskState.TASK_STATE_REJECTED;
    case "auth_required": return TaskState.TASK_STATE_AUTH_REQUIRED;
  }
}

function toA2ARole(role: MessageRole): Role {
  return role === "user" ? Role.ROLE_USER : Role.ROLE_AGENT;
}

function timestamp(value: number): string {
  try {
    return new Date(value).toISOString();
  } catch (cause) {
    throw new InvalidAgentResponseError("Canonical event has an invalid timestamp");
  }
}

function safeRemoteUrl(value: string, label: string, ErrorType: typeof RequestMalformedError | typeof InvalidAgentResponseError): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new ErrorType({ message: `${label} is invalid`, cause });
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    throw new ErrorType(`${label} must be an http or https URL without credentials`);
  }
  return parsed.toString();
}

function incomingPartMetadata(part: Part, label: string): JsonObject | undefined {
  return optionalJsonObject(part.metadata, `${label} metadata`);
}

function attachmentImportKey(namespace: string, messageId: string, partIndex: number): string {
  return `a2a:${namespace.length}:${namespace}:${messageId.length}:${messageId}:${partIndex}`;
}

function attachmentInputError(error: unknown): Error {
  if (error instanceof A2AError) return error;
  if (isApplicationError(error)) {
    if (["invalid_argument", "not_found", "conflict", "forbidden"].includes(error.code)) {
      return new RequestMalformedError("Attachment input was rejected");
    }
    return new Error("Attachment import failed");
  }
  return new Error("Attachment import failed");
}

function assertIncomingParts(parts: readonly Part[]): void {
  if (parts.length < 1 || parts.length > CONTENT_PARTS_MAX) {
    throw new RequestMalformedError(
      `message.parts must contain between 1 and ${CONTENT_PARTS_MAX} parts`,
    );
  }
  parts.forEach((part, index) => {
    const label = `message.parts[${index}]`;
    incomingPartMetadata(part, label);
    if (!part.content) throw new RequestMalformedError(`${label} has no content`);
    switch (part.content.$case) {
      case "text":
        if (typeof part.content.value !== "string") {
          throw new RequestMalformedError(`${label} text is invalid`);
        }
        return;
      case "data":
        if (!isJsonValue(part.content.value)) {
          throw new RequestMalformedError(`${label} data is not valid JSON`);
        }
        return;
      case "raw":
        if (!(part.content.value instanceof Uint8Array)) {
          throw new RequestMalformedError(`${label} raw content is invalid`);
        }
        return;
      case "url":
        safeRemoteUrl(part.content.value, `${label} URL`, RequestMalformedError);
        return;
    }
  });
}

export type A2AMapperOptions = {
  principal: ProtocolPrincipal;
  identities: A2AIdentityMap;
  attachments: AttachmentPort;
  attachmentUrlTtlMs: number;
  now: () => number;
};

export class A2AMapper {
  constructor(readonly options: A2AMapperOptions) {}

  async toTaskInputMessage(message: Message, signal?: AbortSignal): Promise<TaskInputMessage> {
    if (!message.messageId) throw new RequestMalformedError("message.messageId is required");
    if (message.role !== Role.ROLE_USER) {
      throw new RequestMalformedError("Client messages must use ROLE_USER");
    }
    if (message.extensions.length > 0) {
      throw new UnsupportedOperationError("Message extensions are not enabled for this agent");
    }
    if (message.referenceTaskIds.length > 0) {
      throw new UnsupportedOperationError("Reference tasks are not enabled for this agent");
    }
    assertIncomingParts(message.parts);

    const parts: ContentPart[] = [];
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index]!;
      const content = part.content!;
      const metadata = incomingPartMetadata(part, `message.parts[${index}]`);
      if (content.$case === "text") {
        parts.push({ kind: "text", text: content.value, ...(metadata ? { metadata } : {}) });
        continue;
      }
      if (content.$case === "data") {
        parts.push({
          kind: "data",
          data: content.value,
          ...(part.mediaType ? { mediaType: part.mediaType } : {}),
          ...(metadata ? { metadata } : {}),
        });
        continue;
      }

      let attachment: Awaited<ReturnType<AttachmentPort["import"]>>;
      try {
        attachment = await this.options.attachments.import(
          this.options.principal,
          content.$case === "raw"
            ? {
                ...(part.filename ? { name: part.filename } : {}),
                mediaType: part.mediaType || FILE_MEDIA_TYPE,
                idempotencyKey: attachmentImportKey(
                  this.options.identities.namespace,
                  message.messageId,
                  index,
                ),
                source: { kind: "bytes", bytes: Uint8Array.from(content.value) },
                declaredSize: content.value.byteLength,
              }
            : {
                ...(part.filename ? { name: part.filename } : {}),
                mediaType: part.mediaType || FILE_MEDIA_TYPE,
                idempotencyKey: attachmentImportKey(
                  this.options.identities.namespace,
                  message.messageId,
                  index,
                ),
                source: {
                  kind: "url",
                  url: safeRemoteUrl(
                    content.value,
                    `message.parts[${index}] URL`,
                    RequestMalformedError,
                  ),
                },
              },
          signal,
        );
      } catch (error) {
        throw attachmentInputError(error);
      }
      parts.push({ kind: "file", attachment, ...(metadata ? { metadata } : {}) });
    }

    const metadata = optionalJsonObject(message.metadata, "message.metadata");
    return { role: "user", parts, ...(metadata ? { metadata } : {}) };
  }

  async toTask(
    view: TaskView,
    options: {
      historyLength?: number;
      includeArtifacts?: boolean;
      status?: { value: CanonicalTaskStatus; time: number };
      minimal?: boolean;
    } = {},
  ): Promise<Task> {
    const taskId = await this.#externalId("task", view.task.id);
    const contextId = await this.#externalId("thread", view.task.threadId);
    const statusValue = options.status?.value ?? view.task.status;
    const statusTime = options.status?.time ?? view.task.updatedAt;
    const status = await this.#toTaskStatus(view, taskId, contextId, statusValue, statusTime);
    if (options.minimal) {
      return { id: taskId, contextId, status, artifacts: [], history: [], metadata: undefined };
    }

    const historyLength = normalizeHistoryLength(options.historyLength);
    const selectedHistory = historyLength === 0
      ? []
      : historyLength === undefined
        ? view.messages
        : view.messages.slice(-historyLength);
    const history = await Promise.all(selectedHistory.map((message) => this.toMessage(message)));
    const artifacts = options.includeArtifacts === false
      ? []
      : await Promise.all(view.artifacts.map((artifact) => this.toArtifact(artifact)));
    return {
      id: taskId,
      contextId,
      status,
      artifacts,
      history,
      metadata: view.task.metadata,
    };
  }

  async toMessage(message: CanonicalMessage): Promise<Message> {
    const messageId = await this.#externalId("message", message.id);
    const contextId = await this.#externalId("thread", message.threadId);
    const taskId = message.taskId === null ? "" : await this.#externalId("task", message.taskId);
    const metadata: JsonObject = message.role === "user" || message.role === "agent"
      ? message.metadata
      : { ...message.metadata, "openbot.role": message.role };
    return {
      messageId,
      contextId,
      taskId,
      role: toA2ARole(message.role),
      parts: await Promise.all(message.parts.map((part) => this.toPart(part))),
      metadata,
      extensions: [],
      referenceTaskIds: [],
    };
  }

  async toArtifact(artifact: CanonicalArtifact): Promise<Artifact> {
    return {
      artifactId: await this.#externalId("artifact", artifact.id),
      name: artifact.name ?? "",
      description: artifact.description ?? "",
      parts: await Promise.all(artifact.parts.map((part) => this.toPart(part))),
      metadata: artifact.metadata,
      extensions: [],
    };
  }

  async toPart(part: ContentPart): Promise<Part> {
    switch (part.kind) {
      case "text":
        return {
          content: { $case: "text", value: part.text },
          metadata: part.metadata,
          filename: "",
          mediaType: TEXT_MEDIA_TYPE,
        };
      case "data":
        return {
          content: { $case: "data", value: part.data },
          metadata: part.metadata,
          filename: "",
          mediaType: part.mediaType ?? JSON_MEDIA_TYPE,
        };
      case "file": {
        const expiresAt = this.options.now() + this.options.attachmentUrlTtlMs;
        let rawUrl: string;
        try {
          rawUrl = await this.options.attachments.createDownloadUrl(
            this.options.principal,
            part.attachment.id,
            expiresAt,
          );
        } catch (error) {
          throw new InvalidAgentResponseError({
            message: "Could not create an attachment download URL",
            cause: error,
          });
        }
        const url = safeRemoteUrl(rawUrl, "Attachment download URL", InvalidAgentResponseError);
        return {
          content: { $case: "url", value: url },
          metadata: part.metadata,
          filename: part.attachment.name ?? "",
          mediaType: part.attachment.mediaType,
        };
      }
    }
  }

  async statusUpdate(
    view: TaskView,
    status: CanonicalTaskStatus,
    time: number,
    message?: Message,
    metadata?: JsonObject,
  ): Promise<StreamResponse> {
    const value: TaskStatusUpdateEvent = {
      taskId: await this.#externalId("task", view.task.id),
      contextId: await this.#externalId("thread", view.task.threadId),
      status: {
        state: toA2ATaskState(status),
        message,
        timestamp: timestamp(time),
      },
      metadata,
    };
    return { payload: { $case: "statusUpdate", value } };
  }

  async eventMessage(
    event: TaskEventEnvelope,
    messageId: CanonicalMessage["id"],
    role: MessageRole,
    parts: readonly ContentPart[],
  ): Promise<Message> {
    const metadata: JsonObject = role === "user" || role === "agent"
      ? event.metadata
      : { ...event.metadata, "openbot.role": role };
    return {
      messageId: await this.#externalId("message", messageId),
      contextId: await this.#externalId("thread", event.threadId),
      taskId: await this.#externalId("task", event.taskId),
      role: toA2ARole(role),
      parts: await Promise.all(parts.map((part) => this.toPart(part))),
      metadata,
      extensions: [],
      referenceTaskIds: [],
    };
  }

  async interruptMessage(view: TaskView, interrupt: Interrupt): Promise<Message> {
    const externalInterruptId = await this.#externalId("interrupt", interrupt.id);
    return {
      messageId: externalInterruptId,
      contextId: await this.#externalId("thread", view.task.threadId),
      taskId: await this.#externalId("task", view.task.id),
      role: Role.ROLE_AGENT,
      parts: [{
        content: { $case: "text", value: interrupt.prompt },
        metadata: undefined,
        filename: "",
        mediaType: TEXT_MEDIA_TYPE,
      }],
      metadata: {
        ...interrupt.metadata,
        "openbot.interrupt_id": externalInterruptId,
        "openbot.interrupt_kind": interrupt.kind,
        "openbot.response_schema": interrupt.responseSchema,
      },
      extensions: [],
      referenceTaskIds: [],
    };
  }

  async artifactUpdate(view: TaskView, artifact: CanonicalArtifact, metadata?: JsonObject): Promise<StreamResponse> {
    return {
      payload: {
        $case: "artifactUpdate",
        value: {
          taskId: await this.#externalId("task", view.task.id),
          contextId: await this.#externalId("thread", view.task.threadId),
          artifact: await this.toArtifact(artifact),
          append: false,
          lastChunk: true,
          metadata,
        },
      },
    };
  }

  async #toTaskStatus(
    view: TaskView,
    _taskId: string,
    _contextId: string,
    status: CanonicalTaskStatus,
    time: number,
  ): Promise<TaskStatus> {
    const openInterrupt = status === "input_required" || status === "auth_required"
      ? [...view.interrupts]
          .filter((interrupt) => interrupt.status === "open")
          .sort((left, right) => left.createdAt - right.createdAt)
          .at(-1)
      : undefined;
    return {
      state: toA2ATaskState(status),
      message: openInterrupt ? await this.interruptMessage(view, openInterrupt) : undefined,
      timestamp: timestamp(time),
    };
  }

  async #externalId(
    kind: "thread" | "task" | "message" | "artifact" | "attachment" | "interrupt",
    internalId: string,
  ): Promise<string> {
    return this.options.identities.externalId({
      protocol: "a2a",
      namespace: this.options.identities.namespace,
      kind,
      internalId,
    } as Parameters<A2AIdentityMap["externalId"]>[0]);
  }
}

/** Stateful translation of the committed canonical log into an A2A task stream. */
export class A2AEventMapper {
  readonly #messageRoles = new Map<string, MessageRole>();
  #status: CanonicalTaskStatus;

  constructor(
    private readonly mapper: A2AMapper,
    private readonly view: TaskView,
    initialStatus = view.task.status,
  ) {
    this.#status = initialStatus;
  }

  get status(): CanonicalTaskStatus {
    return this.#status;
  }

  async map(event: TaskEventEnvelope): Promise<readonly StreamResponse[]> {
    switch (event.type) {
      case "task.status.changed":
        this.#status = event.data.to;
        return [await this.mapper.statusUpdate(
          this.view,
          event.data.to,
          event.time,
          undefined,
          event.data.reason
            ? { ...event.metadata, "openbot.reason": event.data.reason }
            : event.metadata,
        )];
      case "message.started":
        this.#messageRoles.set(event.data.messageId, event.data.role);
        return [];
      case "message.finished": {
        const role = this.#messageRoles.get(event.data.messageId);
        if (!role || role === "user") return [];
        const message = await this.mapper.eventMessage(
          event,
          event.data.messageId,
          role,
          event.data.parts,
        );
        return [await this.mapper.statusUpdate(this.view, this.#status, event.time, message, event.metadata)];
      }
      case "artifact.updated":
        return [await this.mapper.artifactUpdate(this.view, event.data.artifact, event.metadata)];
      case "interrupt.requested": {
        const status = event.data.interrupt.kind === "auth" ? "auth_required" : "input_required";
        this.#status = status;
        const message = await this.mapper.interruptMessage(this.view, event.data.interrupt);
        return [await this.mapper.statusUpdate(this.view, status, event.time, message, event.metadata)];
      }
      case "run.status.changed":
      case "message.text.delta":
      case "reasoning.summary.delta":
      case "action.started":
      case "action.arguments.delta":
      case "action.finished":
      case "interrupt.resolved":
      case "activity.updated":
        return [];
    }
  }
}
