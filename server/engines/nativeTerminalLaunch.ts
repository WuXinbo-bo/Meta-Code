import type { CodexConfigObject, CodexConfigValue } from "../mcpConfig.js";

// Command arguments are passed directly to the PTY, never through a shell.
function toml(value: CodexConfigValue): string {
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(",")}}`;
  throw new Error("无效的原生 CLI 配置");
}

export function codexTerminalConfigArgs(config: CodexConfigObject) {
  const args: string[] = [];
  for (const [key, value] of Object.entries(config)) args.push("-c", `${key}=${toml(value)}`);
  return args;
}

/** Keep MCP secrets out of the process argument list. Refuse conflicting values. */
export function terminalMcpEnvironment(config: CodexConfigObject, env: Record<string, string>) {
  const result = structuredClone(config);
  const supplied = new Map<string, string>();
  const servers = result.mcp_servers;
  if (servers && !Array.isArray(servers) && typeof servers === "object") {
    for (const server of Object.values(servers)) {
      if (!server || Array.isArray(server) || typeof server !== "object") continue;
      const serverEnv = server.env;
      if (!serverEnv || Array.isArray(serverEnv) || typeof serverEnv !== "object") continue;
      for (const [key, value] of Object.entries(serverEnv)) {
        if (typeof value !== "string") throw new Error("MCP 环境变量必须是字符串");
        if (supplied.has(key) && supplied.get(key) !== value) throw new Error("多个 MCP 使用了冲突的环境变量，请使用独立变量名");
        if (env[key] !== undefined && env[key] !== value) throw new Error("MCP 环境变量与原生进程配置冲突，请使用独立变量名");
        supplied.set(key, value);
      }
      server.env_vars = [...new Set([...(Array.isArray(server.env_vars) ? server.env_vars : []), ...Object.keys(serverEnv)])];
      delete server.env;
    }
  }
  return { config: result, env: { ...env, ...Object.fromEntries(supplied) } };
}
