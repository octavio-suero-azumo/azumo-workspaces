import { count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActionWrapper } from "@/server/action";
import { resolveSession, UnauthenticatedError } from "@/server/authz/session";
import { createTestDb, type TestDatabase } from "@/server/db/client";
import { session, user } from "@/server/db/schema";
import { createTestAuth, createTestSession, TEST_ALLOWED_HD, type TestAuth } from "../support/test-auth";

// AC-01 (function level) and AC-07 (server side), using test-only sessions (DP8).
describe("requireSession core (resolveSession) and action() wrapper", () => {
  let testDb: TestDatabase;
  let auth: TestAuth;

  beforeEach(async () => {
    testDb = await createTestDb();
    auth = createTestAuth(testDb.db);
  });

  afterEach(async () => {
    await testDb.close();
  });

  it("throws UnauthenticatedError without a session cookie", async () => {
    await expect(resolveSession(auth, new Headers(), TEST_ALLOWED_HD)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("throws UnauthenticatedError for a forged session cookie", async () => {
    const forged = new Headers({ cookie: "better-auth.session_token=forged-token.forged-signature" });
    await expect(resolveSession(auth, forged, TEST_ALLOWED_HD)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("returns the userId for a valid test session", async () => {
    const signedIn = await createTestSession(auth, testDb.db);
    const ctx = await resolveSession(auth, signedIn.headers, TEST_ALLOWED_HD);
    expect(ctx.userId).toBe(signedIn.userId);
    expect(ctx.sessionId).toBe(signedIn.sessionId);
  });

  it("AC-07: after sign-out the session row is gone and the next check throws", async () => {
    const signedIn = await createTestSession(auth, testDb.db);
    await auth.api.signOut({ headers: signedIn.headers });

    const remaining = await testDb.db
      .select({ n: count() })
      .from(session)
      .where(eq(session.userId, signedIn.userId));
    expect(remaining[0].n).toBe(0);
    await expect(resolveSession(auth, signedIn.headers, TEST_ALLOWED_HD)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("AC-01: a wrapped action without a session returns UNAUTHENTICATED, never runs, changes nothing", async () => {
    const handler = vi.fn(async (ctx: { userId: string }, name: string) => {
      await testDb.db.update(user).set({ name }).where(eq(user.id, ctx.userId));
      return name;
    });
    const action = createActionWrapper(() => resolveSession(auth, new Headers(), TEST_ALLOWED_HD));
    const rename = action(handler);

    const [before] = await testDb.db.select({ n: count() }).from(user);
    const result = await rename("changed");
    const [after] = await testDb.db.select({ n: count() }).from(user);

    expect(result).toEqual({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Authentication required." },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(after.n).toBe(before.n);
  });

  it("a wrapped action with a valid session receives ctx.userId", async () => {
    const signedIn = await createTestSession(auth, testDb.db);
    const action = createActionWrapper(() => resolveSession(auth, signedIn.headers, TEST_ALLOWED_HD));
    const whoAmI = action(async (ctx) => ctx.userId);

    await expect(whoAmI()).resolves.toEqual({ ok: true, data: signedIn.userId });
  });
});

// Increment C hardening (approved): every request re-checks the STORED user's
// googleHd / emailVerified against the CURRENT ALLOWED_GOOGLE_HD, so a session
// created earlier stops working as soon as the user or the config drifts.
describe("requireSession re-checks the stored identity on every request", () => {
  let testDb: TestDatabase;
  let auth: TestAuth;

  beforeEach(async () => {
    testDb = await createTestDb();
    auth = createTestAuth(testDb.db);
  });

  afterEach(async () => {
    await testDb.close();
  });

  it("accepts a live session whose stored user matches the configured domain", async () => {
    const signedIn = await createTestSession(auth, testDb.db);
    await expect(resolveSession(auth, signedIn.headers, TEST_ALLOWED_HD)).resolves.toMatchObject({
      userId: signedIn.userId,
    });
  });

  it("rejects an existing session after ALLOWED_GOOGLE_HD changes", async () => {
    const signedIn = await createTestSession(auth, testDb.db);
    await expect(resolveSession(auth, signedIn.headers, "renamed.test")).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("rejects an existing session whose stored googleHd no longer matches", async () => {
    const signedIn = await createTestSession(auth, testDb.db);
    await testDb.db.update(user).set({ googleHd: "other.test" }).where(eq(user.id, signedIn.userId));
    await expect(resolveSession(auth, signedIn.headers, TEST_ALLOWED_HD)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("rejects an existing session whose stored googleHd was cleared", async () => {
    const signedIn = await createTestSession(auth, testDb.db);
    await testDb.db.update(user).set({ googleHd: null }).where(eq(user.id, signedIn.userId));
    await expect(resolveSession(auth, signedIn.headers, TEST_ALLOWED_HD)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("rejects an existing session whose stored email is no longer verified", async () => {
    const signedIn = await createTestSession(auth, testDb.db);
    await testDb.db.update(user).set({ emailVerified: false }).where(eq(user.id, signedIn.userId));
    await expect(resolveSession(auth, signedIn.headers, TEST_ALLOWED_HD)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it.each([[""], ["*"]])("fails closed when the configured domain is %j", async (allowedHd) => {
    const signedIn = await createTestSession(auth, testDb.db);
    await expect(resolveSession(auth, signedIn.headers, allowedHd)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("a wrapped action with a drifted user returns UNAUTHENTICATED and never runs", async () => {
    const signedIn = await createTestSession(auth, testDb.db);
    await testDb.db.update(user).set({ googleHd: "other.test" }).where(eq(user.id, signedIn.userId));
    const handler = vi.fn(async () => "ran");
    const run = createActionWrapper(() => resolveSession(auth, signedIn.headers, TEST_ALLOWED_HD))(handler);

    await expect(run()).resolves.toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(handler).not.toHaveBeenCalled();
  });
});
