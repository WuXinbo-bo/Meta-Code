import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTaskHistoryTool } from "../../tasks/historyTool.js";

/** Host binds an immutable snapshot; tool input can never select a file/root. */
export function registerWorkflowTaskHistoryTool(server: McpServer, snapshotPath = process.env.WORKFLOW_TASK_HISTORY_PATH) {
  registerTaskHistoryTool(server, snapshotPath);
}
