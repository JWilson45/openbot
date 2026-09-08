import { z } from "zod";
import type { JsonObject } from "./json.ts";

export const applicationErrorCodeSchema = z.enum([
  "invalid_argument",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "unavailable",
  "deadline_exceeded",
  "canceled",
  "provider_error",
  "internal",
]);

export type ApplicationErrorCode = z.infer<typeof applicationErrorCodeSchema>;

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly retryable: boolean;
  readonly details?: JsonObject;
  readonly cause?: unknown;

  constructor(
    code: ApplicationErrorCode,
    message: string,
    options: { retryable?: boolean; details?: JsonObject; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function isApplicationError(value: unknown): value is ApplicationError {
  return value instanceof ApplicationError;
}
