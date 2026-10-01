import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Review RV-F-06, runtime composition: `getEnv()` → `getDb()` with the real
// modules. On any Vercel environment (`VERCEL` set) without DATABASE_URL the
// app must refuse, write nothing locally and never even LOAD PGlite.
// Placeholder values only; no real secrets and no remote database.

const loads = vi.hoisted(() => ({ pglite: 0 }));
vi.mock("@electric-sql/pglite", async (importOriginal) => {
  loads.pglite += 1;
  return await importOriginal();
});

const scratch = mkdtempSync(join(tmpdir(), "db-client-vercel-"));
const appGlobals = globalThis as typeof globalThis & { __azumoDb?: unknown };

const BASE: Record<string, string> = {
  ALLOWED_GOOGLE_HD: "allowed.test",
  ENABLE_TEST_AUTH: "",
  DATABASE_URL: "",
  VERCEL: "",
  VERCEL_ENV: "",
  BETTER_AUTH_URL: "",
  BLOB_READ_WRITE_TOKEN: "",
  UPLOAD_MAX_BYTES: "",
  UPLOAD_ALLOWED_TYPES: "",
};

async function freshClient(env: Record<string, string>) {
  for (const [name, value] of Object.entries({ ...BASE, ...env })) vi.stubEnv(name, value);
  vi.resetModules();
  delete appGlobals.__azumoDb;
  loads.pglite = 0;
  return import("@/server/db/client");
}

describe("getDb() on Vercel without DATABASE_URL (RV-F-06)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(scratch, "pglite-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete appGlobals.__azumoDb;
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it.each([
    ["preview", { VERCEL: "1", VERCEL_ENV: "preview" }],
    ["development", { VERCEL: "1", VERCEL_ENV: "development" }],
    ["VERCEL only", { VERCEL: "1" }],
    ["production", { VERCEL: "1", VERCEL_ENV: "production", BETTER_AUTH_URL: "https://app.example.test" }],
  ])("%s: refuses, writes nothing and never loads PGlite", async (_label, env) => {
    const { getDb } = await freshClient({ ...env, PGLITE_DATA_DIR: dataDir });
    await expect(getDb()).rejects.toMatchObject({ name: "DatabaseConfigError" });
    expect(loads.pglite).toBe(0);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("control: off Vercel, the local PGlite branch loads PGlite on demand", async () => {
    const { getDb } = await freshClient({ PGLITE_DATA_DIR: dataDir });
    expect(loads.pglite).toBe(0); // importing the client alone does not load PGlite
    const db = await getDb();
    try {
      expect(loads.pglite).toBe(1);
      expect(readdirSync(dataDir).length).toBeGreaterThan(0);
    } finally {
      await (db as unknown as { $client: { close: () => Promise<void> } }).$client.close();
    }
  });
});
