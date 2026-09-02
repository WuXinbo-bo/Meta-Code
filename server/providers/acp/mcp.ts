import type { McpServer } from "@agentclientprotocol/sdk";

export type WorkbenchAcpMcpServer = {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

export function acpMcpServers(servers: WorkbenchAcpMcpServer[]): McpServer[] {
  return servers.map((server): McpServer => {
    if (server.transport === "stdio") {
      if (!server.command) throw new Error(`ACP MCP「${server.name}」缺少启动命令`);
      return {
        name: server.name,
        command: server.command,
        args: server.args || [],
        env: Object.entries(server.env || {}).map(([name, value]) => ({ name, value }))
      };
    }
    if (!server.url) throw new Error(`ACP MCP「${server.name}」缺少 URL`);
    return {
      type: server.transport,
      name: server.name,
      url: server.url,
      headers: Object.entries(server.headers || {}).map(([name, value]) => ({ name, value }))
    };
  });
}
