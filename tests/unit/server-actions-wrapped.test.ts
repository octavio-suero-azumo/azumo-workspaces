import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// AC-01 / R1.4 / architecture §4.8: every server action goes through action().
//
// Rules for files under src/:
// - A file-level "use server" directive may only export
//   `export const <name> = action(...)`. Any other export is a violation.
// - Inline (function-level) "use server" is forbidden: actions must live in
//   "use server" modules so this check can see them.

const SRC_DIR = join(__dirname, "..", "..", "src");

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const DIRECTIVE = /^\s*["']use server["'];?\s*$/m;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function hasFileLevelDirective(source: string): boolean {
  const body = stripComments(source).trimStart();
  return /^["']use server["']/.test(body);
}

/** Returns human-readable violations for one source file. */
function findServerActionViolations(source: string): string[] {
  const code = stripComments(source);
  if (!DIRECTIVE.test(code)) return [];

  if (!hasFileLevelDirective(source)) {
    return ['inline "use server" is not allowed; move the action to a "use server" module and wrap it with action()'];
  }

  const violations: string[] = [];
  const exportRe = /^\s*export\s+(.+)$/gm;
  for (const match of code.matchAll(exportRe)) {
    const statement = match[1].trim();
    if (/^type\s|^interface\s/.test(statement)) continue; // types are erased
    if (/^const\s+[A-Za-z_$][\w$]*\s*=\s*action\s*\(/.test(statement)) continue;
    violations.push(`export not wrapped with action(): "export ${statement.slice(0, 60)}"`);
  }
  return violations;
}

describe("server action wrapper check (self-test on synthetic sources)", () => {
  it("accepts wrapped actions", () => {
    const ok = `"use server";\nimport { action } from "@/server/action";\nexport const create = action(async (ctx, name: string) => name);\nexport type X = string;`;
    expect(findServerActionViolations(ok)).toEqual([]);
  });

  it("flags an unwrapped exported async function", () => {
    const bad = `"use server";\nexport async function create(name: string) { return name; }`;
    expect(findServerActionViolations(bad)).toHaveLength(1);
  });

  it("flags an unwrapped exported const", () => {
    const bad = `'use server'\nexport const create = async (name: string) => name;`;
    expect(findServerActionViolations(bad)).toHaveLength(1);
  });

  it("flags default and re-exports", () => {
    expect(findServerActionViolations(`"use server";\nexport default async function x() {}`)).toHaveLength(1);
    expect(findServerActionViolations(`"use server";\nexport { x } from "./x";`)).toHaveLength(1);
  });

  it("flags inline use server", () => {
    const bad = `export default function Page() {\n  async function go() {\n    "use server";\n  }\n}`;
    expect(findServerActionViolations(bad)).toHaveLength(1);
  });

  it("ignores files without the directive", () => {
    expect(findServerActionViolations(`export async function helper() {}`)).toEqual([]);
  });
});

describe("server actions in src/ (AC-01)", () => {
  it("every server action export under src/ is wrapped with action()", () => {
    const files = listFiles(SRC_DIR).filter((file) => /\.(ts|tsx|js|jsx)$/.test(file));
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap((file) =>
      findServerActionViolations(readFileSync(file, "utf8")).map((v) => `${relative(SRC_DIR, file)}: ${v}`),
    );
    expect(violations).toEqual([]);
  });
});
