import type {
  AgentTaskPort,
  ProtocolPrincipal,
  TaskRef,
  TaskView,
} from "@openbot/application";
import { isApplicationError, type JsonObject, type TaskEventEnvelope } from "@openbot/core";
import {
  TaskState,
  type AgentCard,
  type CancelTaskRequest,
  type DeleteTaskPushNotificationConfigRequest,
  type GetExtendedAgentCardRequest,
  type GetTaskPushNotificationConfigRequest,
  type GetTaskRequest,
  type ListTaskPushNotificationConfigsRequest,
  type ListTaskPushNotificationConfigsResponse,
  type ListTasksRequest,
  type ListTasksResponse,
  type Message,
  type SendMessageRequest,
  type StreamResponse,
  type SubscribeToTaskRequest,
  type Task,
  type TaskPushNotificationConfig,
} from "@a2a-js/sdk";
import type { A2ARequestHandler, ServerCallContext } from "@a2a-js/sdk/server";
import {
  A2AError,
  ContentTypeNotSupportedError,
  ExtendedAgentCardNotConfiguredError,
  InvalidAgentResponseError,
  PushNotificationNotSupportedError,
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { A2AIdentityMap } from "./identity.ts";
import {
  A2AEventMapper,
  A2AMapper,
  isSettledStatus,
  normalizeHistoryLength,
  optionalJsonObject,
  toA2ATaskState,
} from "./mapper.ts";

type Operation = "submit" | "continue" | "read" | "cancel" | "stream";

export type OpenBotA2ARequestHandlerOptions = {
  tasks: AgentTaskPort;
  principal: ProtocolPrincipal;
  agentId: TaskView["task"]["agentId"];
  tenant: string;
  card: AgentCard;
  mapper: A2AMapper;
  identities: A2AIdentityMap;
  signal?: AbortSignal;
  onerror?: (error: Error) => void;
};

function report(onerror: ((error: Error) => void) | undefined, error: unknown): void {
  try {
    onerror?.(error instanceof Error ? error : new Error(String(error)));
  } catch {
    // Diagnostics must never change the protocol result.
  }
}

function applicationError(error: unknown, operation: Operation): Error {
  if (error instanceof A2AError) return error;
  if (!isApplicationError(error)) {
    return new Error("Application operation failed");
  }
  if (error.code === "not_found" && operation !== "submit") {
    return new TaskNotFoundError("Task not found");
  }
  if (error.code === "conflict" && operation === "cancel") {
    return new TaskNotCancelableError("Task cannot be canceled in its current state");
  }
  if (error.code === "conflict" && operation === "continue") {
    return new UnsupportedOperationError("Task cannot accept a follow-up message in its current state");
  }
  if (error.code === "invalid_argument") {
    return new RequestMalformedError(error.message);
  }
  if (error.code === "conflict" && operation === "submit") {
    return new RequestMalformedError("The A2A message identity conflicts with an earlier request");
  }
  return new Error("Application operation failed");
}

function taskRef(identities: A2AIdentityMap, externalTaskId: string): TaskRef {
  if (!externalTaskId) throw new RequestMalformedError("Task id is required");
  return { externalRef: identities.ref("task", externalTaskId) };
}

function validateTenant(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new RequestMalformedError("The request tenant does not match this agent interface");
  }
}

function cancelReason(metadata: unknown): string | undefined {
  const parsed = optionalJsonObject(metadata, "CancelTask metadata");
  if (!parsed) return undefined;
  const keys = Object.keys(parsed);
  if (keys.some((key) => key !== "reason")) {
    throw new UnsupportedOperationError("Only CancelTask metadata.reason is supported");
  }
  if (parsed.reason === undefined) return undefined;
  if (typeof parsed.reason !== "string") {
    throw new RequestMalformedError("CancelTask metadata.reason must be a string");
  }
  return parsed.reason;
}

function historyLength(params: SendMessageRequest): number | undefined {
  return normalizeHistoryLength(params.configuration?.historyLength);
}

function canonicalStatus(status: TaskState): TaskView["task"]["status"] | undefined {
  switch (status) {
    case TaskState.TASK_STATE_UNSPECIFIED: return undefined;
    case TaskState.TASK_STATE_SUBMITTED: return "submitted";
    case TaskState.TASK_STATE_WORKING: return "working";
    case TaskState.TASK_STATE_COMPLETED: return "completed";
    case TaskState.TASK_STATE_FAILED: return "failed";
    case TaskState.TASK_STATE_CANCELED: return "canceled";
    case TaskState.TASK_STATE_INPUT_REQUIRED: return "input_required";
    case TaskState.TASK_STATE_REJECTED: return "rejected";
    case TaskState.TASK_STATE_AUTH_REQUIRED: return "auth_required";
    case TaskState.UNRECOGNIZED:
      throw new RequestMalformedError("ListTasks status is invalid");
  }
}

function updatedAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new RequestMalformedError("statusTimestampAfter must be a valid ISO 8601 timestamp");
  }
  return parsed;
}

export class OpenBotA2ARequestHandler implements A2ARequestHandler {
  readonly #tasks: AgentTaskPort;
  readonly #principal: ProtocolPrincipal;
  readonly #agentId: TaskView["task"]["agentId"];
  readonly #tenant: string;
  readonly #card: AgentCard;
  readonly #mapper: A2AMapper;
  readonly #identities: A2AIdentityMap;
  readonly #signal?: AbortSignal;
  readonly #onerror?: (error: Error) => void;

  constructor(options: OpenBotA2ARequestHandlerOptions) {
    this.#tasks = options.tasks;
    this.#principal = options.principal;
    this.#agentId = options.agentId;
    this.#tenant = options.tenant;
    this.#card = options.card;
    this.#mapper = options.mapper;
    this.#identities = options.identities;
    this.#signal = options.signal;
    this.#onerror = options.onerror;
  }

  async getAgentCard(): Promise<AgentCard> {
    return this.#card;
  }

  async getAuthenticatedExtendedAgentCard(
    _params: GetExtendedAgentCardRequest,
    _context: ServerCallContext,
  ): Promise<AgentCard> {
    throw new ExtendedAgentCardNotConfiguredError();
  }

  async sendMessage(params: SendMessageRequest, _context: ServerCallContext): Promise<Message | Task> {
    const view = await this.#start(params);
    if (params.configuration?.returnImmediately || isSettledStatus(view.task.status)) {
      return this.#mapper.toTask(view, { historyLength: historyLength(params) });
    }
    const settled = await this.#waitUntilSettled(view);
    return this.#mapper.toTask(settled, { historyLength: historyLength(params) });
  }

  async *sendMessageStream(
    params: SendMessageRequest,
    _context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const view = await this.#start(params);
    yield {
      payload: {
        $case: "task",
        value: await this.#mapper.toTask(view, { historyLength: historyLength(params) }),
      },
    };
    if (isSettledStatus(view.task.status)) return;

    const eventMapper = new A2AEventMapper(this.#mapper, view);
    for await (const event of this.#subscribe(view, view.lastSeq)) {
      for (const translated of await eventMapper.map(event)) yield translated;
      if (
        event.type === "task.status.changed" &&
        isSettledStatus((event.data as { to: TaskView["task"]["status"] }).to)
      ) return;
    }
  }

  async getTask(params: GetTaskRequest, _context: ServerCallContext): Promise<Task> {
    validateTenant(params.tenant, this.#tenant);
    const requestedHistory = normalizeHistoryLength(params.historyLength);
    const view = await this.#getRequired(params.id, requestedHistory);
    return this.#mapper.toTask(view, { historyLength: requestedHistory });
  }

  async cancelTask(params: CancelTaskRequest, _context: ServerCallContext): Promise<Task> {
    validateTenant(params.tenant, this.#tenant);
    const existing = await this.#getRequired(params.id, 0);
    if (["completed", "failed", "rejected"].includes(existing.task.status)) {
      throw new TaskNotCancelableError("Task cannot be canceled in its current state");
    }
    const view = await this.#call(
      "cancel",
      () => this.#tasks.cancel(
        this.#principal,
        taskRef(this.#identities, params.id),
        cancelReason(params.metadata),
      ),
    );
    this.#assertAgent(view);
    return this.#mapper.toTask(view);
  }

  async *resubscribe(
    params: SubscribeToTaskRequest,
    _context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    validateTenant(params.tenant, this.#tenant);
    const view = await this.#getRequired(params.id);
    const eventMapper = new A2AEventMapper(this.#mapper, view, "submitted");
    let emittedTask = false;

    for await (const event of this.#subscribe(view, 0)) {
      if (!emittedTask) {
        const initialStatus = event.type === "task.status.changed" && event.data.from === null
          ? { value: event.data.to, time: event.time }
          : undefined;
        yield {
          payload: {
            $case: "task",
            value: await this.#mapper.toTask(view, {
              minimal: true,
              ...(initialStatus ? { status: initialStatus } : {}),
            }),
          },
        };
        emittedTask = true;
        if (initialStatus) {
          if (isSettledStatus(initialStatus.value)) return;
          continue;
        }
      }
      for (const translated of await eventMapper.map(event)) yield translated;
      if (event.type === "task.status.changed" && isSettledStatus(event.data.to)) return;
    }

    if (!emittedTask) {
      yield { payload: { $case: "task", value: await this.#mapper.toTask(view) } };
    }
  }

  async listTasks(
    params: ListTasksRequest,
    _context: ServerCallContext,
  ): Promise<ListTasksResponse> {
    validateTenant(params.tenant, this.#tenant);
    const limit = params.pageSize ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RequestMalformedError("pageSize must be between 1 and 100");
    }
    const requestedHistory = normalizeHistoryLength(params.historyLength);
    const status = canonicalStatus(params.status);
    const after = updatedAfter(params.statusTimestampAfter);
    let threadId: TaskView["task"]["threadId"] | undefined;
    if (params.contextId) {
      const context = await this.#call(
        "read",
        () => this.#identities.resolve("thread", params.contextId),
      );
      if (context === null || context.ref.kind !== "thread") {
        return { tasks: [], nextPageToken: "", pageSize: limit, totalSize: 0 };
      }
      threadId = context.internalId as TaskView["task"]["threadId"];
    }

    const page = await this.#call(
      "read",
      () => this.#tasks.list({
        principal: this.#principal,
        agentId: this.#agentId,
        limit,
        ...(params.pageToken ? { cursor: params.pageToken } : {}),
        ...(threadId ? { threadId } : {}),
        ...(status ? { statuses: [status] } : {}),
        ...(after === undefined ? {} : { updatedAfter: after }),
      }),
    );
    const tasks: Task[] = [];
    for (const item of page.items) {
      if (item.agentId !== this.#agentId) {
        throw new InvalidAgentResponseError("Task list crossed the configured agent boundary");
      }
      const view = await this.#call(
        "read",
        () => this.#tasks.get(
          this.#principal,
          { taskId: item.id },
          requestedHistory === undefined ? undefined : { historyLength: requestedHistory },
        ),
      );
      if (view === null) {
        throw new InvalidAgentResponseError("A listed task could not be loaded");
      }
      this.#assertAgent(view);
      tasks.push(await this.#mapper.toTask(view, {
        historyLength: requestedHistory,
        includeArtifacts: params.includeArtifacts ?? false,
      }));
    }
    return {
      tasks,
      nextPageToken: page.nextCursor ?? "",
      pageSize: limit,
      totalSize: page.totalSize,
    };
  }

  async createTaskPushNotificationConfig(
    _params: TaskPushNotificationConfig,
    _context: ServerCallContext,
  ): Promise<TaskPushNotificationConfig> {
    throw new PushNotificationNotSupportedError();
  }

  async getTaskPushNotificationConfig(
    _params: GetTaskPushNotificationConfigRequest,
    _context: ServerCallContext,
  ): Promise<TaskPushNotificationConfig> {
    throw new PushNotificationNotSupportedError();
  }

  async listTaskPushNotificationConfigs(
    _params: ListTaskPushNotificationConfigsRequest,
    _context: ServerCallContext,
  ): Promise<ListTaskPushNotificationConfigsResponse> {
    throw new PushNotificationNotSupportedError();
  }

  async deleteTaskPushNotificationConfig(
    _params: DeleteTaskPushNotificationConfigRequest,
    _context: ServerCallContext,
  ): Promise<void> {
    throw new PushNotificationNotSupportedError();
  }

  async #start(params: SendMessageRequest): Promise<TaskView> {
    validateTenant(params.tenant, this.#tenant);
    if (!params.message) throw new RequestMalformedError("message is required");
    if (!params.message.messageId) throw new RequestMalformedError("message.messageId is required");
    if (params.configuration?.taskPushNotificationConfig) {
      throw new PushNotificationNotSupportedError();
    }
    const acceptedOutputModes = params.configuration?.acceptedOutputModes ?? [];
    if (
      acceptedOutputModes.length > 0 &&
      !acceptedOutputModes.some((mode) => this.#card.defaultOutputModes.includes(mode))
    ) {
      throw new ContentTypeNotSupportedError(
        "The requested output media types are not advertised by this agent",
      );
    }
    normalizeHistoryLength(params.configuration?.historyLength);
    const message = params.message;
    const externalMessage = this.#identities.ref("message", message.messageId);
    const metadata = optionalJsonObject(params.metadata, "SendMessage metadata");

    if (message.taskId) {
      const current = await this.#getRequired(message.taskId, 0);
      await this.#assertContextMatches(current, message.contextId);
      const knownMessage = await this.#call(
        "read",
        () => this.#identities.resolve("message", message.messageId),
      );
      if (current.task.status !== "input_required" && knownMessage === null) {
        throw new UnsupportedOperationError(
          `Task in state ${toA2ATaskState(current.task.status)} cannot accept a follow-up message`,
        );
      }
      const mappedInput = await this.#mapper.toTaskInputMessage(message, this.#signal);
      if (metadata && mappedInput.metadata?.["a2a.request"] !== undefined) {
        throw new RequestMalformedError("message.metadata reserves a2a.request for request metadata");
      }
      const input = metadata
        ? { ...mappedInput, metadata: { ...(mappedInput.metadata ?? {}), "a2a.request": metadata } }
        : mappedInput;
      const continued = await this.#call(
        "continue",
        () => this.#tasks.continue({
          principal: this.#principal,
          task: taskRef(this.#identities, message.taskId),
          externalMessage,
          message: input,
          idempotencyKey: message.messageId,
        }, this.#signal),
      );
      this.#assertAgent(continued);
      return continued;
    }

    const input = await this.#mapper.toTaskInputMessage(message, this.#signal);
    const submitted = await this.#call(
      "submit",
      () => this.#tasks.submit({
        principal: this.#principal,
        agentId: this.#agentId,
        externalRefs: {
          ...(message.contextId
            ? { thread: this.#identities.ref("thread", message.contextId) }
            : {}),
          message: externalMessage,
        },
        message: input,
        idempotencyKey: message.messageId,
        ...(metadata ? { metadata } : {}),
      }, this.#signal),
    );
    this.#assertAgent(submitted);
    return submitted;
  }

  async #assertContextMatches(view: TaskView, externalContextId: string): Promise<void> {
    if (!externalContextId) return;
    const binding = await this.#call(
      "read",
      () => this.#identities.resolve("thread", externalContextId),
    );
    if (binding === null || binding.ref.kind !== "thread" || binding.internalId !== view.task.threadId) {
      throw new RequestMalformedError("message.contextId does not match message.taskId");
    }
  }

  async #getRequired(externalTaskId: string, history?: number): Promise<TaskView> {
    const view = await this.#call(
      "read",
      () => this.#tasks.get(
        this.#principal,
        taskRef(this.#identities, externalTaskId),
        history === undefined ? undefined : { historyLength: history },
      ),
    );
    if (view === null) throw new TaskNotFoundError();
    this.#assertAgent(view);
    return view;
  }

  async #waitUntilSettled(initial: TaskView): Promise<TaskView> {
    if (!isSettledStatus(initial.task.status)) {
      for await (const event of this.#subscribe(initial, initial.lastSeq)) {
        if (event.type === "task.status.changed" && isSettledStatus(event.data.to)) break;
      }
    }
    const current = await this.#call(
      "read",
      () => this.#tasks.get(this.#principal, { taskId: initial.task.id }),
    );
    if (current === null) throw new InvalidAgentResponseError("Task disappeared while waiting");
    this.#assertAgent(current);
    if (!isSettledStatus(current.task.status)) {
      throw new InvalidAgentResponseError("Task event stream ended before the task settled");
    }
    return current;
  }

  async *#subscribe(view: TaskView, afterSeq: number): AsyncGenerator<TaskEventEnvelope, void, undefined> {
    let stream: AsyncIterable<TaskEventEnvelope>;
    try {
      stream = this.#tasks.subscribe(
        this.#principal,
        { taskId: view.task.id },
        afterSeq,
        this.#signal,
      );
    } catch (error) {
      throw applicationError(error, "stream");
    }
    try {
      for await (const event of stream) yield event;
    } catch (error) {
      const mapped = applicationError(error, "stream");
      if (mapped === error || !isApplicationError(error)) report(this.#onerror, error);
      throw mapped;
    }
  }

  #assertAgent(view: TaskView): void {
    if (view.task.agentId !== this.#agentId) throw new TaskNotFoundError();
  }

  async #call<T>(operation: Operation, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const mapped = applicationError(error, operation);
      if (!(error instanceof A2AError) && (!isApplicationError(error) || mapped.name === "Error")) {
        report(this.#onerror, error);
      }
      throw mapped;
    }
  }
}
