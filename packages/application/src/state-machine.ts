import type { RunStatus, TaskStatus } from "@openbot/core";
import { ApplicationError } from "@openbot/core";

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  submitted: new Set(["working", "canceled", "rejected"]),
  working: new Set(["input_required", "auth_required", "completed", "failed", "canceled"]),
  input_required: new Set(["working", "failed", "canceled"]),
  auth_required: new Set(["working", "failed", "canceled"]),
  completed: new Set(),
  failed: new Set(),
  canceled: new Set(),
  rejected: new Set(),
};

const RUN_TRANSITIONS: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  queued: new Set(["running", "canceled"]),
  running: new Set(["interrupted", "completed", "failed", "canceled"]),
  interrupted: new Set(["running", "failed", "canceled"]),
  completed: new Set(),
  failed: new Set(),
  canceled: new Set(),
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TASK_TRANSITIONS[from].has(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new ApplicationError("conflict", `illegal task transition: ${from} -> ${to}`);
  }
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return from === to || RUN_TRANSITIONS[from].has(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new ApplicationError("conflict", `illegal run transition: ${from} -> ${to}`);
  }
}
