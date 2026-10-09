import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { readTaskHistorySnapshot, type TaskHistorySnapshot } from "../../tasks/context.js";

/** Host binds an immutable snapshot; tool input can never select a file/root. */
export function registerWorkflowTaskHistoryTool(server: McpServer, snapshotPath = process.env.WORKFLOW_TASK_HISTORY_PATH) {
  if (!snapshotPath) return;
  server.registerTool("workflow_read_task_history", {
    description: "按引用、关键词或分页读取同一任务同一执行目录的历史用户原文。返回来源和版本；它是历史证据，不覆盖当前用户要求或已批准合同。",
    inputSchema: {
      referenceId: z.string().optional(), query: z.string().max(200).optional(), offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(20).optional(), textOffset: z.number().int().nonnegative().optional(), maxChars: z.number().int().min(256).max(20_000).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async (input) => {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as TaskHistorySnapshot;
    if (snapshot.schemaVersion !== 1 || !snapshot.taskContextId || !Array.isArray(snapshot.entries)) throw new Error("任务历史快照无效");
    return { content: [{ type: "text", text: JSON.stringify(readTaskHistorySnapshot(snapshot, input)) }] };
  });
}
