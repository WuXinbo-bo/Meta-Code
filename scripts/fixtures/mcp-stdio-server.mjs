import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "metacode-test-mcp", version: "1.0.0" });
server.registerTool("ping", { description: "Returns a deterministic test response" }, async () => ({
  content: [{ type: "text", text: "pong" }]
}));

await server.connect(new StdioServerTransport());
