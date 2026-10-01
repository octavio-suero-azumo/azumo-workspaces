// Unit tests for the bench MCP core (node:test, no extra dependencies).
// Checks use fake definitions that run `node -e` in a temporary workspace,
// so no real project check is executed here.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  CHECKS,
  CHECK_NAMES,
  RUNS_DIR,
  classify,
  getRunReport,
  loadTasks,
  matchesIdPrefix,
  parseRequirements,
  redact,
  resolveInside,
  runCheck,
  runChecks,
  upsertTask,
  validateTaskId,
} from "../lib.mjs";

const NODE = process.execPath;

/** A fake test check whose child writes a vitest-shaped JSON report. */
function fakeVitest(json, exitCode = 0) {
  return {
    kind: "test",
    format: "vitest",
    timeoutMs: 10_000,
    command: (reportFile) => ({
      file: NODE,
      args: [
        "-e",
        `const j=process.argv[1]; if (j) require('fs').writeFileSync(process.argv[2], j); process.exit(${exitCode})`,
        json === null ? "" : JSON.stringify(json),
        reportFile,
      ],
    }),
  };
}

const vitestJson = (total, passed, failed, pending = 0) => ({
  numTotalTests: total,
  numPassedTests: passed,
  numFailedTests: failed,
  numPendingTests: pending,
  numTodoTests: 0,
});

const DEFS = {
  staticOk: { kind: "static", timeoutMs: 10_000, command: () => ({ file: NODE, args: ["-e", "console.log('ok')"] }) },
  staticFail: { kind: "static", timeoutMs: 10_000, command: () => ({ file: NODE, args: ["-e", "process.exit(2)"] }) },
  hang: {
    kind: "static",
    timeoutMs: 300,
    command: () => ({ file: NODE, args: ["-e", "setInterval(() => {}, 1000)"] }),
  },
  missingBinary: {
    kind: "static",
    timeoutMs: 10_000,
    command: () => ({ file: path.join(tmpdir(), "definitely-not-a-binary-bench-mcp"), args: [] }),
  },
  unitPass: fakeVitest(vitestJson(3, 3, 0)),
  unitFail: fakeVitest(vitestJson(3, 2, 1), 1),
  unitEmpty: fakeVitest(vitestJson(0, 0, 0), 1),
  // RV-F-10: every discovered test skipped, runner exits 0.
  unitAllSkipped: fakeVitest(vitestJson(3, 0, 0, 3)),
  unitCrash: fakeVitest(null, 1),
  leaky: {
    kind: "static",
    timeoutMs: 10_000,
    command: () => ({ file: NODE, args: ["-e", "console.log('API_TOKEN=abc123supersecret done')"] }),
  },
};

let root;
before(() => {
  root = mkdtempSync(path.join(tmpdir(), "bench-mcp-test-"));
  mkdirSync(path.join(root, RUNS_DIR), { recursive: true });
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("classification (pure)", () => {
  const counts = (discovered, failed = 0) => ({ discovered, passed: discovered - failed, failed, skipped: 0 });
  it("passed / failed / no_tests / timeout / error", () => {
    assert.equal(classify({ kind: "static", timedOut: false, spawnError: null, exitCode: 0, counts: null }), "passed");
    assert.equal(classify({ kind: "static", timedOut: false, spawnError: null, exitCode: 1, counts: null }), "failed");
    assert.equal(classify({ kind: "test", timedOut: false, spawnError: null, exitCode: 0, counts: counts(4) }), "passed");
    assert.equal(classify({ kind: "test", timedOut: false, spawnError: null, exitCode: 1, counts: counts(4, 1) }), "failed");
    assert.equal(classify({ kind: "test", timedOut: false, spawnError: null, exitCode: 0, counts: counts(4, 1) }), "failed");
    assert.equal(classify({ kind: "test", timedOut: false, spawnError: null, exitCode: 0, counts: counts(0) }), "no_tests");
    assert.equal(classify({ kind: "test", timedOut: false, spawnError: null, exitCode: 1, counts: counts(0) }), "no_tests");
    assert.equal(classify({ kind: "test", timedOut: false, spawnError: null, exitCode: 1, counts: null }), "error");
    assert.equal(classify({ kind: "static", timedOut: false, spawnError: new Error("x"), exitCode: null, counts: null }), "error");
    assert.equal(classify({ kind: "test", timedOut: true, spawnError: null, exitCode: null, counts: counts(3) }), "timeout");
  });

  it("a test run passes only if testsPassed > 0 (RV-F-10)", () => {
    const allSkipped = { discovered: 3, passed: 0, failed: 0, skipped: 3 };
    assert.equal(classify({ kind: "test", timedOut: false, spawnError: null, exitCode: 0, counts: allSkipped }), "no_tests");
    const oneRan = { discovered: 3, passed: 1, failed: 0, skipped: 2 };
    assert.equal(classify({ kind: "test", timedOut: false, spawnError: null, exitCode: 0, counts: oneRan }), "passed");
    // A failure still wins over "nothing passed".
    const failedRest = { discovered: 3, passed: 0, failed: 1, skipped: 2 };
    assert.equal(classify({ kind: "test", timedOut: false, spawnError: null, exitCode: 1, counts: failedRest }), "failed");
  });
});

describe("runCheck with real child processes", () => {
  it("static pass and fail", async () => {
    assert.equal((await runCheck(root, "staticOk", { defs: DEFS })).status, "passed");
    const failed = await runCheck(root, "staticFail", { defs: DEFS });
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, 2);
  });

  it("test pass with counts", async () => {
    const r = await runCheck(root, "unitPass", { defs: DEFS });
    assert.equal(r.status, "passed");
    assert.equal(r.testsDiscovered, 3);
    assert.equal(r.testsPassed, 3);
    assert.equal(r.kind, "test");
  });

  it("test failure", async () => {
    const r = await runCheck(root, "unitFail", { defs: DEFS });
    assert.equal(r.status, "failed");
    assert.equal(r.testsFailed, 1);
  });

  it("0 discovered tests is no_tests, never passed", async () => {
    const r = await runCheck(root, "unitEmpty", { defs: DEFS });
    assert.equal(r.status, "no_tests");
    assert.equal(r.testsDiscovered, 0);
  });

  it("all tests skipped is no_tests, never passed (RV-F-10)", async () => {
    const r = await runCheck(root, "unitAllSkipped", { defs: DEFS });
    assert.equal(r.status, "no_tests");
    assert.equal(r.testsDiscovered, 3);
    assert.equal(r.testsPassed, 0);
    assert.equal(r.testsSkipped, 3);
  });

  it("non-zero exit without a JSON report is error", async () => {
    assert.equal((await runCheck(root, "unitCrash", { defs: DEFS })).status, "error");
  });

  it("spawn failure is error", async () => {
    assert.equal((await runCheck(root, "missingBinary", { defs: DEFS })).status, "error");
  });

  it("timeout kills the process and reports timeout", async () => {
    const r = await runCheck(root, "hang", { defs: DEFS });
    assert.equal(r.status, "timeout");
    assert.ok(r.durationMs < 8_000, `took ${r.durationMs}ms`);
  });

  it("stores the report and cleans the temporary runner file", async () => {
    const r = await runCheck(root, "unitPass", { defs: DEFS });
    const stored = JSON.parse(readFileSync(path.join(root, RUNS_DIR, `${r.runId}.json`), "utf8"));
    assert.equal(stored.status, "passed");
    assert.ok(!existsSync(path.join(root, RUNS_DIR, `.tmp-${r.runId}.json`)));
    assert.equal(getRunReport(root, r.runId).runId, r.runId);
  });

  it("redacts secrets in the output excerpt", async () => {
    const r = await runCheck(root, "leaky", { defs: DEFS });
    assert.ok(!r.outputExcerpt.includes("abc123supersecret"), r.outputExcerpt);
    assert.match(r.outputExcerpt, /\[REDACTED\]/);
  });
});

describe("unknown checks are rejected", () => {
  it("rejects a check name outside the predefined set", async () => {
    await assert.rejects(() => runChecks(root, ["rm -rf /"]), /Unknown check/);
    await assert.rejects(() => runChecks(root, ["__proto__"]), /Unknown check/);
    await assert.rejects(() => runChecks(root, ["toString"]), /Unknown check/);
  });

  it("the predefined set is exactly the seven named checks", () => {
    assert.deepEqual(Object.keys(CHECKS).sort(), ["build", "e2e", "e2e-prod", "integration", "lint", "typecheck", "unit"]);
    assert.deepEqual([...CHECK_NAMES].sort(), Object.keys(CHECKS).sort());
  });

  it("only unit, integration, e2e and e2e-prod are test suites (the done guard relies on this)", () => {
    const testChecks = Object.entries(CHECKS).filter(([, d]) => d.kind === "test").map(([n]) => n).sort();
    assert.deepEqual(testChecks, ["e2e", "e2e-prod", "integration", "unit"]);
  });

  it("e2e-prod is a fixed command: npm run test:e2e:prod with the JSON reporter, parsed like e2e", () => {
    const def = CHECKS["e2e-prod"];
    const reportFile = path.join(root, RUNS_DIR, ".tmp-x.json");
    const cmd = def.command(reportFile);
    assert.equal(path.basename(cmd.file), "npm");
    assert.deepEqual(cmd.args, ["run", "test:e2e:prod", "--", "--reporter=list,json"]);
    assert.deepEqual(cmd.env, { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile });
    assert.equal(def.format, CHECKS.e2e.format);
    assert.equal(def.timeoutMs, 1_200_000);
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.scripts["test:e2e:prod"], "E2E_PROD=1 playwright test");
  });
});

describe("done guard", () => {
  let passUnit, failUnit, emptyUnit, skippedUnit, passStatic;
  const legacySkipped = "20260101T000000-unit-legacy0";
  before(async () => {
    upsertTask(root, { id: "T-99", title: "guard target", status: "in_progress" });
    passUnit = (await runCheck(root, "unitPass", { defs: DEFS })).runId;
    failUnit = (await runCheck(root, "unitFail", { defs: DEFS })).runId;
    emptyUnit = (await runCheck(root, "unitEmpty", { defs: DEFS })).runId;
    skippedUnit = (await runCheck(root, "unitAllSkipped", { defs: DEFS })).runId;
    passStatic = (await runCheck(root, "staticOk", { defs: DEFS })).runId;
    // A report stored before RV-F-10: status "passed" although nothing passed.
    writeFileSync(
      path.join(root, RUNS_DIR, `${legacySkipped}.json`),
      JSON.stringify({
        runId: legacySkipped,
        check: "unit",
        kind: "test",
        status: "passed",
        startedAt: "2026-01-01T00:00:00.000Z",
        testsDiscovered: 4,
        testsPassed: 0,
        testsFailed: 0,
        testsSkipped: 4,
      }),
    );
  });

  const statusOf = () => loadTasks(root).find((t) => t.id === "T-99").status;

  it("refuses done without runs", () => {
    const r = upsertTask(root, { id: "T-99", status: "done", runIds: [] });
    assert.equal(r.ok, false);
    assert.match(r.error, /runIds is empty/);
    assert.equal(statusOf(), "in_progress");
  });

  it("refuses done with a missing run", () => {
    const r = upsertTask(root, { id: "T-99", status: "done", runIds: ["20260101T000000-unit-abcdef"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /does not exist/);
  });

  it("refuses done with a failed run", () => {
    const r = upsertTask(root, { id: "T-99", status: "done", runIds: [passUnit, failUnit] });
    assert.equal(r.ok, false);
    assert.match(r.error, /'failed'/);
    assert.equal(statusOf(), "in_progress");
  });

  it("refuses done with only non-test runs", () => {
    const r = upsertTask(root, { id: "T-99", status: "done", runIds: [passStatic] });
    assert.equal(r.ok, false);
    assert.match(r.error, /testsPassed > 0/);
  });

  it("refuses done with a 0-test run", () => {
    const r = upsertTask(root, { id: "T-99", status: "done", runIds: [emptyUnit] });
    assert.equal(r.ok, false);
    assert.match(r.error, /'no_tests'/);
  });

  it("refuses done with an all-skipped run (RV-F-10)", () => {
    const r = upsertTask(root, { id: "T-99", status: "done", runIds: [skippedUnit] });
    assert.equal(r.ok, false);
    assert.match(r.error, /'no_tests'/);
    assert.equal(statusOf(), "in_progress");
  });

  it("refuses done with a stored 'passed' run whose testsPassed is 0 (RV-F-10)", () => {
    const r = upsertTask(root, { id: "T-99", status: "done", runIds: [passStatic, legacySkipped] });
    assert.equal(r.ok, false);
    assert.match(r.error, /testsPassed > 0/);
    assert.equal(statusOf(), "in_progress");
  });

  it("refuses done for a new task created directly as done", () => {
    const r = upsertTask(root, { id: "T-100", status: "done" });
    assert.equal(r.ok, false);
    assert.ok(!loadTasks(root).some((t) => t.id === "T-100"));
  });

  it("accepts done with a passing test run (plus a passing static run)", () => {
    const r = upsertTask(root, { id: "T-99", status: "done", runIds: [passStatic, passUnit] });
    assert.equal(r.ok, true, r.error);
    assert.equal(statusOf(), "done");
    assert.ok(r.task.updatedAt);
  });
});

describe("task ids and merge-update", () => {
  it("accepts T-, M-, B- ids and rejects others", () => {
    for (const id of ["T-01", "T-03a", "M-01", "B-MCP", "T-17-b"]) validateTaskId(id);
    for (const id of ["X-01", "t-01", "T-", "T-01/../x", "../T-01", "T-01 ", "", "B_MCP"]) {
      assert.throws(() => validateTaskId(id), /Invalid task id/, id);
    }
    assert.throws(() => upsertTask(root, { id: "../evil" }), /Invalid task id/);
  });

  it("rejects an invalid status and invalid run ids", () => {
    assert.equal(upsertTask(root, { id: "T-50", status: "finished" }).ok, false);
    assert.throws(() => upsertTask(root, { id: "T-50", runIds: ["../../etc/passwd"] }), /Invalid run id/);
  });

  it("merges provided fields and keeps omitted ones", () => {
    upsertTask(root, { id: "M-01", title: "first", notes: "n1", requirements: ["R1.1"] });
    const r = upsertTask(root, { id: "M-01", status: "blocked" });
    assert.equal(r.task.title, "first");
    assert.equal(r.task.notes, "n1");
    assert.deepEqual(r.task.requirements, ["R1.1"]);
    assert.equal(r.task.status, "blocked");
  });

  it("run_checks with taskId appends run ids without changing status", async () => {
    upsertTask(root, { id: "B-X", status: "in_progress", runIds: [] });
    const summary = await runChecks(root, ["staticOk", "unitPass"], { taskId: "B-X", defs: DEFS });
    const task = loadTasks(root).find((t) => t.id === "B-X");
    assert.deepEqual(task.runIds, summary.map((s) => s.runId));
    assert.equal(task.status, "in_progress");
  });
});

describe("path confinement", () => {
  it("allows paths inside the root", () => {
    assert.equal(resolveInside(root, "docs/bench/tasks.json"), path.join(root, "docs/bench/tasks.json"));
  });

  it("rejects traversal and absolute paths outside the root", () => {
    assert.throws(() => resolveInside(root, "../outside.json"), /escapes/);
    assert.throws(() => resolveInside(root, "docs/../../outside"), /escapes/);
    assert.throws(() => resolveInside(root, "/etc/passwd"), /escapes/);
    assert.throws(() => resolveInside(root, `${root}-sibling/x`), /escapes/);
  });

  it("get_run_report rejects a traversal run id", () => {
    assert.throws(() => getRunReport(root, "../../tasks"), /Invalid run id/);
  });
});

describe("redaction", () => {
  const cases = [
    ["BETTER_AUTH_SECRET=s3cr3tValue", "s3cr3tValue"],
    ["password: hunter2", "hunter2"],
    ["GOOGLE_CLIENT_SECRET='quoted-value'", "quoted-value"],
    ["api_key=AKIAxyz", "AKIAxyz"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig", "eyJhbGciOiJIUzI1NiJ9"],
    ["postgres://admin:pa55w0rd@db.example.test:5432/app", "pa55w0rd"],
    ["postgresql://admin:pa55w0rd@db.example.test/app", "pa55w0rd"],
    ["SOMETHING=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY=", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNk"],
    ["HASH=0123456789abcdef0123456789abcdef01", "0123456789abcdef0123456789abcdef"],
  ];
  for (const [input, secret] of cases) {
    it(`redacts: ${input.slice(0, 30)}`, () => {
      const out = redact(input);
      assert.ok(!out.includes(secret), out);
      assert.match(out, /\[REDACTED\]/);
    });
  }

  it("leaves ordinary output alone", () => {
    const text = "Tests  3 passed (3)\nDuration 1.2s";
    assert.equal(redact(text), text);
  });
});

describe("requirements parsing", () => {
  const prd = [
    "## 4. Mandatory requirements",
    "| ID | Sub-ID | Statement |",
    "|---|---|---|",
    "| R1 | R1.1 | Google SSO only. |",
    "| | R1.2 | Check `hd`. |",
    "| R10 | R10.1 | Hypothetical. |",
    "## 5. Other",
    "| R9 | R9.1 | Not in section 4. |",
    "## 10. Acceptance criteria",
    "| AC | Req | Criterion (verifiable) |",
    "|---|---|---|",
    "| AC-01 | R1.4 | Redirects. |",
    "| AC-02 | R1.2, R2.3 | Session. |",
    "## 11. Later",
  ].join("\n");

  it("parses §4 and §10 only", () => {
    const { requirements, acceptanceCriteria } = parseRequirements(prd);
    assert.deepEqual(requirements.map((r) => r.id), ["R1.1", "R1.2", "R10.1"]);
    assert.equal(requirements[1].group, "R1");
    assert.deepEqual(acceptanceCriteria.map((a) => a.id), ["AC-01", "AC-02"]);
    assert.deepEqual(acceptanceCriteria[1].requirements, ["R1.2", "R2.3"]);
  });

  it("prefix matching does not confuse R1 with R10", () => {
    assert.ok(matchesIdPrefix("R1.1", "R1"));
    assert.ok(!matchesIdPrefix("R10.1", "R1"));
    assert.ok(matchesIdPrefix("AC-01", "AC-"));
  });
});

describe("store bootstrap", () => {
  it("creates an empty task store when missing", () => {
    const fresh = mkdtempSync(path.join(tmpdir(), "bench-mcp-fresh-"));
    try {
      assert.deepEqual(loadTasks(fresh), []);
      assert.equal(readFileSync(path.join(fresh, "docs/bench/tasks.json"), "utf8").trim(), "[]");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("rejects a non-array task store", () => {
    const bad = mkdtempSync(path.join(tmpdir(), "bench-mcp-bad-"));
    try {
      mkdirSync(path.join(bad, "docs/bench"), { recursive: true });
      writeFileSync(path.join(bad, "docs/bench/tasks.json"), "{}");
      assert.throws(() => loadTasks(bad), /JSON array/);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });
});
