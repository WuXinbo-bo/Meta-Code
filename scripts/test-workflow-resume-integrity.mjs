import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowRepository } from "../server/plugins/orchestration/repository.ts";
import { WorkflowStateFiles, calculateWorkflowPlanImpact } from "../server/plugins/orchestration/stateFiles.ts";
import { normalizeWorkflowPlan, DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES } from "../server/plugins/orchestration/plan.ts";
import { captureWorkspaceSnapshot, changedWorkspaceFiles } from "../server/plugins/orchestration/enforcement.ts";
import { buildWorkflowFileIntegrity, workflowCompletedFileIntegrityIssues } from "../server/plugins/orchestration/fileIntegrity.ts";
import { createOrchestrationScheduler } from "../server/plugins/orchestration/scheduler.ts";
import { workspaceExecutionCoordinator } from "../server/runtime/workspaceExecutionCoordinator.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-resume-integrity-"));
const db = new DatabaseSync(":memory:");
const repository = new WorkflowRepository(db);
const stateFiles = new WorkflowStateFiles(path.join(temporary, "runtime"));
const workspaces = new Map();
const activeNodes = new Map();
const calls = [];
const originalReaddir = fs.readdir;
const scheduler = createOrchestrationScheduler({
  workflowRepository: repository, workflowStateFiles: stateFiles, workflowTicks: new Set(),
  workspaceById: (id) => workspaces.get(id), isEnabled: () => true,
  activeWorkflowNodes: activeNodes, activeWorkflowIntegrations: new Map(), activeDelegationTasks: new Map(), workflowNodeIntents: new Map(),
  syncWorkflowProtocolFiles: () => {}, appendWorkflowProtocolEvent: () => {}, workflowEvent: () => {},
  integrateWorkflow: async (id) => { calls.push(`${id}:integration`); repository.updateRun(id, "completed"); },
  currentWorkflowProviderCapabilities: async () => DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES,
  runtimeBindingForProvider: async () => ({ capabilityFingerprint: "fixture" }), WORKFLOW_RUNNER_ID: "fixture",
  skillProjectionManager: { acquireTemporarySkills: () => () => {} }, workspaceTreeIndex: { invalidate: () => {} },
  executeWorkflowNode: async (id, _owner, nodeId) => { calls.push(`${id}:${nodeId}`); return result(); },
  workflowResultDigest: (value) => JSON.stringify(value)
});
function result(outputs = [], changedFiles = []) {
  return { outcome: "completed", humanSummary: "Verified", outputs, changedFiles, checks: [], decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: [], machineResultPath: null };
}
const until = async (predicate) => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for scheduler");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
async function prepare(id, secondWriter = false) {
  const root = path.join(temporary, id);
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "input.txt"), "original input");
  workspaces.set(id, { id, root });
  const created = repository.create({ id, ownerUserId: "owner", workspaceId: id, executionTarget: "workspace", executionRoot: root, workspaceRoot: root, prompt: "Continue existing task", plannerEngine: "codex" });
  repository.setPlanning(id, "owner", created.revision);
  const nodes = [
    { id: "first", title: "First", objective: "Write initial result", provider: "codex", workspaceAccess: "write", writeScope: secondWriter === "directory-delete" ? ["generated"] : ["shared.txt"], deliverables: secondWriter === "directory-delete" ? ["generated"] : ["shared.txt"] },
    ...(secondWriter === "three" ? [{ id: "third", title: "Third", objective: "Finalize result", provider: "codex", workspaceAccess: "write", writeScope: ["shared.txt", "third.txt"], dependsOn: ["second"], deliverables: ["shared.txt", "third.txt"] }] : []),
    ...(secondWriter ? [{ id: "second", title: "Second", objective: "Refine verified output", provider: "codex", workspaceAccess: "write", writeScope: [secondWriter === "directory-delete" ? "generated" : "shared.txt", "second.txt"], dependsOn: ["first"], deliverables: ["second.txt"] }] : []),
    { id: "consumer", title: "Consumer", objective: "Review result", provider: "codex", workspaceAccess: "read", dependsOn: [secondWriter === "three" ? "third" : secondWriter ? "second" : "first"] }
  ];
  const candidate = repository.savePlan(id, "owner", normalizeWorkflowPlan({ title: id, nodes, finalDelivery: { required: false, reason: "Fixture" } }));
  repository.approve(id, "owner", candidate.revision);
  await complete(id, "first", async () => {
    if (secondWriter === "directory-delete") {
      await fs.mkdir(path.join(root, "generated"));
      await fs.writeFile(path.join(root, "generated", "result.txt"), "first result");
    } else await fs.writeFile(path.join(root, "shared.txt"), "first result");
  }, 1, secondWriter === "directory-delete" ? "generated" : null);
  if (secondWriter) await complete(id, "second", async () => {
    if (secondWriter === "directory-delete") await fs.rm(path.join(root, "generated"), { recursive: true });
    else if (secondWriter === "delete") await fs.unlink(path.join(root, "shared.txt"));
    else await fs.writeFile(path.join(root, "shared.txt"), "refined result");
    await fs.writeFile(path.join(root, "second.txt"), "second result");
  }, 2);
  if (secondWriter === "three") await complete(id, "third", async () => {
    await fs.writeFile(path.join(root, "shared.txt"), "final result");
    await fs.writeFile(path.join(root, "third.txt"), "third result");
  }, 3);
  const workflow = repository.get(id, "owner");
  repository.pause(id, "owner", workflow.revision);
  return root;
}
async function complete(id, nodeId, write, sequence, outputDirectory = null) {
  const workflow = repository.get(id, "owner");
  const node = workflow.nodes.find((item) => item.id === nodeId);
  const before = await captureWorkspaceSnapshot(workflow.executionRoot);
  await write();
  const after = await captureWorkspaceSnapshot(workflow.executionRoot);
  const files = changedWorkspaceFiles(before, after);
  const summary = result(files.filter((file) => after.has(file)).map((file, index) => ({ id: `file-${index}`, type: "file", path: file, mediaType: null, description: file, consumableBy: [] })), files);
  if (outputDirectory) summary.outputs = [{ id: "directory", type: "directory", path: outputDirectory, mediaType: null, description: outputDirectory, consumableBy: [] }];
  const checkpoint = path.join(temporary, "runtime", id, nodeId);
  await fs.mkdir(checkpoint, { recursive: true });
  summary.fileIntegrity = buildWorkflowFileIntegrity(workflow, node, summary, before, after, checkpoint);
  summary.fileIntegrity.verifiedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();
  node.status = "completed"; node.summary = summary; node.resultDigest = JSON.stringify(summary); node.finishedAt = summary.fileIntegrity.verifiedAt;
  repository.updateNode(node);
}
async function resume(id) {
  const workflow = repository.get(id, "owner");
  repository.resume(id, "owner", workflow.revision);
  scheduler.queueWorkflowTick(id, "owner");
  await until(() => ["needs_review", "completed"].includes(repository.get(id, "owner").status));
  await until(() => activeNodes.size === 0 && workspaceExecutionCoordinator.snapshot().active.length === 0);
  return repository.get(id, "owner");
}

try {
  const staleInput = await prepare("stale-input");
  await fs.writeFile(path.join(staleInput, "input.txt"), "externally modified");
  const inputRun = await resume("stale-input");
  assert.equal(inputRun.status, "needs_review");
  assert.equal(inputRun.nodes[0].status, "blocked");
  assert.match(inputRun.nodes[0].staleReason, /输入文件已变化/);
  assert.ok(!calls.includes("stale-input:consumer"), "Stale completed inputs must never dispatch a consumer");
  assert.equal(await fs.readFile(path.join(staleInput, "shared.txt"), "utf8"), "first result", "Evidence failure must preserve real project output");

  const deleted = await prepare("deleted-output");
  await fs.unlink(path.join(deleted, "shared.txt"));
  assert.equal((await resume("deleted-output")).status, "needs_review");
  assert.ok(!calls.includes("deleted-output:consumer"));

  const legitimate = await prepare("verified-refinement", true);
  const refined = repository.get("verified-refinement", "owner");
  const refinementIssues = workflowCompletedFileIntegrityIssues(refined, await captureWorkspaceSnapshot(legitimate));
  assert.equal(refinementIssues.size, 0, `Verified downstream changes must not invalidate the predecessor: ${JSON.stringify([...refinementIssues])}`);
  assert.equal((await resume("verified-refinement")).status, "completed");
  assert.ok(calls.includes("verified-refinement:consumer"));
  assert.equal(calls.filter((call) => call === "verified-refinement:first").length, 0, "Valid completed work must stay reused");

  const sameTimeRoot = await prepare("same-time-writers", "three");
  for (const node of repository.get("same-time-writers", "owner").nodes.filter((item) => item.status === "completed")) {
    node.summary.fileIntegrity.verifiedAt = "2026-01-01T00:00:00.001Z";
    node.finishedAt = node.summary.fileIntegrity.verifiedAt;
    repository.updateNode(node);
  }
  assert.equal(workflowCompletedFileIntegrityIssues(repository.get("same-time-writers", "owner"), await captureWorkspaceSnapshot(sameTimeRoot)).size, 0, "Dependency order must resolve tied timestamps even when the static plan array is not topological");
  assert.equal((await resume("same-time-writers")).status, "completed");

  await prepare("maintenance-refinement", true);
  const maintenance = repository.get("maintenance-refinement", "owner");
  assert.deepEqual(calculateWorkflowPlanImpact(maintenance, maintenance.plan).reused, ["first", "second"], "Unchanged maintenance must retain verified refinement");
  const maintenanceCandidate = repository.saveMaintenancePlan(maintenance.id, "owner", maintenance.plan);
  const maintenanceApproved = repository.approve(maintenance.id, "owner", maintenanceCandidate.revision);
  assert.deepEqual(maintenanceApproved.nodes.slice(0, 2).map((node) => node.status), ["completed", "completed"]);

  await prepare("changed-writer-contract", true);
  const contractRun = repository.get("changed-writer-contract", "owner");
  const changedPlan = normalizeWorkflowPlan({ ...contractRun.plan, nodes: contractRun.plan.nodes.map((node) => node.id === "second" ? { ...node, objective: "Replace the old refinement with a new requirement" } : node) });
  assert.deepEqual(calculateWorkflowPlanImpact(contractRun, changedPlan).reused, [], "A changed writer contract cannot authorize reuse of its predecessor's stale output");
  const contractCandidate = repository.saveMaintenancePlan(contractRun.id, "owner", changedPlan);
  assert.deepEqual(repository.approve(contractRun.id, "owner", contractCandidate.revision).nodes.map((node) => node.status), ["pending", "pending", "pending"]);

  const legitimateDeletion = await prepare("verified-deletion", "delete");
  const deletion = repository.get("verified-deletion", "owner");
  assert.equal(workflowCompletedFileIntegrityIssues(deletion, await captureWorkspaceSnapshot(legitimateDeletion)).size, 0, "Only an actual recorded deletion may supersede the previous output");
  assert.equal((await resume("verified-deletion")).status, "completed");

  const directoryDeletion = await prepare("verified-directory-deletion", "directory-delete");
  const directoryRun = repository.get("verified-directory-deletion", "owner");
  assert.equal(directoryRun.nodes[1].summary.fileIntegrity.outputSignatures["missing:generated"], "missing", "Directory deletion needs explicit durable topology evidence");
  assert.equal(workflowCompletedFileIntegrityIssues(directoryRun, await captureWorkspaceSnapshot(directoryDeletion)).size, 0, "Verified directory deletion must also supersede the directory output marker");
  assert.equal((await resume(directoryRun.id)).status, "completed");

  const missingDeletionRecord = await prepare("missing-deletion-record", "delete");
  const deletionRecord = repository.get("missing-deletion-record", "owner");
  delete deletionRecord.nodes[1].summary.fileIntegrity.outputSignatures["missing:shared.txt"];
  repository.updateNode(deletionRecord.nodes[1]);
  assert.ok(workflowCompletedFileIntegrityIssues(repository.get(deletionRecord.id, "owner"), await captureWorkspaceSnapshot(missingDeletionRecord)).has("first"), "Undefined signatures must never authorize a missing file");
  assert.equal((await resume(deletionRecord.id)).status, "needs_review");

  await prepare("missing-history-evidence");
  const historical = repository.get("missing-history-evidence", "owner").nodes[0];
  delete historical.summary.fileIntegrity;
  repository.updateNode(historical);
  const historicalRun = await resume("missing-history-evidence");
  assert.equal(historicalRun.status, "needs_review");
  assert.match(historicalRun.nodes[0].staleReason, /历史结果缺少业务文件版本记录/);
  assert.ok(!calls.includes("missing-history-evidence:consumer"));

  const missingRoot = await prepare("missing-execution-root");
  const detachedRoot = `${missingRoot}-detached`;
  await fs.rename(missingRoot, detachedRoot);
  const unreadableRun = await resume("missing-execution-root");
  assert.equal(unreadableRun.status, "needs_review");
  assert.match(unreadableRun.nodes[0].error, /无法读取业务执行目录/);
  assert.ok(unreadableRun.nodes[0].logs.some((log) => log.title === "恢复前文件证据已过期"));
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(repository.get(unreadableRun.id, "owner").status, "needs_review", "A missing execution root must not cause an infinite scheduler retry loop");
  assert.equal(workspaceExecutionCoordinator.snapshot().active.length, 0);
  assert.ok(!calls.includes("missing-execution-root:consumer"));
  await fs.rename(detachedRoot, missingRoot);
  assert.equal(await fs.readFile(path.join(missingRoot, "shared.txt"), "utf8"), "first result");

  const cancelRoot = await prepare("cancel-during-snapshot");
  let entered;
  let failSnapshot;
  const enteredSnapshot = new Promise((resolve) => { entered = resolve; });
  fs.readdir = async (...args) => {
    if (args[0] !== cancelRoot) return originalReaddir(...args);
    entered();
    return new Promise((_resolve, reject) => { failSnapshot = () => reject(Object.assign(new Error("Fixture inaccessible directory"), { code: "EACCES" })); });
  };
  const cancelPaused = repository.get("cancel-during-snapshot", "owner");
  repository.resume(cancelPaused.id, "owner", cancelPaused.revision);
  scheduler.queueWorkflowTick(cancelPaused.id, "owner");
  await enteredSnapshot;
  const cancelActive = repository.get(cancelPaused.id, "owner");
  repository.cancel(cancelActive.id, "owner", cancelActive.revision);
  failSnapshot();
  await until(() => workspaceExecutionCoordinator.snapshot().active.length === 0);
  fs.readdir = originalReaddir;
  assert.equal(repository.get(cancelActive.id, "owner").status, "canceled", "Snapshot errors cannot overwrite a concurrent user cancellation");
  assert.ok(!calls.includes(`${cancelActive.id}:consumer`));

  const tampered = await prepare("tampered-refinement", true);
  await fs.writeFile(path.join(tampered, "shared.txt"), "external edit after refinement");
  const tamperedRun = await resume("tampered-refinement");
  assert.equal(tamperedRun.status, "needs_review");
  assert.ok(!calls.includes("tampered-refinement:consumer"), "Approved write scopes alone cannot authorize an external edit");
  assert.ok(tamperedRun.nodes.some((node) => node.status === "blocked"));
  assert.equal(await fs.readFile(path.join(tampered, "shared.txt"), "utf8"), "external edit after refinement");

  const restarted = await prepare("restart-invalid-input");
  await fs.writeFile(path.join(restarted, "input.txt"), "changed while server was offline");
  const paused = repository.get("restart-invalid-input", "owner");
  repository.resume(paused.id, "owner", paused.revision);
  repository.recoverAfterRestart();
  scheduler.queueWorkflowTick(paused.id, "owner");
  await until(() => repository.get(paused.id, "owner").status === "needs_review");
  assert.ok(!calls.includes("restart-invalid-input:consumer"), "Restart recovery must also reject stale completed evidence");
  console.log("Workflow resumes reject external input/output changes, preserve files and accept verified downstream refinement");
} finally {
  fs.readdir = originalReaddir;
  scheduler.dispose();
  await until(() => activeNodes.size === 0);
  db.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
