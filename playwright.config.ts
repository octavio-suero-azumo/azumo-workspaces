import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// E2E configuration. Browsers: `npx playwright install chromium`.
const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;

// The config is evaluated by the runner and by each worker; create the
// throwaway secret once and share it (and the DB port) via env.
process.env.E2E_AUTH_SECRET ??= randomBytes(32).toString("base64url");
// Port of the PGlite socket server started in tests/e2e/global-setup.ts.
// Never 5432 (another local Postgres may live there).
process.env.E2E_DB_PORT ??= "55433";
// The test-only auth helper (DP8) runs in the runner process (global setup)
// and refuses to run unless this is set; never set outside tests.
process.env.ENABLE_TEST_AUTH ??= "1";

// Test-only environment for the app under test. NO real secrets:
// - the Better Auth secret is random per run and never written anywhere;
// - the Google client values are obvious placeholders (no real OAuth client);
// - the allowed domain is the placeholder `allowed.test`;
// - DATABASE_URL points at the in-memory PGlite that global setup serves over
//   a local socket, so the server and the test setup share one database.
//   `max=1` (postgres-js pool size, read from the URL query): PGlite is a
//   single backend and pglite-socket multiplexes connections per protocol
//   MESSAGE, so two concurrent connections interleave Parse/Bind and break the
//   unnamed prepared statement. One pooled connection keeps every query's
//   messages contiguous (postgres-js pipelines queries on it).
const testServerEnv: Record<string, string> = {
  ALLOWED_GOOGLE_HD: "allowed.test",
  BETTER_AUTH_URL: baseURL,
  BETTER_AUTH_SECRET: process.env.E2E_AUTH_SECRET,
  GOOGLE_CLIENT_ID: "test-placeholder-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-placeholder-client-secret",
  ENABLE_TEST_AUTH: "1",
  DATABASE_URL: `postgres://postgres@127.0.0.1:${process.env.E2E_DB_PORT}/postgres?max=1`,
  PGLITE_DATA_DIR: "",
  // No Blob store in E2E (P4 pending): uploads must be "not configured".
  // Empty strings are "defined", so Next never fills them from a .env.local.
  BLOB_READ_WRITE_TOKEN: "",
  UPLOAD_MAX_BYTES: "",
  UPLOAD_ALLOWED_TYPES: "",
  NEXT_TELEMETRY_DISABLED: "1",
};

// Review RV-F-05: `E2E_PROD=1` (npm run test:e2e:prod) runs the SAME suite
// against a production build: `.next/` is deleted, then `next build` and
// `next start` run with the same test-only env. The build happens inside the
// webServer command, hence the longer startup timeout.
const prodMode = process.env.E2E_PROD === "1";
const serverArgs = `--port ${PORT} --hostname 127.0.0.1`;
const webServerCommand = prodMode
  ? `node -e "require('node:fs').rmSync('.next', { recursive: true, force: true })" && npm run build && npm run start -- ${serverArgs}`
  : `npm run dev -- ${serverArgs}`;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  // All specs share ONE database (and one server). Spec files that mutate
  // shared fixtures (e.g. pages.spec.ts creates/deletes W1 pages) must not
  // run concurrently with specs that assert those fixtures exactly.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: `test-results/${prodMode ? "e2e-prod-report" : "e2e-report"}.json` }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: webServerCommand,
    // /sign-in needs no session and no database, so it is a reliable
    // readiness probe even though the DB socket starts in global setup.
    url: `${baseURL}/sign-in`,
    env: testServerEnv,
    // Never reuse a server started with a different (possibly real) env.
    reuseExistingServer: false,
    timeout: prodMode ? 600_000 : 120_000,
    // Build output is useful when the production build fails.
    stdout: prodMode ? "pipe" : "ignore",
  },
});
