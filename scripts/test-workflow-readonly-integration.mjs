import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createOrchestrationRuntime } from "../server/plugins/orchestration/runtime.ts";
import { WorkflowRepository } from "../server/plugins/orchestration/repository.ts";
import { WorkflowStateFiles } from "../server/plugins/orchestration/stateFiles.ts";
import { normalizeWorkflowPlan } from "../server/plugins/orchestration/plan.ts";
import { workspaceExecutionCoordinator } from "../server/runtime/workspaceExecutionCoordinator.ts";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-readonly-integration-"));
const project = path.join(directory, "project");
await fs.mkdir(project);
const db = new DatabaseSync(":memory:");
const repository = new WorkflowRepository(db);
const active = new Map();
const schedulerLeases = [];
const stateFiles = new WorkflowStateFiles(path.join(directory, "runtime"));
const result = { outcome: "completed", humanSummary: "Verified research", outputs: [], changedFiles: [], checks: [], decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: [], machineResultPath: null };
const workspace = { id: "project", root: project };
const plan = normalizeWorkflowPlan({ title: "Research", nodes: [{ id: "research", title: "Research", objective: "Read existing project", provider: "codex", workspaceAccess: "read", acceptance: ["Findings delivered"] }], finalDelivery: { required: false, reason: "Text research" } });
const create = (id) => {
  const workflow = repository.create({ id, ownerUserId: "owner", workspaceId: workspace.id, executionTarget: "workspace", executionRoot: project, workspaceRoot: project, prompt: "Research the project", plannerEngine: "codex" });
  repository.setPlanning(id, "owner", workflow.revision);
  const candidate = repository.savePlan(id, "owner", plan);
  const approved = repository.approve(id, "owner", candidate.revision);
  const node = approved.nodes[0];
  node.status = "completed"; node.summary = result; node.resultDigest = runtime.workflowResultDigest(result);
  repository.updateNode(node);
  stateFiles.syncResults(repository.get(id, "owner"));
  return id;
};
let integratorsStarted = 0;
let releaseIntegrators;
const bothStarted = new Promise((resolve) => { releaseIntegrators = resolve; });
const runtime = createOrchestrationRuntime({
  workflowRepository: repository, workspaceById: () => workspace,
  workflowStateFiles: stateFiles,
  eventHub: { publish() {} }, activeWorkflowIntegrations: active,
  workspaceTreeIndex: { invalidate() {} },
  runtimeBindingForProvider: async () => ({ capabilityFingerprint: "fixture" }),
  getState: () => ({ settings: { apiKey: "fixture" } }),
  threadOptions: () => ({}),
  buildCodex: () => ({ startThread: (options) => {
    assert.equal(options.sandboxMode, "read-only");
    return { runStreamed: async (prompt) => {
      if (prompt.includes("最终 Integrator Agent")) {
        integratorsStarted += 1;
        if (integratorsStarted === 2) releaseIntegrators();
        await bothStarted;
      }
      return { events: (async function* () {
        yield { type: "item.completed", item: { id: "reply", type: "agent_message", text: JSON.stringify(result) } };
        yield { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } };
      })() };
    } };
  } })
});
let timeout;
let runs;
try {
  for (const id of [create("reader-a"), create("reader-b")]) {
    schedulerLeases.push(await workspaceExecutionCoordinator.acquire({ root: project, ownerId: `workflow:${id}`, label: id, access: "read" }));
  }
  runs = Promise.all([runtime.integrateWorkflow("reader-a", "owner"), runtime.integrateWorkflow("reader-b", "owner")]);
  await Promise.race([runs, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Concurrent read-only integration deadlocked")), 3_000); })]);
  const readerA = repository.get("reader-a", "owner");
  assert.equal(readerA.status, "completed", JSON.stringify(readerA.finalResult));
  assert.equal(integratorsStarted, 2);
  assert.equal(repository.get("reader-b", "owner").status, "completed");
  assert.equal(active.size, 0);
  assert.equal(workspaceExecutionCoordinator.snapshot().waiting.length, 0);
  assert.deepEqual(await fs.readdir(project), [], "Final integration must not create business directories");
  console.log("Concurrent read-only workflows integrate without lease upgrades or deadlock");
} finally {
  clearTimeout(timeout);
  releaseIntegrators();
  for (const controller of active.values()) controller.abort(new Error("Test cleanup"));
  for (const lease of schedulerLeases) lease.release();
  await runs?.catch(() => undefined);
  db.close();
  await fs.rm(directory, { recursive: true, force: true });
}
