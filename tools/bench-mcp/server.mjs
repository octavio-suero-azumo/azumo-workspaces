#!/usr/bin/env node
// Azumo Workspaces "bench" MCP server (plan §00, B-MCP). Local stdio only.
// Exposes exactly five tools: get_requirements, list_tasks, upsert_task,
// run_checks, get_run_report. The workspace root is derived from this file's
// location and is never taken from tool input.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CHECK_NAMES,
  TASK_ID_RE,
  TASK_STATUSES,
  getRequirements,
  getRunReport,
  listTasks,
  runChecks,
  upsertTask,
} from "./lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });

/** Wrap a handler so thrown errors become MCP error results. */
const tool = (fn) => async (args) => {
  try {
    return await fn(args ?? {});
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
};

export function createServer() {
  const server = new McpServer({ name: "bench", version: "0.1.0" });

  server.registerTool(
    "get_requirements",
    {
      description:
        "Read mandatory requirements (PRD §4, R*.*) and acceptance criteria (PRD §10, AC-xx) from docs/PRD.md. Optional id prefix filter (e.g. 'R1', 'R2.3', 'AC-05'); ACs are also matched by their linked requirement.",
      inputSchema: { id: z.string().max(20).optional() },
    },
    tool(({ id }) => ok(getRequirements(ROOT, id))),
  );

  server.registerTool(
    "list_tasks",
    {
      description: "List tasks from docs/bench/tasks.json, optionally filtered by status and/or increment.",
      inputSchema: {
        status: z.enum(TASK_STATUSES).optional(),
        increment: z.string().max(40).optional(),
      },
    },
    tool((args) => ok(listTasks(ROOT, args))),
  );

  server.registerTool(
    "upsert_task",
    {
      description:
        "Create or merge-update a task (provided fields replace stored values, arrays included). status 'done' is refused unless every linked run passed and at least one linked unit/integration/e2e/e2e-prod run has testsPassed > 0.",
      inputSchema: {
        id: z.string().regex(TASK_ID_RE),
        title: z.string().max(200).optional(),
        increment: z.string().max(40).optional(),
        status: z.enum(TASK_STATUSES).optional(),
        requirements: z.array(z.string().max(20)).optional(),
        acceptance: z.array(z.string().max(20)).optional(),
        runIds: z.array(z.string().max(80)).optional(),
        notes: z.string().max(4000).optional(),
      },
    },
    tool((args) => {
      const result = upsertTask(ROOT, args);
      return result.ok ? ok(result) : fail(result.error);
    }),
  );

  server.registerTool(
    "run_checks",
    {
      description:
        "Run predefined project checks only (lint, typecheck, unit, integration, e2e, e2e-prod, build) in the workspace root, with per-check timeouts. Saves a report per check under docs/bench/runs/. If taskId is given, appends the run ids to that task (status unchanged).",
      inputSchema: {
        checks: z.array(z.enum(CHECK_NAMES)).min(1).max(CHECK_NAMES.length),
        taskId: z.string().regex(TASK_ID_RE).optional(),
      },
    },
    tool(async ({ checks, taskId }) => ok(await runChecks(ROOT, checks, { taskId }))),
  );

  server.registerTool(
    "get_run_report",
    {
      description: "Return a stored run report by runId, or the latest one if runId is omitted.",
      inputSchema: { runId: z.string().max(80).optional() },
    },
    tool(({ runId }) => ok(getRunReport(ROOT, runId))),
  );

  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await createServer().connect(new StdioServerTransport());
}
