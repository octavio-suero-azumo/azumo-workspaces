import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// TC-22 (a) / AC-12 / architecture §2 and §4.4.
//
// (a) AC-12: the DB client (and any DB driver/ORM/schema) is imported only
//     under src/server/.
// (b) Layering inside src/server: only the data layer (src/server/data), the
//     auth module (src/server/auth) and the DB module itself (src/server/db)
//     import DB code at runtime. authz/, action.ts, pages and components go
//     through src/server/data.
// (c) Client components ("use client") never import server-only modules.

const ROOT = join(__dirname, "..", "..");
const SRC_DIR = join(ROOT, "src");

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

interface ImportRef {
  specifier: string;
  typeOnly: boolean;
}

/** Static and dynamic import/require specifiers in a source file. */
function importsOf(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const staticRe = /^\s*(import|export)\s+(type\s+)?[^;]*?\bfrom\s+["']([^"']+)["']/gm;
  for (const m of source.matchAll(staticRe)) refs.push({ specifier: m[3], typeOnly: Boolean(m[2]) });
  const sideEffectRe = /^\s*import\s+["']([^"']+)["']/gm;
  for (const m of source.matchAll(sideEffectRe)) refs.push({ specifier: m[1], typeOnly: false });
  const dynamicRe = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(dynamicRe)) refs.push({ specifier: m[1], typeOnly: false });
  return refs;
}

/**
 * DB modules: our client/schema (relative specifiers are normalised to
 * `src/server/db/...` first), the ORM and every Postgres driver.
 */
function isDbSpecifier(specifier: string): boolean {
  return (
    /(^|\/)server\/db(\/|$)/.test(specifier) ||
    /^drizzle-orm(\/|$)/.test(specifier) ||
    /^postgres$/.test(specifier) ||
    /^pg$/.test(specifier) ||
    /^@neondatabase\//.test(specifier) ||
    /^@electric-sql\/pglite/.test(specifier)
  );
}

const sources = listFiles(SRC_DIR)
  .filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file))
  .map((file) => ({ rel: relative(ROOT, file).split(sep).join("/"), text: readFileSync(file, "utf8") }));

/** Resolve relative specifiers inside src/server/db to "server/db" so they are caught too. */
function normalise(rel: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const baseDir = rel.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") baseDir.pop();
    else if (part !== ".") baseDir.push(part);
  }
  return baseDir.join("/");
}

function dbImports(rel: string, text: string, { includeTypeOnly }: { includeTypeOnly: boolean }) {
  return importsOf(text)
    .filter((ref) => includeTypeOnly || !ref.typeOnly)
    .map((ref) => normalise(rel, ref.specifier))
    .filter(isDbSpecifier);
}

describe("import scanner self-test", () => {
  it("finds static, type-only, side-effect and dynamic imports", () => {
    const src = [
      'import { a } from "@/server/db/client";',
      'import type { B } from "drizzle-orm";',
      'import "postgres";',
      'const x = await import("@electric-sql/pglite");',
    ].join("\n");
    expect(importsOf(src)).toEqual([
      { specifier: "@/server/db/client", typeOnly: false },
      { specifier: "drizzle-orm", typeOnly: true },
      { specifier: "postgres", typeOnly: false },
      { specifier: "@electric-sql/pglite", typeOnly: false },
    ]);
    expect(dbImports("src/app/x.tsx", src, { includeTypeOnly: true })).toHaveLength(4);
    expect(dbImports("src/server/data/x.ts", 'import { y } from "../db/client";', { includeTypeOnly: false })).toEqual([
      "src/server/db/client",
    ]);
  });
});

describe("DB import boundary (AC-12)", () => {
  it("scans a non-empty src/", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("(a) no file outside src/server/ imports the DB client, schema, ORM or a driver (not even types)", () => {
    const offenders = sources
      .filter(({ rel }) => !rel.startsWith("src/server/"))
      .flatMap(({ rel, text }) => dbImports(rel, text, { includeTypeOnly: true }).map((spec) => `${rel} → ${spec}`));
    expect(offenders).toEqual([]);
  });

  it("(b) inside src/server/, only data/, auth/ and db/ import DB code at runtime", () => {
    const allowed = ["src/server/data/", "src/server/auth/", "src/server/db/"];
    const offenders = sources
      .filter(({ rel }) => rel.startsWith("src/server/") && !allowed.some((prefix) => rel.startsWith(prefix)))
      .flatMap(({ rel, text }) => dbImports(rel, text, { includeTypeOnly: false }).map((spec) => `${rel} → ${spec}`));
    expect(offenders).toEqual([]);
  });

  it("(c) client components never import server data, DB, auth or session modules", () => {
    const serverOnly = /(^|\/)server\/(data|db|auth|authz\/session|authz\/authorize|action)(\/|$)/;
    const offenders = sources
      .filter(({ text }) => /^\s*["']use client["']/m.test(text))
      .flatMap(({ rel, text }) =>
        importsOf(text)
          .map((ref) => normalise(rel, ref.specifier))
          .filter((spec) => serverOnly.test(spec) || isDbSpecifier(spec))
          .map((spec) => `${rel} → ${spec}`),
      );
    expect(offenders).toEqual([]);
  });
});
