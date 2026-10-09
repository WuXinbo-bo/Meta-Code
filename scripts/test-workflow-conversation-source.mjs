import assert from "node:assert/strict";
import { workflowConversationSource } from "../src/tasks/workflowConversationSource.ts";

const workflow = { createdAt: "2026-10-09T12:00:00.000Z", executionRoot: "/project" };
const handoff = (id, createdAt, executionRoot = "/project", kind = "session") => ({
  source: { kind, id, executionRoot }, sourceRevision: 1, createdAt, goal: id,
  decisions: [], files: [], unresolved: [], attachments: []
});
const context = {
  executions: [{ kind: "session", id: "initial", executionRoot: "/project" }, { kind: "session", id: "latest", executionRoot: "/project" }, { kind: "session", id: "later", executionRoot: "/project" }, { kind: "session", id: "other", executionRoot: "/other" }, { kind: "workflow", id: "workflow", executionRoot: "/project" }],
  handoffs: [handoff("later", "2026-10-09T14:00:00.000Z"), handoff("other", "2026-10-09T11:59:00.000Z", "/other"), handoff("initial", "2026-10-09T10:00:00.000Z"), handoff("latest", workflow.createdAt), handoff("workflow", "2026-10-09T11:59:59.000Z", "/project", "workflow")]
};
assert.equal(workflowConversationSource(context, workflow)?.source.id, "latest", "Select the latest same-root conversation at or before workflow creation, independent of array order");
assert.equal(workflowConversationSource({ ...context, handoffs: [context.handoffs[0]] }, workflow), null, "Later conversation changes are not the source of an existing workflow");
assert.equal(workflowConversationSource({ ...context, handoffs: [context.handoffs[1]] }, workflow), null, "Other execution roots cannot supply the source badge");
assert.equal(workflowConversationSource(context, { executionRoot: "/project" }), null, "Historical workflows without a creation timestamp do not guess their source");
assert.equal(workflowConversationSource(context, { ...workflow, createdAt: "invalid" }), null);
assert.equal(workflowConversationSource(context, { createdAt: workflow.createdAt }), null);
assert.equal(workflowConversationSource({ ...context, handoffs: [handoff("initial", "invalid")] }, workflow), null, "Snapshots without valid capture evidence are hidden");
assert.equal(workflowConversationSource({ ...context, handoffs: [handoff("unknown", "2026-10-09T11:00:00Z")] }, workflow), null, "A trusted task execution link is required");
assert.equal(workflowConversationSource({ ...context, handoffs: [handoff("initial", "2026-10-09T11:00:00Z", "/other")] }, workflow), null, "The handoff's declared root must agree with the execution link");
const legacy = handoff("initial", "2026-10-09T11:00:00Z");
delete legacy.source.executionRoot;
assert.equal(workflowConversationSource({ ...context, handoffs: [legacy] }, workflow)?.source.id, "initial", "Root-less old snapshots can use the trusted task execution link");
assert.equal(workflowConversationSource({ ...context, executions: [{ kind: "session", id: "initial" }], handoffs: [legacy] }, workflow), null, "Missing root evidence never crosses the directory boundary");
const windows = { executions: [{ kind: "session", id: "windows", executionRoot: "C:\\Project" }], handoffs: [handoff("windows", "2026-10-09T11:00:00Z", "c:/project/")] };
assert.equal(workflowConversationSource(windows, { ...workflow, executionRoot: "C:/PROJECT" })?.source.id, "windows");
assert.equal(workflowConversationSource(context, { ...workflow, executionRoot: "/Project" }), null, "POSIX paths preserve case");
assert.equal(workflowConversationSource(null, workflow), null);
console.log("workflow conversation source: creation cutoff, latest valid snapshot, task link evidence, root isolation, Windows case compatibility and historical fallback passed");
