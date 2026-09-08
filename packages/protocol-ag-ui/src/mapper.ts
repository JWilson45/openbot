import { EventSchemas, EventType, type AGUIEvent, type Interrupt as AgUiInterrupt } from "@ag-ui/core";
import type { AttachmentPort, ProtocolPrincipal, TaskView } from "@openbot/application";
import {
  taskEventEnvelopeSchema,
  type ContentPart,
  type Interrupt,
  type JsonValue,
  type Message,
  type RunId,
  type TaskEventEnvelope,
} from "@openbot/core";
import { AgUiIdentityMap } from "./identity.ts";
import { AgUiAdapterError, type AgUiLimits } from "./types.ts";

export type AgUiMapperPhase = "idle" | "active" | "terminal";

export type AgUiEventMapperOptions = {
  principal: ProtocolPrincipal;
  identities: AgUiIdentityMap;
  attachments: AttachmentPort;
  limits: AgUiLimits;
  now?: () => number;
  afterSeq?: number;
  expectedThreadId?: string;
  expectedRunId?: string;
  /** Restricts task-log replay to one internal run while preserving task sequence checks. */
  targetRunInternalId?: RunId;
  parentRunId?: string;
};

type OpenMessage = { externalId: string; text: string };
type OpenAction = { name: string; arguments: string; parentMessageId?: string };

/**
 * Stateful canonical-event to AG-UI mapper with stricter lifecycle validation than
 * the SDK's consumer-side verifyEvents helper.
 */
export class AgUiEventMapper {
  phase: AgUiMapperPhase = "idle";
  lastSeq: number;

  private readonly principal: ProtocolPrincipal;
  private readonly identities: AgUiIdentityMap;
  private readonly attachments: AttachmentPort;
  private readonly limits: AgUiLimits;
  private readonly now: () => number;
  private readonly expectedThreadId?: string;
  private readonly expectedRunId?: string;
  private readonly targetRunInternalId?: RunId;
  private readonly parentRunId?: string;
  private accountId?: string;
  private taskId?: string;
  private agentId?: string;
  private threadInternalId?: string;
  private runInternalId?: string;
  private threadExternalId?: string;
  private runExternalId?: string;
  private taskExternalId?: string;
  private lastTimestamp?: number;
  private readonly openMessages = new Map<string, OpenMessage>();
  private readonly ignoredMessages = new Set<string>();
  private readonly openActions = new Map<string, OpenAction>();
  private reasoningSpanId?: string;
  private reasoningMessageId?: string;
  private reasoningSourceId?: string;
  private reasoningBytes = 0;
  private readonly interrupts: AgUiInterrupt[] = [];

  constructor(options: AgUiEventMapperOptions) {
    this.principal = options.principal;
    this.identities = options.identities;
    this.attachments = options.attachments;
    this.limits = options.limits;
    this.now = options.now ?? Date.now;
    this.lastSeq = options.afterSeq ?? 0;
    this.expectedThreadId = options.expectedThreadId;
    this.expectedRunId = options.expectedRunId;
    this.targetRunInternalId = options.targetRunInternalId;
    this.parentRunId = options.parentRunId;
    if (!Number.isSafeInteger(this.lastSeq) || this.lastSeq < 0) {
      throw new AgUiAdapterError("invalid_cursor", "Event cursor must be a non-negative integer", 400);
    }
  }

  get terminal(): boolean {
    return this.phase === "terminal";
  }

  /** Seeds a snapshot-tail mapper after a self-contained RUN_STARTED checkpoint. */
  async seedActiveFromReplay(view: TaskView): Promise<void> {
    if (this.phase !== "idle" || this.lastSeq !== view.lastSeq) {
      throw new AgUiAdapterError("invalid_replay_seed", "Replay mapper cannot be seeded in its current state", 500);
    }
    const run = view.runs.at(-1);
    if (run === undefined || (run.status !== "queued" && run.status !== "running")) {
      throw new AgUiAdapterError("invalid_replay_seed", "Replay tail requires an active run", 500);
    }
    if (view.task.accountId !== this.principal.accountId || run.accountId !== this.principal.accountId) {
      throw new AgUiAdapterError("tenant_boundary_violation", "Replay crossed an account boundary", 500);
    }
    this.accountId = view.task.accountId;
    this.taskId = view.task.id;
    this.agentId = view.task.agentId;
    this.threadInternalId = view.task.threadId;
    this.runInternalId = run.id;
    this.threadExternalId = await this.identities.externalId({
      protocol: "ag-ui",
      namespace: this.identities.namespace,
      kind: "thread",
      internalId: view.task.threadId,
    });
    this.runExternalId = await this.identities.externalId({
      protocol: "ag-ui",
      namespace: this.identities.namespace,
      kind: "run",
      internalId: run.id,
    });
    this.taskExternalId = await this.identities.externalId({
      protocol: "ag-ui",
      namespace: this.identities.namespace,
      kind: "task",
      internalId: view.task.id,
    });
    this.phase = "active";
  }

  async map(untrustedEnvelope: TaskEventEnvelope): Promise<AGUIEvent[]> {
    if (this.terminal) {
      throw new AgUiAdapterError(
        "event_after_terminal",
        "Canonical event received after the AG-UI terminal event",
        500,
      );
    }
    const parsed = taskEventEnvelopeSchema.safeParse(untrustedEnvelope);
    if (!parsed.success) {
      throw new AgUiAdapterError(
        "invalid_canonical_event",
        "Canonical event failed boundary validation",
        500,
        { cause: parsed.error },
      );
    }
    const envelope = parsed.data;
    this.assertEnvelopeBoundary(envelope);
    this.lastSeq = envelope.seq;
    this.lastTimestamp = envelope.time;

    // A task log may contain multiple sequential runs. Run-specific replay
    // validates the whole task sequence but maps only its selected run.
    if (
      this.targetRunInternalId !== undefined &&
      envelope.runId !== null &&
      envelope.runId !== this.targetRunInternalId
    ) {
      return [];
    }

    switch (envelope.type) {
      case "task.status.changed":
        return [];
      case "run.status.changed":
        return this.mapRunStatus(envelope);
      case "message.started":
        return this.mapMessageStarted(envelope);
      case "message.text.delta":
        return this.mapMessageDelta(envelope);
      case "message.finished":
        return this.mapMessageFinished(envelope);
      case "action.started":
        return this.mapActionStarted(envelope);
      case "action.arguments.delta":
        return this.mapActionArguments(envelope);
      case "action.finished":
        return this.mapActionFinished(envelope);
      case "reasoning.summary.delta":
        return this.mapReasoning(envelope);
      case "activity.updated":
        return this.mapActivity(envelope);
      case "interrupt.requested":
        return this.mapInterrupt(envelope);
      case "interrupt.resolved":
        return [];
      case "artifact.updated":
        return this.mapArtifact(envelope);
    }
  }

  /** Emits a standards-valid terminal error when a supposedly live log ends. */
  endOfStream(): AGUIEvent[] {
    if (this.terminal) return [];
    return this.abortWithError(
      "incomplete_stream",
      "The canonical event stream ended without a terminal run event",
    );
  }

  /** Closes open triads before reporting an adapter or upstream failure. */
  abortWithError(code: string, message: string): AGUIEvent[] {
    if (this.terminal) return [];
    const events = this.closeOpenStreams(this.lastTimestamp ?? this.now());
    events.push(this.checked({ type: EventType.RUN_ERROR, code, message }, undefined));
    this.phase = "terminal";
    return events;
  }

  private assertEnvelopeBoundary(envelope: TaskEventEnvelope): void {
    if (envelope.seq !== this.lastSeq + 1) {
      throw new AgUiAdapterError(
        "event_sequence_gap",
        `Expected canonical event sequence ${this.lastSeq + 1}, received ${envelope.seq}`,
        500,
      );
    }
    if (envelope.accountId !== this.principal.accountId) {
      throw new AgUiAdapterError("tenant_boundary_violation", "Canonical event crossed an account boundary", 500);
    }
    for (const [label, previous, current] of [
      ["account", this.accountId, envelope.accountId],
      ["task", this.taskId, envelope.taskId],
      ["agent", this.agentId, envelope.agentId],
      ["thread", this.threadInternalId, envelope.threadId],
    ] as const) {
      if (previous !== undefined && previous !== current) {
        throw new AgUiAdapterError(
          "identity_boundary_violation",
          `Canonical event changed ${label} identity inside one AG-UI stream`,
          500,
        );
      }
    }
    this.accountId ??= envelope.accountId;
    this.taskId ??= envelope.taskId;
    this.agentId ??= envelope.agentId;
    this.threadInternalId ??= envelope.threadId;
    if (
      this.phase === "active" &&
      envelope.runId !== null &&
      envelope.runId !== this.runInternalId &&
      this.targetRunInternalId === undefined
    ) {
      throw new AgUiAdapterError(
        "run_boundary_violation",
        "Canonical event changed run identity before the current run terminated",
        500,
      );
    }
  }

  private async mapRunStatus(
    envelope: Extract<TaskEventEnvelope, { type: "run.status.changed" }>,
  ): Promise<AGUIEvent[]> {
    const status = envelope.data.to;
    if (status === "queued" || status === "running") {
      if (this.phase === "idle") return [await this.startRun(envelope)];
      if (envelope.runId !== this.runInternalId) {
        throw new AgUiAdapterError("overlapping_runs", "A second run started before termination", 500);
      }
      return [];
    }
    this.assertActiveRun(envelope.runId);
    if (status === "interrupted") {
      if (this.interrupts.length === 0) {
        throw new AgUiAdapterError(
          "missing_interrupt",
          "Interrupted run reached its terminal boundary without an interrupt payload",
          500,
        );
      }
      // Permission/input interrupts commonly suspend an in-flight tool call. Close all
      // AG-UI triads explicitly before the terminal interrupt outcome.
      const events = this.closeOpenStreams(envelope.time);
      events.push(
        this.checked(
          {
            type: EventType.RUN_FINISHED,
            threadId: this.threadExternalId!,
            runId: this.runExternalId!,
            outcome: { type: "interrupt", interrupts: [...this.interrupts] },
          },
          envelope,
        ),
      );
      this.phase = "terminal";
      return events;
    }
    if (status === "completed") {
      this.assertOrdinaryStreamsClosed();
      const events = this.closeReasoning(envelope);
      events.push(
        this.checked(
          {
            type: EventType.RUN_FINISHED,
            threadId: this.threadExternalId!,
            runId: this.runExternalId!,
            outcome: { type: "success" },
          },
          envelope,
        ),
      );
      this.phase = "terminal";
      return events;
    }
    if (status === "failed" || status === "canceled") {
      const events = this.closeOpenStreams(envelope.time);
      const error = envelope.data.error;
      events.push(
        this.checked(
          {
            type: EventType.RUN_ERROR,
            code: status === "canceled" ? "cancelled" : (error?.code ?? "run_failed"),
            message:
              error?.message ??
              envelope.data.reason ??
              (status === "canceled" ? "Run was cancelled" : "Run failed"),
          },
          envelope,
        ),
      );
      this.phase = "terminal";
      return events;
    }
    return [];
  }

  private async startRun(
    envelope: Extract<TaskEventEnvelope, { type: "run.status.changed" }>,
  ): Promise<AGUIEvent> {
    this.runInternalId = envelope.runId;
    this.threadExternalId = await this.identities.externalId({
      protocol: "ag-ui",
      namespace: this.identities.namespace,
      kind: "thread",
      internalId: envelope.threadId,
    });
    this.runExternalId = await this.identities.externalId({
      protocol: "ag-ui",
      namespace: this.identities.namespace,
      kind: "run",
      internalId: envelope.runId,
    });
    this.taskExternalId = await this.identities.externalId({
      protocol: "ag-ui",
      namespace: this.identities.namespace,
      kind: "task",
      internalId: envelope.taskId,
    });
    if (this.expectedThreadId !== undefined && this.threadExternalId !== this.expectedThreadId) {
      throw new AgUiAdapterError(
        "thread_identity_mismatch",
        "Canonical thread does not match the requested AG-UI thread",
        500,
      );
    }
    if (this.expectedRunId !== undefined && this.runExternalId !== this.expectedRunId) {
      throw new AgUiAdapterError(
        "run_identity_mismatch",
        "Canonical run does not match the requested AG-UI run",
        500,
      );
    }
    this.phase = "active";
    return this.checked(
      {
        type: EventType.RUN_STARTED,
        threadId: this.threadExternalId,
        runId: this.runExternalId,
        ...(this.parentRunId === undefined ? {} : { parentRunId: this.parentRunId }),
      },
      envelope,
    );
  }

  private async mapMessageStarted(
    envelope: Extract<TaskEventEnvelope, { type: "message.started" }>,
  ): Promise<AGUIEvent[]> {
    const internalId = envelope.data.messageId;
    if (this.openMessages.has(internalId) || this.ignoredMessages.has(internalId)) {
      throw new AgUiAdapterError("duplicate_message_start", "Message stream started twice", 500);
    }
    if (envelope.data.role !== "agent") {
      this.ignoredMessages.add(internalId);
      return [];
    }
    this.assertActiveRun(envelope.runId);
    this.assertStreamCapacity();
    const externalId = await this.identities.externalId({
      protocol: "ag-ui",
      namespace: this.identities.namespace,
      kind: "message",
      internalId,
    });
    this.openMessages.set(internalId, { externalId, text: "" });
    return [
      this.checked(
        { type: EventType.TEXT_MESSAGE_START, messageId: externalId, role: "assistant" },
        envelope,
      ),
    ];
  }

  private mapMessageDelta(
    envelope: Extract<TaskEventEnvelope, { type: "message.text.delta" }>,
  ): AGUIEvent[] {
    if (this.ignoredMessages.has(envelope.data.messageId)) return [];
    this.assertActiveRun(envelope.runId);
    const open = this.openMessages.get(envelope.data.messageId);
    if (open === undefined) {
      throw new AgUiAdapterError("message_delta_without_start", "Message delta has no open message", 500);
    }
    const next = open.text + envelope.data.delta;
    if (byteLength(next) > this.limits.maxAccumulatedTextBytes) {
      throw new AgUiAdapterError("message_too_large", "Streamed message exceeds the configured limit", 500);
    }
    open.text = next;
    return [
      this.checked(
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: open.externalId,
          delta: envelope.data.delta,
        },
        envelope,
      ),
    ];
  }

  private async mapMessageFinished(
    envelope: Extract<TaskEventEnvelope, { type: "message.finished" }>,
  ): Promise<AGUIEvent[]> {
    const internalId = envelope.data.messageId;
    if (this.ignoredMessages.delete(internalId)) return [];
    this.assertActiveRun(envelope.runId);
    const open = this.openMessages.get(internalId);
    if (open === undefined) {
      throw new AgUiAdapterError("message_end_without_start", "Message ended without a start event", 500);
    }
    const finalText = envelope.data.parts
      .filter((part): part is Extract<ContentPart, { kind: "text" }> => part.kind === "text")
      .map((part) => part.text)
      .join("");
    const events: AGUIEvent[] = [];
    if (finalText !== open.text) {
      if (!finalText.startsWith(open.text)) {
        throw new AgUiAdapterError(
          "message_content_mismatch",
          "Final message content does not match its streamed prefix",
          500,
        );
      }
      const suffix = finalText.slice(open.text.length);
      if (suffix) {
        events.push(
          this.checked(
            { type: EventType.TEXT_MESSAGE_CONTENT, messageId: open.externalId, delta: suffix },
            envelope,
          ),
        );
      }
    }
    const richParts = envelope.data.parts.filter((part) => part.kind !== "text");
    if (richParts.length > 0) {
      events.push(
        this.checked(
          {
            type: EventType.CUSTOM,
            name: "openbot.message.parts",
            value: {
              messageId: open.externalId,
              parts: await this.publicParts(richParts),
            },
          },
          envelope,
        ),
      );
    }
    events.push(
      this.checked({ type: EventType.TEXT_MESSAGE_END, messageId: open.externalId }, envelope),
    );
    this.openMessages.delete(internalId);
    return events;
  }

  private mapActionStarted(
    envelope: Extract<TaskEventEnvelope, { type: "action.started" }>,
  ): AGUIEvent[] {
    this.assertActiveRun(envelope.runId);
    if (this.openActions.has(envelope.data.actionCallId)) {
      throw new AgUiAdapterError("duplicate_tool_start", "Tool call started twice", 500);
    }
    this.assertStreamCapacity();
    const parentMessageId = lastValue(this.openMessages)?.externalId;
    this.openActions.set(envelope.data.actionCallId, {
      name: envelope.data.name,
      arguments: "",
      parentMessageId,
    });
    return [
      this.checked(
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: envelope.data.actionCallId,
          toolCallName: envelope.data.name,
          ...(parentMessageId === undefined ? {} : { parentMessageId }),
        },
        envelope,
      ),
    ];
  }

  private mapActionArguments(
    envelope: Extract<TaskEventEnvelope, { type: "action.arguments.delta" }>,
  ): AGUIEvent[] {
    this.assertActiveRun(envelope.runId);
    const action = this.openActions.get(envelope.data.actionCallId);
    if (action === undefined) {
      throw new AgUiAdapterError("tool_args_without_start", "Tool arguments have no open call", 500);
    }
    const next = action.arguments + envelope.data.delta;
    if (byteLength(next) > this.limits.maxAccumulatedToolArgsBytes) {
      throw new AgUiAdapterError("tool_args_too_large", "Tool arguments exceed the configured limit", 500);
    }
    action.arguments = next;
    return [
      this.checked(
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: envelope.data.actionCallId,
          delta: envelope.data.delta,
        },
        envelope,
      ),
    ];
  }

  private mapActionFinished(
    envelope: Extract<TaskEventEnvelope, { type: "action.finished" }>,
  ): AGUIEvent[] {
    this.assertActiveRun(envelope.runId);
    const action = this.openActions.get(envelope.data.actionCallId);
    if (action === undefined) {
      throw new AgUiAdapterError("tool_end_without_start", "Tool call ended without a start event", 500);
    }
    const normalizedArguments = action.arguments || "{}";
    try {
      const parsed = JSON.parse(normalizedArguments);
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("tool arguments must be a JSON object");
      }
    } catch (cause) {
      throw new AgUiAdapterError(
        "invalid_tool_arguments",
        "Tool call arguments did not concatenate to a JSON object",
        500,
        { cause },
      );
    }
    this.openActions.delete(envelope.data.actionCallId);
    const events: AGUIEvent[] = [];
    if (!action.arguments) {
      events.push(
        this.checked(
          { type: EventType.TOOL_CALL_ARGS, toolCallId: envelope.data.actionCallId, delta: "{}" },
          envelope,
        ),
      );
    }
    events.push(
      this.checked(
        { type: EventType.TOOL_CALL_END, toolCallId: envelope.data.actionCallId },
        envelope,
      ),
    );
    if (envelope.data.output !== undefined) {
      events.push(
        this.checked(
          {
            type: EventType.TOOL_CALL_RESULT,
            messageId: `tool-result:${envelope.data.actionCallId}`,
            toolCallId: envelope.data.actionCallId,
            role: "tool",
            content: stringifyJson(envelope.data.output),
            metadata: { outcome: envelope.data.outcome },
          },
          envelope,
        ),
      );
    }
    return events;
  }

  private async mapReasoning(
    envelope: Extract<TaskEventEnvelope, { type: "reasoning.summary.delta" }>,
  ): Promise<AGUIEvent[]> {
    this.assertActiveRun(envelope.runId);
    this.reasoningBytes += byteLength(envelope.data.delta);
    if (this.reasoningBytes > this.limits.maxAccumulatedTextBytes) {
      throw new AgUiAdapterError("reasoning_too_large", "Reasoning summary exceeds the configured limit", 500);
    }
    const sourceId = envelope.data.messageId ?? envelope.runId;
    const sourceExternal =
      envelope.data.messageId === undefined
        ? this.runExternalId!
        : await this.identities.externalId({
            protocol: "ag-ui",
            namespace: this.identities.namespace,
            kind: "message",
            internalId: envelope.data.messageId,
          });
    const events: AGUIEvent[] = [];
    if (this.reasoningSpanId === undefined) {
      this.reasoningSpanId = `reasoning:${this.runExternalId}`;
      events.push(
        this.checked(
          { type: EventType.REASONING_START, messageId: this.reasoningSpanId },
          envelope,
        ),
      );
    }
    if (this.reasoningSourceId !== sourceId) {
      if (this.reasoningMessageId !== undefined) {
        events.push(
          this.checked(
            { type: EventType.REASONING_MESSAGE_END, messageId: this.reasoningMessageId },
            envelope,
          ),
        );
      }
      this.reasoningSourceId = sourceId;
      this.reasoningMessageId = `reasoning-message:${sourceExternal}`;
      events.push(
        this.checked(
          {
            type: EventType.REASONING_MESSAGE_START,
            messageId: this.reasoningMessageId,
            role: "reasoning",
          },
          envelope,
        ),
      );
    }
    events.push(
      this.checked(
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: this.reasoningMessageId!,
          delta: envelope.data.delta,
        },
        envelope,
      ),
    );
    return events;
  }

  private mapActivity(
    envelope: Extract<TaskEventEnvelope, { type: "activity.updated" }>,
  ): AGUIEvent[] {
    this.assertActiveRun(envelope.runId);
    return [
      this.checked(
        {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: `activity:${this.runExternalId}`,
          activityType: "openbot.run.activity",
          content: {
            label: envelope.data.label,
            ...(envelope.data.progress === undefined ? {} : { progress: envelope.data.progress }),
          },
          replace: true,
        },
        envelope,
      ),
    ];
  }

  private async mapInterrupt(
    envelope: Extract<TaskEventEnvelope, { type: "interrupt.requested" }>,
  ): Promise<AGUIEvent[]> {
    this.assertActiveRun(envelope.runId);
    if (this.interrupts.length >= this.limits.maxPendingInterrupts) {
      throw new AgUiAdapterError("too_many_interrupts", "Too many pending interrupts", 500);
    }
    const interrupt = envelope.data.interrupt;
    const id = await this.identities.externalId({
      protocol: "ag-ui",
      namespace: this.identities.namespace,
      kind: "interrupt",
      internalId: interrupt.id,
    });
    const toolCallId =
      stringMetadata(interrupt, "action-call-id") ??
      stringMetadata(interrupt, "action_call_id") ??
      (this.openActions.size === 1 ? this.openActions.keys().next().value : undefined);
    const mapped: AgUiInterrupt = {
      id,
      reason: interrupt.kind,
      message: interrupt.prompt,
      responseSchema: interrupt.responseSchema,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(interrupt.expiresAt === null ? {} : { expiresAt: safeIsoDate(interrupt.expiresAt) }),
    };
    this.interrupts.push(mapped);
    return [];
  }

  private async mapArtifact(
    envelope: Extract<TaskEventEnvelope, { type: "artifact.updated" }>,
  ): Promise<AGUIEvent[]> {
    if (this.phase !== "active") return [];
    const artifact = envelope.data.artifact;
    const id = await this.identities.externalId({
      protocol: "ag-ui",
      namespace: this.identities.namespace,
      kind: "artifact",
      internalId: artifact.id,
    });
    return [
      this.checked(
        {
          type: EventType.CUSTOM,
          name: "openbot.artifact.updated",
          value: {
            id,
            name: artifact.name,
            description: artifact.description,
            parts: await this.publicParts(artifact.parts),
            createdAt: safeIsoDate(artifact.createdAt),
            updatedAt: safeIsoDate(artifact.updatedAt),
          },
        },
        envelope,
      ),
    ];
  }

  private closeReasoning(envelope: TaskEventEnvelope): AGUIEvent[] {
    const events: AGUIEvent[] = [];
    if (this.reasoningMessageId !== undefined) {
      events.push(
        this.checked(
          { type: EventType.REASONING_MESSAGE_END, messageId: this.reasoningMessageId },
          envelope,
        ),
      );
      this.reasoningMessageId = undefined;
    }
    if (this.reasoningSpanId !== undefined) {
      events.push(
        this.checked(
          { type: EventType.REASONING_END, messageId: this.reasoningSpanId },
          envelope,
        ),
      );
      this.reasoningSpanId = undefined;
    }
    return events;
  }

  private closeOpenStreams(timestamp: number): AGUIEvent[] {
    const events: AGUIEvent[] = [];
    for (const [toolCallId] of this.openActions) {
      events.push(this.checked({ type: EventType.TOOL_CALL_END, toolCallId }, undefined, timestamp));
    }
    this.openActions.clear();
    for (const [, message] of this.openMessages) {
      events.push(
        this.checked(
          { type: EventType.TEXT_MESSAGE_END, messageId: message.externalId },
          undefined,
          timestamp,
        ),
      );
    }
    this.openMessages.clear();
    if (this.reasoningMessageId !== undefined) {
      events.push(
        this.checked(
          { type: EventType.REASONING_MESSAGE_END, messageId: this.reasoningMessageId },
          undefined,
          timestamp,
        ),
      );
      this.reasoningMessageId = undefined;
    }
    if (this.reasoningSpanId !== undefined) {
      events.push(
        this.checked(
          { type: EventType.REASONING_END, messageId: this.reasoningSpanId },
          undefined,
          timestamp,
        ),
      );
      this.reasoningSpanId = undefined;
    }
    return events;
  }

  private assertActiveRun(runId: string): void {
    if (this.phase !== "active" || this.runInternalId !== runId) {
      throw new AgUiAdapterError("event_outside_run", "Run-scoped event occurred outside its active run", 500);
    }
  }

  private assertOrdinaryStreamsClosed(): void {
    if (this.openMessages.size > 0 || this.openActions.size > 0 || this.ignoredMessages.size > 0) {
      throw new AgUiAdapterError(
        "unclosed_event_stream",
        "Run terminated with an open message or tool-call stream",
        500,
      );
    }
  }

  private assertStreamCapacity(): void {
    if (this.openMessages.size + this.openActions.size >= this.limits.maxOpenStreams) {
      throw new AgUiAdapterError("too_many_open_streams", "Too many open event streams", 500);
    }
  }

  private checked(candidate: unknown, envelope?: TaskEventEnvelope, timestamp?: number): AGUIEvent {
    const withBase = {
      ...(candidate as Record<string, unknown>),
      timestamp: envelope?.time ?? timestamp ?? this.lastTimestamp ?? this.now(),
      metadata:
        envelope === undefined
          ? this.taskExternalId === undefined
            ? undefined
            : { openbot: { taskId: this.taskExternalId, seq: this.lastSeq } }
          : { openbot: { taskId: this.taskExternalId, seq: envelope.seq } },
    };
    const parsed = EventSchemas.safeParse(withBase);
    if (!parsed.success) {
      throw new AgUiAdapterError(
        "invalid_ag_ui_event",
        "Mapped event failed the pinned AG-UI schema",
        500,
        { cause: parsed.error },
      );
    }
    if (parsed.data.type === EventType.RAW || parsed.data.rawEvent !== undefined) {
      throw new AgUiAdapterError("raw_event_forbidden", "RAW provider events cannot cross this boundary", 500);
    }
    if (byteLength(JSON.stringify(parsed.data)) > this.limits.maxEventBytes) {
      throw new AgUiAdapterError("event_too_large", "Mapped AG-UI event exceeds the configured limit", 500);
    }
    return parsed.data;
  }

  private async publicParts(parts: readonly ContentPart[]): Promise<JsonValue[]> {
    const output: JsonValue[] = [];
    for (const part of parts) {
      if (part.kind === "text") {
        output.push({ kind: "text", text: part.text });
      } else if (part.kind === "data") {
        output.push({ kind: "data", data: part.data, ...(part.mediaType ? { mediaType: part.mediaType } : {}) });
      } else {
        const externalId = await this.identities.externalId({
          protocol: "ag-ui",
          namespace: this.identities.namespace,
          kind: "attachment",
          internalId: part.attachment.id,
        });
        const url = await this.attachments.createDownloadUrl(
          this.principal,
          part.attachment.id,
          this.now() + this.limits.attachmentUrlTtlMs,
        );
        output.push({
          kind: "file",
          attachment: {
            id: externalId,
            name: part.attachment.name,
            mediaType: part.attachment.mediaType,
            size: part.attachment.size,
            sha256: part.attachment.sha256,
            url,
          },
        });
      }
    }
    return output;
  }
}

export type ReplaySnapshotOptions = {
  view: TaskView;
  identities: AgUiIdentityMap;
  attachments: AttachmentPort;
  principal: ProtocolPrincipal;
  limits: AgUiLimits;
  now?: () => number;
};

/** Produces a self-contained replay checkpoint; callers tail strictly after view.lastSeq. */
export async function createReplaySnapshot(options: ReplaySnapshotOptions): Promise<AGUIEvent[]> {
  const { view, identities, limits } = options;
  const now = options.now ?? Date.now;
  const run = view.runs.at(-1);
  if (run === undefined) {
    throw new AgUiAdapterError("run_not_found", "Task has no run to replay", 404);
  }
  const threadId = await identities.externalId({
    protocol: "ag-ui",
    namespace: identities.namespace,
    kind: "thread",
    internalId: view.task.threadId,
  });
  const taskId = await identities.externalId({
    protocol: "ag-ui",
    namespace: identities.namespace,
    kind: "task",
    internalId: view.task.id,
  });
  const runId = await identities.externalId({
    protocol: "ag-ui",
    namespace: identities.namespace,
    kind: "run",
    internalId: run.id,
  });
  const metadata = { openbot: { taskId, seq: view.lastSeq, snapshot: true } };
  const check = (candidate: unknown): AGUIEvent => {
    const parsed = EventSchemas.safeParse(candidate);
    if (!parsed.success) {
      throw new AgUiAdapterError("invalid_ag_ui_snapshot", "Replay snapshot failed AG-UI validation", 500, {
        cause: parsed.error,
      });
    }
    if (parsed.data.type === EventType.RAW || parsed.data.rawEvent !== undefined) {
      throw new AgUiAdapterError("raw_event_forbidden", "RAW events cannot appear in replay", 500);
    }
    if (byteLength(JSON.stringify(parsed.data)) > limits.maxEventBytes) {
      throw new AgUiAdapterError("event_too_large", "Replay event exceeds the configured limit", 500);
    }
    return parsed.data;
  };
  const timestamp = now();
  const messages = [];
  for (const message of view.messages) {
    const mapped = await snapshotMessage(message, identities, taskId);
    if (mapped !== null) messages.push(mapped);
  }
  const events: AGUIEvent[] = [
    check({ type: EventType.RUN_STARTED, threadId, runId, timestamp, metadata }),
    check({ type: EventType.MESSAGES_SNAPSHOT, messages, timestamp, metadata }),
  ];
  if (run.status === "completed") {
    events.push(
      check({
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        outcome: { type: "success" },
        timestamp,
        metadata,
      }),
    );
  } else if (run.status === "failed" || run.status === "canceled") {
    events.push(
      check({
        type: EventType.RUN_ERROR,
        code: run.status === "canceled" ? "cancelled" : "run_failed",
        message: run.status === "canceled" ? "Run was cancelled" : "Run failed",
        timestamp,
        metadata,
      }),
    );
  } else if (run.status === "interrupted") {
    const interrupts: AgUiInterrupt[] = [];
    for (const interrupt of view.interrupts.filter(
      (candidate) => candidate.runId === run.id && candidate.status === "open",
    )) {
      interrupts.push(await snapshotInterrupt(interrupt, identities));
    }
    if (interrupts.length === 0) {
      throw new AgUiAdapterError("missing_interrupt", "Interrupted replay has no open interrupt", 500);
    }
    events.push(
      check({
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        outcome: { type: "interrupt", interrupts },
        timestamp,
        metadata,
      }),
    );
  }
  return events;
}

async function snapshotMessage(message: Message, identities: AgUiIdentityMap, taskId: string) {
  const id = await identities.externalId({
    protocol: "ag-ui",
    namespace: identities.namespace,
    kind: "message",
    internalId: message.id,
  });
  const content = message.parts.map(partToSnapshotText).filter(Boolean).join("\n");
  const metadata = { openbot: { taskId } };
  if (message.role === "agent") return { id, role: "assistant" as const, content, metadata };
  if (message.role === "user") return { id, role: "user" as const, content, metadata };
  if (message.role === "system") return { id, role: "system" as const, content, metadata };
  const toolCallId =
    typeof message.metadata["action-call-id"] === "string"
      ? message.metadata["action-call-id"]
      : typeof message.metadata["action_call_id"] === "string"
        ? message.metadata["action_call_id"]
        : undefined;
  if (toolCallId === undefined) return null;
  return { id, role: "tool" as const, toolCallId, content, metadata };
}

async function snapshotInterrupt(
  interrupt: Interrupt,
  identities: AgUiIdentityMap,
): Promise<AgUiInterrupt> {
  const id = await identities.externalId({
    protocol: "ag-ui",
    namespace: identities.namespace,
    kind: "interrupt",
    internalId: interrupt.id,
  });
  return {
    id,
    reason: interrupt.kind,
    message: interrupt.prompt,
    responseSchema: interrupt.responseSchema,
    ...(interrupt.expiresAt === null ? {} : { expiresAt: safeIsoDate(interrupt.expiresAt) }),
  };
}

function partToSnapshotText(part: ContentPart): string {
  if (part.kind === "text") return part.text;
  if (part.kind === "data") return stringifyJson(part.data);
  return `[attachment: ${part.attachment.name ?? part.attachment.mediaType}]`;
}

function stringMetadata(interrupt: Interrupt, key: string): string | undefined {
  const value = interrupt.metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeIsoDate(value: number): string {
  if (value > 8_640_000_000_000_000) {
    throw new AgUiAdapterError("invalid_interrupt_expiry", "Interrupt expiry is outside ISO range", 500);
  }
  return new Date(value).toISOString();
}

function stringifyJson(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function lastValue<T>(map: Map<unknown, T>): T | undefined {
  let value: T | undefined;
  for (const candidate of map.values()) value = candidate;
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
