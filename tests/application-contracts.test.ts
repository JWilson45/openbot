import { describe, expect, test } from "bun:test";
import {
  assertRunTransition,
  assertTaskTransition,
  canTransitionRun,
  canTransitionTask,
} from "../packages/application/src/index.ts";
import { ApplicationError } from "../packages/core/src/index.ts";

describe("application state contracts", () => {
  test("task lifecycle accepts interrupt/resume and rejects terminal resurrection", () => {
    expect(canTransitionTask("submitted", "working")).toBe(true);
    expect(canTransitionTask("working", "input_required")).toBe(true);
    expect(canTransitionTask("input_required", "working")).toBe(true);
    expect(canTransitionTask("completed", "working")).toBe(false);
    expect(() => assertTaskTransition("completed", "working")).toThrow(ApplicationError);
  });

  test("cancel and repeated transitions are idempotent", () => {
    expect(canTransitionTask("canceled", "canceled")).toBe(true);
    expect(canTransitionRun("canceled", "canceled")).toBe(true);
    expect(() => assertRunTransition("queued", "completed")).toThrow("illegal run transition");
  });

  test("every terminal state is absorbing", () => {
    for (const terminal of ["completed", "failed", "canceled", "rejected"] as const) {
      expect(canTransitionTask(terminal, "working")).toBe(false);
      expect(canTransitionTask(terminal, terminal)).toBe(true);
    }
    for (const terminal of ["completed", "failed", "canceled"] as const) {
      expect(canTransitionRun(terminal, "running")).toBe(false);
      expect(canTransitionRun(terminal, terminal)).toBe(true);
    }
  });
});
