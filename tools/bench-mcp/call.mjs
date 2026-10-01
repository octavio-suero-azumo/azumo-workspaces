// One real MCP tool call against the bench server over stdio (coordinator helper).
// Usage: node tools/bench-mcp/call.mjs <tool> '<json-arguments>'
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "server.mjs");
const [tool, rawArgs = "{}"] = process.argv.slice(2);
if (!tool) {
  console.error("usage: node tools/bench-mcp/call.mjs <tool> '<json-arguments>'");
  process.exit(2);
}

const client = new Client({ name: "bench-call", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
try {
  const result = await client.callTool({ name: tool, arguments: JSON.parse(rawArgs) }, undefined, {
    timeout: 20 * 60 * 1000,
  });
  if (result.isError) console.log("[isError: true]");
  for (const part of result.content ?? []) console.log(part.type === "text" ? part.text : JSON.stringify(part));
  process.exitCode = result.isError ? 1 : 0;
} finally {
  await client.close();
}
