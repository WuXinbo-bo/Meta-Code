import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createOrchestrationRuntime } from "../server/plugins/orchestration/runtime.ts";
import { WorkflowRepository } from "../server/plugins/orchestration/repository.ts";
import { WorkflowStateFiles } from "../server/plugins/orchestration/stateFiles.ts";
import { normalizeWorkflowPlan } from "../server/plugins/orchestration/plan.ts";
import { readWorkflowNodeResultTransaction, submitWorkflowNodeResult } from "../server/plugins/orchestration/nodeResultTransactions.ts";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-result-runtime-budget-"));
const workspace = { id: "workspace", root: path.join(directory, "project") };
await fs.mkdir(workspace.root);
const db = new DatabaseSync(":memory:");
const repository = new WorkflowRepository(db);
const stateFiles = new WorkflowStateFiles(path.join(directory, "runtime"));
let transactionPath;
let testCase;
let calls;
let launches;
let transactionReads = 0;
let readTraces = [];
let activityWrites = 0;
const updateNodeActivity = repository.updateNodeActivity.bind(repository);
repository.updateNodeActivity = (node) => { activityWrites += 1; return updateNodeActivity(node); };
const readFileSync = fsSync.readFileSync;
const runtime = createOrchestrationRuntime({
  workflowRepository: repository, workflowStateFiles: stateFiles, workspaceById: () => workspace,
  agentAdapterRegistry: {
    list: () => [{ id: "codex", capabilities: { workflow: { worker: true }, workspace: { read: true, write: true }, tools: { shell: true } } }],
    descriptor: () => ({ capabilities: { tools: { shell: true } } }),
    workflowWorkerRunner: (id) => id === "claude" && testCase === "business-auto-codex" ? undefined : () => undefined
  },
  workspaceAgentConfig: () => ({ skillPolicies: {} }), promptWithAgents: (text) => text,
  eventHub: { publish() {} }, mcpServersForNode: () => [],
  runtimeDirectory: path.join(directory, "node-runtime"),
  workflowNodeResultToolServer: (file) => { transactionPath = file; return { name: "workbench-workflow-result" }; },
  workflowNodeMcpConfigPath: async () => "fixture-config",
  claudeMcpAllowedTools: () => ["mcp__workbench-workflow-result__*"],
  CLAUDE_WORKFLOW_READ_TOOLS: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
  CLAUDE_WORKFLOW_READ_ONLY_DISALLOWED_TOOLS: ["Write", "Edit", "NotebookEdit", "Bash"],
  getState: () => ({ settings: { apiKey: "fixture" } }),
  assertCodexWorkflowControlPlane: async () => {}, delegatedThreadOptions: () => ({}),
  buildCodex: () => ({ startThread: () => ({ runStreamed: async (prompt) => {
    launches += 1;
    assert.match(prompt, /Codex 只读节点通常通过 read-only shell 读取文件/);
    assert.match(prompt, /合同禁止 shell\/终端命令，必须遵守/);
    assert.doesNotMatch(prompt, /只读节点不具备 Bash/);
    return { events: (async function* () {
      for (let index = 0; index < 10; index++) {
        calls += 1;
        const beforeReads = transactionReads;
        yield { type: "item.completed", item: { id: `codex-read-${index}`, type: "command_execution", command: "cat source.js", status: "completed", aggregated_output: "Project facts" } };
        assert.equal(transactionReads, beforeReads, "Codex business reads avoid protocol transaction I/O");
      }
      submitWorkflowNodeResult(transactionPath, { outcome: "completed", humanSummary: "Actual review completed" });
      yield { type: "turn.completed", usage: {} };
    })() };
  } }) }),
  createWorkflowClaudeHandle: async (options) => {
    launches += 1;
    return {
      currentSessionId: "fixture-claude", closed: false, send() {}, close() {},
      nextTurn: async () => {
        if (testCase === "business") {
          const beforeWrites = activityWrites;
          for (let index = 0; index < 20; index++) await options.onEvent({ type: "assistant", sourceId: "stream", text: `Partial review ${index}` });
          assert.equal(activityWrites, beforeWrites, "Rapid text events are coalesced before persistence");
          await new Promise((resolve) => setTimeout(resolve, 275));
          assert.equal(activityWrites, beforeWrites + 1, "Streaming text is persisted within one bounded interval");
        }
        for (let index = 0; index < 10; index++) {
          calls += 1;
          if (testCase === "business") {
            const beforeReads = transactionReads;
            const beforeWrites = activityWrites;
            readTraces = [];
            await options.onEvent({ type: "tool.completed", sourceId: `read-${index}`, toolName: "Read", phase: "completed", text: "Project facts" });
            assert.equal(transactionReads, beforeReads, `Business read completions read no result transaction: ${readTraces.join("\n")}`);
            assert.equal(activityWrites, beforeWrites + 1, "Completed tools remain immediately durable");
          } else if (testCase === "schema") {
            await options.onEvent({ type: "tool.completed", sourceId: `invalid-${index}`, toolName: "mcp__workbench-workflow-result__workflow_submit_result", phase: "failed", text: "input schema validation: expected humanSummary string", payload: { is_error: true } });
          } else {
            const receipt = submitWorkflowNodeResult(transactionPath, { outcome: "completed", humanSummary: "Missing declared output" });
            assert.equal(receipt.ok, false);
            await options.onEvent({ type: "tool.completed", sourceId: `submit-${index}`, toolName: "mcp__workbench-workflow-result__workflow_submit_result", phase: "completed", text: JSON.stringify(receipt) });
          }
        }
        submitWorkflowNodeResult(transactionPath, { outcome: "completed", humanSummary: "Actual review completed" });
        await options.onEvent({ type: "turn.completed", text: "Review completed" });
        return { sessionId: "fixture-claude", failed: false, usage: {} };
      }
    };
  }
});

try {
  fsSync.readFileSync = function (filename, ...args) {
    if (String(filename) === transactionPath) { transactionReads += 1; readTraces.push(new Error().stack); }
    return readFileSync.call(this, filename, ...args);
  };
  for (const kind of ["business", "business-codex", "business-auto-codex", "schema", "repeated"]) {
    testCase = kind; calls = 0; launches = 0;
    const workflow = repository.create({ id: kind, ownerUserId: "owner", workspaceId: workspace.id, executionTarget: "workspace", executionRoot: workspace.root, workspaceRoot: workspace.root, prompt: "Review existing project", plannerEngine: "claude" });
    repository.setPlanning(kind, "owner", workflow.revision);
    const candidate = repository.savePlan(kind, "owner", normalizeWorkflowPlan({ title: kind, validationMode: "standard", finalDelivery: { required: false, reason: "Text review" }, nodes: [{ id: "review", title: "Review", objective: "Review existing project", acceptance: ["Provide findings"], provider: kind === "business-auto-codex" ? "auto" : kind === "business-codex" ? "codex" : "claude", workspaceAccess: "read", deliverables: kind === "repeated" ? ["missing.md"] : [] }] }));
    const approved = repository.approve(kind, "owner", candidate.revision);
    const attempt = repository.claimNodeAttempt(approved.nodes[0].recordId, "fixture-runner", path.join(directory, "runtime", kind, "checkpoints"), new Date(Date.now() + 60_000).toISOString());
    let result;
    try { result = await runtime.runBuiltinWorkflowNode(kind, "owner", "review", new AbortController(), attempt, "fixture-runner"); }
    catch (error) {
      result = error.result;
      if (!result && kind.startsWith("business")) throw error;
      if (!result) { assert.match(error.message, /没有进展|失败预算/); result = { outcome: "blocked" }; }
    }
    if (kind.startsWith("business")) {
      assert.equal(result.outcome, "completed");
      assert.equal(calls, 10);
    } else {
      const transaction = readWorkflowNodeResultTransaction(transactionPath);
      assert.equal(transaction.submissionProgress.repeatedFailures, 3);
      assert.equal(transaction.submissionProgress.totalFailures, 3, "Handler receipt failures are not counted twice");
      assert.equal(calls, 3, "Failed result submission stops after three identical failures");
      assert.notEqual(result.outcome, "completed");
    }
    assert.equal(launches, 1, "Budget exhaustion cannot restart or repair the model");
  }
  const node = repository.get("business", "owner").nodes[0];
  db.prepare("UPDATE workflow_nodes SET status='pause_requested' WHERE id=?").run(node.recordId);
  repository.updateNodeActivity(node);
  assert.equal(db.prepare("SELECT status FROM workflow_nodes WHERE id=?").get(node.recordId).status, "pause_requested", "Activity flush preserves concurrent control state");
  const eventsFile = path.join(stateFiles.directoryFor("business"), "events.jsonl");
  const beforeEvents = await fs.readFile(eventsFile, "utf8");
  const get = repository.get;
  repository.get = () => { throw new Error("Event append must not hydrate workflows"); };
  try {
    runtime.appendWorkflowProtocolEvent("business", "intruder", "unexpected");
    assert.equal(await fs.readFile(eventsFile, "utf8"), beforeEvents, "Event identity enforces workflow ownership");
    runtime.appendWorkflowProtocolEvent("business", "owner", "identity-check");
    assert.equal(JSON.parse((await fs.readFile(eventsFile, "utf8")).trim().split("\n").at(-1)).type, "identity-check");
    repository.delete("business", "owner");
    const retained = await fs.readFile(eventsFile, "utf8");
    runtime.appendWorkflowProtocolEvent("business", "owner", "after-delete");
    assert.equal(await fs.readFile(eventsFile, "utf8"), retained, "Late events cannot recreate deleted workflow state");
  } finally { repository.get = get; }
  console.log("Result runtime: business event I/O isolation, schema and semantic repair termination passed");
} finally {
  fsSync.readFileSync = readFileSync;
  db.close();
  await fs.rm(directory, { recursive: true, force: true });
}
