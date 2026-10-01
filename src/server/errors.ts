/**
 * Typed application errors. Mapped to HTTP status in `src/server/http.ts` and
 * to action results in `src/server/action.ts`. Messages are safe to show to
 * the user: never include stack traces, secrets or data from other workspaces.
 */

import { ZodError } from "zod";

export type AppErrorCode = "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "UNAVAILABLE";

export type PublicErrorCode = AppErrorCode | "INTERNAL";

export interface PublicError {
  code: PublicErrorCode;
  message: string;
}

const INTERNAL_MESSAGE = "Something went wrong.";

/**
 * Reduce any thrown value to a safe `{ code, message }`. Unknown errors become
 * `INTERNAL` with a generic message (their details are logged server-side
 * only, never returned).
 */
export function toPublicError(error: unknown): PublicError {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ZodError) {
    return { code: "VALIDATION", message: "Invalid input." };
  }
  return { code: "INTERNAL", message: INTERNAL_MESSAGE };
}

export abstract class AppError extends Error {
  abstract readonly code: AppErrorCode;
}

export class UnauthenticatedError extends AppError {
  readonly code = "UNAUTHENTICATED";
  constructor(message = "Authentication required.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN";
  constructor(message = "You do not have permission to do this.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  constructor(message = "Not found.") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  readonly code = "CONFLICT";
  constructor(message = "The request conflicts with the current state.") {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends AppError {
  readonly code = "VALIDATION";
  constructor(message = "Invalid input.") {
    super(message);
    this.name = "ValidationError";
  }
}

/** A feature that depends on missing server configuration (e.g. uploads without a Blob token). */
export class ServiceUnavailableError extends AppError {
  readonly code = "UNAVAILABLE";
  constructor(message = "This feature is not available right now.") {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}
