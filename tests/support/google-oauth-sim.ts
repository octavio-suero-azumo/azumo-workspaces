/**
 * SIMULATED Google OAuth round trip for integration tests (TC-01..TC-03).
 *
 * Drives Better Auth's real endpoints in-process: `POST /sign-in/social`, then
 * `GET /callback/google`. Only Google's token endpoint is faked (via a `fetch`
 * stub) so it returns an UNSIGNED ID token with synthetic claims.
 *
 * What this proves: our config, Better Auth's built-in `hd` check on the
 * decoded token, `validateUserInfo`, the database hooks and the rows written.
 * What it does NOT prove: Google's token signature, real `hd` issuance,
 * redirect URIs or the OAuth client setup. Those need a real Google login
 * (TC-40..TC-42, manual, production).
 */
import { vi } from "vitest";
import { TEST_BASE_URL } from "./test-auth";

export interface SyntheticGoogleClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string;
  name?: string;
}

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Unsigned JWT-shaped string. Better Auth's callback only decodes it. */
export function syntheticIdToken(claims: SyntheticGoogleClaims): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: "simulated", typ: "JWT" };
  const payload = {
    iss: "https://accounts.google.com",
    aud: "test-placeholder-client-id.apps.googleusercontent.com",
    iat: now,
    exp: now + 3600,
    name: claims.name ?? "Simulated User",
    picture: undefined,
    ...claims,
  };
  return `${base64url(header)}.${base64url(payload)}.simulated-signature`;
}

interface AuthHandler {
  handler: (request: Request) => Promise<Response>;
}

export interface SimulatedSignInResult {
  status: number;
  location: string | null;
  setCookies: string[];
}

function cookieHeaderFrom(setCookies: string[]): string {
  return setCookies.map((line) => line.split(";")[0]).join("; ");
}

/** Run a full simulated Google sign-in and return the callback response. */
export async function simulateGoogleSignIn(
  auth: AuthHandler,
  claims: SyntheticGoogleClaims,
): Promise<SimulatedSignInResult> {
  const start = await auth.handler(
    new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_BASE_URL },
      body: JSON.stringify({ provider: "google", callbackURL: "/", errorCallbackURL: "/sign-in" }),
    }),
  );
  if (start.status !== 200) {
    throw new Error(`sign-in/social returned ${start.status}: ${await start.text()}`);
  }
  const { url } = (await start.json()) as { url: string };
  const authorizationUrl = new URL(url);
  const state = authorizationUrl.searchParams.get("state");
  if (!state) throw new Error("authorization URL has no state");

  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (target.startsWith(GOOGLE_TOKEN_ENDPOINT)) {
      return Response.json({
        access_token: "simulated-access-token",
        id_token: syntheticIdToken(claims),
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid email profile",
      });
    }
    // Any other outbound call is unexpected in this flow.
    throw new Error(`Unexpected outbound fetch in simulated sign-in: ${target}`);
  });

  try {
    const callback = await auth.handler(
      new Request(
        `${TEST_BASE_URL}/api/auth/callback/google?code=simulated-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: cookieHeaderFrom(start.headers.getSetCookie()) } },
      ),
    );
    return {
      status: callback.status,
      location: callback.headers.get("location"),
      setCookies: callback.headers.getSetCookie(),
    };
  } finally {
    fetchSpy.mockRestore();
  }
}
