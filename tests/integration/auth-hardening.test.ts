import { count } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_DISABLED_PATHS, createAuth, type Auth } from "@/server/auth/config";
import { createTestDb, type AppDatabase, type TestDatabase } from "@/server/db/client";
import { account, session, user } from "@/server/db/schema";
import { simulateGoogleSignIn, syntheticIdToken, type SyntheticGoogleClaims } from "../support/google-oauth-sim";
import { createTestAuth, createTestSession, TEST_ALLOWED_HD, TEST_BASE_URL, testEnv } from "../support/test-auth";

// Review RV-C-01 (increments B/C): account linking, Google ID-token sign-in
// and unused account/profile endpoints are disabled.
//
// SIMULATED: synthetic Google claims through Better Auth's real endpoints
// (only Google's token endpoint is faked, see tests/support/google-oauth-sim).
// This proves our configuration and Better Auth's handling of it; it does not
// prove anything about real Google tokens (TC-40..TC-42 stay manual).

async function rowCounts(db: AppDatabase) {
  const [[users], [sessions], [accounts]] = await Promise.all([
    db.select({ n: count() }).from(user),
    db.select({ n: count() }).from(session),
    db.select({ n: count() }).from(account),
  ]);
  return { users: users.n, sessions: sessions.n, accounts: accounts.n };
}

function claims(overrides: Partial<SyntheticGoogleClaims> = {}): SyntheticGoogleClaims {
  return {
    sub: `google-sub-${Math.random().toString(36).slice(2)}`,
    email: `alice@${TEST_ALLOWED_HD}`,
    email_verified: true,
    hd: TEST_ALLOWED_HD,
    ...overrides,
  };
}

function errorCode(location: string | null): string | null {
  if (!location) return null;
  return new URL(location, "http://localhost").searchParams.get("error");
}

function issuedSessionCookie(setCookies: string[]): boolean {
  return setCookies.some((c) => c.includes("better-auth.session_token=") && !c.includes("Max-Age=0"));
}

describe("RV-C-01 (simulated): no second identity, no ID-token sign-in", () => {
  let testDb: TestDatabase;
  let auth: Auth;

  beforeEach(async () => {
    testDb = await createTestDb();
    // Production options (no test plugin).
    auth = createAuth({ db: testDb.db, env: testEnv() });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await testDb.close();
  });

  it("(a) existing user + NEW Google sub + same email + no hd → rejected, account count unchanged", async () => {
    const first = await simulateGoogleSignIn(auth, claims({ sub: "google-sub-original" }));
    expect(first.location).toBe("/");
    expect(await rowCounts(testDb.db)).toEqual({ users: 1, sessions: 1, accounts: 1 });

    const second = claims({ sub: "google-sub-intruder" });
    delete second.hd;
    const result = await simulateGoogleSignIn(auth, second);

    expect(result.location).toMatch(/^\/sign-in\?/);
    expect(errorCode(result.location)).not.toBeNull();
    expect(issuedSessionCookie(result.setCookies)).toBe(false);
    expect(await rowCounts(testDb.db)).toEqual({ users: 1, sessions: 1, accounts: 1 });
  });

  it("(a') existing user + NEW Google sub + same email even WITH the allowed hd → not linked", async () => {
    // Isolates the accountLinking setting: this identity passes every domain
    // check, so only the disabled linking can stop it.
    await simulateGoogleSignIn(auth, claims({ sub: "google-sub-original" }));
    const result = await simulateGoogleSignIn(auth, claims({ sub: "google-sub-second" }));

    expect(result.location).toMatch(/^\/sign-in\?/);
    expect(errorCode(result.location)).toBe("account_not_linked");
    expect(issuedSessionCookie(result.setCookies)).toBe(false);
    const accounts = await testDb.db.select({ accountId: account.accountId }).from(account);
    expect(accounts).toEqual([{ accountId: "google-sub-original" }]);
    expect(await rowCounts(testDb.db)).toEqual({ users: 1, sessions: 1, accounts: 1 });
  });

  it("(b) the SAME sub returning with hd=other.test → rejected, no new session row", async () => {
    const identity = claims({ sub: "google-sub-returning" });
    const first = await simulateGoogleSignIn(auth, identity);
    expect(first.location).toBe("/");
    expect(await rowCounts(testDb.db)).toEqual({ users: 1, sessions: 1, accounts: 1 });

    const result = await simulateGoogleSignIn(auth, { ...identity, hd: "other.test" });

    expect(result.location).toMatch(/^\/sign-in\?/);
    expect(errorCode(result.location)).not.toBeNull();
    expect(issuedSessionCookie(result.setCookies)).toBe(false);
    expect(await rowCounts(testDb.db)).toEqual({ users: 1, sessions: 1, accounts: 1 });
    const [stored] = await testDb.db.select({ googleHd: user.googleHd }).from(user);
    expect(stored.googleHd).toBe(TEST_ALLOWED_HD);
  });

  it("(c) ID-token sign-in is refused before any verification or row write", async () => {
    // Any outbound call (e.g. fetching Google's JWKS) would mean the token was
    // being processed; fail loudly instead.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      throw new Error(`Unexpected outbound fetch: ${String(input)}`);
    });

    const response = await auth.handler(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_BASE_URL },
        body: JSON.stringify({ provider: "google", idToken: { token: syntheticIdToken(claims()) } }),
      }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).toMatchObject({ code: "ID_TOKEN_NOT_SUPPORTED" });
    expect(response.headers.getSetCookie().some((c) => c.includes("better-auth.session_token="))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await rowCounts(testDb.db)).toEqual({ users: 0, sessions: 0, accounts: 0 });
  });
});

describe("RV-C-01: disabled Better Auth endpoints answer non-2xx", () => {
  let testDb: TestDatabase;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.close();
  });

  const METHOD: Readonly<Record<(typeof AUTH_DISABLED_PATHS)[number], "GET" | "POST">> = {
    "/link-social": "POST",
    "/unlink-account": "POST",
    "/update-user": "POST",
    "/get-access-token": "POST",
    "/refresh-token": "POST",
    "/account-info": "GET",
  };

  it.each(AUTH_DISABLED_PATHS.map((path) => [path] as const))(
    "%s is 404 even with a valid session, and changes nothing",
    async (path) => {
      const auth = createTestAuth(testDb.db);
      const signedIn = await createTestSession(auth, testDb.db, { name: "Original Name" });
      const before = await rowCounts(testDb.db);

      const method = METHOD[path];
      const response = await auth.handler(
        new Request(`${TEST_BASE_URL}/api/auth${path}`, {
          method,
          headers: { cookie: signedIn.cookie, origin: TEST_BASE_URL, "content-type": "application/json" },
          body:
            method === "POST"
              ? JSON.stringify({ provider: "google", providerId: "google", name: "Changed", callbackURL: "/" })
              : undefined,
        }),
      );

      expect(response.status).toBe(404);
      expect(await rowCounts(testDb.db)).toEqual(before);
      const [stored] = await testDb.db.select({ name: user.name }).from(user);
      expect(stored.name).toBe("Original Name");
    },
  );

  it("control: the same session still reaches an enabled endpoint (get-session → 200)", async () => {
    const auth = createTestAuth(testDb.db);
    const signedIn = await createTestSession(auth, testDb.db);
    const response = await auth.handler(
      new Request(`${TEST_BASE_URL}/api/auth/get-session`, { headers: { cookie: signedIn.cookie } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: signedIn.userId } });
  });
});
