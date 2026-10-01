import { notFound, redirect } from "next/navigation";
import { requireSession, type SessionContext } from "@/server/authz/session";
import { getDataContext, type DataContext } from "@/server/data/context";
import { NotFoundError, UnauthenticatedError } from "@/server/errors";

/**
 * Helpers for server components (pages and layouts). Server actions use
 * `action()` instead; route handlers use `errorResponse()`.
 */

/** Session + data context for a page render; no session → redirect to /sign-in. */
export async function requirePageContext(): Promise<{ session: SessionContext; ctx: DataContext }> {
  let session: SessionContext;
  try {
    session = await requireSession();
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      redirect("/sign-in");
    }
    throw error;
  }
  return { session, ctx: await getDataContext(session) };
}

/** Render Next's 404 for a NotFound (non-member or missing resource, DP2). */
export async function orNotFound<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof NotFoundError) {
      notFound();
    }
    throw error;
  }
}
