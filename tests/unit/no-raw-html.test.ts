import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// TC-28 (static part) / AC-30 / architecture §9: user content is rendered only
// through React text nodes or the editor's schema. No raw-HTML sink exists
// anywhere under src/.
const SRC_DIR = join(__dirname, "..", "..", "src");

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const RAW_HTML_SINKS = /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write\s*\(/;

describe("no raw-HTML sinks in src/ (AC-30)", () => {
  it("self-test: the pattern catches each sink", () => {
    for (const sample of [
      "<div dangerouslySetInnerHTML={{ __html: x }} />",
      "el.innerHTML = value;",
      "el.outerHTML= value;",
      'el.insertAdjacentHTML("beforeend", value);',
      "document.write(value)",
    ]) {
      expect(RAW_HTML_SINKS.test(sample)).toBe(true);
    }
    expect(RAW_HTML_SINKS.test("const html = editor.getJSON();")).toBe(false);
  });

  it("finds 0 usages under src/", () => {
    const files = listFiles(SRC_DIR).filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .filter((file) => RAW_HTML_SINKS.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_DIR, file));
    expect(offenders).toEqual([]);
  });
});
