// Core logic for the project-local "bench" MCP server (plan §00, B-MCP).
// Every function takes the workspace root explicitly so tests can use a
// temporary directory. The server always passes the root computed from its
// own file location; no path, command or cwd ever comes from tool input.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TASKS_FILE = "docs/bench/tasks.json";
export const RUNS_DIR = "docs/bench/runs";
export const TASK_ID_RE = /^(T|M|B)-[0-9A-Za-z-]+$/;
export const RUN_ID_RE = /^[0-9A-Za-z-]+$/;
export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done"];
export const CHECK_NAMES = ["lint", "typecheck", "unit", "integration", "e2e", "e2e-prod", "build"];
const EXCERPT_CHARS = 4000;

// ---------------------------------------------------------------------------
// Path confinement
// ---------------------------------------------------------------------------

/** Resolve `rel` against `root` and throw if the result escapes the root. */
export function resolveInside(root, rel) {
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Path escapes the workspace root: ${rel}`);
  }
  return target;
}

function readJson(root, rel, fallback) {
  const file = resolveInside(root, rel);
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(root, rel, value) {
  const file = resolveInside(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Requirements (docs/PRD.md §4 and §10)
// ---------------------------------------------------------------------------

function sectionBody(markdown, number) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^## ${number}\\.`).test(l));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

function tableRows(lines) {
  return lines
    .filter((l) => l.trim().startsWith("|") && !/^\|\s*-/.test(l.trim()))
    .map((l) => {
      const cells = l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
      return cells.map((c) => c.trim());
    });
}

/** Prefix match that does not let "R1" match "R10.1". */
export function matchesIdPrefix(id, prefix) {
  if (!id.startsWith(prefix)) return false;
  if (id.length === prefix.length) return true;
  return !(/\d$/.test(prefix) && /^\d/.test(id.slice(prefix.length)));
}

export function parseRequirements(markdown) {
  const requirements = [];
  let group = null;
  for (const cells of tableRows(sectionBody(markdown, 4))) {
    const [g, sub, ...rest] = cells;
    if (!/^R\d+\.\d+$/.test(sub ?? "")) continue; // header or malformed row
    if (g) group = g;
    requirements.push({ id: sub, group, statement: rest.join(" | ") });
  }
  const acceptanceCriteria = [];
  for (const cells of tableRows(sectionBody(markdown, 10))) {
    const [id, req, ...rest] = cells;
    if (!/^AC-\d+$/.test(id ?? "")) continue;
    const reqs = (req ?? "").split(/[\s,;/]+/).filter((r) => /^R\d+(\.\d+)?$/.test(r));
    acceptanceCriteria.push({ id, requirements: reqs, criterion: rest.join(" | ") });
  }
  return { requirements, acceptanceCriteria };
}

export function getRequirements(root, id) {
  const markdown = readFileSync(resolveInside(root, "docs/PRD.md"), "utf8");
  const all = parseRequirements(markdown);
  if (!id) return all;
  return {
    filter: id,
    requirements: all.requirements.filter((r) => matchesIdPrefix(r.id, id)),
    acceptanceCriteria: all.acceptanceCriteria.filter(
      (ac) => matchesIdPrefix(ac.id, id) || ac.requirements.some((r) => matchesIdPrefix(r, id)),
    ),
  };
}

// ---------------------------------------------------------------------------
// Task store
// ---------------------------------------------------------------------------

export function loadTasks(root) {
  const file = resolveInside(root, TASKS_FILE);
  if (!existsSync(file)) writeJson(root, TASKS_FILE, []);
  const tasks = readJson(root, TASKS_FILE, []);
  if (!Array.isArray(tasks)) throw new Error(`${TASKS_FILE} must contain a JSON array`);
  return tasks;
}

export function listTasks(root, { status, increment } = {}) {
  return loadTasks(root).filter(
    (t) => (!status || t.status === status) && (!increment || t.increment === increment),
  );
}

export function validateTaskId(id) {
  if (typeof id !== "string" || !TASK_ID_RE.test(id)) {
    throw new Error(`Invalid task id "${id}": must match ${TASK_ID_RE}`);
  }
}

export function validateRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new Error(`Invalid run id "${runId}"`);
  }
}

export function loadRun(root, runId) {
  validateRunId(runId);
  return readJson(root, `${RUNS_DIR}/${runId}.json`, null);
}

/**
 * Returns null if `task` may be marked done, otherwise the refusal reason.
 * Rule: runIds non-empty, every run exists and passed, and at least one is a
 * test suite (unit | integration | e2e | e2e-prod) with testsPassed > 0
 * (review RV-F-10: a suite whose tests were all skipped proves nothing; the
 * explicit count also protects against run reports stored before that fix).
 */
export function doneGuard(root, task) {
  const runIds = task.runIds ?? [];
  if (runIds.length === 0) return "status 'done' requires at least one linked run report (runIds is empty)";
  const runs = [];
  for (const runId of runIds) {
    const run = loadRun(root, runId);
    if (!run) return `linked run ${runId} does not exist`;
    if (run.status !== "passed") return `linked run ${runId} (${run.check}) has status '${run.status}', not 'passed'`;
    runs.push(run);
  }
  // kind "test" is assigned only to the unit, integration, e2e and e2e-prod checks.
  const hasTests = runs.some((r) => r.kind === "test" && r.testsPassed > 0);
  if (!hasTests) {
    return "status 'done' requires at least one linked passing test run (unit | integration | e2e | e2e-prod) with testsPassed > 0";
  }
  return null;
}

const UPSERT_FIELDS = ["title", "increment", "status", "requirements", "acceptance", "runIds", "notes"];

/**
 * Merge-update: provided fields replace stored values (arrays included);
 * omitted fields are kept. Returns { ok, task } or { ok: false, error }.
 */
export function upsertTask(root, input) {
  validateTaskId(input.id);
  if (input.status !== undefined && !TASK_STATUSES.includes(input.status)) {
    return { ok: false, error: `Invalid status "${input.status}". Allowed: ${TASK_STATUSES.join(", ")}` };
  }
  for (const runId of input.runIds ?? []) validateRunId(runId);

  const tasks = loadTasks(root);
  const index = tasks.findIndex((t) => t.id === input.id);
  const existing = index === -1 ? null : tasks[index];
  const merged = existing
    ? { ...existing }
    : { id: input.id, title: input.id, status: "todo", requirements: [], acceptance: [], runIds: [], notes: "" };
  for (const field of UPSERT_FIELDS) {
    if (input[field] !== undefined) merged[field] = input[field];
  }

  if (merged.status === "done") {
    const reason = doneGuard(root, merged);
    if (reason) return { ok: false, error: `Refused to set ${input.id} to 'done': ${reason}. Nothing was written.` };
  }

  merged.updatedAt = new Date().toISOString();
  if (index === -1) tasks.push(merged);
  else tasks[index] = merged;
  writeJson(root, TASKS_FILE, tasks);
  return { ok: true, created: index === -1, task: merged };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const REDACTIONS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]"],
  [/(postgres(?:ql)?:\/\/)[^:@\s/]+:[^@\s]+@/gi, "$1[REDACTED]@"],
  [
    /\b([A-Za-z0-9_.-]*(?:key|secret|token|password|passwd|pwd)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)[^\s"',;]+\3/gi,
    "$1$2[REDACTED]",
  ],
  [/=(\s*["']?)[A-Za-z0-9+/_-]{32,}={0,2}/g, "=$1[REDACTED]"],
];

export function redact(text) {
  return REDACTIONS.reduce((acc, [re, replacement]) => acc.replace(re, replacement), text);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function nodeBin(name) {
  return path.join(path.dirname(process.execPath), name);
}

/** Fixed, predefined checks. `reportFile` is an absolute path inside RUNS_DIR. */
export const CHECKS = {
  lint: { kind: "static", timeoutMs: 180_000, command: () => ({ file: nodeBin("npm"), args: ["run", "lint"] }) },
  typecheck: { kind: "static", timeoutMs: 240_000, command: () => ({ file: nodeBin("npm"), args: ["run", "typecheck"] }) },
  build: { kind: "build", timeoutMs: 900_000, command: () => ({ file: nodeBin("npm"), args: ["run", "build"] }) },
  unit: {
    kind: "test",
    format: "vitest",
    timeoutMs: 240_000,
    command: (reportFile) => ({
      file: nodeBin("npx"),
      args: ["vitest", "run", "--project", "unit", "--reporter=json", `--outputFile=${reportFile}`],
    }),
  },
  integration: {
    kind: "test",
    format: "vitest",
    timeoutMs: 420_000,
    command: (reportFile) => ({
      file: nodeBin("npx"),
      args: ["vitest", "run", "--project", "integration", "--reporter=json", `--outputFile=${reportFile}`],
    }),
  },
  e2e: {
    kind: "test",
    format: "playwright",
    timeoutMs: 900_000,
    // CLI --reporter overrides the config reporters, so the JSON reporter
    // honours PLAYWRIGHT_JSON_OUTPUT_NAME instead of the config outputFile.
    command: (reportFile) => ({
      file: nodeBin("npx"),
      args: ["playwright", "test", "--reporter=list,json"],
      env: { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
    }),
  },
  // Review RV-F-05: the same E2E suite against `next build && next start`
  // (fixed command: `npm run test:e2e:prod`), parsed like `e2e`.
  "e2e-prod": {
    kind: "test",
    format: "playwright",
    timeoutMs: 1_200_000,
    command: (reportFile) => ({
      file: nodeBin("npm"),
      args: ["run", "test:e2e:prod", "--", "--reporter=list,json"],
      env: { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
    }),
  },
};

/** Extract counts from a runner JSON report, or null if unparseable. */
export function parseTestReport(format, raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  if (format === "vitest") {
    if (typeof json.numTotalTests !== "number") return null;
    return {
      discovered: json.numTotalTests,
      passed: json.numPassedTests ?? 0,
      failed: json.numFailedTests ?? 0,
      skipped: (json.numPendingTests ?? 0) + (json.numTodoTests ?? 0),
    };
  }
  if (format === "playwright") {
    const s = json.stats;
    if (!s || typeof s.expected !== "number") return null;
    const skipped = s.skipped ?? 0;
    const failed = s.unexpected ?? 0;
    const passed = s.expected + (s.flaky ?? 0);
    return { discovered: passed + failed + skipped, passed, failed, skipped };
  }
  return null;
}

/**
 * Pure status classification.
 * @param {{kind: string, timedOut: boolean, spawnError: unknown, exitCode: number|null, counts: object|null}} r
 */
export function classify({ kind, timedOut, spawnError, exitCode, counts }) {
  if (timedOut) return "timeout";
  if (spawnError) return "error";
  if (kind === "test") {
    if (!counts) return "error"; // runner crash / config error: no parseable report
    if (counts.discovered === 0) return "no_tests";
    if (exitCode !== 0 || counts.failed > 0) return "failed";
    // Review RV-F-10: every test skipped is not a pass.
    if (!(counts.passed > 0)) return "no_tests";
    return "passed";
  }
  return exitCode === 0 ? "passed" : "failed";
}

function killTree(child, signal) {
  try {
    process.kill(-child.pid, signal); // negative pid: whole process group
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function execute({ file, args, env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > EXCERPT_CHARS * 4) output = output.slice(-EXCERPT_CHARS * 4);
    };
    const child = spawn(file, args, { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), 5_000);
    }, timeoutMs);

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ exitCode, signal, timedOut, spawnError, output });
    };
    child.on("error", (err) => {
      spawnError = err;
      append(`\n[spawn error] ${err.message}\n`);
      finish(null, null);
    });
    child.on("exit", (code, signal) => {
      // Give stdio a moment to drain; do not hang on grandchildren holding pipes.
      const fallback = setTimeout(() => finish(code, signal), 2_000);
      child.on("close", () => {
        clearTimeout(fallback);
        finish(code, signal);
      });
    });
  });
}

function newRunId(check) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  return `${stamp}-${check}-${randomBytes(3).toString("hex")}`;
}

function childEnv(extra) {
  const binDir = path.dirname(process.execPath);
  return { ...process.env, ...extra, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
}

export async function runCheck(root, check, { taskId, defs = CHECKS } = {}) {
  const def = Object.hasOwn(defs, check) ? defs[check] : null;
  if (!def) throw new Error(`Unknown check "${check}". Allowed: ${Object.keys(defs).join(", ")}`);
  const runId = newRunId(check);
  const reportRel = `${RUNS_DIR}/.tmp-${runId}.json`;
  const reportFile = resolveInside(root, reportRel);
  mkdirSync(path.dirname(reportFile), { recursive: true });

  const { file, args, env } = def.command(reportFile);
  const display = [path.basename(file), ...args].join(" ").replace(reportFile, reportRel);
  const startedAt = new Date();
  const result = await execute({
    file,
    args,
    env: childEnv(env),
    cwd: path.resolve(root),
    timeoutMs: def.timeoutMs,
  });
  const durationMs = Date.now() - startedAt.getTime();

  let counts = null;
  if (def.kind === "test" && existsSync(reportFile)) {
    counts = parseTestReport(def.format, readFileSync(reportFile, "utf8"));
  }
  rmSync(reportFile, { force: true });

  const report = {
    runId,
    check,
    kind: def.kind,
    command: display,
    startedAt: startedAt.toISOString(),
    durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    status: classify({ kind: def.kind, ...result, counts }),
    testsDiscovered: counts?.discovered ?? 0,
    testsPassed: counts?.passed ?? 0,
    testsFailed: counts?.failed ?? 0,
    testsSkipped: counts?.skipped ?? 0,
    outputExcerpt: redact(result.output).slice(-EXCERPT_CHARS),
    ...(taskId ? { taskId } : {}),
  };
  writeJson(root, `${RUNS_DIR}/${runId}.json`, report);
  return report;
}

export async function runChecks(root, checks, { taskId, defs = CHECKS } = {}) {
  if (!Array.isArray(checks) || checks.length === 0) throw new Error("checks must be a non-empty array");
  for (const check of checks) {
    if (!Object.hasOwn(defs, check)) {
      throw new Error(`Unknown check "${check}". Allowed: ${Object.keys(defs).join(", ")}`);
    }
  }
  if (taskId !== undefined) {
    validateTaskId(taskId);
    if (!loadTasks(root).some((t) => t.id === taskId)) throw new Error(`Task ${taskId} does not exist`);
  }

  const reports = [];
  for (const check of checks) reports.push(await runCheck(root, check, { taskId, defs }));

  if (taskId !== undefined) {
    const tasks = loadTasks(root);
    const task = tasks.find((t) => t.id === taskId);
    task.runIds = [...(task.runIds ?? []), ...reports.map((r) => r.runId)];
    task.updatedAt = new Date().toISOString();
    writeJson(root, TASKS_FILE, tasks);
  }

  return reports.map(({ runId, check, status, exitCode, durationMs, testsDiscovered, testsPassed, testsFailed }) => ({
    runId,
    check,
    status,
    exitCode,
    durationMs,
    testsDiscovered,
    testsPassed,
    testsFailed,
  }));
}

export function getRunReport(root, runId) {
  if (runId !== undefined) {
    const run = loadRun(root, runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    return run;
  }
  const dir = resolveInside(root, RUNS_DIR);
  if (!existsSync(dir)) throw new Error("No run reports yet");
  const runs = readdirJson(dir).map((name) => loadRun(root, name.replace(/\.json$/, "")));
  if (runs.length === 0) throw new Error("No run reports yet");
  runs.sort((a, b) => (a.startedAt + a.runId).localeCompare(b.startedAt + b.runId));
  return runs.at(-1);
}

function readdirJson(dir) {
  // Skips temporary runner files (".tmp-*"), which do not match RUN_ID_RE.
  return readdirSync(dir).filter((n) => n.endsWith(".json") && RUN_ID_RE.test(n.slice(0, -5)));
}
