import { toPublicError, type PublicErrorCode } from "@/server/errors";

/**
 * Single place that maps errors to HTTP status for route handlers
 * (architecture §4.6). Bodies carry only `{ error: { code, message } }`:
 * no stack traces, no foreign data.
 */

const STATUS_BY_CODE: Readonly<Record<PublicErrorCode, number>> = Object.freeze({
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 400,
  UNAVAILABLE: 503,
  INTERNAL: 500,
});

export function statusForError(error: unknown): number {
  return STATUS_BY_CODE[toPublicError(error).code];
}

export function errorResponse(error: unknown): Response {
  const publicError = toPublicError(error);
  if (publicError.code === "INTERNAL") {
    console.error("[http] unhandled error", error);
  }
  return Response.json(
    { error: publicError },
    { status: STATUS_BY_CODE[publicError.code], headers: { "Cache-Control": "no-store" } },
  );
}
