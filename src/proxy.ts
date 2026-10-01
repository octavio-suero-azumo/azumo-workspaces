import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic redirect only (architecture §4.5). This checks that a session
 * cookie EXISTS; it never validates it and is NOT authorization. Every page,
 * route handler and server action still calls `requireSession()` itself.
 *
 * Excluded by the matcher: `/sign-in`, all `/api/*` routes (auth endpoints,
 * and route handlers that must answer 401 rather than redirect), Next.js
 * internals and any path with a file extension (static assets).
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) {
    return NextResponse.next();
  }
  return NextResponse.redirect(new URL("/sign-in", request.url));
}

export const config = {
  matcher: ["/((?!api/|_next/|sign-in(?:/|$)|favicon\\.ico$|.*\\.[^/]+$).*)"],
};
