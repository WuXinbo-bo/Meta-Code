import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkflowRepository } from "../server/plugins/orchestration/repository.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createWorkflowNodeResultTransaction,
  readWorkflowNodeResultTransaction,
  recordWorkflowNodeHostVerification,
  submitWorkflowNodeResult,
  workflowNodeResultReceipt
} from "../server/plugins/orchestration/nodeResultTransactions.ts";
import { normalizeWorkflowPlan, validateWorkflowPlan, planSystemPrompt, workflowNodeContractDigest } from "../server/plugins/orchestration/plan.ts";
import { applyWorkflowPlanOperations, createWorkflowPlanTransaction, readWorkflowPlanTransaction, replaceWorkflowPlanDraft, submitWorkflowPlan } from "../server/plugins/orchestration/plannerTransactions.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-workflow-protocol-v2-"));
try {
  const transactionPath = path.join(root, "result.json");
  createWorkflowNodeResultTransaction(transactionPath, {
    schemaVersion: 1, workflowId: "workflow-test", planVersion: 1, nodeRecordId: "workflow-test:1:write",
    nodeId: "write", attemptId: "attempt-1", attempt: 1, contractDigest: "digest", idempotencyKey: "key",
    taskContract: { execution: { executionRoot: root }, outputs: { deliverables: ["report.md"] } }, downstreamNodeIds: [],
    requireSelfReview: true, resultProtocolVersion: 2
  });
  const submission = {
    outcome: "completed", humanSummary: "已生成报告", outputs: [{ type: "file", path: "report.md", description: "报告" }],
    checks: [{ name: "内容检查", status: "passed", evidence: "文件存在" }]
  };
  const missing = submitWorkflowNodeResult(transactionPath, submission);
  assert.equal(missing.ok, false, "missing file must not commit");
  assert.equal(missing.status, "editing");
  await fs.writeFile(path.join(root, "report.md"), "# Real report\n");
  const receipt = submitWorkflowNodeResult(transactionPath, submission);
  assert.equal(receipt.status, "committed");
  assert.equal(receipt.ok, true);
  assert.ok(!Object.hasOwn(receipt, "taskContract"));
  assert.equal(readWorkflowNodeResultTransaction(transactionPath).draftResult.outputs[0].id.startsWith("output-"), true);
  assert.deepEqual(submitWorkflowNodeResult(transactionPath, submission), receipt, "identical repeat submit is idempotent");
  assert.throws(() => submitWorkflowNodeResult(transactionPath, { ...submission, humanSummary: "Changed" }), /不能覆盖/);
  const committedBytes = await fs.readFile(transactionPath, "utf8");
  assert.throws(() => submitWorkflowNodeResult(transactionPath, { ...submission, outcome: "invalid" }), /合法 outcome/);
  assert.equal(await fs.readFile(transactionPath, "utf8"), committedBytes, "invalid replay never modifies committed data");
  const evidencePath = path.join(root, "evidence.json");
  createWorkflowNodeResultTransaction(evidencePath, {
    ...readWorkflowNodeResultTransaction(transactionPath), transactionId: undefined,
    taskContract: { execution: { executionRoot: root, workspaceAccess: "read" }, outputs: { verificationCommands: ["node test.mjs"], deliverables: [] } }
  });
  const hostCheck = { name: "node test.mjs", command: "node test.mjs", status: "failed", exitCode: 1, evidence: "Real failing assertion" };
  recordWorkflowNodeHostVerification(evidencePath, { executor: "workbench", phase: "before_agent", checks: [hostCheck], changedFiles: [], verifiedAt: new Date().toISOString() });
  const rejected = submitWorkflowNodeResult(evidencePath, {
    outcome: "completed", humanSummary: "Try replacing system evidence", checks: [{ ...hostCheck, status: "passed", exitCode: 0, evidence: "Forged" }],
    fileIntegrity: { schemaVersion: 1 }, machineResultPath: "forged", changedFiles: ["forged"], taskContract: {}
  });
  assert.equal(rejected.ok, false, "host failure cannot be overwritten by the worker");
  let evidence = readWorkflowNodeResultTransaction(evidencePath);
  assert.deepEqual(evidence.draftResult.checks, [hostCheck]);
  assert.equal(evidence.draftResult.fileIntegrity, undefined);
  assert.equal(evidence.draftResult.machineResultPath, null);
  assert.deepEqual(evidence.draftResult.changedFiles, []);
  assert.equal(submitWorkflowNodeResult(evidencePath, { outcome: "partial", humanSummary: "Host test failed", unresolved: ["Fix assertion"] }).status, "committed");
  const checkpointPath = path.join(root, "checkpoint.json");
  createWorkflowNodeResultTransaction(checkpointPath, { ...readWorkflowNodeResultTransaction(transactionPath), taskContract: { outputs: { deliverables: [] } } });
  submitWorkflowNodeResult(checkpointPath, { handoff: { facts: ["Verified fact"] } }, true);
  submitWorkflowNodeResult(checkpointPath, { outcome: "completed", humanSummary: "Done" });
  assert.deepEqual(readWorkflowNodeResultTransaction(checkpointPath).draftResult.handoff.facts, ["Verified fact"], "omitted fields preserve checkpoint data");
  const legacyPath = path.join(root, "legacy.json");
  createWorkflowNodeResultTransaction(legacyPath, { ...readWorkflowNodeResultTransaction(transactionPath), resultProtocolVersion: undefined });
  assert.throws(() => submitWorkflowNodeResult(legacyPath, submission), /旧版/);
  const plan = normalizeWorkflowPlan({
    title: "Delivery review", validationMode: "standard", finalDelivery: { required: true, directory: "deliverables", primary: "deliverables/final.md", format: "md", additional: [], producerNodeId: "produce" },
    audit: { checks: ["dependency-minimality", "critical-path", "concurrency-utilization", "read-write-consistency", "provider-allocation", "final-delivery"].map((key) => ({ key, status: "passed", note: "checked" })) },
    nodes: [
      { id: "produce", title: "Produce", objective: "Write final report", provider: "claude", providerReason: "Writing", workspaceAccess: "write", writeScope: ["deliverables"], deliverables: ["deliverables/final.md"], acceptance: ["Report exists"] },
      { id: "review", title: "Review", objective: "Read final report", provider: "codex", providerReason: "Review", workspaceAccess: "read", dependsOn: ["produce"], requiredArtifacts: ["deliverables/final.md"], acceptance: ["Review report"] }
    ]
  });
  assert.deepEqual(validateWorkflowPlan(plan, new Set()), [], "read-only validation after final delivery is valid");
  const writesAfterReview = structuredClone(plan);
  writesAfterReview.nodes.push({ ...plan.nodes[0], id: "rewrite", dependsOn: ["review"] });
  assert.ok(validateWorkflowPlan(writesAfterReview, new Set()).some((issue) => issue.includes("下游写入")), "indirect writer after final producer remains rejected");
  assert.equal(normalizeWorkflowPlan({ ...plan, validationMode: undefined }).validationMode, "strict", "legacy plans retain strict validation");
  const plannerPath = path.join(root, "planner.json");
  createWorkflowPlanTransaction(plannerPath, { workflowId: "workflow-test", mode: "initial", baseRevision: 1, basePlanVersion: 0, previousPlan: null, availableSkills: [], availableMcpServers: [], providerCapabilities: { claudeAvailable: true, codexAvailable: true } });
  const smallPlan = {
    title: "Read project", finalDelivery: { required: false, directory: ".", primary: null, format: "", additional: [], producerNodeId: null, reason: "Pure review" },
    nodes: [{ id: "review", objective: "Review project", workspaceAccess: "read", acceptance: ["Give specific findings"] }]
  };
  const candidate = submitWorkflowPlan(plannerPath, smallPlan);
  assert.equal(candidate.status, "committed");
  assert.equal(candidate.draftPlan.validationMode, "standard");
  assert.equal(candidate.draftPlan.audit.checks.length, 6);
  assert.deepEqual(candidate.draftPlan.nodes[0].writeScope, []);
  assert.equal(submitWorkflowPlan(plannerPath, smallPlan).digest, candidate.digest);
  assert.throws(() => submitWorkflowPlan(plannerPath, { ...smallPlan, title: "Changed" }), /不能覆盖/);
  const sharedPath = path.join(root, "shared.json");
  createWorkflowPlanTransaction(sharedPath, { workflowId: "workflow-shared", mode: "initial", baseRevision: 1, basePlanVersion: 0, previousPlan: null, availableSkills: [], availableMcpServers: [], providerCapabilities: { claudeAvailable: true, codexAvailable: true } });
  replaceWorkflowPlanDraft(sharedPath, { ...candidate.draftPlan, sharedContracts: [{ id: "data", version: 1, constraints: ["unit=ms"] }], nodes: [{ ...candidate.draftPlan.nodes[0], contractRefs: ["data@1"] }] });
  let shared = readWorkflowPlanTransaction(sharedPath).draftPlan;
  assert.deepEqual(shared.nodes[0].constraints, ["[共享合同 data@1] unit=ms"]);
  const firstDigest = workflowNodeContractDigest(shared.nodes[0]);
  applyWorkflowPlanOperations(sharedPath, [{ type: "update_node", nodeId: "review", fields: { objective: "Review latest data" } }]);
  shared = readWorkflowPlanTransaction(sharedPath).draftPlan;
  assert.deepEqual(shared.nodes[0].contractRefs, ["data@1"], "partial node updates retain references");
  assert.deepEqual(shared.sharedContracts, [{ id: "data", version: 1, constraints: ["unit=ms"] }]);
  const beforeVersion = workflowNodeContractDigest(shared.nodes[0]);
  applyWorkflowPlanOperations(sharedPath, [
    { type: "set_plan_fields", fields: { sharedContracts: [{ id: "data", version: 2, constraints: ["unit=s"] }] } },
    { type: "update_node", nodeId: "review", fields: { contractRefs: ["data@2"] } }
  ]);
  shared = readWorkflowPlanTransaction(sharedPath).draftPlan;
  assert.deepEqual(shared.nodes[0].constraints, ["[共享合同 data@2] unit=s"]);
  assert.notEqual(workflowNodeContractDigest(shared.nodes[0]), beforeVersion, "contract version/content changes invalidate reuse");
  assert.notEqual(workflowNodeContractDigest(shared.nodes[0]), firstDigest);
  assert.deepEqual(normalizeWorkflowPlan(shared), shared, "normalization/persistence is idempotent");
  const sharedDb = new DatabaseSync(":memory:");
  try {
    const repository = new WorkflowRepository(sharedDb);
    const created = repository.create({ id: "persisted-shared", ownerUserId: "owner", workspaceId: "workspace", executionTarget: "workspace", executionRoot: root, workspaceRoot: root, prompt: "Review shared contract", plannerEngine: "codex" });
    repository.setPlanning(created.id, "owner", created.revision);
    const saved = repository.savePlan(created.id, "owner", shared);
    const approved = repository.approve(created.id, "owner", saved.revision);
    assert.deepEqual(approved.nodes[0].contractRefs, ["data@2"], "approved runtime nodes retain shared contract references");
    assert.equal(workflowNodeContractDigest(approved.nodes[0]), workflowNodeContractDigest(shared.nodes[0]), "persisted runtime contracts keep their approved digest");
  } finally { sharedDb.close(); }
  applyWorkflowPlanOperations(sharedPath, [
    { type: "set_plan_fields", fields: { sharedContracts: [] } },
    { type: "update_node", nodeId: "review", fields: { contractRefs: [] } }
  ]);
  shared = readWorkflowPlanTransaction(sharedPath).draftPlan;
  assert.deepEqual(shared.nodes[0].constraints, [], "removing all refs must remove their old expansion");
  assert.deepEqual(normalizeWorkflowPlan(shared), shared);
  assert.throws(() => normalizeWorkflowPlan({ ...smallPlan, sharedContracts: {} }), /共享合同必须/);
  assert.throws(() => normalizeWorkflowPlan({ ...smallPlan, nodes: [{ ...smallPlan.nodes[0], contractRefs: [{}] }] }), /引用必须/);
  const prompt = planSystemPrompt([], [], "", 5, undefined, "workspace");
  assert.ok(prompt.length < 3500, "base planner protocol has a bounded context budget");

  const historyPath = path.join(root, "history.json");
  await fs.writeFile(historyPath, JSON.stringify({ schemaVersion: 1, taskContextId: "context", revision: 2, entries: [{ referenceId: "request-1", source: { kind: "session", id: "session-1" }, sourceRevision: 4, messageId: "m-1", role: "user", text: "Keep exported API stable", recordedAt: "2026-01-01" }] }));
  const withToolServer = async (file, environment, check) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", file], env: { ...process.env, ...environment }, cwd: process.cwd(), stderr: "pipe" });
    const client = new Client({ name: "protocol-v2-test", version: "1" });
    try { await client.connect(transport); await check(client); }
    finally { await client.close().catch(() => transport.close()); }
  };
  const decoded = (response) => JSON.parse(response.content.find((item) => item.type === "text").text);
  await withToolServer("server/plugins/orchestration/nodeResultToolServer.ts", { WORKFLOW_NODE_RESULT_TRANSACTION_PATH: checkpointPath, WORKFLOW_TASK_HISTORY_PATH: historyPath }, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("workflow_submit_result"));
    assert.ok(names.includes("workflow_read_task_history"));
    assert.ok(!names.includes("workflow_self_review_result"));
    assert.ok(!names.includes("workflow_set_result_summary"));
    const contract = decoded(await client.callTool({ name: "workflow_read_node_contract", arguments: {} }));
    assert.ok(contract.taskContract);
    assert.ok(!Object.hasOwn(contract, "operations"));
    assert.ok(!Object.hasOwn(contract, "draftResult"));
    const draft = decoded(await client.callTool({ name: "workflow_read_result_draft", arguments: {} }));
    assert.ok(draft.draftResult);
    assert.ok(!Object.hasOwn(draft, "taskContract"));
    const response = await client.callTool({ name: "workflow_submit_result", arguments: { outcome: "completed", humanSummary: "Done" } });
    assert.equal(decoded(response).status, "committed");
    assert.ok(JSON.stringify(response).length < 600, "completed receipt must not echo the contract/history");
    const history = decoded(await client.callTool({ name: "workflow_read_task_history", arguments: { query: "API" } }));
    assert.equal(history.entries[0].referenceId, "request-1");
    assert.equal(history.entries[0].sourceRevision, 4);
  });
  await withToolServer("server/plugins/orchestration/nodeResultToolServer.ts", { WORKFLOW_NODE_RESULT_TRANSACTION_PATH: legacyPath }, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("workflow_self_review_result"));
    assert.ok(!names.includes("workflow_submit_result"));
    const response = decoded(await client.callTool({ name: "workflow_set_result_summary", arguments: { humanSummary: "Legacy draft" } }));
    assert.equal(response.status, "editing");
    assert.ok(!Object.hasOwn(response, "taskContract"));
  });
  await withToolServer("server/plugins/orchestration/plannerToolServer.ts", { WORKFLOW_PLANNER_TRANSACTION_PATH: plannerPath }, async (client) => {
    const response = decoded(await client.callTool({ name: "workflow_submit_plan", arguments: { plan: smallPlan } }));
    assert.equal(response.status, "committed");
    assert.ok(!Object.hasOwn(response, "draftPlan"));
    assert.equal(readWorkflowPlanTransaction(plannerPath).digest, candidate.digest);
  });
  console.log("workflow protocol v2, evidence, idempotency, recovery and final-delivery review checks passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
