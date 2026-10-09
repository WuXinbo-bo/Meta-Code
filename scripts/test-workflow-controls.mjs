import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { WorkflowRepository } from "../server/plugins/orchestration/repository.ts";
import { WorkflowStateFiles } from "../server/plugins/orchestration/stateFiles.ts";
import { normalizeWorkflowPlan, DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES } from "../server/plugins/orchestration/plan.ts";
import { createOrchestrationScheduler } from "../server/plugins/orchestration/scheduler.ts";
import { registerOrchestrationRoutes } from "../server/plugins/orchestration/controller.ts";
import { WorkflowTargetService } from "../server/plugins/orchestration/targets.ts";
import { workspaceExecutionCoordinator } from "../server/runtime/workspaceExecutionCoordinator.ts";
import { captureWorkspaceSnapshot } from "../server/plugins/orchestration/enforcement.ts";
import { buildWorkflowFileIntegrity } from "../server/plugins/orchestration/fileIntegrity.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-workflow-controls-"));
const project = path.join(temporary, "project");
const runtime = path.join(temporary, "runtime");
await fs.mkdir(project);
await fs.mkdir(runtime);
await fs.writeFile(path.join(project, "existing.txt"), "existing project\n");
const db = new DatabaseSync(":memory:");
const repository = new WorkflowRepository(db);
const stateFiles = new WorkflowStateFiles(path.join(runtime, "runs"));
const workspace = { id: "workspace", root: project, name: "Test project" };
const activeNodes = new Map();
const activePlanners = new Map();
const activeIntegrations = new Map();
const intents = new Map();
const events = [];
const gates = new Map();
const calls = [];
let planRequests = 0;
let questionRequests = 0;
let semanticQuestionGate;
let readinessGate;
const originalReaddir = fs.readdir;
const planNotes = [];
const binding = { capabilityFingerprint: "test-runtime", providerId: "codex" };
const result = { outcome: "completed", humanSummary: "verified result", outputs: [], changedFiles: [], checks: [], decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: [], machineResultPath: null };
const plan = normalizeWorkflowPlan({
  title: "Continuous project task", summary: "Preserve results across safe adjustments",
  audit: { status: "passed", checks: ["dependency-minimality", "critical-path", "concurrency-utilization", "read-write-consistency", "provider-allocation", "final-delivery"].map((key) => ({ key, status: "passed", note: "Verified" })), changes: [] },
  finalDelivery: { required: false, directory: "", primary: null, format: "", additional: [], producerNodeId: null, reason: "Control-only test" },
  nodes: [
    { id: "research", title: "Research", objective: "Read current project", provider: "codex", providerReason: "Inspect repository files", workspaceAccess: "read", acceptance: ["Provide findings"] },
    { id: "implement", title: "Implement", objective: "Implement agreed change", provider: "codex", providerReason: "Implement and verify code", workspaceAccess: "write", writeScope: ["src/**"], dependsOn: ["research"], acceptance: ["Verify change"] }
  ]
});
const changedPlan = normalizeWorkflowPlan({ ...plan, nodes: plan.nodes.map((node) => node.id === "implement" ? { ...node, objective: "Implement the revised change" } : node) });
const active = (id) => activePlanners.has(id) || activeIntegrations.has(id) || [...activeNodes.keys()].some((key) => key.startsWith(`${id}:`));
const until = async (predicate, label) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const emit = (id, type) => events.push({ id, type });
const scheduler = createOrchestrationScheduler({
  workflowTicks: new Set(), workspaceById: () => workspace,
  syncWorkflowProtocolFiles: (id, owner) => repository.get(id, owner),
  appendWorkflowProtocolEvent: () => {}, workflowEvent: emit,
  activeWorkflowNodes: activeNodes, activeWorkflowIntegrations: activeIntegrations, activeDelegationTasks: new Map(),
  integrateWorkflow: async (id) => repository.updateRun(id, "completed", result),
  currentWorkflowProviderCapabilities: async () => DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES,
  runtimeBindingForProvider: async () => binding, WORKFLOW_RUNNER_ID: "test-runner", workflowNodeIntents: intents,
  skillProjectionManager: { acquireTemporarySkills: () => () => {} }, workspaceTreeIndex: { invalidate: () => {} },
  executeWorkflowNode: async (id, _owner, nodeId, controller, attempt) => {
    calls.push(`${id}:${nodeId}`);
    const before = await captureWorkspaceSnapshot(project);
    return new Promise((resolve, reject) => {
      gates.set(`${id}:${nodeId}`, async () => {
        try {
          const workflow = repository.get(id, "owner");
          const node = workflow.nodes.find((item) => item.id === nodeId);
          const summary = structuredClone(result);
          await fs.mkdir(attempt.checkpointDirectory, { recursive: true });
          summary.fileIntegrity = buildWorkflowFileIntegrity(workflow, node, summary, before, await captureWorkspaceSnapshot(project), attempt.checkpointDirectory);
          resolve(summary);
        } catch (error) { reject(error); }
      });
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
  },
  workflowResultDigest: (value) => JSON.stringify(value), workflowRepository: repository, workflowStateFiles: stateFiles, isEnabled: () => true
});
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUser = { id: "owner" }; next(); });
registerOrchestrationRoutes(app, {
  acquireRequest: () => () => {}, workspaceTreeIndex: { invalidate: () => {} }, workflowRepository: repository,
  workspaceById: () => workspace, agentAdapterRegistry: { descriptor: () => ({ capabilities: { workflow: { planner: true } } }), workflowPlannerRunner: () => ({}) },
  providerReadiness: async () => {
    if (readinessGate) {
      const gate = readinessGate;
      gate.calls += 1;
      if (gate.calls === 2) { gate.waiting = true; await gate.promise; }
    }
    return { ready: true, issues: [] };
  }, uid: () => "created-default", workflowStateFiles: stateFiles, workflowEvent: emit,
  workflowRuntimeActive: active, activeWorkflowPlanners: activePlanners, activeWorkflowNodes: activeNodes, workflowNodeIntents: intents,
  activeWorkflowIntegrations: activeIntegrations,
  waitForWorkflowRuntimeRelease: async (id) => until(() => !active(id), "runtime checkpoint"),
  openInSystemFileManager: async () => {}, assertExistingDirectory: (value) => value, workflowResultPath: () => ({ absolute: project, relative: "." }),
  runtimeBindingForProvider: async () => binding, workspaceAgentConfig: () => ({ skillPolicies: {} }), managedSkillManager: { listPublic: () => [] },
  mcpServersForWorkspace: () => [], currentWorkflowProviderCapabilities: async () => DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES,
  WORKFLOW_PLANNER_TRANSACTION_DIR: path.join(runtime, "transactions"), workflowPlannerRequestKey: () => "test-request",
  requestWorkflowPlan: async (workflow) => { planRequests += 1; planNotes.push(workflow.reviewNote); return { plan: changedPlan, engineSessionId: null, noChange: false, note: "Only the implementation changes", finalText: "Research remains applicable" }; },
  plannerSkillContext: () => "", workflowPlannerFailureMessage: (error) => String(error), retryableWorkflowPlannerFailure: () => false,
  activeWorkflowPlannerRuns: new Map(), assertWorkflowExecutionReady: async () => {}, queueWorkflowTick: scheduler.queueWorkflowTick,
  workflowTargetService: new WorkflowTargetService(runtime)
  ,answerWorkflowQuestion: async (snapshot, question, _provider, signal) => {
    questionRequests += 1;
    if (semanticQuestionGate) await semanticQuestionGate(signal);
    return `Snapshot ${snapshot.revision}: ${question}; the implementation depends on the research findings.`;
  }
});
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const post = async (endpoint, body) => {
  const response = await fetch(`${baseUrl}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  assert.ok(response.ok, `${endpoint}: ${JSON.stringify(data)}`);
  return data;
};
const createApproved = (id) => {
  const workflow = repository.create({ id, ownerUserId: "owner", workspaceId: workspace.id, executionTarget: "workspace", workspaceRoot: project, executionRoot: project, prompt: "Maintain existing project", plannerEngine: "codex" });
  repository.setPlanning(id, "owner", workflow.revision);
  const candidate = repository.savePlan(id, "owner", plan);
  return repository.approve(id, "owner", candidate.revision);
};

try {
  const before = await fs.readdir(project);
  const created = await post("/api/workflows", { workspaceId: workspace.id, prompt: "A project task", plannerEngine: "codex" });
  assert.equal(created.executionTarget, "workspace");
  assert.equal(created.executionRoot, await fs.realpath(project));
  assert.deepEqual(await fs.readdir(project), before, "Creating an orchestration must not add a business or protocol folder to the project");

  createApproved("adjust");
  scheduler.queueWorkflowTick("adjust", "owner");
  await until(() => gates.has("adjust:research"), "first node starts");
  const response = await post("/api/workflows/adjust/plan", { source: "maintenance", mode: "refine", intent: "adjust", note: "Revise implementation only" });
  assert.equal(response.queuedUntilCheckpoint, true);
  assert.equal(response.workflow.pauseMode, "checkpoint");
  assert.equal(activeNodes.get("adjust:research").signal.aborted, false, "Safe adjustments must let the active node finish");
  assert.equal(planRequests, 0);
  gates.get("adjust:research")();
  await until(() => repository.get("adjust", "owner").status === "awaiting_approval", "new candidate approval").catch((error) => { throw new Error(`${error.message}: ${JSON.stringify(repository.get("adjust", "owner"))}`); });
  assert.equal(repository.get("adjust", "owner").activePlanVersion, 2);
  assert.equal(calls.includes("adjust:implement"), false, "The previous graph must not dispatch another node after a change request");
  assert.equal(repository.get("adjust", "owner").plan.nodes[1].objective, "Implement the revised change");

  createApproved("question");
  scheduler.queueWorkflowTick("question", "owner");
  await until(() => gates.has("question:research"), "question first node");
  const planningBeforeQuestion = planRequests;
  const query = await post("/api/workflows/question/plan", { source: "maintenance", mode: "refine", intent: "question", note: "What remains?" });
  assert.equal(query.queriedSnapshot, true);
  assert.equal(query.workflow.status, "running", "Status queries must not pause running work");
  assert.equal(query.workflow.pendingMaintenance, null);
  assert.equal(questionRequests, 0, "Simple progress questions need no model");
  assert.equal(planRequests, planningBeforeQuestion, "Questions must not enter planner transactions");
  const semantic = await post("/api/workflows/question/plan", { source: "maintenance", mode: "refine", intent: "question", note: "Why does implementation depend on research?" });
  assert.match(semantic.queryAnswer, /depends on the research/);
  assert.equal(questionRequests, 1, "Semantic questions must reach a real answerer");
  assert.equal(semantic.workflow.status, "running");
  let waitingForQuestion = false;
  semanticQuestionGate = (signal) => new Promise((_resolve, reject) => { waitingForQuestion = true; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  const pendingQuestion = fetch(`${baseUrl}/api/workflows/question/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "maintenance", intent: "question", note: "Explain the implementation constraints" }) });
  await until(() => waitingForQuestion, "semantic question starts");
  await post("/api/workflows/question/question/cancel", {});
  assert.equal((await pendingQuestion).status, 409, "Canceling a question cancels only that request");
  assert.equal(repository.get("question", "owner").status, "running");
  semanticQuestionGate = undefined;
  gates.get("question:research")();
  await until(() => gates.has("question:implement"), "question resumes unchanged plan");
  const questioned = repository.get("question", "owner");
  assert.equal(questioned.activePlanVersion, 1, "Questions must never install a proposed changed graph");
  assert.equal(questioned.plan.nodes[1].objective, "Implement agreed change");
  gates.get("question:implement")();
  await until(() => repository.get("question", "owner").status === "completed", "question run completes");
  await until(() => workspaceExecutionCoordinator.snapshot().active.length === 0, "workspace execution releases");
  createApproved("pause");
  scheduler.queueWorkflowTick("pause", "owner");
  await until(() => gates.has("pause:research"), "pause node starts");
  const paused = await post("/api/workflows/pause/pause", {});
  assert.equal(paused.pauseMode, "checkpoint");
  assert.equal(activeNodes.get("pause:research").signal.aborted, false);
  gates.get("pause:research")();
  await until(() => !active("pause"), "checkpoint pause drains");
  assert.equal(repository.get("pause", "owner").nodes[0].status, "completed");
  assert.equal(calls.includes("pause:implement"), false);
  await post("/api/workflows/pause/resume", {});
  await until(() => gates.has("pause:implement"), "checkpoint resume retains completed node");
  assert.equal(calls.filter((call) => call === "pause:research").length, 1);
  await post("/api/workflows/pause/pause", { mode: "immediate" });
  await until(() => !active("pause"), "immediate pause aborts");
  assert.equal(repository.get("pause", "owner").nodes[1].status, "paused");

  const lease = await workspaceExecutionCoordinator.acquire({ root: project, ownerId: "session:external", label: "Ordinary chat", access: "write" });
  createApproved("locked");
  scheduler.queueWorkflowTick("locked", "owner");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.some((call) => call.startsWith("locked:")), false, "Workflow must wait for a normal conversation writer");
  lease.release();
  await until(() => gates.has("locked:research"), "workspace lock opens");
  await post("/api/workflows/locked/plan", { source: "maintenance", mode: "refine", intent: "adjust", note: "Queued change" });
  const forcedPause = await post("/api/workflows/locked/pause", { mode: "immediate" });
  assert.equal(forcedPause.pendingMaintenance, null, "An explicit immediate pause must cancel a queued change request");
  await until(() => !active("locked"), "forced pause releases runtime");
  assert.equal(repository.get("locked", "owner").pauseMode, "immediate");
  for (const action of ["pause", "cancel", "replace"]) {
    const id = `readiness-${action}`;
    createApproved(id);
    scheduler.queueWorkflowTick(id, "owner");
    await until(() => gates.has(`${id}:research`), `${action} node starts`);
    let release;
    readinessGate = { calls: 0, waiting: false, promise: new Promise((resolve) => { release = resolve; }) };
    const initialRequests = planRequests;
    await post(`/api/workflows/${id}/plan`, { source: "maintenance", mode: "refine", intent: "adjust", note: "Obsolete adjustment" });
    gates.get(`${id}:research`)();
    await until(() => readinessGate.waiting, `${action} readiness waits`);
    if (action === "cancel") await post(`/api/workflows/${id}/cancel`, {});
    else {
      await post(`/api/workflows/${id}/pause`, { mode: "immediate" });
      if (action === "replace") await post(`/api/workflows/${id}/plan`, { source: "maintenance", mode: "refine", intent: "adjust", note: "Replacement adjustment" });
    }
    release();
    if (action === "replace") {
      await until(() => repository.get(id, "owner").status === "awaiting_approval", "replacement reaches approval");
      assert.equal(planRequests, initialRequests + 1);
      assert.equal(planNotes.at(-1), "Replacement adjustment");
    } else {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(planRequests, initialRequests, "Stopped requests cannot start after readiness resolves");
      assert.equal(repository.get(id, "owner").status, action === "cancel" ? "canceled" : "paused");
      assert.equal(repository.get(id, "owner").pendingMaintenance, null);
    }
    readinessGate = undefined;
  }
  for (const action of ["cancel", "pause"]) {
    const id = `maintenance-impact-${action}`;
    const created = createApproved(id);
    repository.pause(id, "owner", created.revision);
    let entered;
    let release;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    fs.readdir = async (...args) => {
      if (args[0] === project) { entered(); await gate; }
      return originalReaddir(...args);
    };
    await post(`/api/workflows/${id}/plan`, { source: "maintenance", mode: "refine", intent: "adjust", note: "Change while impact is being scanned" });
    await waiting;
    assert.equal(repository.get(id, "owner").activePlanVersion, 1, "Impact computation must finish before publishing a candidate plan");
    await post(`/api/workflows/${id}/${action}`, action === "pause" ? { mode: "immediate" } : {});
    release();
    fs.readdir = originalReaddir;
    await until(() => !activePlanners.has(id), "canceled impact scan releases planner");
    const stopped = repository.get(id, "owner");
    assert.equal(stopped.activePlanVersion, 1, "A stopped maintenance scan cannot publish a new plan version");
    assert.equal(stopped.status, action === "cancel" ? "canceled" : "paused");
    assert.ok(!events.some((event) => event.id === id && event.type === "workflow.plan.ready"), "Canceled candidates cannot emit a ready event");
  }
  createApproved("restart");
  const restartRun = repository.get("restart", "owner");
  repository.requestMaintenance("restart", "owner", restartRun.revision, { note: "Persisted change", intent: "adjust", plannerEngine: "claude", requestedAt: new Date().toISOString(), resumeAfter: true });
  repository.recoverAfterRestart();
  assert.equal(repository.get("restart", "owner").pendingMaintenance.note, "Persisted change");
  assert.equal(repository.get("restart", "owner").status, "paused");
  console.log("Workflow checkpoint, question, approval and execution-root checks passed");
} finally {
  fs.readdir = originalReaddir;
  for (const release of gates.values()) release();
  await until(() => activeNodes.size === 0, "test cleanup nodes").catch(() => undefined);
  scheduler.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await new Promise((resolve) => server.close(resolve));
  db.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
