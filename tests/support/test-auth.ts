/**
 * TEST-ONLY auth helper (DP8, AC-36, RK-6).
 *
 * - Lives under tests/, never under src/, has no HTTP route, and is imported
 *   only by test code (enforced by tests/unit/test-auth-isolation.test.ts).
 * - Refuses to run when VERCEL_ENV=production or ENABLE_TEST_AUTH !== "1".
 * - Builds a separate Better Auth instance from the SAME production options
 *   plus Better Auth's `testUtils` plugin, so sessions still pass through the
 *   real `session.create.before` domain hook.
 */
import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { buildAuthOptions } from "@/server/auth/config";
import type { AppDatabase } from "@/server/db/client";
import { user as userTable } from "@/server/db/schema";
import { parseEnv, type Env, type EnvSource } from "@/server/env";

/** Placeholder domain used by every test (never a real company domain). */
export const TEST_ALLOWED_HD = "allowed.test";
export const TEST_BASE_URL = "http://localhost:3000";

export class TestAuthDisabledError extends Error {
  constructor(reason: string) {
    super(`Test auth is disabled: ${reason}`);
    this.name = "TestAuthDisabledError";
  }
}

/** Throws unless test auth is explicitly enabled outside production. */
export function assertTestAuthEnabled(source: EnvSource = process.env): void {
  if (source.VERCEL_ENV === "production") {
    throw new TestAuthDisabledError("VERCEL_ENV is production");
  }
  if (source.ENABLE_TEST_AUTH !== "1") {
    throw new TestAuthDisabledError('ENABLE_TEST_AUTH must be "1"');
  }
}

/**
 * Validated env for tests. The secret is random per process (never stored);
 * Google client values are obvious non-secret placeholders.
 */
export function testEnv(overrides: EnvSource = {}): Env {
  return parseEnv({
    ALLOWED_GOOGLE_HD: TEST_ALLOWED_HD,
    BETTER_AUTH_URL: TEST_BASE_URL,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    GOOGLE_CLIENT_ID: "test-placeholder-client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "test-placeholder-client-secret",
    ...overrides,
  });
}

export function createTestAuth(db: AppDatabase, env: Env = testEnv()) {
  assertTestAuthEnabled();
  const options = buildAuthOptions({ db, env });
  return betterAuth({ ...options, plugins: [testUtils()] });
}

export type TestAuth = ReturnType<typeof createTestAuth>;

export interface TestSession {
  userId: string;
  sessionId: string;
  sessionToken: string;
  /** Request headers carrying the signed session cookie. */
  headers: Headers;
  /** `name=value` of the signed session cookie. */
  cookie: string;
}

export interface ExistingUserLogin {
  userId: string;
  sessionId: string;
  /** Signed session cookie accepted by Better Auth. */
  cookie: { name: string; value: string };
  expiresAt: Date;
}

/**
 * Create a session for an EXISTING user (for example a seeded fixture). The
 * session still passes through the real `session.create.before` domain hook.
 */
export async function loginExistingUser(auth: TestAuth, userId: string): Promise<ExistingUserLogin> {
  assertTestAuthEnabled();
  const ctx = await auth.$context;
  const login = await ctx.test.login({ userId });
  const [cookie] = login.cookies;
  return {
    userId,
    sessionId: login.session.id,
    cookie: { name: cookie.name, value: cookie.value },
    expiresAt: new Date(login.session.expiresAt),
  };
}

let counter = 0;

/**
 * Create a user on the allowed test domain (`hd=allowed.test`,
 * `emailVerified=true`) and a session for it, returning the signed session
 * cookie Better Auth accepts. Signing is done by Better Auth's own
 * `testUtils` (HMAC-SHA256 with the instance secret).
 */
export async function createTestSession(
  auth: TestAuth,
  db: AppDatabase,
  overrides: { email?: string; name?: string; googleHd?: string | null; emailVerified?: boolean } = {},
): Promise<TestSession> {
  assertTestAuthEnabled();
  counter += 1;
  const id = `test-user-${Date.now().toString(36)}-${counter}`;
  await db.insert(userTable).values({
    id,
    name: overrides.name ?? `Test User ${counter}`,
    email: overrides.email ?? `user${counter}.${Date.now().toString(36)}@${TEST_ALLOWED_HD}`,
    emailVerified: overrides.emailVerified ?? true,
    googleHd: overrides.googleHd === undefined ? TEST_ALLOWED_HD : overrides.googleHd,
  });

  const ctx = await auth.$context;
  const login = await ctx.test.login({ userId: id });
  const [cookie] = login.cookies;
  return {
    userId: id,
    sessionId: login.session.id,
    sessionToken: login.token,
    headers: login.headers,
    cookie: `${cookie.name}=${cookie.value}`,
  };
}
