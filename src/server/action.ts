import { unstable_rethrow } from "next/navigation";
import { requireSession, type SessionContext } from "@/server/authz/session";
import { toPublicError, type PublicError } from "@/server/errors";

/**
 * Mandatory wrapper for every server action (architecture §4.8, AC-01).
 *
 * Server actions are public POST endpoints, so each one must be exported from
 * a `"use server"` file as `export const name = action(async (ctx, ...) => …)`.
 * `tests/unit/server-actions-wrapped.test.ts` fails if any export skips it.
 *
 * The wrapper resolves the session first (no session → `UNAUTHENTICATED`
 * result, handler never runs, so no DB change) and maps every thrown error to
 * a typed result without stack traces.
 */

export interface ActionContext {
  userId: string;
}

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: PublicError };

export type ActionHandler<Args extends unknown[], R> = (ctx: ActionContext, ...args: Args) => Promise<R>;

export type SessionResolver = () => Promise<Pick<SessionContext, "userId">>;

/** Build an `action()` wrapper around a session resolver (injectable for tests). */
export function createActionWrapper(resolveSession: SessionResolver) {
  return function action<Args extends unknown[], R>(
    handler: ActionHandler<Args, R>,
  ): (...args: Args) => Promise<ActionResult<R>> {
    return async (...args: Args): Promise<ActionResult<R>> => {
      try {
        const session = await resolveSession();
        const data = await handler({ userId: session.userId }, ...args);
        return { ok: true, data };
      } catch (error) {
        // Let Next.js control-flow errors (redirect, notFound) propagate.
        unstable_rethrow(error);
        const publicError = toPublicError(error);
        if (publicError.code === "INTERNAL") {
          console.error("[action] unhandled error", error);
        }
        return { ok: false, error: publicError };
      }
    };
  };
}

export const action = createActionWrapper(requireSession);
