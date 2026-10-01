import { count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuth, type Auth } from "@/server/auth/config";
import { createTestDb, type AppDatabase, type TestDatabase } from "@/server/db/client";
import { account, session, user } from "@/server/db/schema";
import { simulateGoogleSignIn, type SyntheticGoogleClaims } from "../support/google-oauth-sim";
import { createTestAuth, createTestSession, TEST_ALLOWED_HD, testEnv } from "../support/test-auth";

// TC-01..TC-03 (AC-02..AC-04) plus RK-1 (returning users / changed config).
// SIMULATED: synthetic Google claims through Better Auth's real callback.
// A real Google login is still required for AC-02..AC-04 (TC-40..TC-42).

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

describe("simulated Google claims: domain guard at user and session creation", () => {
  let testDb: TestDatabase;
  let auth: Auth;

  beforeEach(async () => {
    testDb = await createTestDb();
    auth = createAuth({ db: testDb.db, env: testEnv() });
  });

  afterEach(async () => {
    await testDb.close();
  });

  it("TC-01 (simulated): allowed hd + email_verified creates user, account and session, redirects to /", async () => {
    const result = await simulateGoogleSignIn(auth, claims());

    expect(result.status).toBe(302);
    expect(result.location).toBe("/");
    expect(result.setCookies.some((c) => c.includes("better-auth.session_token="))).toBe(true);
    expect(await rowCounts(testDb.db)).toEqual({ users: 1, sessions: 1, accounts: 1 });

    const [stored] = await testDb.db.select().from(user);
    expect(stored.googleHd).toBe(TEST_ALLOWED_HD);
    expect(stored.emailVerified).toBe(true);
  });

  it("TC-02 (simulated): a Workspace account from another domain is rejected with 0 rows", async () => {
    const result = await simulateGoogleSignIn(
      auth,
      claims({ email: "mallory@other.test", hd: "other.test" }),
    );

    expect(result.status).toBe(302);
    expect(result.location).toMatch(/^\/sign-in\?/);
    expect(errorCode(result.location)).not.toBeNull();
    expect(result.setCookies.some((c) => c.includes("better-auth.session_token=") && !c.includes("Max-Age=0"))).toBe(false);
    expect(await rowCounts(testDb.db)).toEqual({ users: 0, sessions: 0, accounts: 0 });
  });

  it("TC-03 (simulated): a personal Gmail account (no hd) is rejected with 0 rows", async () => {
    const withoutHd = claims({ email: "someone@gmail.com" });
    delete withoutHd.hd;
    const result = await simulateGoogleSignIn(auth, withoutHd);

    expect(result.location).toMatch(/^\/sign-in\?/);
    expect(await rowCounts(testDb.db)).toEqual({ users: 0, sessions: 0, accounts: 0 });
  });

  it("allowed hd but email_verified=false is rejected with 0 rows", async () => {
    const result = await simulateGoogleSignIn(auth, claims({ email_verified: false }));

    expect(result.location).toMatch(/^\/sign-in\?/);
    expect(errorCode(result.location)).toBe("email_not_verified");
    expect(await rowCounts(testDb.db)).toEqual({ users: 0, sessions: 0, accounts: 0 });
  });

  it("returning user whose stored hd no longer matches is refused a new session", async () => {
    const identity = claims();
    const first = await simulateGoogleSignIn(auth, identity);
    expect(first.location).toBe("/");
    expect(await rowCounts(testDb.db)).toEqual({ users: 1, sessions: 1, accounts: 1 });

    // Stored identity drifts out of bounds (e.g. data from an older config).
    await testDb.db.update(user).set({ googleHd: "stale.test" });

    const second = await simulateGoogleSignIn(auth, identity);
    expect(second.location).toMatch(/^\/sign-in\?/);
    expect(errorCode(second.location)).toBe("hd_mismatch");
    expect(await rowCounts(testDb.db)).toEqual({ users: 1, sessions: 1, accounts: 1 });
  });

  it("session creation re-checks the stored user against the CURRENT ALLOWED_GOOGLE_HD", async () => {
    // A user created while `allowed.test` was the configured domain...
    const before = createTestAuth(testDb.db);
    const existing = await createTestSession(before, testDb.db);
    expect(await rowCounts(testDb.db)).toMatchObject({ users: 1, sessions: 1 });

    // ...cannot get a new session after the configured domain changes.
    const after = createTestAuth(testDb.db, testEnv({ ALLOWED_GOOGLE_HD: "renamed.test" }));
    const ctx = await after.$context;
    await expect(ctx.test.login({ userId: existing.userId })).rejects.toMatchObject({
      body: { code: "hd_mismatch" },
    });
    expect(await rowCounts(testDb.db)).toMatchObject({ users: 1, sessions: 1 });
  });

  it("a stored user without a verified email is refused a session", async () => {
    const testAuth = createTestAuth(testDb.db);
    await expect(createTestSession(testAuth, testDb.db, { emailVerified: false })).rejects.toMatchObject({
      body: { code: "email_not_verified" },
    });
    expect(await rowCounts(testDb.db)).toMatchObject({ users: 1, sessions: 0 });
  });

  it("the stored hd cannot be changed through Better Auth's update-user endpoint", async () => {
    const testAuth = createTestAuth(testDb.db);
    const signedIn = await createTestSession(testAuth, testDb.db);

    await expect(
      testAuth.api.updateUser({ headers: signedIn.headers, body: { googleHd: "other.test" } }),
    ).rejects.toBeDefined();

    const [stored] = await testDb.db.select().from(user).where(eq(user.id, signedIn.userId));
    expect(stored.googleHd).toBe(TEST_ALLOWED_HD);
  });
});
