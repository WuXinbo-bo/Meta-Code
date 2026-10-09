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

const rawEmpty = { type: "item.completed", item: { id: "empty", type: "agent_message", text: " " } };
const empty = workflowLogFromEngineEvent({ type: "assistant", sourceId: "empty", text: "Codex 回复", payload: rawEmpty }, "planner");
const legacyEmpty = { ...empty, text: "Codex 回复", activity: { ...empty.activity, summary: "Codex 回复" } };
const streaming = workflowLogFromEngineEvent({ type: "assistant", sourceId: "stream", text: "流式回复", phase: "running" }, "codex");
const finished = { ...streaming, text: "已完成业务修改。", activity: { ...streaming.activity, summary: "已完成业务修改。", phase: "completed" } };
const independentReply = workflowLogFromEngineEvent({ type: "assistant", sourceId: "independent-reply", text: "已完成业务修改。" }, "codex");
const reconnect = workflowLogFromEngineEvent({ type: "status", sourceId: "reconnect", text: "Reconnecting... 1/5" }, "codex");
const inputs = [...logs, legacyEmpty, streaming, finished, independentReply, reconnect];
const original = JSON.stringify(inputs);
const publicLogs = publicWorkflowActivity(inputs);
assert.equal(publicLogs.length, 7, "card preview and drawer count exclude raw empty markers and duplicate stream identities");
assert.ok(!publicLogs.some((log) => log.id === legacyEmpty.id));
assert.equal(publicLogs.find((log) => log.id === streaming.id)?.text, "已完成业务修改。", "preview resolves the same final body as the drawer transcript");
assert.equal(publicLogs.filter((log) => log.text === "已完成业务修改。").length, 3, "different genuine reply IDs remain independent");
assert.ok(publicLogs.some((log) => log.id === reconnect.id), "reconnect is still represented in the shared count");
assert.equal(JSON.stringify(inputs), original, "effective projection does not rewrite raw logs");
assert.deepEqual(publicWorkflowActivity(publicLogs), publicLogs, "projecting a drawer transcript again cannot change its count");
const preview = publicLogs.slice(-5);
assert.ok(!preview.some((log) => log.id === legacyEmpty.id), "empty replies never consume a latest-five preview slot");

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
