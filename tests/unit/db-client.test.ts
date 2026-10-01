import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DatabaseConfigError,
  POSTGRES_POOL_DEFAULTS,
  postgresClientOptions,
  selectDatabaseDriver,
} from "@/server/db/client";

// Reviews RV-F-03 (serverless pool options) and RV-F-06 (no PGlite on Vercel,
// PGlite loaded only on demand). Pure logic only: no database is opened here.

const URL_PLAIN = "postgres://db.example.test:5432/app";

describe("selectDatabaseDriver (RV-F-06)", () => {
  it("uses postgres whenever DATABASE_URL is set, on or off Vercel", () => {
    expect(selectDatabaseDriver({ DATABASE_URL: URL_PLAIN })).toBe("postgres");
    expect(selectDatabaseDriver({ DATABASE_URL: URL_PLAIN, VERCEL: "1", VERCEL_ENV: "preview" })).toBe("postgres");
    expect(selectDatabaseDriver({ DATABASE_URL: URL_PLAIN, VERCEL: "1", VERCEL_ENV: "production" })).toBe("postgres");
  });

  it("allows local PGlite only off Vercel and outside production", () => {
    expect(selectDatabaseDriver({})).toBe("pglite");
    expect(selectDatabaseDriver({ VERCEL_ENV: "development" })).toBe("pglite");
  });

  it.each([
    ["production", { VERCEL: "1", VERCEL_ENV: "production" }],
    ["preview", { VERCEL: "1", VERCEL_ENV: "preview" }],
    ["development (vercel dev / build)", { VERCEL: "1", VERCEL_ENV: "development" }],
    ["VERCEL set without VERCEL_ENV", { VERCEL: "1" }],
    ["VERCEL_ENV=production without VERCEL", { VERCEL_ENV: "production" }],
  ])("refuses PGlite on Vercel: %s", (_label, env) => {
    expect(() => selectDatabaseDriver(env)).toThrow(DatabaseConfigError);
    expect(() => selectDatabaseDriver(env)).toThrow(/DATABASE_URL is required/);
  });
});

describe("postgresClientOptions (RV-F-03)", () => {
  it("uses the serverless pool defaults and never prepares statements", () => {
    expect(POSTGRES_POOL_DEFAULTS).toEqual({ max: 3, idle_timeout: 20, connect_timeout: 10 });
    expect(postgresClientOptions(URL_PLAIN)).toEqual({ prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10 });
  });

  it("never sets TLS options: sslmode comes from the URL only", () => {
    const options = postgresClientOptions("postgresql://u:p@ep-x-pooler.example.test/db?sslmode=require");
    expect(options).toEqual({ prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10 });
    expect(Object.keys(options)).not.toContain("ssl");
  });

  it("leaves pool settings that the URL already carries to the URL (explicit options would override it)", () => {
    expect(postgresClientOptions("postgres://postgres@127.0.0.1:55433/postgres?max=1")).toEqual({
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  });

  it("falls back to the defaults when the URL cannot be parsed by WHATWG URL", () => {
    expect(postgresClientOptions("postgres://u@[bad/db")).toEqual({
      prepare: false,
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  });
});

describe("PGlite is loaded only in the PGlite branch (RV-F-06)", () => {
  const source = readFileSync(join(__dirname, "..", "..", "src", "server", "db", "client.ts"), "utf8");

  it("has no value import of PGlite or its drizzle adapter (type-only is fine)", () => {
    const staticImports = [...source.matchAll(/^\s*import\s+(type\s+)?[^;]*?\bfrom\s+["']([^"']+)["']/gm)]
      .filter((m) => !m[1])
      .map((m) => m[2]);
    expect(staticImports.length).toBeGreaterThan(0);
    expect(staticImports.filter((spec) => /^@electric-sql\/pglite|^drizzle-orm\/pglite/.test(spec))).toEqual([]);
  });

  it("loads them with dynamic imports", () => {
    expect(source).toMatch(/import\(\s*["']@electric-sql\/pglite["']\s*\)/);
    expect(source).toMatch(/import\(\s*["']drizzle-orm\/pglite["']\s*\)/);
    expect(source).toMatch(/import\(\s*["']drizzle-orm\/pglite\/migrator["']\s*\)/);
  });
});
