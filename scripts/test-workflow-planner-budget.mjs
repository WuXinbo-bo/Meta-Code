import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestrationRuntime } from "../server/plugins/orchestration/runtime.ts";
import { createWorkflowPlanTransaction, readWorkflowPlanTransaction, submitWorkflowPlan } from "../server/plugins/orchestration/plannerTransactions.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-planner-budget-"));
const capabilities = { claudeAvailable: true, codexAvailable: true };
const minimalPlan = {
  title: "Review project", finalDelivery: { required: false, directory: ".", reason: "Pure review" },
  nodes: [{ objective: "Review existing code", workspaceAccess: "read", acceptance: ["List concrete findings"] }]
};

async function runPlannerCase(kind) {
  const transactionPath = path.join(root, `${kind}.json`);
  createWorkflowPlanTransaction(transactionPath, { workflowId: kind, mode: "initial", baseRevision: 1, basePlanVersion: 0, previousPlan: null, availableSkills: [], availableMcpServers: [], providerCapabilities: capabilities });
  let calls = 0;
  let launches = 0;
  let businessReads = 0;
  const readFileSync = fsSync.readFileSync;
  const runtime = createOrchestrationRuntime({
    WORKFLOW_PLANNER_RECOVERY_ATTEMPTS: 2,
    getState: () => ({ settings: { apiKey: "fixture" } }),
    workflowRepository: { setPlannerSession() {} },
    workflowPlannerToolServer: () => ({ name: "workbench-workflow-plan" }),
    assertCodexWorkflowControlPlane: async () => {}, threadOptions: () => ({}),
    buildCodex: () => ({ startThread: () => ({ runStreamed: async () => {
      launches += 1;
      return { events: (async function* () {
        for (let i = 0; i < 10; i++) {
          calls += 1;
          if (kind === "schema") {
            yield { type: "item.completed", item: { id: `schema-${i}`, type: "mcp_tool_call", server: "workbench-workflow-plan", tool: "workflow_submit_plan", status: "failed", error: { message: "Input validation error: required objective must be string" }, arguments: { plan: { summary: `Attempt ${i}` } } } };
          } else if (kind === "repeated") {
            const transaction = submitWorkflowPlan(transactionPath, { ...minimalPlan, title: `Changed summary ${i}`, nodes: [{ ...minimalPlan.nodes[0], acceptance: [] }] });
            yield { type: "item.completed", item: { id: `submit-${i}`, type: "mcp_tool_call", server: "workbench-workflow-plan", tool: "workflow_submit_plan", status: "completed", result: { ok: false, validationErrors: transaction.validationErrors } } };
          } else {
            if (kind === "business") {
              const beforeReads = businessReads;
              yield { type: "item.completed", item: { id: `business-${i}`, type: "command_execution", command: "Read project", status: "completed", aggregated_output: "Project facts" } };
              assert.equal(businessReads, beforeReads, "Ordinary business tools never read the planner transaction");
              continue;
            }
            // Required fields in a successful tool's input are not failures.
            yield { type: "item.completed", item: { id: `read-${i}`, type: "mcp_tool_call", server: "workbench-workflow-plan", tool: "workflow_read_plan", status: "completed", arguments: { acceptance: ["must be valid"], required: true }, result: { ok: true, validationErrors: [] } } };
          }
          if (i === 9 && kind === "success") submitWorkflowPlan(transactionPath, minimalPlan);
        }
        if (kind === "business") submitWorkflowPlan(transactionPath, minimalPlan);
        yield { type: "turn.completed", usage: {} };
      })() };
    } }) })
  });
  const workflow = { id: kind, ownerUserId: "owner", plannerEngine: "codex", plannerSessionId: null, plannerEngineSessionId: null, maxConcurrentAgents: 5, executionRoot: root, workDirectory: root, executionTarget: "workspace", originalPrompt: "Review existing project" };
  const controller = new AbortController();
  fsSync.readFileSync = function (filename, ...args) {
    if (String(filename) === transactionPath) businessReads += 1;
    return readFileSync.call(this, filename, ...args);
  };
  try {
    const promise = runtime.runBuiltinWorkflowPlan(workflow, { id: "project", root }, [], [], "", capabilities, controller, transactionPath, () => {});
    if (["success", "business"].includes(kind)) {
      const result = await promise;
      assert.equal(result.noChange, false);
      assert.equal(readWorkflowPlanTransaction(transactionPath).status, "committed");
      assert.equal(calls, 10, "Successful tool payloads never trigger the failure budget");
    } else {
      await assert.rejects(promise, /格式.*(?:无进展|错误)|自动修复/);
      assert.equal(calls, 3, "Repeated failures terminate the current model stream after three calls");
      assert.equal(readWorkflowPlanTransaction(transactionPath).submissionBudget.stopped, true);
    }
  } finally {
    fsSync.readFileSync = readFileSync;
  }
  assert.equal(launches, 1, "Stopped format repairs do not restart the model");
  assert.equal(controller.signal.aborted, false, "Format failure must not impersonate user cancellation");
}

try {
  await runPlannerCase("success");
  await runPlannerCase("business");
  await runPlannerCase("repeated");
  await runPlannerCase("schema");
  console.log("Planner runtime format budgets and successful-tool isolation passed");
} finally { await fs.rm(root, { recursive: true, force: true }); }
