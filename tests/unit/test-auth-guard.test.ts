import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { assertTestAuthEnabled, TestAuthDisabledError } from "../support/test-auth";

// TC-08 / AC-36 / DP8 / RK-6: the test-only auth helper is guarded and is
// never reachable from application code.

describe("test-auth guard (TC-08)", () => {
  it("is disabled when VERCEL_ENV=production, even with ENABLE_TEST_AUTH=1", () => {
    expect(() => assertTestAuthEnabled({ VERCEL_ENV: "production", ENABLE_TEST_AUTH: "1" })).toThrow(
      TestAuthDisabledError,
    );
  });

  it("is disabled when ENABLE_TEST_AUTH is unset", () => {
    expect(() => assertTestAuthEnabled({})).toThrow(TestAuthDisabledError);
  });

  it.each(["", "0", "false", "true", "yes"])('is disabled when ENABLE_TEST_AUTH=%j (only "1" enables)', (value) => {
    expect(() => assertTestAuthEnabled({ ENABLE_TEST_AUTH: value })).toThrow(TestAuthDisabledError);
  });

  it("is enabled only with ENABLE_TEST_AUTH=1 outside production", () => {
    expect(() => assertTestAuthEnabled({ ENABLE_TEST_AUTH: "1" })).not.toThrow();
    expect(() => assertTestAuthEnabled({ ENABLE_TEST_AUTH: "1", VERCEL_ENV: "preview" })).not.toThrow();
  });
});

const ROOT = join(__dirname, "..", "..");
const SRC_DIR = join(ROOT, "src");

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/**
 * Every module specifier a source file references (review RV-C-06):
 * `import … from`, `export … from`, side-effect `import "…"`, dynamic
 * `import("…")` / `import(\`…\`)` and CommonJS `require("…")`.
 */
function moduleSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s*["'`]([^"'`]+)["'`]/g,
    /^\s*import\s*["'`]([^"'`]+)["'`]/gm,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

const TEST_HELPER_SPECIFIER = /(^|\/)(tests\/|support\/)|test-auth|google-oauth-sim/;

function importsTestHelpers(source: string): boolean {
  return moduleSpecifiers(source).some((specifier) => TEST_HELPER_SPECIFIER.test(specifier));
}

describe("test-helper import scanner (self-test on synthetic sources)", () => {
  it.each([
    ['import { createTestAuth } from "../../tests/support/test-auth";'],
    ["import type { TestAuth } from '@/../tests/support/test-auth';"],
    ['export { createTestAuth } from "../tests/support/test-auth";'],
    ['import "../../tests/support/google-oauth-sim";'],
    ['const m = await import("../../tests/support/test-auth");'],
    ["const m = await import( '../support/test-auth' );"],
    ["const m = await import(`../../tests/support/test-auth`);"],
    ['const m = require("../../tests/support/test-auth");'],
    ["const { simulateGoogleSignIn } = require('google-oauth-sim');"],
  ])("flags %s", (source) => {
    expect(importsTestHelpers(source)).toBe(true);
  });

  it.each([
    ['import { getAuth } from "@/server/auth";'],
    ['const m = await import("@/server/data/pages");'],
    ['const x = require("node:path");'],
    ['// mentions tests/ only in a comment without importing'],
  ])("does not flag %s", (source) => {
    expect(importsTestHelpers(source)).toBe(false);
  });
});

describe("test-auth isolation (AC-36)", () => {
  const sources = listFiles(SRC_DIR)
    .filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file))
    .map((file) => ({ file: relative(ROOT, file), text: readFileSync(file, "utf8") }));

  it("scans a non-empty src/", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("no file under src/ imports the test helpers or the tests/ tree (static, dynamic or require)", () => {
    const offenders = sources.filter(({ text }) => importsTestHelpers(text)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("no file under src/ uses Better Auth's testUtils plugin", () => {
    const offenders = sources.filter(({ text }) => /\btestUtils\b/.test(text)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("no HTTP route under src/app exposes test auth", () => {
    const routes = sources.filter(({ file }) => /src\/app\/.*route\.(ts|js)$/.test(file));
    const offenders = routes.filter(({ text }) => /ENABLE_TEST_AUTH|test-auth|testUtils/.test(text));
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });
});
