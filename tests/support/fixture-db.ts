/**
 * Vitest harness for integration tests (T-03c).
 *
 * - One fresh in-memory PGlite (all versioned migrations applied) per call,
 *   i.e. per test file / describe block that uses it.
 * - `reset: "each"` (default): the database is wiped and the fixtures are
 *   reloaded before EVERY test, so mutating tests never leak into each other.
 * - `reset: "once"`: seed once for read-only suites.
 */
import { afterAll, beforeAll, beforeEach } from "vitest";
import type { DataContext } from "@/server/data/context";
import { createTestDb, type AppDatabase, type TestDatabase } from "@/server/db/client";
import { ctxFor, resetAndSeed, type Fixtures, type FixtureUserKey } from "./fixtures";

export interface FixtureDb {
  readonly db: AppDatabase;
  readonly fx: Fixtures;
  /** Data-layer context for a fixture user. */
  as(key: FixtureUserKey): DataContext;
}

export function useFixtureDb(options: { reset?: "each" | "once" } = {}): FixtureDb {
  const reset = options.reset ?? "each";
  let testDb: TestDatabase | undefined;
  let fixtures: Fixtures | undefined;

  beforeAll(async () => {
    testDb = await createTestDb();
    if (reset === "once") {
      fixtures = await resetAndSeed(testDb.db);
    }
  });

  if (reset === "each") {
    beforeEach(async () => {
      if (!testDb) throw new Error("test database not initialised");
      fixtures = await resetAndSeed(testDb.db);
    });
  }

  afterAll(async () => {
    await testDb?.close();
  });

  const harness: FixtureDb = {
    get db() {
      if (!testDb) throw new Error("test database not initialised");
      return testDb.db;
    },
    get fx() {
      if (!fixtures) throw new Error("fixtures not seeded");
      return fixtures;
    },
    as(key) {
      return ctxFor(harness.db, harness.fx, key);
    },
  };
  return harness;
}
