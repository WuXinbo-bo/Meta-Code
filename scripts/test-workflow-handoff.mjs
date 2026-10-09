import assert from "node:assert/strict";
import { isWorkflowHandoffMessage, readWorkflowHandoff, workflowHandoffKey, workflowHandoffSourceId, workflowHandoffSourceKind } from "../src/tasks/workflowHandoff.ts";
import { handoffWorkflowId } from "../src/tasks/linkedWorkflow.ts";
import { renderTaskHandoff } from "../server/tasks/context.ts";

const source = { kind: "workflow", id: "old", executionRoot: "/project" };
const rendered = renderTaskHandoff({ source, sourceRevision: 3, goal: "维护支付 API\n保留现有兼容性", messages: [{ id: "result", role: "assistant", text: "回归检查已通过\n12 tests passed" }], userRequests: [], attachments: [], decisions: ["保留现有接口合同"], files: ["src/payments.js", "test/payments.test.js"], unresolved: ["需确认旧账户兼容范围"], createdAt: new Date().toISOString() });
const parsed = readWorkflowHandoff(rendered);
assert.equal(parsed.title, "维护支付 API");
assert.equal(parsed.summary, "回归检查已通过\n12 tests passed");
assert.deepEqual(parsed.files, ["src/payments.js", "test/payments.test.js"]);
assert.deepEqual(parsed.decisions, ["保留现有接口合同"]);
assert.deepEqual(parsed.unresolved, ["需确认旧账户兼容范围"]);
assert.equal(parsed.completed, false);

const result = { role: "assistant", eventType: "task.workflow.result", text: "编排已完成：支付接口维护\n\n已完成兼容修复\n12 tests passed\n\n关键决定：\n保留接口\n\n成果：\nsrc/payments.js\ntest/payments.test.js\n\n待处理：\n补充上线说明", payload: { workflowId: "old" } };
assert.equal(isWorkflowHandoffMessage(result), true);
assert.equal(workflowHandoffSourceId(result), "old");
assert.deepEqual(readWorkflowHandoff(result.text), { title: "支付接口维护", completed: true, summary: "已完成兼容修复\n12 tests passed", files: ["src/payments.js", "test/payments.test.js"], decisions: ["保留接口"], unresolved: ["补充上线说明"] });
assert.equal(isWorkflowHandoffMessage({ role: "user", text: result.text }), false, "Quoted handoffs from users remain user messages");
assert.equal(isWorkflowHandoffMessage({ role: "assistant", text: "普通回答" }), false);
assert.equal(isWorkflowHandoffMessage({ role: "assistant", text: "编排进度交接：历史目标" }), true);
assert.equal(workflowHandoffSourceId({ ...result, payload: {}, sourceId: "workflow-result:old:1:completed:digest" }), "old");
assert.notEqual(workflowHandoffKey(result), workflowHandoffKey({ ...result, payload: { workflowId: "recent" } }), "Different workflow rounds with identical text remain distinct");
assert.notEqual(workflowHandoffKey({ ...result, payload: { workflowId: "old", planVersion: 1 } }), workflowHandoffKey({ ...result, payload: { workflowId: "old", planVersion: 2 } }), "Identical result text from different approved plans remains in history");
assert.notEqual(workflowHandoffKey({ ...result, payload: {}, sourceId: "workflow-result:old:1:completed:digest" }), workflowHandoffKey({ ...result, payload: {}, sourceId: "workflow-result:old:2:completed:digest" }));
const conversationSource = { role: "assistant", text: rendered, eventType: "task.context.handoff", payload: { sourceKind: "session", sourceId: "other-provider-chat", sourceRevision: 4, workflowId: "old" } };
assert.equal(workflowHandoffSourceKind(conversationSource), "session", "Provider changes retain their ordinary conversation source");
assert.equal(workflowHandoffSourceId(conversationSource), "", "An explicit session handoff never inherits workflow navigation");
assert.notEqual(workflowHandoffKey(conversationSource), workflowHandoffKey({ ...conversationSource, payload: { ...conversationSource.payload, sourceRevision: 5 } }));

const workflows = [{ id: "old", taskContextId: "task", executionRoot: "/project", updatedAt: "2026-10-07T12:00:00Z" }, { id: "recent", taskContextId: "task", executionRoot: "/project", updatedAt: "2026-10-08T12:00:00Z" }, { id: "branch", taskContextId: "task", executionRoot: "/worktree", updatedAt: "2026-10-09T12:00:00Z" }];
const session = { taskContextId: "task", executionRoot: "/project" };
assert.equal(handoffWorkflowId("old", session, workflows), "old", "Historical cards open their own round");
assert.equal(handoffWorkflowId("branch", session, workflows), "", "Cards cannot cross execution roots");
assert.equal(handoffWorkflowId("removed", session, workflows), "", "Removed sources must not open a newer round");
assert.equal(handoffWorkflowId("", session, workflows), "", "Ambiguous legacy sources do not guess");
assert.equal(handoffWorkflowId("", session, [workflows[0]]), "old", "Single-round legacy histories retain navigation");
console.log("workflow handoff: published/legacy/context parsing, summary fields, role boundary, source-specific navigation, root isolation and deduplication passed");
