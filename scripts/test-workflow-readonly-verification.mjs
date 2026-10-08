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
import { WorkflowNodeStageRetryError } from "../server/plugins/orchestration/errors.ts";
import {
  commitWorkflowNodeResultTransaction, readWorkflowNodeResultTransaction, recordWorkflowNodeSelfReview,
  registerWorkflowNodeChecks, registerWorkflowNodeOutputs, setWorkflowNodeHandoff, setWorkflowNodeOutcome,
  setWorkflowNodeResultSummary, validateWorkflowNodeResultTransaction, WORKFLOW_NODE_SELF_REVIEW_KEYS
} from "../server/plugins/orchestration/nodeResultTransactions.ts";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-readonly-verification-"));
const db = new DatabaseSync(":memory:");
const repository = new WorkflowRepository(db);
const stateFiles = new WorkflowStateFiles(path.join(directory, "runtime"));
let transactionPath;
let testCase;
let turns = 0;
let verificationEvidence;
let runController;
let restartRequested = false;
let snapshotFailuresRemaining = 0;
let commandCounter;
const originalReaddir = fs.readdir;
fs.readdir = async (...args) => {
  if (args[0] === workspace.root && snapshotFailuresRemaining && commandCounter && fsSync.existsSync(commandCounter)) {
    snapshotFailuresRemaining -= 1;
    throw Object.assign(new Error("Simulated transient directory access"), { code: "EBUSY" });
  }
  return originalReaddir(...args);
};
const workspace = { id: "workspace", root: path.join(directory, "project") };
const runtime = createOrchestrationRuntime({
  workflowRepository: repository, workflowStateFiles: stateFiles, workspaceById: () => workspace,
  agentAdapterRegistry: { list: () => [], workflowWorkerRunner: () => () => undefined },
  workspaceAgentConfig: () => ({ skillPolicies: {} }), promptWithAgents: (text) => text,
  eventHub: { publish() {} }, mcpServersForNode: () => [],
  runtimeDirectory: path.join(directory, "node-runtime"),
  workflowNodeResultToolServer: (file) => { transactionPath = file; return { name: "workbench-workflow-result" }; },
  workflowNodeMcpConfigPath: async () => "fixture-config",
  claudeMcpAllowedTools: () => ["mcp__workbench-workflow-result__*"],
  CLAUDE_WORKFLOW_READ_TOOLS: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
  CLAUDE_WORKFLOW_READ_ONLY_DISALLOWED_TOOLS: ["Write", "Edit", "NotebookEdit", "Bash"],
  createWorkflowClaudeHandle: async (options) => {
    assert.equal(options.cwd, workspace.root);
    assert.equal(options.permissionMode, testCase === "write" ? "bypassPermissions" : "plan");
    if (testCase !== "write") {
      assert.ok(options.disallowedTools.includes("Bash"), "Host verification must preserve native Bash prohibition");
      assert.ok(options.disallowedTools.includes("Write"));
    }
    let prompt;
    return {
      currentSessionId: "fixture-claude", closed: false,
      send: (value) => { prompt = value; }, close() {},
      nextTurn: async () => {
        turns += 1;
        if (["restart", "failed-restart", "host-write-restart", "stale-restart", "identity-restart", "incomplete-command"].includes(testCase) && !restartRequested) {
          restartRequested = true;
          runController.abort(new Error("Simulated interruption before candidate commit"));
          throw runController.signal.reason;
        }
        const transaction = readWorkflowNodeResultTransaction(transactionPath);
        verificationEvidence = transaction.taskContract.systemVerification;
        if (testCase === "write") {
          assert.equal(verificationEvidence, undefined, "Writer verification must wait until real output exists");
          assert.deepEqual(transaction.draftResult.checks, []);
          await fs.writeFile(path.join(workspace.root, "generated.txt"), "generated");
        } else if (testCase === "no-command") {
          assert.equal(verificationEvidence, undefined);
          assert.match(prompt, /纯只读分析节点/);
          assert.match(prompt, /无需命令执行或 systemVerification/);
          assert.doesNotMatch(prompt, /systemVerification 是真实命令/);
        } else {
          assert.match(prompt, /systemVerification/);
          assert.match(prompt, /不要重复执行或改写系统检查/);
          assert.equal(verificationEvidence.executor, "workbench");
          assert.equal(verificationEvidence.phase, "before_agent");
          assert.ok(verificationEvidence.checks.length);
        }
        assert.match(prompt, /Git 忽略规则不等于编排写入授权/);
        const failed = Boolean(verificationEvidence?.checks.some((check) => check.status !== "passed"));
        assert.equal(failed, ["failed", "failed-restart", "host-write", "host-write-restart"].includes(testCase));
        // Result tools may register their own checks but cannot replace host failures.
        if (failed) {
          registerWorkflowNodeChecks(transactionPath, verificationEvidence.checks.map((check) => ({ ...check, status: "passed", exitCode: 0, evidence: "attempted overwrite" })));
          assert.ok(readWorkflowNodeResultTransaction(transactionPath).draftResult.checks.some((check) => check.status === "failed"));
        }
        registerWorkflowNodeOutputs(transactionPath, [{ id: "review", type: testCase === "write" ? "file" : "text", path: testCase === "write" ? "generated.txt" : null, mediaType: null, description: "Reviewed files and real host verification", consumableBy: [] }]);
        setWorkflowNodeResultSummary(transactionPath, { humanSummary: failed ? "System verification failed" : "Tests passed; source reviewed", warnings: [], unresolved: failed ? ["Host verification failed"] : [] });
        setWorkflowNodeHandoff(transactionPath, { facts: ["Host output reviewed"], constraints: [], nextAgentInstructions: [] });
        if (testCase === "agent-write") await fs.writeFile(path.join(workspace.root, "unauthorized.txt"), "Simulated forbidden Agent write");
        if (failed) {
          setWorkflowNodeOutcome(transactionPath, "completed");
          assert.ok(validateWorkflowNodeResultTransaction(transactionPath).errors.some((error) => error.includes("失败检查")), "A completed claim cannot bypass failed host verification");
        }
        setWorkflowNodeOutcome(transactionPath, failed ? "blocked" : "completed");
        recordWorkflowNodeSelfReview(transactionPath, { status: "passed", checks: WORKFLOW_NODE_SELF_REVIEW_KEYS.map((key) => ({ key, status: "passed", note: "Compared current contract and evidence" })) });
        assert.equal(validateWorkflowNodeResultTransaction(transactionPath).valid, true);
        commitWorkflowNodeResultTransaction(transactionPath);
        return { sessionId: "fixture-claude", failed: false, usage: {} };
      }
    };
  }
});

async function run(id, script, expectedOutcome) {
  testCase = id;
  restartRequested = false;
  commandCounter = path.join(directory, `${id}-counter.txt`);
  snapshotFailuresRemaining = id === "snapshot-retry" ? 1 : id === "snapshot-exhausted" ? 3 : 0;
  const previousTurns = turns;
  await fs.rm(workspace.root, { recursive: true, force: true });
  await fs.mkdir(workspace.root);
  await fs.writeFile(path.join(workspace.root, "verify.mjs"), `import * as counterFs from 'node:fs'; counterFs.appendFileSync(${JSON.stringify(commandCounter)}, 'run\\n');\n${script}`);
  const workflow = repository.create({ id, ownerUserId: "owner", workspaceId: workspace.id, executionTarget: "workspace", executionRoot: workspace.root, workspaceRoot: workspace.root, prompt: "Read source and verify", plannerEngine: "claude" });
  repository.setPlanning(id, "owner", workflow.revision);
  const candidate = repository.savePlan(id, "owner", normalizeWorkflowPlan({ title: id, nodes: [{ id: "verify", title: "Verify", objective: "Read source and verify node test output", provider: "claude", workspaceAccess: id === "write" ? "write" : "read", writeScope: id === "write" ? ["generated.txt"] : [], deliverables: id === "write" ? ["generated.txt"] : [], verificationCommands: id === "no-command" ? [] : ["node --test verify.mjs"] }], finalDelivery: { required: false, reason: "Text review" } }));
  const approved = repository.approve(id, "owner", candidate.revision);
  const checkpointRoot = path.join(directory, "runtime", id, "nodes", "verify", "plans", "1", "attempts");
  let attempt = repository.claimNodeAttempt(approved.nodes[0].recordId, "fixture-runner", checkpointRoot, new Date(Date.now() + 60_000).toISOString());
  let result;
  let retries = 0;
  while (!result) {
    runController = new AbortController();
    try { result = await runtime.runBuiltinWorkflowNode(id, "owner", "verify", runController, attempt, "fixture-runner"); }
    catch (error) {
      if (error instanceof WorkflowNodeStageRetryError || runController.signal.aborted) {
        retries += 1;
        assert.ok(retries <= 3, "Stage recovery must be bounded");
        const beforePath = path.join(attempt.checkpointDirectory, "before-snapshot.json");
        const checkpointPath = path.join(attempt.checkpointDirectory, "host-verification.json");
        const originalBefore = await fs.readFile(beforePath, "utf8");
        const host = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
        if (error instanceof WorkflowNodeStageRetryError) assert.equal(host.phase, "commands_completed", "Command output must be durable before a failing snapshot");
        if (id === "stale-restart") await fs.appendFile(path.join(workspace.root, "verify.mjs"), "\n// modified after verified command\n");
        if (id === "incomplete-command") {
          host.phase = "commands_running";
          await fs.writeFile(checkpointPath, JSON.stringify(host));
        }
        if (id === "identity-restart") {
          host.identityDigest = "different execution root or contract";
          await fs.writeFile(checkpointPath, JSON.stringify(host));
        }
        repository.checkpointNodeAttempt(attempt.id, { status: "interrupted" });
        const node = repository.get(id, "owner").nodes[0]; node.status = "interrupted"; repository.updateNode(node);
        const previousId = attempt.id;
        attempt = repository.claimNodeAttempt(node.recordId, "fixture-runner", checkpointRoot, new Date(Date.now() + 60_000).toISOString());
        assert.equal(attempt.id, previousId);
        assert.equal(await fs.readFile(beforePath, "utf8"), originalBefore, "Recovery must preserve the original pre-command file snapshot");
        assert.ok(await fs.readFile(checkpointPath, "utf8"));
      } else { result = error.result; if (!result) throw error; }
    }
  }
  assert.equal(result.outcome, expectedOutcome, JSON.stringify(result));
  const expectedTurns = id === "snapshot-exhausted" ? 0 : ["restart", "failed-restart", "host-write-restart"].includes(id) ? 2 : 1;
  assert.equal(turns, previousTurns + expectedTurns, "Stage recovery must not restart an Agent that has not been needed");
  assert.equal(repository.getNodeAttempt(attempt.id).verificationRunCount, id === "no-command" ? 0 : 1, "Host commands must run once, not again after the Agent reply");
  if (!["no-command", "stale-restart", "identity-restart", "incomplete-command"].includes(id)) {
    assert.equal(result.checks.filter((check) => check.command === "node --test verify.mjs").length, 1, "Host evidence must not be duplicated");
    assert.ok(result.checks.some((check) => check.evidence.includes("fixture command")));
  }
  if (id !== "no-command") assert.equal((await fs.readFile(commandCounter, "utf8")).trim().split("\\n").length, 1, "Durable checkpoint recovery must not execute the real command again");
  assert.ok(!(await fs.readdir(workspace.root)).includes(".workflow"), "System verification must create no extra project directory");
  if (id === "passed") {
    const committedCandidate = readWorkflowNodeResultTransaction(transactionPath).draftResult;
    const resumedAttempt = repository.checkpointNodeAttempt(attempt.id, { phase: "result_candidate_committed", parsedResult: committedCandidate, verifiedResult: null });
    const recovered = await runtime.runBuiltinWorkflowNode(id, "owner", "verify", new AbortController(), resumedAttempt, "fixture-runner");
    assert.equal(recovered.outcome, "completed");
    assert.equal(turns, previousTurns + 1, "Recovery after candidate commit must reuse Agent result");
    assert.equal(repository.getNodeAttempt(attempt.id).verificationRunCount, 1, "Recovery must reuse durable host checks without a second command execution");
    assert.equal(recovered.checks.filter((check) => check.command === "node --test verify.mjs").length, 1);
    const verifiedAttempt = repository.getNodeAttempt(attempt.id);
    const verified = await runtime.runBuiltinWorkflowNode(id, "owner", "verify", new AbortController(), verifiedAttempt, "fixture-runner");
    assert.equal(verified.outcome, "completed", "Unchanged verified checkpoint must remain recoverable");
    await fs.appendFile(path.join(workspace.root, "verify.mjs"), "\n// externally changed after verification\n");
    await assert.rejects(
      runtime.runBuiltinWorkflowNode(id, "owner", "verify", new AbortController(), repository.getNodeAttempt(attempt.id), "fixture-runner"),
      (error) => error.result?.outcome === "blocked" && error.result.unresolved.some((reason) => reason.includes("输入文件已变化")),
      "Verified checkpoint recovery must reject changed files instead of reusing a previous successful check"
    );
    assert.equal(turns, previousTurns + 1, "Rejecting stale verification must not rerun the Agent");
  }
  return result;
}

try {
  const passed = await run("passed", "import test from 'node:test'; import assert from 'node:assert/strict'; test('sum contract', () => assert.equal(1 + 2, 3)); console.log('fixture command passed');\n", "completed");
  assert.equal(passed.checks[0].status, "passed");
  assert.match(passed.checks[0].evidence, /sum contract/);
  assert.deepEqual(await fs.readdir(workspace.root), ["verify.mjs"]);
  const failed = await run("failed", "console.error('fixture command failed'); process.exitCode = 1;\n", "blocked");
  assert.equal(failed.checks[0].exitCode, 1);
  assert.equal(failed.checks[0].status, "failed");
  const written = await run("host-write", "import fs from 'node:fs'; fs.writeFileSync('unexpected.txt', 'forbidden'); console.log('fixture command wrote a file');\n", "blocked");
  assert.deepEqual(verificationEvidence.changedFiles, ["unexpected.txt"]);
  assert.ok(written.checks.some((check) => check.name === "只读系统验收文件边界" && check.status === "failed"));
  const agentWritten = await run("agent-write", "console.log('fixture command passed');\n", "failed");
  assert.ok(agentWritten.unresolved.some((reason) => reason.includes("unauthorized.txt")), "Post-Agent scope validation must remain active");
  await run("write", "import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; test('generated output', () => assert.equal(fs.readFileSync('generated.txt', 'utf8'), 'generated')); console.log('fixture command verifies real output');\n", "completed");
  await run("restart", "console.log('fixture command passed');\n", "completed");
  const recoveredFailed = await run("failed-restart", "console.error('fixture command failed'); process.exitCode = 1;\n", "blocked");
  assert.equal(recoveredFailed.checks[0].status, "failed");
  const recoveredWrites = await run("host-write-restart", "import fs from 'node:fs'; fs.writeFileSync('unexpected.txt', 'forbidden'); console.log('fixture command wrote a file');\n", "blocked");
  assert.deepEqual(verificationEvidence.changedFiles, ["unexpected.txt"]);
  assert.ok(recoveredWrites.checks.some((check) => check.name === "只读系统验收文件边界" && check.status === "failed"));
  const stale = await run("stale-restart", "console.log('fixture command passed');\n", "blocked");
  assert.ok(stale.unresolved.some((reason) => reason.includes("过期证据")));
  const identity = await run("identity-restart", "console.log('fixture command passed');\n", "blocked");
  assert.ok(identity.unresolved.some((reason) => reason.includes("合同、执行目录")));
  const incomplete = await run("incomplete-command", "console.log('fixture command passed');\n", "blocked");
  assert.ok(incomplete.unresolved.some((reason) => reason.includes("不能确认命令")));
  await run("snapshot-retry", "console.log('fixture command passed');\n", "completed");
  await run("snapshot-exhausted", "console.log('fixture command passed');\n", "failed");
  await run("no-command", "console.log('This script must not execute');\n", "completed");
  console.log("Readonly Claude preserves Bash/file restrictions, reviews real host checks once, rejects forged failures and detects verification/Agent writes");
} finally {
  fs.readdir = originalReaddir;
  db.close();
  await fs.rm(directory, { recursive: true, force: true });
}
