import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MigrationConfigError,
  describeTarget,
  localMigrations,
  main,
  parseArgs,
  redactUrl,
  resolveMigrationTarget,
} from "../../scripts/migrate.mjs";

// Review RV-F-01: the production migration path is guarded. Pure logic and
// `main()` in dry-run / refusal paths only: nothing connects to a database.
// Placeholder hosts and credentials only.

const ROOT = join(__dirname, "..", "..");
const PASSWORD = "PlaceholderPw-not-real-123";
const UNPOOLED = `postgresql://app_owner:${PASSWORD}@ep-direct-1.example.test/appdb?sslmode=require`;
const POOLED = `postgresql://app_owner:${PASSWORD}@ep-direct-1-pooler.example.test/appdb?sslmode=require`;

function refusal(fn: () => unknown): MigrationConfigError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MigrationConfigError);
  return caught as MigrationConfigError;
}

describe("resolveMigrationTarget: prod", () => {
  it.each([
    ["nothing set", {}],
    ["both empty", { DATABASE_URL_UNPOOLED: "", DATABASE_URL: "" }],
    ["whitespace only", { DATABASE_URL_UNPOOLED: "  ", DATABASE_URL: "\t" }],
    ["only PGlite settings", { PGLITE_DATA_DIR: ".pglite" }],
  ])("refuses when no URL is set (%s) and never falls back to PGlite", (_label, env) => {
    const error = refusal(() => resolveMigrationTarget("prod", env, ROOT));
    expect(error.message).toMatch(/Refusing to migrate/);
    expect(error.message).toMatch(/never uses local PGlite/);
  });

  it("prefers DATABASE_URL_UNPOOLED over DATABASE_URL", () => {
    const target = resolveMigrationTarget("prod", { DATABASE_URL_UNPOOLED: UNPOOLED, DATABASE_URL: POOLED }, ROOT);
    expect(target).toMatchObject({
      kind: "postgres",
      source: "DATABASE_URL_UNPOOLED",
      host: "ep-direct-1.example.test",
      database: "appdb",
      pooled: false,
    });
  });

  it("falls back to DATABASE_URL (flagged as possibly pooled)", () => {
    const target = resolveMigrationTarget("prod", { DATABASE_URL: POOLED }, ROOT);
    expect(target).toMatchObject({ kind: "postgres", source: "DATABASE_URL", pooled: true });
  });

  it.each(["mysql://h/db", "https://h/db", "not a url", "postgres://"])("refuses a non-Postgres URL %j without echoing it", (value) => {
    const error = refusal(() => resolveMigrationTarget("prod", { DATABASE_URL_UNPOOLED: value }, ROOT));
    expect(error.message).toMatch(/DATABASE_URL_UNPOOLED/);
    if (value.length > 12) expect(error.message).not.toContain(value);
  });
});

describe("resolveMigrationTarget: auto (npm run db:migrate)", () => {
  it("refuses without a URL and points to the explicit local command", () => {
    const error = refusal(() => resolveMigrationTarget("auto", {}, ROOT));
    expect(error.message).toMatch(/db:migrate:local/);
  });

  it("targets the URL when one is set", () => {
    expect(resolveMigrationTarget("auto", { DATABASE_URL: POOLED }, ROOT)).toMatchObject({ kind: "postgres" });
  });
});

describe("resolveMigrationTarget: local", () => {
  it("targets PGlite only when asked explicitly", () => {
    expect(resolveMigrationTarget("local", {}, ROOT)).toEqual({ kind: "pglite", dataDir: join(ROOT, ".pglite") });
    expect(resolveMigrationTarget("local", { PGLITE_DATA_DIR: "tmp/db" }, ROOT)).toEqual({
      kind: "pglite",
      dataDir: join(ROOT, "tmp/db"),
    });
  });

  it("is refused on Vercel", () => {
    refusal(() => resolveMigrationTarget("local", { VERCEL: "1" }, ROOT));
  });

  it("unknown modes are refused", () => {
    refusal(() => resolveMigrationTarget("pglite", {}, ROOT));
  });
});

describe("output never contains credentials", () => {
  it("describeTarget names host and database only", () => {
    const text = describeTarget(resolveMigrationTarget("prod", { DATABASE_URL_UNPOOLED: UNPOOLED }, ROOT));
    expect(text).toBe("Postgres ep-direct-1.example.test/appdb (from DATABASE_URL_UNPOOLED)");
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("app_owner");
    expect(text).not.toContain("sslmode");
  });

  it("redactUrl removes the URL and the password from error messages", () => {
    const message = `connect failed for ${UNPOOLED}; password ${PASSWORD} rejected`;
    const out = redactUrl(message, UNPOOLED);
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain(UNPOOLED);
  });

  it("main() dry run prints the target and migrations, applies nothing, and never prints credentials", async () => {
    const lines: string[] = [];
    const code = await main(["--target=prod", "--dry-run"], { DATABASE_URL_UNPOOLED: UNPOOLED }, {
      log: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
      root: ROOT,
    });
    expect(code).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("ep-direct-1.example.test/appdb");
    expect(output).toContain("Dry run: nothing was applied.");
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain("app_owner");
  });

  it("main() refuses (exit 1) without a URL, before touching anything", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "migrate-refusal-"));
    try {
      const lines: string[] = [];
      const code = await main(["--target=prod"], { PGLITE_DATA_DIR: scratch }, {
        log: (line: string) => lines.push(line),
        error: (line: string) => lines.push(line),
        root: ROOT,
      });
      expect(code).toBe(1);
      expect(lines.join("\n")).toMatch(/Refusing to migrate/);
      expect(lines.join("\n")).not.toMatch(/Migration target/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("arguments and migration list", () => {
  it("parses the supported flags and refuses anything else", () => {
    expect(parseArgs([])).toEqual({ mode: "auto", dryRun: false });
    expect(parseArgs(["--target=prod", "--dry-run"])).toEqual({ mode: "prod", dryRun: true });
    expect(parseArgs(["--target=local"])).toEqual({ mode: "local", dryRun: false });
    refusal(() => parseArgs(["--target=pglite"]));
    refusal(() => parseArgs(["--url=postgres://x/y"]));
  });

  it("lists the versioned migrations in drizzle/", () => {
    const tags = localMigrations(ROOT);
    expect(tags.length).toBeGreaterThan(0);
    expect(tags[0]).toBe("0000_auth_tables");
  });
});
