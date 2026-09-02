export type WorkbenchMcpTransport = "stdio" | "http" | "sse";

export type WorkbenchMcpServer = {
  name: string;
  transport: WorkbenchMcpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

export type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
export type CodexConfigObject = { [key: string]: CodexConfigValue };

export function claudeMcpConfig(servers: WorkbenchMcpServer[]) {
  const entries = servers.map((server) => [server.name, server.transport === "stdio"
    ? { type: "stdio", command: server.command, args: server.args || [], env: server.env || {} }
    : { type: server.transport, url: server.url, headers: server.headers || {} }] as const);
  return { mcpServers: Object.fromEntries(entries) };
}

function codexServerName(name: string, used: Set<string>) {
  const base = name.replace(/[^a-zA-Z0-9_-]/g, "_") || "mcp";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base}_${suffix++}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

export function codexMcpConfig(servers: WorkbenchMcpServer[]): { config: CodexConfigObject; env: Record<string, string>; skipped: string[] } {
  const usedNames = new Set<string>();
  const usedEnvNames = new Set<string>();
  const env: Record<string, string> = {};
  const skipped: string[] = [];
  const entries: Array<[string, CodexConfigObject]> = [];
  for (const server of servers) {
    // Current Codex CLI supports stdio and Streamable HTTP. Legacy SSE remains
    // available to Claude but must not make a Codex thread fail at startup.
    if (server.transport === "sse") {
      skipped.push(server.name);
      continue;
    }
    const name = codexServerName(server.name, usedNames);
    const headerEnv = Object.fromEntries(Object.entries(server.headers || {}).map(([header, value]) => {
      const base = `WORKBENCH_MCP_${name}_${header}`.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase();
      let envName = base;
      let suffix = 2;
      while (usedEnvNames.has(envName)) envName = `${base}_${suffix++}`;
      usedEnvNames.add(envName);
      env[envName] = value;
      return [header, envName];
    }));
    const transport = server.transport === "stdio"
      ? {
          command: server.command || "",
          args: server.args || [],
          ...(Object.keys(server.env || {}).length ? { env: server.env || {} } : {})
        }
      : {
          url: server.url || "",
          ...(Object.keys(headerEnv).length ? { env_http_headers: headerEnv } : {})
        };
    entries.push([name, {
      ...transport,
      enabled: true,
      required: false,
      startup_timeout_sec: 30,
      tool_timeout_sec: 300
    }]);
  }
  return { config: entries.length ? { mcp_servers: Object.fromEntries(entries) } : {}, env, skipped };
}
