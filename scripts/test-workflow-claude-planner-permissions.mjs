import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { resolveWorkbenchPaths } from "../dist-server/appPaths.js";
import { runClaude } from "../dist-server/engines/claude/process.js";
import { resolveClaudeCommand } from "../dist-server/engines/claude/runtime.js";
import { CliRuntimeManager } from "../dist-server/runtime/manager.js";
import { createWorkflowPlanTransaction, readWorkflowPlanTransaction } from "../dist-server/workflows/plannerTransactions.js";

const root = process.cwd();
const permissionMode = process.argv.includes("--plan") ? "plan" : "default";
const paths = resolveWorkbenchPaths(root);
const runtimeManager = new CliRuntimeManager(root, paths.runtimesDir);
const runtime = await runtimeManager.detect("claude", "", "managed");
assert.equal(runtime.available, true, runtime.message);
const cli = resolveClaudeCommand(runtime.path);

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-claude-planner-permission-"));
const transactionPath = path.join(temp, "transaction.json");
const mcpConfigPath = path.join(temp, "mcp.json");
createWorkflowPlanTransaction(transactionPath, {
  workflowId: "workflow-claude-permission-test", mode: "refine", baseRevision: 1, basePlanVersion: 1,
  previousPlan: { planSchemaVersion: 2, title: "权限链测试", summary: "只验证工具调用", assumptions: [], questions: [], risks: [], audit: { status: "passed", checks: [{ key: "provider-allocation", status: "passed", note: "无需执行 Agent" }], changes: [] }, nodes: [] },
  availableSkills: [], availableMcpServers: [], providerCapabilities: { claudeAvailable: true, codexAvailable: true }
});
await fsp.writeFile(mcpConfigPath, JSON.stringify({
  mcpServers: {
    "workbench-workflow-plan": {
      type: "stdio",
      command: process.execPath,
      args: [path.join(root, "dist-server", "workflows", "plannerToolServer.js")],
      env: { WORKFLOW_PLANNER_TRANSACTION_PATH: transactionPath }
    }
  }
}), "utf8");

let requestCount = 0;
const server = http.createServer((req, res) => {
  if (!req.url?.startsWith("/v1/messages")) return void res.writeHead(404).end();
  req.resume();
  req.on("end", () => {
    requestCount += 1;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const tool = requestCount === 1
      ? { id: "tool_read", name: "mcp__workbench-workflow-plan__workflow_read_plan", input: {} }
      : requestCount === 2
        ? { id: "tool_no_change", name: "mcp__workbench-workflow-plan__workflow_no_change", input: { reason: "权限链验证完成" } }
        : null;
    const content = tool ? { type: "tool_use", id: tool.id, name: tool.name, input: {} } : { type: "text", text: "权限链验证完成" };
    const events = [
      ["message_start", { type: "message_start", message: { id: `msg_${requestCount}`, type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: content }],
      ...(tool && Object.keys(tool.input).length ? [["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } }]] : []),
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
      ["message_stop", { type: "message_stop" }]
    ];
    for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 45_000);
const events = [];
try {
  await runClaude({
    executable: cli.executable,
    executableArgs: cli.args,
    cwd: temp,
    prompt: "先读取规划事务，然后以无修改结束。",
    model: "claude-test",
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: "test-key",
    configDir: path.join(temp, "claude-home"),
    mcpConfigPath,
    permissionMode,
    allowedTools: ["Read", "Glob", "Grep", "mcp__workbench-workflow-plan__*"],
    disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"],
    signal: controller.signal,
    onEvent: (event) => events.push(event)
  });
  assert.equal(readWorkflowPlanTransaction(transactionPath).status, "no_change", JSON.stringify({ requestCount, events }, null, 2));
  assert.ok(events.some((event) => event.type === "tool.completed" && event.toolName === "mcp__workbench-workflow-plan__workflow_read_plan"));
  assert.ok(events.some((event) => event.type === "tool.completed" && event.toolName === "mcp__workbench-workflow-plan__workflow_no_change"));
  assert.ok(!events.some((event) => event.type === "error" && /权限/.test(event.text)));
  console.log(`Claude workflow MCP preauthorization chain OK (${permissionMode})`);
} finally {
  clearTimeout(timeout);
  server.close();
  await fsp.rm(temp, { recursive: true, force: true });
}
