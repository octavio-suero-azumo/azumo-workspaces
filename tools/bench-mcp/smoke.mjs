// Smoke run: real MCP invocations against the bench server over stdio.
// Usage: node tools/bench-mcp/smoke.mjs
// NOTE: this writes real evidence (docs/bench/tasks.json, docs/bench/runs/*).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "server.mjs");

function show(label, result) {
  console.log(`\n=== ${label} ===`);
  if (result?.content) {
    if (result.isError) console.log("[isError: true]");
    for (const part of result.content) console.log(part.type === "text" ? part.text : part);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

const parse = (result) => JSON.parse(result.content[0].text);

const client = new Client({ name: "bench-smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));

try {
  const { tools } = await client.listTools();
  show("listTools", tools.map((t) => t.name));

  show("get_requirements({id:'R1'})", await client.callTool({ name: "get_requirements", arguments: { id: "R1" } }));

  show("list_tasks()", await client.callTool({ name: "list_tasks", arguments: {} }));

  show(
    "upsert_task(B-MCP, in_progress)",
    await client.callTool({
      name: "upsert_task",
      arguments: {
        id: "B-MCP",
        title: "Local bench MCP server (tools/bench-mcp)",
        increment: "A",
        status: "in_progress",
        requirements: ["R5.2"],
        notes: "Created by tools/bench-mcp/smoke.mjs",
      },
    }),
  );

  const checks = await client.callTool(
    { name: "run_checks", arguments: { checks: ["typecheck", "unit", "integration"], taskId: "B-MCP" } },
    undefined,
    { timeout: 1_000_000 },
  );
  show("run_checks([typecheck, unit, integration], taskId B-MCP)", checks);

  show("get_run_report() (latest)", await client.callTool({ name: "get_run_report", arguments: {} }));

  const integration = parse(checks).find((r) => r.check === "integration");
  show(
    `upsert_task(B-MCP, done, runIds=[${integration.runId}]) (must be refused)`,
    await client.callTool({
      name: "upsert_task",
      arguments: { id: "B-MCP", status: "done", runIds: [integration.runId] },
    }),
  );

  show("list_tasks({status:'in_progress'})", await client.callTool({ name: "list_tasks", arguments: { status: "in_progress" } }));
} finally {
  await client.close();
}
