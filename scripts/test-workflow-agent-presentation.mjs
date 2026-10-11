import assert from "node:assert/strict";
import { isWorkflowMachineActivity, workflowAgentPresentation, workflowOptionLabel } from "../src/workflow/agentPresentation.ts";

const log = (text, extra = {}) => ({ id: text, kind: "message", category: "message", title: "Agent 回复", text, createdAt: "2026-10-11T00:00:00Z", ...extra });
assert.equal(isWorkflowMachineActivity(log('{"status":"paid","result":{"total":12}}')), false, "business JSON must remain eligible for preview");
assert.equal(isWorkflowMachineActivity(log('{"type":"result","subtype":"success","session_id":"fixture"}')), true);
assert.equal(isWorkflowMachineActivity(log('{"schemaVersion":1,"outcome":"completed","humanSummary":"receipt"}')), true);
assert.equal(isWorkflowMachineActivity(log('{"type":"result",')), false, "partial messages remain visible");
assert.equal(isWorkflowMachineActivity(log("用户可读业务结论")), false, "generic reply titles do not hide actual content");

const logs = [log("用户可读业务结论"), log("Codex 回复"), log('{"type":"result","subtype":"success"}')];
const planning = workflowAgentPresentation({ status: "planning", provider: "codex", logs, objective: "原目标" });
assert.equal(planning.summary, "用户可读业务结论");
assert.equal(planning.progress, null, "tool counts never imply progress");
const result = { outcome: "partial", humanSummary: "实现完成，兼容性仍待核验", outputs: [], changedFiles: ["src/api.ts", "src/api.ts"], checks: [{ name: "compatibility", status: "failed" }], decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: ["兼容性待处理"], unresolved: ["兼容性待处理"], machineResultPath: null };
const presentation = workflowAgentPresentation({ status: "blocked", provider: "claude", logs, result });
assert.equal(presentation.summary, result.humanSummary);
assert.equal(presentation.files, 1);
assert.equal(presentation.checks, "0/1 验收");
assert.equal(presentation.issues, 1);
assert.equal(workflowAgentPresentation({ status: "completed", provider: "codex", logs, objective: "正式计划" }).activity, "", "settled planning does not retain temporary receipt text");
assert.equal(workflowOptionLabel({ title: "接口维护", status: "paused", activePlanVersion: 3, executionTarget: "worktree" }), "接口维护 · 已暂停 · v3 · Worktree");
console.log("workflow business previews, protocol filtering, result freshness and navigation labels passed");
