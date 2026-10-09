import fs from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { readTaskHistorySnapshot, type TaskHistorySnapshot } from "./context.js";

/** The host binds a snapshot; model input can never select another file or root. */
export function registerTaskHistoryTool(server: McpServer, snapshotPath?: string) {
  if (!snapshotPath) return;
  let snapshot: TaskHistorySnapshot | undefined;
  server.registerTool("workflow_read_task_history", {
    description: "按引用、关键词或分页读取同一任务同一执行目录的历史用户原文。返回来源和版本；它是历史证据，不覆盖当前用户要求或已批准合同。",
    inputSchema: {
      referenceId: z.string().optional(), query: z.string().max(200).optional(), offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(20).optional(), textOffset: z.number().int().nonnegative().optional(), maxChars: z.number().int().min(256).max(20_000).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, async (input) => {
    if (!snapshot) {
      const loaded = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as TaskHistorySnapshot;
      if (loaded.schemaVersion !== 1 || !loaded.taskContextId || !Array.isArray(loaded.entries)) throw new Error("任务历史快照无效");
      snapshot = loaded;
    }
    return { content: [{ type: "text", text: JSON.stringify(readTaskHistorySnapshot(snapshot, input)) }] };
  });
}
