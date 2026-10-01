/**
 * Extract the Postgres error (SQLSTATE `code` + `constraint`) from a thrown
 * value. Drizzle wraps driver errors in `DrizzleQueryError` (`cause`).
 */
export interface PgErrorInfo {
  code?: string;
  constraint?: string;
}

export function pgError(error: unknown): PgErrorInfo {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === "string" ? candidate.constraint : undefined,
      };
    }
    current = candidate.cause;
  }
  return {};
}

/** Run `fn`, expect it to reject, and return the Postgres error info. */
export async function expectPgError(fn: () => Promise<unknown>): Promise<PgErrorInfo> {
  try {
    await fn();
  } catch (error) {
    return pgError(error);
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_CHECK_VIOLATION = "23514";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
