import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { workflowLogFromEngineEvent } from "../server/plugins/orchestration/logs.ts";
import { publicWorkflowActivity } from "../src/workflow/publicActivity.ts";
import { coalescedWorkflowRefresh } from "../src/workflow/eventRefresh.ts";

const logs = [
  workflowLogFromEngineEvent({ type: "tool.started", toolName: "mcp__workbench-workflow-plan__workflow_read_plan", sourceId: "claude-control", text: "{}" }, "claude"),
  workflowLogFromEngineEvent({ type: "tool.completed", toolName: "mcp_tool_call", sourceId: "codex-control", text: "完成", detail: { server: "workbench-workflow-result", tool: "workflow_commit_result" } }, "codex"),
  workflowLogFromEngineEvent({ type: "error", toolName: "mcp__workbench_workflow_result__workflow_validate_result", sourceId: "control-error", text: "validation failed" }, "claude"),
  workflowLogFromEngineEvent({ type: "tool.completed", toolName: "mcp__customer__workflow_read_plan", sourceId: "business", text: "业务数据" }, "claude"),
  workflowLogFromEngineEvent({ type: "tool.completed", toolName: "mcp_tool_call", sourceId: "business-mcp", text: "完成", detail: { server: "business", tool: "workflow_commit_result" } }, "codex"),
  workflowLogFromEngineEvent({ type: "assistant", sourceId: "reply", text: "已完成业务修改。" }, "codex"),
  workflowLogFromEngineEvent({ type: "error", sourceId: "failure", text: "产物缺失，需要处理。" }, "codex")
];
assert.deepEqual(publicWorkflowActivity(logs).map((log) => log.id), ["claude:business", "codex:business-mcp", "codex:reply", "codex:failure"]);
assert.equal(logs.length, 7, "Persisted diagnostic logs must remain intact");

let calls = 0;
let active = 0;
let maxActive = 0;
let finish;
const refresh = coalescedWorkflowRefresh(async () => {
  calls++;
  maxActive = Math.max(maxActive, ++active);
  if (calls === 1) await new Promise((resolve) => { finish = resolve; });
  active--;
}, 10);
for (let index = 0; index < 100; index++) refresh.schedule();
await wait(30);
assert.equal(calls, 1, "Stream bursts coalesce into one resource read");
for (let index = 0; index < 100; index++) refresh.schedule();
await wait(20);
assert.equal(calls, 1, "A slow read must never overlap with another read");
finish();
await wait(30);
assert.equal(calls, 2, "Events during a read require one trailing reconciliation");
assert.equal(maxActive, 1);
refresh.schedule();
refresh.dispose();
await wait(30);
assert.equal(calls, 2, "Navigation cancels delayed refreshes");
console.log("Workflow public activity hides only internal receipts; stream reads remain bounded, sequential and reconciled");
