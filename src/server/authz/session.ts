import { headers } from "next/headers";
import { getAuth, type Auth } from "@/server/auth";
import { evaluateGoogleIdentity } from "@/server/auth/domain-guard";
import { getEnv } from "@/server/env";
import { UnauthenticatedError } from "@/server/errors";

export { UnauthenticatedError } from "@/server/errors";

/**
 * Server-side session check (R1.4, architecture §4.1).
 *
 * The session is always read from the database (cookie cache disabled), so a
 * signed-out or revoked session is rejected on the very next request (AC-07).
 * Roles/memberships are never cached here (architecture §4.9).
 *
 * Hardening (approved for increment C): on EVERY request the stored user's
 * `googleHd` and `emailVerified` are re-checked against the CURRENT
 * `ALLOWED_GOOGLE_HD`. A session that was valid under an older configuration,
 * or whose user no longer satisfies the domain rule, is treated as
 * unauthenticated (R1.2).
 */

export interface SessionContext {
  userId: string;
  sessionId: string;
  user: { id: string; email: string; name: string };
}

/** Anything exposing Better Auth's `api.getSession` (the app or a test instance). */
export type SessionReader = Pick<Auth, "api">;

/**
 * Resolve the session for `requestHeaders` using `auth`, accepting it only if
 * the stored user still matches `allowedHd` with a verified email. Throws
 * `UnauthenticatedError` otherwise. Other failures (for example the database
 * being down) propagate and become a 500, never a pass.
 */
export async function resolveSession(
  auth: SessionReader,
  requestHeaders: Headers,
  allowedHd: string,
): Promise<SessionContext> {
  const result = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true },
  });
  if (!result?.session || !result.user) {
    throw new UnauthenticatedError();
  }
  const verdict = evaluateGoogleIdentity(
    { hd: result.user.googleHd, emailVerified: result.user.emailVerified },
    allowedHd,
  );
  if (!verdict.ok) {
    throw new UnauthenticatedError();
  }
  return {
    userId: result.user.id,
    sessionId: result.session.id,
    user: { id: result.user.id, email: result.user.email, name: result.user.name },
  };
}

/** Session for the current request (server components, actions, route handlers). */
export async function requireSession(): Promise<SessionContext> {
  // Read request headers first: this marks the caller as dynamic, so Next
  // never tries to prerender a session-protected page at build time.
  const requestHeaders = await headers();
  const auth = await getAuth();
  return resolveSession(auth, requestHeaders, getEnv().ALLOWED_GOOGLE_HD);
}
