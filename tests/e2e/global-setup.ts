/**
 * Playwright global setup (T-03c, DP8). TEST-ONLY.
 *
 * One in-memory PGlite database is shared by the test setup and the Next.js
 * server under test:
 *
 *   1. create PGlite, apply the versioned migrations, seed the §2 fixtures;
 *   2. create sessions for fixture users through the test-only auth helper
 *      (Better Auth `testUtils`, same options as production, no HTTP route)
 *      and write them as Playwright storageState files (gitignored);
 *   3. serve the same PGlite over the Postgres wire protocol with
 *      `@electric-sql/pglite-socket`; the Next server reaches it through its
 *      normal `DATABASE_URL` → postgres-js path (see playwright.config.ts).
 *
 * Playwright starts `webServer` BEFORE global setup. That is fine: the
 * readiness probe (`/sign-in`) never touches the database, and postgres-js
 * connects lazily on the first query, which only happens once tests run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { FullConfig } from "@playwright/test";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createTestDb } from "@/server/db/client";
import { seedFixtures, type FixtureUserKey } from "../support/fixtures";
import { assertTestAuthEnabled, createTestAuth, loginExistingUser, testEnv } from "../support/test-auth";
import { AUTH_DIR, FIXTURES_FILE, storageStatePath } from "./support/paths";

/** Users that get a signed-in storageState. */
const SIGNED_IN_USERS: readonly FixtureUserKey[] = ["alice", "bob", "carol", "erin", "outsider"];

export default async function globalSetup(config: FullConfig) {
  assertTestAuthEnabled();
  const baseURL = config.webServer?.env?.BETTER_AUTH_URL;
  const secret = process.env.E2E_AUTH_SECRET;
  const port = Number(process.env.E2E_DB_PORT);
  if (!baseURL || !secret || !Number.isInteger(port) || port <= 0) {
    throw new Error("E2E global setup: BETTER_AUTH_URL, E2E_AUTH_SECRET and E2E_DB_PORT must be set by playwright.config.ts");
  }

  // 1. Database + fixtures (in process, before any socket client exists).
  const testDb = await createTestDb();
  const fx = await seedFixtures(testDb.db);

  // 2. Sessions → storageState (same secret as the server, so the signature verifies).
  const auth = createTestAuth(testDb.db, testEnv({ BETTER_AUTH_URL: baseURL, BETTER_AUTH_SECRET: secret }));
  const host = new URL(baseURL).hostname;
  mkdirSync(AUTH_DIR, { recursive: true });
  for (const key of SIGNED_IN_USERS) {
    const login = await loginExistingUser(auth, fx.users[key].id);
    const state = {
      cookies: [
        {
          name: login.cookie.name,
          value: login.cookie.value,
          domain: host,
          path: "/",
          httpOnly: true,
          secure: false,
          sameSite: "Lax" as const,
          expires: Math.floor(login.expiresAt.getTime() / 1000),
        },
      ],
      origins: [],
    };
    writeFileSync(storageStatePath(key), JSON.stringify(state, null, 2));
  }
  writeFileSync(FIXTURES_FILE, JSON.stringify(fx, null, 2));

  // 3. Serve the same database to the Next server.
  const server = new PGLiteSocketServer({ db: testDb.client, host: "127.0.0.1", port, maxConnections: 16 });
  try {
    await server.start();
  } catch (error) {
    await testDb.close();
    throw new Error(`E2E global setup: could not listen on 127.0.0.1:${port} (set E2E_DB_PORT to a free port)`, {
      cause: error,
    });
  }

  return async () => {
    await server.stop();
    await testDb.close();
  };
}
