#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTaskHistoryTool } from "./historyTool.js";

const snapshotPath = process.env.METACODE_TASK_HISTORY_PATH;
if (!snapshotPath) throw new Error("METACODE_TASK_HISTORY_PATH 未配置");
const server = new McpServer({ name: "workbench-task-history", version: "1.0.0" });
registerTaskHistoryTool(server, snapshotPath);
await server.connect(new StdioServerTransport());
