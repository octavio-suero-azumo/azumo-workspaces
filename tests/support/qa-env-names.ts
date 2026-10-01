/**
 * QA helper (2026-10-01): variable NAMES in local env files, never values.
 *
 * `.env.local` and `.env.migrate.local` now hold REAL credentials (production
 * Neon, the private production Blob store, the Google OAuth client). The QA
 * isolation guards (tests/unit/qa-env-isolation.test.ts and
 * tests/integration/qa-env-isolation.test.ts) need to know which names those
 * files define. This helper reads a file only to collect the identifier on the
 * left of `=`; the value part of a line is never stored, returned, compared or
 * printed. Quoted multi-line values are skipped so that no fragment of a value
 * can ever be mistaken for a name.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(__dirname, "..", "..");

/** Every local env file that some tool in this repo could load. */
export const LOCAL_ENV_FILES: readonly string[] = Object.freeze([
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
  ".env.migrate.local",
]);

/** Files `@next/env` loads for `next dev`, `next build` and `next start`. */
export const NEXT_LOADED_ENV_FILES: readonly string[] = Object.freeze([
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
]);

/**
 * Variables that select or authenticate an external service (database, Blob
 * store, Google OAuth client, session signing). A test process must never
 * receive a real value for any of them.
 */
export const EXTERNAL_SERVICE_ENV_NAMES: readonly string[] = Object.freeze([
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_PRISMA_URL",
  "PGPASSWORD",
  "BLOB_READ_WRITE_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "BETTER_AUTH_SECRET",
  "AUTH_SECRET",
]);

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.?)/;

/** Names assigned in one env file (empty when the file does not exist). */
export function envFileNames(file: string, root: string = REPO_ROOT): string[] {
  const path = join(root, file);
  if (!existsSync(path)) return [];
  const names = new Set<string>();
  let openQuote: string | null = null;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (openQuote) {
      // Inside a quoted multi-line value: skip until the closing quote.
      if (line.includes(openQuote)) openQuote = null;
      continue;
    }
    const match = ASSIGNMENT.exec(line);
    if (!match) continue;
    names.add(match[1]);
    const quote = match[2];
    if (quote === '"' || quote === "'" || quote === "`") {
      const afterOpening = line.slice(line.indexOf(quote) + 1);
      if (!afterOpening.includes(quote)) openQuote = quote;
    }
  }
  return [...names].sort();
}

/** Names assigned in any of `files`. */
export function namesInEnvFiles(files: readonly string[], root: string = REPO_ROOT): string[] {
  return [...new Set(files.flatMap((file) => envFileNames(file, root)))].sort();
}

/** The subset of `names` that is defined and non-empty in `env`. Returns names only. */
export function definedNonEmpty(env: Readonly<Record<string, string | undefined>>, names: readonly string[]): string[] {
  return [...new Set(names)].filter((name) => typeof env[name] === "string" && env[name] !== "").sort();
}
