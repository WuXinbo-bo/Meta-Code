import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { WorkbenchMcpServer } from "../mcpConfig.js";

export const WORKFLOW_PLANNER_MCP_SERVER = "workbench-workflow-plan";
export const WORKFLOW_PLANNER_TOOL_NAMES = [
  "workflow_read_plan",
  "workflow_replace_plan",
  "workflow_apply_operations",
  "workflow_validate_draft",
  "workflow_commit_candidate",
  "workflow_no_change"
] as const;

export const WORKFLOW_RESULT_MCP_SERVER = "workbench-workflow-result";
export const WORKFLOW_RESULT_TOOL_NAMES = [
  "workflow_read_node_contract",
  "workflow_read_result_draft",
  "workflow_set_result_summary",
  "workflow_register_outputs",
  "workflow_register_checks",
  "workflow_set_handoff",
  "workflow_set_outcome",
  "workflow_report_blocked",
  "workflow_self_review_result",
  "workflow_validate_result",
  "workflow_commit_result"
] as const;

function codexIdentifier(value: string) {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

export function codexMcpToolFunction(server: string, tool: string) {
  return `mcp__${codexIdentifier(server)}__${codexIdentifier(tool)}`;
}

export function codexWorkflowPlannerToolInstructions() {
  const functions = WORKFLOW_PLANNER_TOOL_NAMES.map((tool) => `- ${tool}: tools.${codexMcpToolFunction(WORKFLOW_PLANNER_MCP_SERVER, tool)}(...)`).join("\n");
  return [
    "Codex 规划工具调用约定：这些 MCP 工具通过统一 exec 工具暴露，必须使用下面的完整 JavaScript 函数名，不能调用 tools.workflow_read_plan 等短名称。",
    functions,
    `首次读取示例：const result = await tools.${codexMcpToolFunction(WORKFLOW_PLANNER_MCP_SERVER, "workflow_read_plan")}({}); text(result);`,
    "如果需要核对函数，可在 exec 中从 ALL_TOOLS 筛选 workbench_workflow_plan；不得因短名称不存在而判定规划 MCP 未挂载。"
  ].join("\n");
}

export function codexWorkflowResultToolInstructions() {
  const functions = WORKFLOW_RESULT_TOOL_NAMES.map((tool) => `- ${tool}: tools.${codexMcpToolFunction(WORKFLOW_RESULT_MCP_SERVER, tool)}(...)`).join("\n");
  return [
    "Codex 机器交接工具调用约定：这些 MCP 工具通过统一 exec 工具暴露，必须使用下面的完整 JavaScript 函数名，不能调用 tools.workflow_read_node_contract 等短名称。",
    functions,
    `首次读取示例：const result = await tools.${codexMcpToolFunction(WORKFLOW_RESULT_MCP_SERVER, "workflow_read_node_contract")}({}); text(result);`,
    "如果需要核对函数，可在 exec 中从 ALL_TOOLS 筛选 workbench_workflow_result；不得因短名称不存在而判定结果 MCP 未挂载。"
  ].join("\n");
}

async function assertWorkflowControlTools(
  server: WorkbenchMcpServer,
  cwd: string,
  expectedServer: string,
  expectedTools: readonly string[],
  label: string,
  timeoutMs = 15_000
) {
  if (server.transport !== "stdio" || !server.command) throw new Error("任务编排控制面必须使用 stdio MCP");
  if (server.name !== expectedServer) throw new Error(`任务编排控制面名称错误：应为 ${expectedServer}，实际为 ${server.name}`);
  const env = Object.fromEntries(Object.entries({ ...process.env, ...(server.env || {}) }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({ command: server.command, args: server.args || [], env, cwd, stderr: "pipe" });
  const client = new McpClient({ name: "meta-code-workflow-preflight", version: "0.1.3" });
  let timer: NodeJS.Timeout | null = null;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} MCP 启动超过 ${Math.ceil(timeoutMs / 1000)} 秒`)), timeoutMs);
    });
    await Promise.race([client.connect(transport), timeout]);
    const listed = await Promise.race([client.listTools(), timeout]);
    const available = new Set(listed.tools.map((tool) => tool.name));
    const missing = expectedTools.filter((tool) => !available.has(tool));
    if (missing.length) throw new Error(`缺少${label}：${missing.join(", ")}`);
    return { server: expectedServer, tools: [...expectedTools] };
  } catch (error) {
    throw new Error(`任务编排${label}预检失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => transport.close().catch(() => undefined));
  }
}

export function assertWorkflowPlannerTools(server: WorkbenchMcpServer, cwd: string, timeoutMs = 15_000) {
  return assertWorkflowControlTools(server, cwd, WORKFLOW_PLANNER_MCP_SERVER, WORKFLOW_PLANNER_TOOL_NAMES, "规划工具", timeoutMs);
}

export function assertWorkflowResultTools(server: WorkbenchMcpServer, cwd: string, timeoutMs = 15_000) {
  return assertWorkflowControlTools(server, cwd, WORKFLOW_RESULT_MCP_SERVER, WORKFLOW_RESULT_TOOL_NAMES, "结果工具", timeoutMs);
}
