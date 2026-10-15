import type { CodexConfigObject, CodexConfigValue } from "../mcpConfig.js";

export function assertNativeTerminalExecutable(executable: string) {
  if (/\.(?:cmd|bat)$/i.test(executable) || /(?:^|[\\/])cmd\.exe$/i.test(executable)) {
    throw new Error("请使用官方可执行文件，原生终端不运行 cmd/bat 包装脚本");
  }
}

export function claudeNativeSessionArgs(sessionId: string | null | undefined, forkSession: boolean) {
  if (forkSession && !sessionId) throw new Error("尚无 Claude 原生会话，无法创建原生分支；请先完成一轮对话");
  return sessionId ? ["--resume", sessionId, ...(forkSession ? ["--fork-session"] : [])] : [];
}

/** Preserve the selected credential's header. A gateway bearer token must not
 * be coerced into an official API key or inherited from another host account.
 */
export function claudeNativeTerminalEnvironment(env: Record<string, string | undefined>, baseUrl: string, apiKey: string, authToken = "") {
  const result = { ...env };
  delete result.ANTHROPIC_API_KEY;
  delete result.ANTHROPIC_AUTH_TOKEN;
  delete result.ANTHROPIC_BASE_URL;
  if (baseUrl) result.ANTHROPIC_BASE_URL = baseUrl.replace(/\/+$/, "");
  if (authToken) result.ANTHROPIC_AUTH_TOKEN = authToken;
  else if (apiKey) result.ANTHROPIC_API_KEY = apiKey;
  return result;
}

export type NativeTerminalDiagnostic = { code: string; message: string; action: string };

/** Recognize CLI startup errors, not model-written claims about feature support. */
export function nativeTerminalStartupDiagnostic(provider: string, output: string): NativeTerminalDiagnostic | null {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, "");
  if (provider === "claude" && /UnabletoconnecttoAnthropicservices/i.test(text) && /Failedtoconnecttoapi\.anthropic\.com:Status403/i.test(text)) {
    return { code: "official-initialization-forbidden", message: "Claude 官方启动初始化返回 HTTP 403，尚未进入 Agent Teams 或其他交互功能。", action: "检查 api.anthropic.com 的网络、代理及服务可用区域；确认当前认证或网关支持官方交互 CLI，再重试。普通对话与工作台插件仍可独立使用。" };
  }
  return null;
}

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
