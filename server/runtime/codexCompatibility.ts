import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkbenchMcpServer } from "../mcpConfig.js";

const execFileAsync = promisify(execFile);

function tomlValue(value: unknown) {
  return JSON.stringify(value);
}

export async function assertCodexMcpConfiguration(executable: string, server: WorkbenchMcpServer, timeoutMs = 15_000) {
  if (!executable) throw new Error("Codex CLI 路径为空");
  if (server.transport !== "stdio" || !server.command) throw new Error("Codex 控制面预检只支持 stdio MCP");
  const key = `mcp_servers.${server.name}`;
  const overrides = [
    `${key}.command=${tomlValue(server.command)}`,
    `${key}.args=${tomlValue(server.args || [])}`,
    `${key}.enabled=true`,
    `${key}.required=${server.required === true}`
  ];
  const args = [...overrides.flatMap((value) => ["--config", value]), "mcp", "get", server.name, "--json"];
  try {
    const { stdout } = await execFileAsync(executable, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout) as { name?: string; transport?: { type?: string; command?: string } };
    if (parsed.name !== server.name || parsed.transport?.type !== "stdio") throw new Error("Codex 未返回预期的 stdio MCP 配置");
    return { executable, server: server.name };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex CLI 与任务编排 MCP 配置不兼容：${detail}`);
  }
}
