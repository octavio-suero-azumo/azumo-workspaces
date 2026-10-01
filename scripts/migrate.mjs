#!/usr/bin/env node
// Guarded Drizzle migration runner (review RV-F-01).
//
//   npm run db:migrate:prod   remote Postgres ONLY. Uses DATABASE_URL_UNPOOLED
//                             (preferred: direct, non-PgBouncer endpoint) or
//                             DATABASE_URL. Refuses when neither is set and
//                             never falls back to local PGlite.
//   npm run db:migrate:local  local PGlite ONLY (PGLITE_DATA_DIR or ./.pglite).
//                             Refused when VERCEL is set.
//   npm run db:migrate        remote when a URL is set, otherwise REFUSES and
//                             points to the two explicit commands above.
//
// `--dry-run` resolves and prints the target and the local migration list
// without connecting to anything.
//
// Migrations are the versioned SQL files in `drizzle/` (DP9), applied with the
// drizzle-orm migrator (same `drizzle.__drizzle_migrations` journal table as
// drizzle-kit). Output names only the target host and database: never the
// user, password or query string of the connection URL.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MODES = Object.freeze(["prod", "local", "auto"]);
const URL_VARIABLES = Object.freeze(["DATABASE_URL_UNPOOLED", "DATABASE_URL"]);

export class MigrationConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationConfigError";
  }
}

const nonEmpty = (value) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);

/** Parse argv (without node and script) into `{ mode, dryRun }`. Unknown flags are refused. */
export function parseArgs(argv) {
  let mode = "auto";
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--target=") && MODES.includes(arg.slice("--target=".length))) {
      mode = arg.slice("--target=".length);
    } else {
      throw new MigrationConfigError(`Unknown argument. Allowed: --target=${MODES.join("|")}, --dry-run`);
    }
  }
  return { mode, dryRun };
}

/** Host and database name of a Postgres URL; never the credentials or query. */
function describeUrl(url, source) {
  if (!/^postgres(?:ql)?:\/\//i.test(url)) {
    throw new MigrationConfigError(`${source} must be a postgres:// or postgresql:// URL`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new MigrationConfigError(`${source} is not a valid URL`);
  }
  if (!parsed.hostname) throw new MigrationConfigError(`${source} has no host`);
  let database = "";
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    database = parsed.pathname.replace(/^\//, "");
  }
  return { host: parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname, database: database || "(default)" };
}

/**
 * Decide what to migrate. Pure: reads only `env`. Throws MigrationConfigError
 * (never echoing a value) instead of guessing.
 *
 * @returns {{ kind: "postgres", url: string, source: string, host: string, database: string, pooled: boolean }
 *          | { kind: "pglite", dataDir: string }}
 */
export function resolveMigrationTarget(mode, env, root = PROJECT_ROOT) {
  if (!MODES.includes(mode)) throw new MigrationConfigError(`Unknown mode. Allowed: ${MODES.join(", ")}`);

  if (mode === "local") {
    if (nonEmpty(env.VERCEL)) {
      throw new MigrationConfigError("Refusing to migrate local PGlite on Vercel (VERCEL is set)");
    }
    const dataDir = nonEmpty(env.PGLITE_DATA_DIR) ?? ".pglite";
    return { kind: "pglite", dataDir: path.resolve(root, dataDir) };
  }

  const source = URL_VARIABLES.find((name) => nonEmpty(env[name]));
  if (!source) {
    const hint =
      mode === "prod"
        ? "Set DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL to the target database. This command never uses local PGlite."
        : "Set DATABASE_URL_UNPOOLED or DATABASE_URL, or run `npm run db:migrate:local` to migrate the local PGlite database explicitly.";
    throw new MigrationConfigError(`Refusing to migrate: neither DATABASE_URL_UNPOOLED nor DATABASE_URL is set. ${hint}`);
  }
  const url = nonEmpty(env[source]);
  const { host, database } = describeUrl(url, source);
  return { kind: "postgres", url, source, host, database, pooled: source === "DATABASE_URL" };
}

/** One-line, credential-free description of a target. */
export function describeTarget(target) {
  if (target.kind === "pglite") return `local PGlite at ${target.dataDir}`;
  return `Postgres ${target.host}/${target.database} (from ${target.source})`;
}

/** Remove the URL and its password from a message before printing it. */
export function redactUrl(text, url) {
  let out = String(text);
  if (!url) return out;
  out = out.split(url).join("[DATABASE_URL]");
  try {
    const { password } = new URL(url);
    if (password) out = out.split(decodeURIComponent(password)).join("[REDACTED]").split(password).join("[REDACTED]");
  } catch {
    /* unparsable: the whole URL was already removed */
  }
  return out;
}

/** Tags of the local migration files, from drizzle/meta/_journal.json. */
export function localMigrations(root = PROJECT_ROOT) {
  const journal = path.join(root, "drizzle", "meta", "_journal.json");
  if (!existsSync(journal)) throw new MigrationConfigError("drizzle/meta/_journal.json not found");
  const { entries } = JSON.parse(readFileSync(journal, "utf8"));
  return entries.map((entry) => entry.tag);
}

async function migratePostgres(target, migrationsFolder) {
  const [{ default: postgres }, { drizzle }, { migrate }] = await Promise.all([
    import("postgres"),
    import("drizzle-orm/postgres-js"),
    import("drizzle-orm/postgres-js/migrator"),
  ]);
  // One connection, no prepared statements (safe even on a pooled URL), fail
  // fast. TLS comes from the URL's sslmode.
  const client = postgres(target.url, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function migratePglite(target, migrationsFolder) {
  const [{ PGlite }, { drizzle }, { migrate }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
    import("drizzle-orm/pglite/migrator"),
  ]);
  const client = new PGlite(target.dataDir);
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    await client.close();
  }
}

/** CLI entry. Returns the process exit code. */
export async function main(argv, env, { log = console.log, error = console.error, root = PROJECT_ROOT } = {}) {
  let target;
  try {
    const { mode, dryRun } = parseArgs(argv);
    target = resolveMigrationTarget(mode, env, root);
    const migrations = localMigrations(root);
    log(`Migration target: ${describeTarget(target)}`);
    if (target.kind === "postgres" && target.pooled) {
      log("Note: using DATABASE_URL (possibly a pooled endpoint). DATABASE_URL_UNPOOLED is preferred for migrations.");
    }
    log(`Migrations in drizzle/: ${migrations.length} (${migrations.join(", ")})`);
    if (dryRun) {
      log("Dry run: nothing was applied.");
      return 0;
    }
    const migrationsFolder = path.join(root, "drizzle");
    if (target.kind === "postgres") await migratePostgres(target, migrationsFolder);
    else await migratePglite(target, migrationsFolder);
    log("Migrations applied (already-applied migrations were skipped).");
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const url = target?.kind === "postgres" ? target.url : undefined;
    error(`${err instanceof MigrationConfigError ? "" : "Migration failed: "}${redactUrl(message, url)}`);
    return 1;
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
