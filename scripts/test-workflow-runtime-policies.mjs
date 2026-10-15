import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createOrchestrationRuntime } from "../server/plugins/orchestration/runtime.ts";
import { WorkflowRepository } from "../server/plugins/orchestration/repository.ts";
import { WorkflowStateFiles } from "../server/plugins/orchestration/stateFiles.ts";
import { normalizeWorkflowPlan, workflowNodeContractDigest } from "../server/plugins/orchestration/plan.ts";
import { workflowValidationPolicy } from "../server/plugins/orchestration/validationPolicy.ts";
import { workflowNodeInputs } from "../server/plugins/orchestration/contextProjection.ts";
import { workflowQuestionSnapshot, isWorkflowStatusQuestion } from "../server/plugins/orchestration/questions.ts";
import { beginWorkflowRecoveryGuard, recordWorkflowRecoveryEffect, workflowRecoveryReplayIssue } from "../server/plugins/orchestration/recoveryGuard.ts";
import { buildClaudeSessionArgs } from "../server/engines/claude/session.ts";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-runtime-policies-"));
const project = path.join(directory, "project");
await fs.mkdir(project);
await fs.writeFile(path.join(project, "output.js"), "export const result = 42;\n");
const db = new DatabaseSync(":memory:");
const repository = new WorkflowRepository(db);
const stateFiles = new WorkflowStateFiles(path.join(directory, "runs"));
const command = "node test.mjs";
const checks = [{ name: command, command, status: "passed", exitCode: 0, evidence: "verified" }];
const result = {
  outcome: "completed", humanSummary: "Output matches the approved test", outputs: [{ id: "output", type: "code", path: "output.js", mediaType: null, description: "implementation", consumableBy: [] }],
  changedFiles: ["output.js"], checks, decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: [], machineResultPath: null,
  fileIntegrity: { schemaVersion: 1, executionRoot: project, inputSnapshotPath: "", excludedInputPaths: [], includedInputPaths: [], outputPaths: ["output.js"], outputSignatures: {} }
};
let modelCalls = 0;
let questionToolAttempt = false;
let claudeOptions;
const runtime = createOrchestrationRuntime({
  workflowRepository: repository, workspaceById: () => ({ id: "project", root: project }), workflowStateFiles: stateFiles,
  eventHub: { publish() {} }, activeWorkflowIntegrations: new Map(), workspaceTreeIndex: { invalidate() {} }, runtimeDirectory: path.join(directory, "runtime"),
  runtimeBindingForProvider: async () => ({ capabilityFingerprint: "fixture" }), getState: () => ({ settings: { apiKey: "fixture", model: "configured-model", reasoningEffort: "high" } }), threadOptions: () => ({}),
  buildCodex: () => ({ startThread: () => ({ runStreamed: async () => {
    modelCalls += 1;
    return { events: (async function* () { yield { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }; yield { type: "turn.completed", usage: {} }; })() };
  } }) }),
  buildSnapshotQuestionCodex: (cwd) => ({ startThread: (options) => {
    assert.equal(options.workingDirectory, cwd); assert.notEqual(cwd, project); assert.equal(options.networkAccessEnabled, false); assert.equal(options.webSearchMode, "disabled");
    assert.equal(options.model, "configured-model"); assert.equal(options.modelReasoningEffort, "high");
    return { runStreamed: async (prompt) => {
      assert.match(prompt, /任务快照/);
      return { events: (async function* () {
        if (questionToolAttempt) yield { type: "item.started", item: { type: "tool_call", name: "request_user_input" } };
        yield { type: "item.completed", item: { type: "agent_message", text: "Based on the recorded acceptance, the implementation is test-backed." } };
        yield { type: "turn.completed", usage: {} };
      })() };
    } };
  } }),
  createWorkflowClaudeHandle: async (options) => {
    claudeOptions = options;
    assert.deepEqual(options.tools, []);
    assert.equal(options.snapshotOnly, true);
    assert.notEqual(options.cwd, project);
    assert.deepEqual(JSON.parse(await fs.readFile(options.mcpConfigPath, "utf8")), { mcpServers: {} });
    return { currentSessionId: "question", closed: false, send() {}, close() {}, nextTurn: async () => { await options.onEvent({ type: "assistant", text: "The recorded checks support the result." }); return { sessionId: "question", failed: false, usage: {} }; } };
  }
});

async function create(id, mode, { evidence = true, semantic = false } = {}) {
  const run = repository.create({ id, ownerUserId: "owner", workspaceId: "project", executionTarget: "workspace", executionRoot: project, workspaceRoot: project, prompt: "Create a test-backed output", plannerEngine: "codex" });
  repository.setPlanning(id, "owner", run.revision);
  const plan = normalizeWorkflowPlan({ validationMode: mode, title: "Test-backed output", nodes: [{ id: "build", title: "Build output", objective: "Create output", provider: "codex", workspaceAccess: "write", writeScope: ["output.js"], acceptance: [command], verificationCommands: [command], deliverables: ["output.js"] }], finalDelivery: { required: false, reason: "Test" } });
  const candidate = repository.savePlan(id, "owner", plan);
  const approved = repository.approve(id, "owner", candidate.revision);
  const node = approved.nodes[0];
  const attempt = repository.claimNodeAttempt(node.recordId, "runner", path.join(directory, id), new Date(Date.now() + 60_000).toISOString());
  await fs.mkdir(attempt.checkpointDirectory, { recursive: true });
  node.status = "completed"; node.attempt = attempt.attempt; node.summary = structuredClone(result);
  if (semantic) node.summary.outputs = [{ ...node.summary.outputs[0], type: "text", path: null }];
  node.resultDigest = runtime.workflowResultDigest(node.summary);
  repository.updateNode(node);
  repository.checkpointNodeAttempt(attempt.id, { phase: "completed", status: "completed" });
  if (evidence) await fs.writeFile(path.join(attempt.checkpointDirectory, "host-command-evidence.json"), JSON.stringify({ workflowId: id, nodeRecordId: node.recordId, attemptId: attempt.id, contractDigest: workflowNodeContractDigest(node), checks }));
  stateFiles.syncResults(repository.get(id, "owner"));
  return repository.get(id, "owner");
}

try {
  for (const [mode, expected] of [["strict", 2], ["standard", 1], ["deterministic", 0]]) {
    const before = modelCalls;
    await create(mode, mode);
    await runtime.integrateWorkflow(mode, "owner");
    assert.equal(repository.get(mode, "owner").status, "completed");
    assert.equal(modelCalls - before, expected, `${mode} must use only its approved model stages`);
  }
  const fallback = await create("missing-host-evidence", "deterministic", { evidence: false });
  assert.equal(workflowValidationPolicy(fallback, new Map()).effective, "single-node-review", "Agent-authored passed checks cannot replace host evidence");
  const beforeFallback = modelCalls;
  await runtime.integrateWorkflow(fallback.id, "owner");
  assert.equal(modelCalls - beforeFallback, 1);
  const semantic = await create("semantic", "deterministic", { semantic: true });
  assert.equal(workflowValidationPolicy(semantic, new Map([["build", checks]])).effective, "single-node-review", "Research retains semantic review");
  const constrained = structuredClone(semantic); constrained.nodes[0].summary = structuredClone(result); constrained.nodes[0].constraints = ["Preserve accessibility"];
  assert.equal(workflowValidationPolicy(constrained, new Map([["build", checks]])).effective, "single-node-review");
  const implicit = structuredClone(constrained); delete implicit.plan.validationMode;
  assert.equal(workflowValidationPolicy(implicit, new Map()).effective, "strict", "Old plans preserve their approved review boundary");

  const snapshot = workflowQuestionSnapshot(fallback);
  for (const question of [
    "What remains?",
    "现在做到哪一步了？请报告已完成、运行中和等待的节点。",
    "当前进度如何？请列出已完成的节点、运行中的节点以及等待的节点。",
    "What is the current status? Please list completed, running, and waiting nodes.",
    "请显示失败和阻塞的任务状态。"
  ]) assert.equal(isWorkflowStatusQuestion(question), true, `Pure status request: ${question}`);
  for (const question of [
    "为什么这个设计不支持多用户？",
    "现在做到哪一步了？请分析为什么运行很慢。",
    "请报告已完成、运行中和等待的节点，并建议如何优化。",
    "目前状态如何？停止运行中的节点。",
    "What remains? Change the waiting nodes to Claude.",
    "List running nodes and explain their design tradeoffs.",
    ""
  ]) assert.equal(isWorkflowStatusQuestion(question), false, `Semantic or mixed request: ${question}`);
  assert.match(await runtime.answerWorkflowQuestion(snapshot, "How do the checks support the result?", "codex", new AbortController().signal), /test-backed/);
  assert.match(await runtime.answerWorkflowQuestion(snapshot, "Explain the checks", "claude", new AbortController().signal), /recorded checks/);
  assert.equal(await fs.stat(claudeOptions.cwd).catch(() => null), null, "Question runtime must be cleaned up");
  questionToolAttempt = true;
  await assert.rejects(() => runtime.answerWorkflowQuestion(snapshot, "Explain", "codex", new AbortController().signal), /不能执行工具/);
  const args = buildClaudeSessionArgs({ permissionMode: "default", tools: [], snapshotOnly: true }, "query");
  assert.equal(args[args.indexOf("--tools") + 1], "", "Empty allowedTools is not sufficient: explicit native tools must be disabled");
  assert.ok(args.includes("--safe-mode")); assert.ok(args.includes("--disable-slash-commands"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");

  const ancestor = { ...fallback.nodes[0], id: "ancestor", constraints: ["Never change schemaVersion=2"], acceptance: ["Keep all fields"], dependsOn: [] };
  const parent = { ...fallback.nodes[0], id: "parent", dependsOn: ["ancestor"] };
  const leaf = { ...fallback.nodes[0], id: "leaf", dependsOn: ["parent"] };
  const inputs = workflowNodeInputs({ ...fallback, nodes: [ancestor, parent, leaf] }, leaf, new Map([["parent", result], ["ancestor", result]]));
  assert.deepEqual(inputs.dependencies.map((item) => item.nodeId), ["parent"]);
  assert.deepEqual(inputs.ancestorContracts[0].constraints, ancestor.constraints);
  assert.deepEqual(inputs.ancestorContracts[0].acceptance, ancestor.acceptance);
  assert.equal(inputs.ancestorContracts[0].objective, ancestor.objective, "Ancestor business goals remain authoritative");
  assert.deepEqual(inputs.ancestorContracts[0].deliverables, ancestor.deliverables, "Deliverables may contain approved schema clauses and cannot be pruned");
  assert.equal("machineResultPath" in inputs.dependencies[0], false, "Internal protocol paths are not business context");

  const guard = path.join(directory, "guard.json");
  const progress = { snapshotDigest: "same", resultDraft: {} };
  for (let i = 0; i < 3; i++) beginWorkflowRecoveryGuard(guard, progress);
  assert.throws(() => beginWorkflowRecoveryGuard(guard, progress), /无进展/);
  beginWorkflowRecoveryGuard(guard, { ...progress, snapshotDigest: "changed" });
  recordWorkflowRecoveryEffect(guard, { type: "tool.started", sourceId: "read", toolName: "Read", text: "" });
  recordWorkflowRecoveryEffect(guard, { type: "tool.started", sourceId: "control", toolName: "workflow_submit_result", text: "" });
  assert.equal(workflowRecoveryReplayIssue(guard), null);
  recordWorkflowRecoveryEffect(guard, { type: "tool.started", sourceId: "publish", toolName: "Bash", text: "", payload: { input: { command: "npm publish --token secret-value" } } });
  assert.match(workflowRecoveryReplayIssue(guard), /未确认结束/);
  recordWorkflowRecoveryEffect(guard, { type: "tool.completed", sourceId: "publish", toolName: "Bash", text: "" });
  assert.match(workflowRecoveryReplayIssue(guard), /已调用命令/);
  assert.ok(!(await fs.readFile(guard, "utf8")).includes("secret-value"));
  assert.throws(() => beginWorkflowRecoveryGuard(guard, { ...progress, snapshotDigest: "changed-again" }), /自动重放已停止/);
  await fs.writeFile(guard, "invalid-json");
  assert.match(workflowRecoveryReplayIssue(guard), /记录损坏/);
  console.log("Workflow validation tiers, semantic snapshot questions, context projection and recovery guards passed");
} finally { db.close(); await fs.rm(directory, { recursive: true, force: true }); }
