import assert from "node:assert/strict";
import { claudeMcpConfig, codexMcpConfig } from "../dist-server/mcpConfig.js";

const servers = [
  { name: "blender", transport: "stdio", command: "uvx.exe", args: ["blender-mcp"], env: { BLENDER_PORT: "9876" }, required: true },
  { name: "remote.api", transport: "http", url: "https://example.test/mcp", headers: { "X-API-Key": "test" } },
  { name: "legacy-sse", transport: "sse", url: "https://example.test/sse" }
];

const claude = claudeMcpConfig(servers);
assert.equal(claude.mcpServers.blender.type, "stdio");
assert.equal(claude.mcpServers["legacy-sse"].type, "sse");

const codex = codexMcpConfig(servers);
assert.deepEqual(codex.skipped, ["legacy-sse"]);
assert.equal(codex.config.mcp_servers.blender.command, "uvx.exe");
assert.equal(codex.config.mcp_servers.remote_api.url, "https://example.test/mcp");
const headerEnvName = codex.config.mcp_servers.remote_api.env_http_headers["X-API-Key"];
assert.equal(codex.env[headerEnvName], "test");
assert.equal(codex.config.mcp_servers.blender.required, true);
assert.equal(codex.config.mcp_servers.remote_api.required, false);

const duplicate = codexMcpConfig([
  { name: "workbench-workflow-plan", transport: "stdio", command: "node", required: true },
  { name: "workbench-workflow-plan", transport: "stdio", command: "user-command", required: false }
]);
assert.equal(duplicate.config.mcp_servers["workbench-workflow-plan"].command, "node");
assert.equal(duplicate.config.mcp_servers["workbench-workflow-plan"].required, true);
assert.equal(duplicate.config.mcp_servers["workbench-workflow-plan_2"].command, "user-command");

console.log("MCP config adapters passed");
