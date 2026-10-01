import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// TC-37 (partial) / AC-34 / R6.2: env files are gitignored except the
// names-only template, and the template carries no values.
const ROOT = join(__dirname, "..", "..");

describe("secrets hygiene", () => {
  it(".gitignore ignores .env* but keeps .env.example", () => {
    const lines = readFileSync(join(ROOT, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim());
    expect(lines).toContain(".env*");
    expect(lines).toContain("!.env.example");
    expect(lines.indexOf("!.env.example")).toBeGreaterThan(lines.indexOf(".env*"));
  });

  it(".env.example lists names only (every assignment is empty)", () => {
    const assignments = readFileSync(join(ROOT, ".env.example"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(assignments.length).toBeGreaterThan(0);
    for (const line of assignments) {
      expect(line).toMatch(/^[A-Z][A-Z0-9_]*=$/);
    }

    const names = assignments.map((line) => line.slice(0, -1));
    expect(names).toEqual(
      expect.arrayContaining([
        "DATABASE_URL",
        "BETTER_AUTH_SECRET",
        "BETTER_AUTH_URL",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "ALLOWED_GOOGLE_HD",
        "ENABLE_TEST_AUTH",
        "BLOB_READ_WRITE_TOKEN",
        "UPLOAD_MAX_BYTES",
        "UPLOAD_ALLOWED_TYPES",
      ]),
    );
  });
});
