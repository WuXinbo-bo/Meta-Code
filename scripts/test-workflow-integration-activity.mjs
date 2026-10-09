import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createOrchestrationRuntime } from "../server/plugins/orchestration/runtime.ts";
import { WorkflowRepository } from "../server/plugins/orchestration/repository.ts";
import { WorkflowStateFiles } from "../server/plugins/orchestration/stateFiles.ts";
import { normalizeWorkflowPlan } from "../server/plugins/orchestration/plan.ts";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-integration-activity-"));
const workspace = { id: "workspace", root: path.join(directory, "project") };
await fs.mkdir(workspace.root);
const db = new DatabaseSync(":memory:");
const repository = new WorkflowRepository(db);
const stateFiles = new WorkflowStateFiles(path.join(directory, "runs"));
const active = new Map();
const result = { outcome: "completed", humanSummary: "Reviewed real source", outputs: [], changedFiles: [], checks: [], decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: [], machineResultPath: null };
let currentId;
let activityWrites = 0;
let turnCount = 0;
let hydrationCalls = 0;
const get = repository.get.bind(repository);
repository.get = (...args) => { hydrationCalls += 1; return get(...args); };
const append = repository.appendIntegrationLogs.bind(repository);
repository.appendIntegrationLogs = (id, logs) => {
  if (logs.some((log) => /^(?:Integrator|Validator) · /.test(log.title))) activityWrites += 1;
  return append(id, logs);
};
const runtime = createOrchestrationRuntime({
  workflowRepository: repository, workspaceById: () => workspace, workflowStateFiles: stateFiles,
  eventHub: { publish() {} }, activeWorkflowIntegrations: active, workspaceTreeIndex: { invalidate() {} },
  runtimeBindingForProvider: async () => ({ capabilityFingerprint: "fixture" }),
  runtimeDirectory: path.join(directory, "runtime"),
  CLAUDE_WORKFLOW_READ_TOOLS: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
  CLAUDE_WORKFLOW_READ_ONLY_DISALLOWED_TOOLS: ["Write", "Edit", "NotebookEdit", "Bash"],
  createWorkflowClaudeHandle: async (options) => ({
    currentSessionId: "fixture-claude", closed: false, send() {}, close() {},
    nextTurn: async () => {
      turnCount += 1;
      const beforeWrites = activityWrites;
      const beforeHydration = hydrationCalls;
      for (let index = 0; index < 50; index++) await options.onEvent({ type: "assistant", sourceId: "stream", text: "Repeated chunk" });
      for (let index = 0; index < 20; index++) await options.onEvent({ type: "assistant", sourceId: "stream", text: `Growing chunk ${index}` });
      assert.equal(activityWrites, beforeWrites, "Streaming chunks do not synchronously write logs");
      assert.equal(hydrationCalls, beforeHydration, "Streaming callbacks never hydrate workflow results");
      if (currentId === "complete") {
        await new Promise((resolve) => setTimeout(resolve, 275));
        assert.equal(activityWrites, beforeWrites + 1, "Seventy chunks coalesce into one bounded activity write");
        for (let index = 0; index < 20; index++) await options.onEvent({ type: "assistant", sourceId: "stream", text: "Growing chunk 19" });
        await new Promise((resolve) => setTimeout(resolve, 275));
        assert.equal(activityWrites, beforeWrites + 1, "Duplicate chunks do not schedule extra writes");
        await options.onEvent({ type: "tool.completed", sourceId: "read", toolName: "Read", text: "Source reviewed" });
        assert.equal(activityWrites, beforeWrites + 2, "Completed tools remain immediately durable");
        await options.onEvent({ type: "assistant", sourceId: "final", text: JSON.stringify(result) });
        await options.onEvent({ type: "turn.completed", text: "Stage completed" });
        assert.equal(activityWrites, beforeWrites + 3, "Terminal event flushes pending final text immediately");
        return { sessionId: "fixture-claude", failed: false, usage: {} };
      }
      const workflow = get(currentId, "owner");
      if (currentId === "pause") repository.pause(currentId, "owner", workflow.revision);
      else repository.cancel(currentId, "owner", workflow.revision);
      const controller = active.get(currentId);
      controller.abort(new Error("User stopped integration"));
      throw controller.signal.reason;
    }
  })
});

function create(id) {
  const workflow = repository.create({ id, ownerUserId: "owner", workspaceId: workspace.id, executionTarget: "workspace", executionRoot: workspace.root, workspaceRoot: workspace.root, prompt: "Review existing source", plannerEngine: "claude" });
  repository.setPlanning(id, "owner", workflow.revision);
  const candidate = repository.savePlan(id, "owner", normalizeWorkflowPlan({ title: id, validationMode: "strict", finalDelivery: { required: false, reason: "Text review" }, nodes: [{ id: "review", title: "Review", objective: "Review source", provider: "claude", workspaceAccess: "read", acceptance: ["Findings delivered"] }] }));
  const approved = repository.approve(id, "owner", candidate.revision);
  const node = approved.nodes[0];
  node.status = "completed"; node.summary = result; node.resultDigest = runtime.workflowResultDigest(result);
  repository.updateNode(node);
  stateFiles.syncResults(get(id, "owner"));
}

try {
  for (const id of ["complete", "pause", "cancel"]) {
    currentId = id; turnCount = 0;
    create(id);
    const beforeWrites = activityWrites;
    await runtime.integrateWorkflow(id, "owner");
    const workflow = get(id, "owner");
    if (id === "complete") {
      assert.equal(workflow.status, "completed");
      assert.equal(turnCount, 2, "Both independent integration stages still execute");
      assert.equal(activityWrites - beforeWrites, 6);
    } else {
      assert.equal(workflow.status, id === "pause" ? "paused" : "canceled", "Log flush never overwrites user control state");
      assert.equal(turnCount, 1, "Stopping integration cannot start the next stage");
      assert.equal(activityWrites - beforeWrites, 1, "Stopping flushes pending live text once");
    }
    assert.equal(active.size, 0);
    const retainedWrites = activityWrites;
    await new Promise((resolve) => setTimeout(resolve, 275));
    assert.equal(activityWrites, retainedWrites, "No delayed timer survives integration exit");
  }
  console.log("Integration activity: bounded streaming writes, duplicate suppression, immediate terminal logs and pause/cancel preservation passed");
} finally {
  db.close();
  await fs.rm(directory, { recursive: true, force: true });
}
