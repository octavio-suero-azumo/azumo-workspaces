import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv, type Env } from "@/server/env";
import * as schema from "./schema";

/**
 * Database client factory (T-03a).
 *
 * - `DATABASE_URL` set   -> postgres-js (Neon in production), `prepare: false`
 *   so it works behind Neon's pooled (PgBouncer) endpoint, and a small pool
 *   suited to Vercel Functions (review RV-F-03). TLS follows the URL's
 *   `sslmode` (Neon URLs carry it); nothing TLS-related is hardcoded here.
 * - `DATABASE_URL` empty -> in-process PGlite persisted at `PGLITE_DATA_DIR`
 *   (default `.pglite/`). Local dev only; migrations are applied on first use.
 *   PGlite is refused on ANY Vercel environment (`VERCEL` set) and whenever
 *   `VERCEL_ENV=production` (fail closed, review RV-F-06). PGlite and its
 *   drizzle adapter are loaded with a dynamic import ONLY in that branch, so a
 *   Vercel deployment never loads them.
 *
 * Only code under `src/server/` may import this module (AC-12).
 */

export type AppDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS_FOLDER = join(process.cwd(), "drizzle");

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

/**
 * postgres-js pool defaults for serverless (RV-F-03): few connections per
 * Function instance, idle connections closed after 20 s, fail fast when the
 * database is unreachable. Values are in seconds.
 */
interface PostgresPoolOptions {
  max: number;
  idle_timeout: number;
  connect_timeout: number;
}

export const POSTGRES_POOL_DEFAULTS: Readonly<PostgresPoolOptions> = Object.freeze({
  max: 3,
  idle_timeout: 20,
  connect_timeout: 10,
});

export type PostgresClientOptions = { prepare: false } & Partial<PostgresPoolOptions>;

/**
 * Options for `postgres(databaseUrl, options)`. An explicit option overrides
 * the URL query in postgres-js, so a pool setting that the URL already carries
 * (e.g. the E2E server's `?max=1`) is left to the URL. TLS (`sslmode`) is never
 * set here: it always comes from the URL.
 */
export function postgresClientOptions(databaseUrl: string): PostgresClientOptions {
  let query: URLSearchParams | undefined;
  try {
    query = new URL(databaseUrl).searchParams;
  } catch {
    query = undefined; // e.g. a multi-host URL: postgres-js parses it itself
  }
  const options: PostgresClientOptions = { prepare: false };
  for (const key of Object.keys(POSTGRES_POOL_DEFAULTS) as (keyof PostgresPoolOptions)[]) {
    if (!query?.has(key)) options[key] = POSTGRES_POOL_DEFAULTS[key];
  }
  return options;
}

export type DatabaseDriver = "postgres" | "pglite";

/**
 * Which driver the app uses for `env`. Throws `DatabaseConfigError` when
 * `DATABASE_URL` is missing on Vercel (any environment) or in production:
 * the local PGlite fallback is for local development only.
 */
export function selectDatabaseDriver(env: Pick<Env, "DATABASE_URL" | "VERCEL" | "VERCEL_ENV">): DatabaseDriver {
  if (env.DATABASE_URL) return "postgres";
  if (env.VERCEL) {
    throw new DatabaseConfigError("DATABASE_URL is required on Vercel (VERCEL is set); local PGlite is never used there");
  }
  if (env.VERCEL_ENV === "production") {
    throw new DatabaseConfigError("DATABASE_URL is required when VERCEL_ENV=production");
  }
  return "pglite";
}

/** In-process PGlite with all versioned migrations applied (`dataDir` undefined = in memory). */
async function openPglite(dataDir: string | undefined): Promise<{ db: AppDatabase; client: PGlite }> {
  const [{ PGlite: PGliteClass }, { drizzle: drizzlePglite }, { migrate: migratePglite }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
    import("drizzle-orm/pglite/migrator"),
  ]);
  const client = new PGliteClass(dataDir);
  const db = drizzlePglite({ client, schema });
  await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, client };
}

async function openDatabase(env: Env): Promise<AppDatabase> {
  if (selectDatabaseDriver(env) === "postgres" && env.DATABASE_URL) {
    const client = postgres(env.DATABASE_URL, postgresClientOptions(env.DATABASE_URL));
    return drizzlePostgres({ client, schema });
  }
  const { db } = await openPglite(env.PGLITE_DATA_DIR ?? join(process.cwd(), ".pglite"));
  return db;
}

// Cached on globalThis so dev hot reloads reuse one PGlite instance (PGlite
// holds an exclusive lock on its data directory).
const globalForDb = globalThis as typeof globalThis & {
  __azumoDb?: Promise<AppDatabase>;
};

/** Process-wide database for the running app. */
export function getDb(): Promise<AppDatabase> {
  if (!globalForDb.__azumoDb) {
    globalForDb.__azumoDb = openDatabase(getEnv()).catch((error: unknown) => {
      globalForDb.__azumoDb = undefined;
      throw error;
    });
  }
  return globalForDb.__azumoDb;
}

export interface TestDatabase {
  db: AppDatabase;
  /** The underlying PGlite instance (E2E serves it over a socket). */
  client: PGlite;
  close: () => Promise<void>;
}

/**
 * Fresh in-memory PGlite with all versioned migrations applied. For tests only;
 * each call is an isolated database.
 */
export async function createTestDb(): Promise<TestDatabase> {
  const { db, client } = await openPglite(undefined);
  return { db, client, close: () => client.close() };
}
