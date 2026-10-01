import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Review RV-F-01: the real CLI (`node scripts/migrate.mjs`), as npm runs it.
// - Refusal paths: a child process with no database URL exits 1 and creates
//   nothing locally.
// - Remote path: the `--target=prod` runner applies drizzle/ over the Postgres
//   wire protocol. The "remote" database is a throwaway in-memory PGlite served
//   on 127.0.0.1 by pglite-socket (no real Neon, no credentials), so this proves
//   the runner and the SQL, not Neon itself (RV-F-02 stays open).

const ROOT = join(__dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "migrate.mjs");

interface RunResult {
  code: number | null;
  output: string;
}

function runScript(args: string[], env: Record<string, string>): Promise<RunResult> {
  // Minimal env: nothing inherited that could point at a real database.
  const childEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: childEnv });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

describe("migrate CLI refuses without a database URL", () => {
  let scratch: string;
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "migrate-cli-"));
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it.each([["db:migrate:prod", "--target=prod"], ["db:migrate", "--target=auto"]])(
    "%s exits 1 and never creates a local PGlite database",
    async (_script, flag) => {
      const dataDir = join(scratch, flag.replace(/\W/g, ""));
      const { code, output } = await runScript([flag], { PGLITE_DATA_DIR: dataDir, DATABASE_URL: "", DATABASE_URL_UNPOOLED: "" });
      expect(code).toBe(1);
      expect(output).toMatch(/Refusing to migrate/);
      expect(existsSync(dataDir)).toBe(false);
    },
  );

  it("db:migrate:local exits 1 on Vercel", async () => {
    const dataDir = join(scratch, "vercel");
    const { code } = await runScript(["--target=local"], { VERCEL: "1", PGLITE_DATA_DIR: dataDir });
    expect(code).toBe(1);
    expect(existsSync(dataDir)).toBe(false);
  });
});

describe("migrate CLI applies drizzle/ to a Postgres URL (wire protocol)", () => {
  let db: PGlite;
  let server: PGLiteSocketServer;
  let url: string;

  beforeAll(async () => {
    db = new PGlite();
    const port = await freePort();
    server = new PGLiteSocketServer({ db, host: "127.0.0.1", port, maxConnections: 4 });
    await server.start();
    // Placeholder password: the throwaway server ignores it; it lets the test
    // prove the password never reaches the output.
    url = `postgres://postgres:placeholder-pw-xyz@127.0.0.1:${port}/postgres`;
  });

  afterAll(async () => {
    await server?.stop();
    await db?.close();
  });

  it("applies every migration once, prints only host/db, and is idempotent", async () => {
    const first = await runScript(["--target=prod"], { DATABASE_URL_UNPOOLED: url });
    expect(first.output).toContain("Migration target: Postgres 127.0.0.1");
    expect(first.output).not.toContain("placeholder-pw-xyz");
    expect(first.code, first.output).toBe(0);

    const tables = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(["user", "session", "workspace", "page", "attachment"]),
    );
    const applied = await db.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations");
    const journalCount = (await import("../../scripts/migrate.mjs")).localMigrations(ROOT).length;
    expect(applied.rows[0]?.n).toBe(journalCount);

    const second = await runScript(["--target=prod"], { DATABASE_URL_UNPOOLED: url });
    expect(second.code, second.output).toBe(0);
    const again = await db.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations");
    expect(again.rows[0]?.n).toBe(journalCount);
  });
});
