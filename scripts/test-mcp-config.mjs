import assert from "node:assert/strict";
import { claudeMcpConfig, codexMcpConfig } from "../dist-server/mcpConfig.js";

const servers = [
  { name: "blender", transport: "stdio", command: "uvx.exe", args: ["blender-mcp"], env: { BLENDER_PORT: "9876" } },
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
assert.equal(codex.config.mcp_servers.blender.required, false);

console.log("MCP config adapters passed");
