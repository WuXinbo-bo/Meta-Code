import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeWorkflowNodeResult, validateWorkflowNodeResultValue, workflowNodeResultGateIssues } from "./execution.js";
import { withTransactionFileLock, writeJsonAtomically } from "./transactionFile.js";
import type { WorkflowNodeCheck, WorkflowNodeOutcome, WorkflowNodeOutput, WorkflowNodeResult } from "./types.js";

export type WorkflowNodeResultTransactionStatus = "editing" | "validated" | "committed" | "aborted";

export type WorkflowNodeResultContract = {
  schemaVersion: 1;
  workflowId: string;
  planVersion: number;
  nodeRecordId: string;
  nodeId: string;
  attemptId: string;
  attempt: number;
  contractDigest: string;
  idempotencyKey: string;
  taskContract: Record<string, unknown>;
  downstreamNodeIds: string[];
  requireSelfReview?: boolean;
};

export const WORKFLOW_NODE_SELF_REVIEW_KEYS = [
  "objective-coverage",
  "scope-boundary",
  "deliverable-reality",
  "acceptance-evidence",
  "downstream-separation",
  "outcome-consistency"
] as const;

export type WorkflowNodeSelfReview = {
  status: "passed" | "revised";
  checks: Array<{ key: typeof WORKFLOW_NODE_SELF_REVIEW_KEYS[number]; status: "passed" | "revised"; note: string }>;
  changes: string[];
  resultDigest: string;
  reviewedAt: string;
};

export type WorkflowNodeResultTransaction = WorkflowNodeResultContract & {
  transactionId: string;
  transactionSchemaVersion: 1;
  baseRevision: number;
  status: WorkflowNodeResultTransactionStatus;
  draftResult: WorkflowNodeResult;
  operations: Array<{ id: string; type: string; createdAt: string }>;
  validationErrors: string[];
  selfReview: WorkflowNodeSelfReview | null;
  digest: string | null;
  createdAt: string;
  updatedAt: string;
};

const emptyResult = (): WorkflowNodeResult => ({
  outcome: "partial",
  humanSummary: "",
  outputs: [],
  changedFiles: [],
  checks: [],
  decisions: [],
  handoff: { facts: [], constraints: [], nextAgentInstructions: [] },
  warnings: [],
  unresolved: [],
  machineResultPath: null
});

function resultDigest(result: WorkflowNodeResult) {
  return crypto.createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

function assertMutable(transaction: WorkflowNodeResultTransaction) {
  if (!['editing', 'validated'].includes(transaction.status)) throw new Error("节点结果事务已经结束，不能继续修改");
}

function writeTransaction(target: string, transaction: WorkflowNodeResultTransaction, operation?: string) {
  transaction.updatedAt = new Date().toISOString();
  transaction.baseRevision += 1;
  transaction.status = "editing";
  transaction.validationErrors = [];
  transaction.selfReview = null;
  transaction.digest = null;
  if (operation) transaction.operations.push({ id: `result-operation-${crypto.randomUUID()}`, type: operation, createdAt: transaction.updatedAt });
  writeJsonAtomically(target, transaction);
  return transaction;
}

export function createWorkflowNodeResultTransaction(target: string, contract: WorkflowNodeResultContract) {
  const now = new Date().toISOString();
  const transaction: WorkflowNodeResultTransaction = {
    ...contract,
    transactionId: `node-result-transaction-${crypto.randomUUID()}`,
    transactionSchemaVersion: 1,
    baseRevision: 0,
    status: "editing",
    draftResult: emptyResult(),
    operations: [],
    validationErrors: [],
    selfReview: null,
    digest: null,
    createdAt: now,
    updatedAt: now
  };
  writeJsonAtomically(target, transaction);
  return transaction;
}

export function openWorkflowNodeResultTransaction(target: string, contract: WorkflowNodeResultContract) {
  if (!fs.existsSync(target)) return { transaction: createWorkflowNodeResultTransaction(target, contract), resumed: false };
  const transaction = readWorkflowNodeResultTransaction(target);
  const identityKeys: Array<keyof WorkflowNodeResultContract> = ["workflowId", "planVersion", "nodeRecordId", "nodeId", "attemptId", "attempt", "contractDigest", "idempotencyKey"];
  const mismatch = identityKeys.find((key) => transaction[key] !== contract[key]);
  if (mismatch) throw new Error(`节点结果事务身份不匹配：${mismatch}`);
  return { transaction, resumed: true };
}

export function readWorkflowNodeResultTransaction(target: string) {
  const value = JSON.parse(fs.readFileSync(target, "utf8")) as WorkflowNodeResultTransaction;
  if (value.transactionSchemaVersion !== 1 || !value.transactionId || !value.workflowId || !value.attemptId) throw new Error("节点结果事务文件格式无效");
  value.draftResult = normalizeWorkflowNodeResult(value.draftResult);
  value.selfReview ||= null;
  return value;
}

export function workflowNodeResultTransactionIssues(transaction: WorkflowNodeResultTransaction) {
  const errors: string[] = [];
  try { transaction.draftResult = validateWorkflowNodeResultValue(transaction.draftResult); }
  catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  const contract = transaction.taskContract as { execution?: { workDirectory?: string }; outputs?: { deliverables?: string[] } };
  const workDirectory = String(contract.execution?.workDirectory || "").trim();
  errors.push(...workflowNodeResultGateIssues(transaction.draftResult, {
    downstreamNodeIds: transaction.downstreamNodeIds,
    deliverables: contract.outputs?.deliverables || [],
    artifactIssue: workDirectory ? (reportedPath) => {
      const resolved = path.isAbsolute(reportedPath) ? path.resolve(reportedPath) : path.resolve(workDirectory, reportedPath);
      const root = path.resolve(workDirectory);
      const inside = resolved === root || resolved.startsWith(`${root}${path.sep}`);
      if (!inside) return `产物路径越出任务目录：${reportedPath}`;
      return fs.existsSync(resolved) ? null : `声明的产物不存在：${reportedPath}`;
    } : undefined
  }));
  if (transaction.requireSelfReview) {
    if (!transaction.selfReview) errors.push("提交前必须完成节点结果自审");
    else if (transaction.selfReview.resultDigest !== resultDigest(transaction.draftResult)) errors.push("节点结果在自审后发生变化，必须重新自审");
  }
  return [...new Set(errors)];
}

export function reopenWorkflowNodeResultTransaction(target: string, reasons: string[] = []) {
  return withTransactionFileLock(target, () => {
    const transaction = readWorkflowNodeResultTransaction(target);
    if (transaction.status === "aborted") throw new Error("已中止的节点结果事务不能修复");
    const now = new Date().toISOString();
    transaction.status = "editing";
    transaction.validationErrors = [...new Set(reasons.map((item) => item.trim()).filter(Boolean))];
    transaction.selfReview = null;
    transaction.digest = null;
    transaction.baseRevision += 1;
    transaction.updatedAt = now;
    transaction.operations.push({ id: `result-operation-${crypto.randomUUID()}`, type: "result_repair", createdAt: now });
    writeJsonAtomically(target, transaction);
    return transaction;
  });
}

export function recordWorkflowNodeSelfReview(target: string, input: {
  status: "passed" | "revised";
  checks: WorkflowNodeSelfReview["checks"];
  changes?: string[];
}) {
  return withTransactionFileLock(target, () => recordWorkflowNodeSelfReviewUnlocked(target, input));
}

function recordWorkflowNodeSelfReviewUnlocked(target: string, input: {
  status: "passed" | "revised";
  checks: WorkflowNodeSelfReview["checks"];
  changes?: string[];
}) {
  const transaction = readWorkflowNodeResultTransaction(target); assertMutable(transaction);
  const received = new Set(input.checks.map((check) => check.key));
  const missing = WORKFLOW_NODE_SELF_REVIEW_KEYS.filter((key) => !received.has(key));
  const duplicates = input.checks.filter((check, index) => input.checks.findIndex((item) => item.key === check.key) !== index);
  if (missing.length) throw new Error(`节点自审缺少检查：${missing.join(", ")}`);
  if (duplicates.length) throw new Error(`节点自审包含重复检查：${[...new Set(duplicates.map((item) => item.key))].join(", ")}`);
  if (input.checks.some((check) => !check.note.trim())) throw new Error("节点自审检查必须提供可公开结论");
  const now = new Date().toISOString();
  transaction.selfReview = {
    status: input.status,
    checks: input.checks.map((check) => ({ ...check, note: check.note.trim() })),
    changes: [...new Set((input.changes || []).map((item) => item.trim()).filter(Boolean))],
    resultDigest: resultDigest(transaction.draftResult),
    reviewedAt: now
  };
  transaction.updatedAt = now;
  transaction.baseRevision += 1;
  transaction.status = "editing";
  transaction.validationErrors = [];
  transaction.digest = null;
  transaction.operations.push({ id: `result-operation-${crypto.randomUUID()}`, type: "self_review", createdAt: now });
  writeJsonAtomically(target, transaction);
  return transaction;
}

export function setWorkflowNodeResultSummary(target: string, input: {
  humanSummary: string;
  decisions?: Array<{ key: string; value: string; reason: string }>;
  warnings?: string[];
  unresolved?: string[];
}) {
  return withTransactionFileLock(target, () => {
    const transaction = readWorkflowNodeResultTransaction(target); assertMutable(transaction);
    transaction.draftResult.humanSummary = input.humanSummary.trim();
    if (input.decisions) transaction.draftResult.decisions = input.decisions;
    if (input.warnings) transaction.draftResult.warnings = [...new Set(input.warnings.map((item) => item.trim()).filter(Boolean))];
    if (input.unresolved) transaction.draftResult.unresolved = [...new Set(input.unresolved.map((item) => item.trim()).filter(Boolean))];
    return writeTransaction(target, transaction, "set_summary");
  });
}

export function registerWorkflowNodeOutputs(target: string, outputs: WorkflowNodeOutput[]) {
  return withTransactionFileLock(target, () => {
    const transaction = readWorkflowNodeResultTransaction(target); assertMutable(transaction);
    const byId = new Map(transaction.draftResult.outputs.map((output) => [output.id, output]));
    for (const output of outputs) byId.set(output.id, output);
    transaction.draftResult.outputs = [...byId.values()];
    return writeTransaction(target, transaction, "register_outputs");
  });
}

export function registerWorkflowNodeChecks(target: string, checks: WorkflowNodeCheck[]) {
  return withTransactionFileLock(target, () => {
    const transaction = readWorkflowNodeResultTransaction(target); assertMutable(transaction);
    const byName = new Map(transaction.draftResult.checks.map((check) => [check.name, check]));
    for (const check of checks) byName.set(check.name, check);
    transaction.draftResult.checks = [...byName.values()];
    return writeTransaction(target, transaction, "register_checks");
  });
}

export function setWorkflowNodeHandoff(target: string, handoff: WorkflowNodeResult["handoff"]) {
  return withTransactionFileLock(target, () => {
    const transaction = readWorkflowNodeResultTransaction(target); assertMutable(transaction);
    transaction.draftResult.handoff = handoff;
    return writeTransaction(target, transaction, "set_handoff");
  });
}

export function setWorkflowNodeOutcome(target: string, outcome: WorkflowNodeOutcome) {
  return withTransactionFileLock(target, () => {
    const transaction = readWorkflowNodeResultTransaction(target); assertMutable(transaction);
    transaction.draftResult.outcome = outcome;
    return writeTransaction(target, transaction, "set_outcome");
  });
}

export function validateWorkflowNodeResultTransaction(target: string) {
  return withTransactionFileLock(target, () => validateWorkflowNodeResultTransactionUnlocked(target));
}

function validateWorkflowNodeResultTransactionUnlocked(target: string) {
  const transaction = readWorkflowNodeResultTransaction(target);
  if (!['editing', 'validated'].includes(transaction.status)) throw new Error("节点结果事务已经结束，不能执行校验");
  const errors = workflowNodeResultTransactionIssues(transaction);
  transaction.validationErrors = errors;
  transaction.status = errors.length ? "editing" : "validated";
  transaction.digest = errors.length ? null : resultDigest(transaction.draftResult);
  transaction.updatedAt = new Date().toISOString();
  writeJsonAtomically(target, transaction);
  return { valid: errors.length === 0, errors, digest: transaction.digest, result: transaction.draftResult };
}

export function commitWorkflowNodeResultTransaction(target: string) {
  return withTransactionFileLock(target, () => {
    const existing = readWorkflowNodeResultTransaction(target);
    if (existing.status === "committed") return existing;
    const validation = validateWorkflowNodeResultTransactionUnlocked(target);
    if (!validation.valid) throw new Error(`节点结果候选校验未通过：${validation.errors.join("；")}`);
    const transaction = readWorkflowNodeResultTransaction(target);
    transaction.status = "committed";
    transaction.digest = validation.digest;
    transaction.updatedAt = new Date().toISOString();
    writeJsonAtomically(target, transaction);
    return transaction;
  });
}

export function reportWorkflowNodeBlocked(target: string, input: { humanSummary: string; reasons: string[] }) {
  return withTransactionFileLock(target, () => {
    const transaction = readWorkflowNodeResultTransaction(target); assertMutable(transaction);
    transaction.draftResult.outcome = "blocked";
    transaction.draftResult.humanSummary = input.humanSummary.trim();
    transaction.draftResult.unresolved = [...new Set(input.reasons.map((item) => item.trim()).filter(Boolean))];
    return writeTransaction(target, transaction, "report_blocked");
  });
}

export function abortWorkflowNodeResultTransaction(target: string, reason: string) {
  return withTransactionFileLock(target, () => {
    const transaction = readWorkflowNodeResultTransaction(target);
    if (transaction.status === "committed") return transaction;
    transaction.status = "aborted";
    transaction.validationErrors = [reason.trim() || "节点结果事务已中止"];
    transaction.updatedAt = new Date().toISOString();
    writeJsonAtomically(target, transaction);
    return transaction;
  });
}
