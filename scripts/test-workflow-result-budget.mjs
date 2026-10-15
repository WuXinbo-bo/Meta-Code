import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createWorkflowNodeResultTransaction, readWorkflowNodeResultTransaction,
  recordWorkflowNodeResultToolFailure, submitWorkflowNodeResult, workflowNodeResultSubmissionIssue
} from "../server/plugins/orchestration/nodeResultTransactions.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-result-budget-"));
const create = async (name) => {
  const target = path.join(root, name);
  createWorkflowNodeResultTransaction(target, {
    schemaVersion: 1, workflowId: "w", planVersion: 1, nodeRecordId: "n", nodeId: "n",
    attemptId: name, attempt: 1, contractDigest: "digest", idempotencyKey: name,
    resultProtocolVersion: 2, taskContract: { execution: { executionRoot: root }, outputs: { deliverables: ["missing.md"] } }, downstreamNodeIds: []
  });
  return target;
};
try {
  const target = await create("same-errors.json");
  for (let index = 0; index < 3; index++) {
    const receipt = submitWorkflowNodeResult(target, { outcome: "completed", humanSummary: `Different summary ${index}` });
    assert.equal(receipt.ok, false);
    assert.equal(Boolean(receipt.repairBlocked), index === 2, "Changing prose must not disguise identical missing artifacts");
  }
  assert.match(workflowNodeResultSubmissionIssue(readWorkflowNodeResultTransaction(target)), /没有进展/);
  await fs.writeFile(path.join(root, "missing.md"), "real artifact");
  const fixed = submitWorkflowNodeResult(target, { outcome: "completed", humanSummary: "Real output", outputs: [{ type: "file", path: "missing.md", description: "Report" }] });
  assert.equal(fixed.status, "committed", "A genuine valid explicit correction may complete without replaying business work");
  assert.equal(workflowNodeResultSubmissionIssue(readWorkflowNodeResultTransaction(target)), null);

  const schema = await create("schema.json");
  recordWorkflowNodeResultToolFailure(schema, "event-1", "invalid input: expected string");
  recordWorkflowNodeResultToolFailure(schema, "event-1", "invalid input: expected string");
  assert.equal(readWorkflowNodeResultTransaction(schema).submissionProgress.totalFailures, 1, "Duplicate native tool events count once");
  for (let index = 2; index <= 8; index++) recordWorkflowNodeResultToolFailure(schema, `event-${index}`, `invalid input: field ${index}`);
  assert.match(workflowNodeResultSubmissionIssue(readWorkflowNodeResultTransaction(schema)), /失败预算/);
  assert.equal(readWorkflowNodeResultTransaction(schema).status, "editing", "Budget stop retains the durable business/result checkpoint");
  console.log("Result repair budget: repeated semantic gate errors, schema failures, native event deduplication and valid correction passed");
} finally { await fs.rm(root, { recursive: true, force: true }); }
