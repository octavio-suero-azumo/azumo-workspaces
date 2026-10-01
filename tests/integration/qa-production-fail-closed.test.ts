import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// ============================================================================
// QA independent verification — essential check 9 (deploy readiness).
//
// Gap closed: the production rules are unit-tested at `parseEnv()` level only
// (tests/unit/env.test.ts) and the auth route is tested for an invalid domain
// (auth-route-fail-closed.test.ts). Nothing exercised the RUNTIME composition
// (`getEnv()` → `getDb()` / `getAuth()` → `requireSession()` → action /
// route / page guard) with production settings. This file does, with the real
// modules (only `next/headers`, `next/cache` and `getDataContext` replaced;
// `getDataContext` throws so that a handler that wrongly runs is detected).
//
// No database is ever opened: PGLITE_DATA_DIR points at an empty temp dir and
// the test asserts it stays empty. Placeholder values only; no real secrets.
// ============================================================================

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/data/context", () => ({
  getDataContext: vi.fn(async () => {
    throw new Error("QA: a handler ran although the configuration is invalid");
  }),
}));

const scratch = mkdtempSync(join(tmpdir(), "qa-fail-closed-"));

const PRODUCTION_BASE: Record<string, string> = {
  VERCEL_ENV: "production",
  BETTER_AUTH_URL: "https://app.example.test",
  BETTER_AUTH_SECRET: "qa-placeholder-secret-not-real-0123456789abcdef",
  GOOGLE_CLIENT_ID: "test-placeholder-client-id",
  GOOGLE_CLIENT_SECRET: "test-placeholder-client-secret",
  ALLOWED_GOOGLE_HD: "allowed.test",
  ENABLE_TEST_AUTH: "",
  DATABASE_URL: "",
  PGLITE_DATA_DIR: scratch,
  BLOB_READ_WRITE_TOKEN: "",
  UPLOAD_MAX_BYTES: "",
  UPLOAD_ALLOWED_TYPES: "",
};

const appGlobals = globalThis as typeof globalThis & { __azumoDb?: unknown; __azumoAuth?: unknown };

function stubAll(values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

/** Fresh module graph (fresh env cache) with `cookie` as the request's cookie. */
async function freshApp(cookie = "better-auth.session_token=any-token.any-signature") {
  vi.resetModules();
  delete appGlobals.__azumoDb;
  delete appGlobals.__azumoAuth;
  const { headers } = await import("next/headers");
  vi.mocked(headers).mockResolvedValue(new Headers({ cookie }) as never);
  const { getDataContext } = await import("@/server/data/context");
  return { getDataContext: vi.mocked(getDataContext) };
}

describe("QA: production configuration fails closed at runtime (essential check 9)", () => {
  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.unstubAllEnvs();
    delete appGlobals.__azumoDb;
    delete appGlobals.__azumoAuth;
    // Nothing may ever be written to the local PGlite directory.
    expect(readdirSync(scratch)).toEqual([]);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("control: the production base configuration itself is valid", async () => {
    stubAll(PRODUCTION_BASE);
    await freshApp();
    const { getEnv } = await import("@/server/env");
    expect(getEnv()).toMatchObject({ VERCEL_ENV: "production", ENABLE_TEST_AUTH: false });
  });

  it("VERCEL_ENV=production without DATABASE_URL: the DB, auth, session check and sign-in endpoint all refuse (no local PGlite)", async () => {
    stubAll(PRODUCTION_BASE);
    await freshApp();
    const { getDb } = await import("@/server/db/client");
    const { getAuth } = await import("@/server/auth");
    const { requireSession } = await import("@/server/authz/session");
    const { requirePageContext } = await import("@/server/render-guards");

    await expect(getDb()).rejects.toMatchObject({ name: "DatabaseConfigError" });
    await expect(getAuth()).rejects.toMatchObject({ name: "DatabaseConfigError" });
    await expect(requireSession()).rejects.toMatchObject({ name: "DatabaseConfigError" });
    // Pages: not a redirect and not a render; the error propagates (Next → 500).
    await expect(requirePageContext()).rejects.toMatchObject({ name: "DatabaseConfigError" });

    const { POST: authRoute } = await import("@/app/api/auth/[...all]/route");
    await expect(
      authRoute(
        new Request("https://app.example.test/api/auth/sign-in/social", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://app.example.test" },
          body: JSON.stringify({ provider: "google", callbackURL: "/" }),
        }),
      ),
    ).rejects.toMatchObject({ name: "DatabaseConfigError" });
  });

  it("VERCEL_ENV=production with ENABLE_TEST_AUTH=1: env refuses to load, auth never starts, the test-auth helper refuses", async () => {
    stubAll({ ...PRODUCTION_BASE, ENABLE_TEST_AUTH: "1", DATABASE_URL: "postgres://qa-placeholder.invalid:5432/none" });
    await freshApp();
    const { getEnv, EnvValidationError } = await import("@/server/env");
    const { getAuth } = await import("@/server/auth");

    let caught: unknown;
    try {
      getEnv();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    expect((caught as InstanceType<typeof EnvValidationError>).issues.some((i) => i.startsWith("ENABLE_TEST_AUTH:"))).toBe(true);
    await expect(getAuth()).rejects.toMatchObject({ name: "EnvValidationError" });

    const { assertTestAuthEnabled, TestAuthDisabledError } = await import("../support/test-auth");
    expect(() => assertTestAuthEnabled(process.env)).toThrow(TestAuthDisabledError);
  });

  it("VERCEL_ENV=production with BETTER_AUTH_URL unset: auth never starts (RV-C-07)", async () => {
    stubAll({ ...PRODUCTION_BASE, BETTER_AUTH_URL: "", DATABASE_URL: "postgres://qa-placeholder.invalid:5432/none" });
    await freshApp();
    const { getAuth } = await import("@/server/auth");
    await expect(getAuth()).rejects.toMatchObject({ name: "EnvValidationError" });
  });

  it.each([
    ["wildcard", "*"],
    ["empty", ""],
    ["a comma list", "allowed.test,other.test"],
  ])(
    "ALLOWED_GOOGLE_HD %s at runtime: server action, both route handlers and the page guard fail closed; no handler runs",
    async (_label, value) => {
      stubAll({ ...PRODUCTION_BASE, VERCEL_ENV: "", ALLOWED_GOOGLE_HD: value });
      const { getDataContext } = await freshApp();

      // Server action (the real export, bound to the real requireSession).
      const { savePageAction } = await import("@/app/(app)/w/[workspaceId]/p/actions");
      const result = await savePageAction({
        pageId: "3f2b7c1e-9a4d-4e2f-8b6a-1c2d3e4f5a6b",
        workspaceId: "3f2b7c1e-9a4d-4e2f-8b6a-1c2d3e4f5a6c",
        title: "QA",
      });
      expect(result).toEqual({ ok: false, error: { code: "INTERNAL", message: "Something went wrong." } });

      // Route handlers: 500 with a generic body (never 2xx, never details).
      const { GET: downloadRoute } = await import("@/app/api/files/[attachmentId]/route");
      const download = await downloadRoute(new Request("http://localhost:3000/api/files/x"), {
        params: Promise.resolve({ attachmentId: "3f2b7c1e-9a4d-4e2f-8b6a-1c2d3e4f5a6b" }),
      } as never);
      expect(download.status).toBe(500);
      expect(await download.json()).toEqual({ error: { code: "INTERNAL", message: "Something went wrong." } });

      const { POST: uploadRoute } = await import("@/app/api/uploads/route");
      const token = await uploadRoute(
        new Request("http://localhost:3000/api/uploads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "blob.generate-client-token",
            payload: { pathname: "x.pdf", clientPayload: "{}", multipart: false },
          }),
        }),
      );
      expect(token.status).toBe(500);
      const tokenBody = await token.text();
      expect(tokenBody).not.toContain("clientToken");

      // Pages: the guard throws (Next renders an error), it never yields a context.
      const { requirePageContext } = await import("@/server/render-guards");
      await expect(requirePageContext()).rejects.toMatchObject({ name: "EnvValidationError" });

      expect(getDataContext).not.toHaveBeenCalled();
    },
  );
});
