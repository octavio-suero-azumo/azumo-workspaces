import { getAuth } from "@/server/auth";

// Better Auth endpoints (Google OAuth start/callback, get-session, sign-out).
// The auth instance is resolved per request so invalid configuration fails
// closed with a 500 instead of breaking the build (AC-06).
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  const auth = await getAuth();
  return auth.handler(request);
}

export { handle as GET, handle as POST };
