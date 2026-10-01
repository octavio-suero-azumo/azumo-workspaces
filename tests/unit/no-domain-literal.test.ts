import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// TC-05 (a) / AC-06 / R1.3: the allowed domain comes only from configuration.
// No company domain literal may appear anywhere under src/.
const SRC_DIR = join(__dirname, "..", "..", "src");
// Matches both candidate domains (".co" is a prefix of ".com"), case-insensitive.
const FORBIDDEN = /azumo\.co/i;

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

describe("no hardcoded domain in src/", () => {
  it("finds 0 occurrences of the company domain literals", () => {
    const files = listFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);

    const offenders = files
      .filter((file) => FORBIDDEN.test(readFileSync(file, "latin1")))
      .map((file) => relative(SRC_DIR, file));

    expect(offenders).toEqual([]);
  });
});
