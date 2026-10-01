import { describe, expect, it } from "vitest";
import { definedNonEmpty, EXTERNAL_SERVICE_ENV_NAMES, LOCAL_ENV_FILES, namesInEnvFiles } from "../support/qa-env-names";

// ============================================================================
// QA isolation guard (2026-10-01, pre-deploy), integration project.
//
// The integration suite runs the real server modules (getEnv → getDb, auth,
// Blob wrapper). Those modules read process.env. This file proves, without
// reading or printing any VALUE, that the integration Vitest worker received
// none of the real credentials that `.env.local` / `.env.migrate.local` now
// hold: the only variable injected by configuration is ENABLE_TEST_AUTH
// (vitest.config.mts, DP8). Every database the suite opens is therefore an
// in-memory/temporary PGlite or a pglite-socket on 127.0.0.1, and Blob calls
// are mocked. Failures print variable NAMES only.
// ============================================================================

/** Snapshot taken at module load, before any test can stub anything. */
const WORKER_ENV_AT_LOAD: Readonly<Record<string, string | undefined>> = { ...process.env };

describe("QA isolation guard: integration worker never sees real credentials", () => {
  it("the integration Vitest worker received no credential and no variable defined in a local env file", () => {
    const names = [...EXTERNAL_SERVICE_ENV_NAMES, ...namesInEnvFiles(LOCAL_ENV_FILES)].filter(
      (name) => name !== "ENABLE_TEST_AUTH",
    );
    expect(names.length).toBeGreaterThan(0);
    expect(definedNonEmpty(WORKER_ENV_AT_LOAD, names)).toEqual([]);
  });

  it("ENABLE_TEST_AUTH reaches the worker only through vitest.config.mts, as exactly \"1\"", () => {
    expect(WORKER_ENV_AT_LOAD.ENABLE_TEST_AUTH).toBe("1");
    expect(WORKER_ENV_AT_LOAD.VERCEL_ENV).toBeUndefined();
  });
});
