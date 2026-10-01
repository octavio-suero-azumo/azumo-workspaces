// Protocol-level tests: start the real server over stdio with the SDK client.
// Only read-only or rejected calls are made, so the workspace is not modified.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server.mjs");

/** Call a tool and normalise protocol-level rejections into an error result. */
async function call(client, name, args) {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: String(err?.message ?? err) }] };
  }
}

describe("bench MCP server over stdio", () => {
  let client;
  before(async () => {
    client = new Client({ name: "bench-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
  });
  after(async () => client?.close());

  it("exposes exactly the five tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["get_requirements", "get_run_report", "list_tasks", "run_checks", "upsert_task"],
    );
  });

  it("rejects an unknown check name without running anything", async () => {
    const r = await call(client, "run_checks", { checks: ["rm"] });
    assert.equal(r.isError, true);
  });

  it("rejects free-form command/cwd input", async () => {
    // Extra keys are stripped by the schema; with no valid check it still fails.
    const r = await call(client, "run_checks", { checks: [], command: "ls", cwd: "/" });
    assert.equal(r.isError, true);
  });

  it("rejects an invalid task id", async () => {
    const r = await call(client, "upsert_task", { id: "../../etc/passwd" });
    assert.equal(r.isError, true);
  });

  it("rejects a traversal run id", async () => {
    const r = await call(client, "get_run_report", { runId: "../tasks" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Invalid run id/);
  });
});
