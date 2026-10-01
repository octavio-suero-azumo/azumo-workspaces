import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";
import { NEXT_LOADED_ENV_FILES, namesInEnvFiles } from "./tests/support/qa-env-names";

/**
 * Visual BASELINE / UI-audit configuration (QA, 2026-10-01). TEST-ONLY.
 *
 * Everything that touches the app under test is REUSED from
 * playwright.config.ts, by reference and unchanged:
 *   - `webServer`: same command and port, `reuseExistingServer: false`, and the
 *     same pinned test-only env (random Better Auth secret, placeholder Google
 *     client, `allowed.test`, local PGlite socket, empty Blob token). Because
 *     the object is shared, `E2E_PROD=1` works here too (production build,
 *     same env);
 *   - `globalSetup`: isolated in-memory PGlite, migrations, fixtures and the
 *     DP8 test-only sessions (no real Google login, no production data);
 *   - `use` (baseURL, trace), one worker, no retries.
 * Only the test directory, the output/report locations and the projects
 * differ, so `npm run test:e2e` (testDir tests/e2e) is not affected.
 *
 * Run:     npx playwright test -c playwright.visual.config.ts
 * Output:  screenshots in docs/evidence/ui/<VISUAL_PHASE>/ (default "before";
 *          an existing file is never overwritten unless VISUAL_OVERWRITE=1),
 *          audit metrics in test-results/visual/metrics/.
 */

const server = base.webServer;
if (!server || Array.isArray(server)) {
  throw new Error("playwright.visual.config.ts: expected the single webServer object of playwright.config.ts");
}
const env: Readonly<Record<string, string | undefined>> = server.env ?? {};

function hostOf(value: string | undefined): string | null {
  try {
    return value ? new URL(value).hostname : null;
  } catch {
    return null;
  }
}

// Fail closed BEFORE the server or global setup start. Messages carry variable
// NAMES only, never values (.env.local holds real credentials).
const checks: ReadonlyArray<readonly [string, boolean]> = [
  ["DATABASE_URL must point at the local PGlite socket (127.0.0.1)", hostOf(env.DATABASE_URL) === "127.0.0.1"],
  ["BETTER_AUTH_URL must be 127.0.0.1", hostOf(env.BETTER_AUTH_URL) === "127.0.0.1"],
  ["BETTER_AUTH_SECRET must be the per-run random test secret", (env.BETTER_AUTH_SECRET ?? "").length >= 32],
  ["BLOB_READ_WRITE_TOKEN must be pinned empty", env.BLOB_READ_WRITE_TOKEN === ""],
  ["PGLITE_DATA_DIR must be pinned empty", env.PGLITE_DATA_DIR === ""],
  ["GOOGLE_CLIENT_ID must be a test placeholder", (env.GOOGLE_CLIENT_ID ?? "").startsWith("test-placeholder")],
  ["GOOGLE_CLIENT_SECRET must be a test placeholder", (env.GOOGLE_CLIENT_SECRET ?? "").startsWith("test-placeholder")],
  ["ALLOWED_GOOGLE_HD must be the placeholder test domain", env.ALLOWED_GOOGLE_HD === "allowed.test"],
  ["ENABLE_TEST_AUTH must be 1", env.ENABLE_TEST_AUTH === "1"],
  ["webServer.reuseExistingServer must be false", server.reuseExistingServer === false],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
// Every name defined in a Next-loaded env file must be pinned: @next/env only
// fills variables that are undefined, and an empty string counts as defined.
const unpinned = namesInEnvFiles(NEXT_LOADED_ENV_FILES).filter((name) => !Object.hasOwn(env, name));
if (unpinned.length > 0) failed.push(`unpinned env-file names: ${unpinned.join(", ")}`);
if (failed.length > 0) {
  throw new Error(`playwright.visual.config.ts refuses to start: ${failed.join("; ")}`);
}

export default defineConfig({
  testDir: "./tests/visual",
  outputDir: "./test-results/visual",
  globalSetup: base.globalSetup,
  webServer: server,
  use: base.use,
  fullyParallel: base.fullyParallel,
  workers: base.workers,
  forbidOnly: base.forbidOnly,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/visual/visual-report.json" }]],
  projects: [
    {
      name: "isolation-preflight",
      testMatch: /isolation-preflight\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Never runs unless every preflight check passed.
      name: "ui-baseline",
      testMatch: /ui-baseline\.spec\.ts$/,
      dependencies: ["isolation-preflight"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
