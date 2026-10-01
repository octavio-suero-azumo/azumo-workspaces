import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  definedNonEmpty,
  envFileNames,
  EXTERNAL_SERVICE_ENV_NAMES,
  LOCAL_ENV_FILES,
  NEXT_LOADED_ENV_FILES,
  namesInEnvFiles,
} from "../support/qa-env-names";

// ============================================================================
// QA isolation guard (2026-10-01, pre-deploy).
//
// `.env.local` / `.env.migrate.local` now hold REAL credentials (production
// Neon, the private production Blob store, the Google OAuth client). These
// tests prove, without reading or printing any VALUE, that:
//   1. this Vitest worker (unit project) received none of those variables:
//      Vite's loadEnv only exposes VITE_* names and never copies other .env
//      entries into process.env;
//   2. the E2E Next server (playwright.config.ts `webServer.env`, used by both
//      `test:e2e` and `test:e2e:prod`) pins every variable that a Next-loaded
//      env file defines and every app variable that selects the database, the
//      Blob store or the Google client. `@next/env` only fills variables that
//      are undefined (an empty string counts as defined), so a pinned name can
//      never receive a real value from `.env.local`.
// Failures print variable NAMES only.
// ============================================================================

/** Snapshot taken at module load, before any test in this file can stub anything. */
const WORKER_ENV_AT_LOAD: Readonly<Record<string, string | undefined>> = { ...process.env };

/** Set by vitest.config.mts for the integration project only (test-only auth, DP8). */
const VITEST_CONFIG_ENV = new Set(["ENABLE_TEST_AUTH"]);

/** Every variable src/server/env.ts reads, except the platform-set VERCEL / VERCEL_ENV. */
const APP_ENV_NAMES_TO_PIN = [
  "DATABASE_URL",
  "PGLITE_DATA_DIR",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ALLOWED_GOOGLE_HD",
  "ENABLE_TEST_AUTH",
  "BLOB_READ_WRITE_TOKEN",
  "UPLOAD_MAX_BYTES",
  "UPLOAD_ALLOWED_TYPES",
];

interface LoadedPlaywrightConfig {
  webServer: { command: string; env: Record<string, string> };
}

async function loadPlaywrightConfig(e2eProd: boolean): Promise<LoadedPlaywrightConfig> {
  vi.stubEnv("E2E_PROD", e2eProd ? "1" : "");
  vi.resetModules();
  const loaded = (await import("../../playwright.config")) as { default: LoadedPlaywrightConfig };
  return loaded.default;
}

/** Assigned directly (`??=`) by playwright.config.ts when it is evaluated. */
const SET_BY_PLAYWRIGHT_CONFIG = ["E2E_AUTH_SECRET", "E2E_DB_PORT", "ENABLE_TEST_AUTH"];

describe("QA isolation guard: unit worker and E2E server never see real credentials", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const name of SET_BY_PLAYWRIGHT_CONFIG) {
      const original = WORKER_ENV_AT_LOAD[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  });

  it("the unit Vitest worker received no credential and no variable defined in a local env file", () => {
    const names = [...EXTERNAL_SERVICE_ENV_NAMES, ...namesInEnvFiles(LOCAL_ENV_FILES)].filter(
      (name) => !VITEST_CONFIG_ENV.has(name),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(definedNonEmpty(WORKER_ENV_AT_LOAD, names)).toEqual([]);
  });

  it("the E2E server env pins every Next-loaded env-file name and every app external-service name", async () => {
    const { webServer } = await loadPlaywrightConfig(false);
    const pinned = new Set(Object.keys(webServer.env));
    const required = [...new Set([...APP_ENV_NAMES_TO_PIN, ...namesInEnvFiles(NEXT_LOADED_ENV_FILES)])].sort();
    expect(required.filter((name) => !pinned.has(name))).toEqual([]);
  });

  it("the E2E pins point at local, placeholder or empty values only (no DB host but 127.0.0.1, no Blob token)", async () => {
    const { webServer } = await loadPlaywrightConfig(false);
    const env = webServer.env;
    expect(new URL(env.DATABASE_URL).hostname).toBe("127.0.0.1");
    expect(env.BLOB_READ_WRITE_TOKEN).toBe("");
    expect(env.PGLITE_DATA_DIR).toBe("");
    expect(env.GOOGLE_CLIENT_SECRET.startsWith("test-placeholder")).toBe(true);
    expect(env.GOOGLE_CLIENT_ID.startsWith("test-placeholder")).toBe(true);
    expect(env.ALLOWED_GOOGLE_HD).toBe("allowed.test");
    expect(new URL(env.BETTER_AUTH_URL).hostname).toBe("127.0.0.1");
  });

  it("self-test: the names-only parser skips comments and quoted multi-line values; definedNonEmpty returns names only", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-env-names-"));
    try {
      writeFileSync(
        join(dir, ".env.local"),
        [
          "# COMMENTED=1",
          "export FOO=bar",
          'MULTI="first line',
          "QA_FRAGMENT_NOT_A_NAME=inside-a-quoted-value",
          '"',
          "BAZ='x'",
          "EMPTY=",
          "not an assignment",
        ].join("\n"),
      );
      expect(envFileNames(".env.local", dir)).toEqual(["BAZ", "EMPTY", "FOO", "MULTI"]);
      expect(envFileNames(".env.absent", dir)).toEqual([]);
      expect(definedNonEmpty({ A: "", B: "value", C: undefined }, ["A", "B", "C", "D"])).toEqual(["B"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("test:e2e:prod (next build && next start) runs under exactly the same pinned env as test:e2e", async () => {
    const dev = await loadPlaywrightConfig(false);
    const prod = await loadPlaywrightConfig(true);
    expect(prod.webServer.command).toMatch(/npm run build && npm run start/);
    expect(dev.webServer.command).not.toMatch(/npm run build/);
    // BETTER_AUTH_SECRET is random per runner process but shared by both evaluations.
    expect(prod.webServer.env).toEqual(dev.webServer.env);
  });
});
