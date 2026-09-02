import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeWorkflowPlan, normalizeWorkflowProviderCapabilities, validateWorkflowPlan, type WorkflowProviderCapabilitiesInput } from "./plan.js";
import { withTransactionFileLock, writeJsonAtomically } from "./transactionFile.js";
import type { WorkflowPlan, WorkflowPlanningMode } from "./types.js";

export type WorkflowPlanEditOperation = {
  type: "set_plan_fields" | "upsert_node" | "update_node" | "remove_node" | "set_dependencies";
  nodeId?: string;
  fields?: Record<string, unknown>;
  node?: Record<string, unknown>;
  dependsOn?: string[];
};

export type WorkflowPlanTransactionStatus = "editing" | "validated" | "committed" | "no_change" | "aborted";

export type WorkflowPlanTransaction = {
  schemaVersion: 1;
  id: string;
  workflowId: string;
  mode: WorkflowPlanningMode;
  baseRevision: number;
  basePlanVersion: number;
  status: WorkflowPlanTransactionStatus;
  draftPlan: WorkflowPlan;
  availableSkills: string[];
  availableMcpServers: string[];
  providerCapabilities: WorkflowProviderCapabilitiesInput;
  requestKey?: string;
  operations: Array<{ id: string; createdAt: string; operation: WorkflowPlanEditOperation }>;
  validationErrors: string[];
  note: string | null;
  digest: string | null;
  createdAt: string;
  updatedAt: string;
};

const emptyPlan = (): WorkflowPlan => normalizeWorkflowPlan({
  title: "任务编排",
  summary: "",
  assumptions: [],
  questions: [],
  risks: [],
  audit: { status: "passed", checks: [], changes: [] },
  nodes: []
});

function planDigest(plan: WorkflowPlan) {
  return crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function createWorkflowPlanTransaction(target: string, input: {
  workflowId: string;
  mode: WorkflowPlanningMode;
  baseRevision: number;
  basePlanVersion: number;
  previousPlan: WorkflowPlan | null;
  availableSkills: string[];
  availableMcpServers: string[];
  providerCapabilities: WorkflowProviderCapabilitiesInput;
  requestKey?: string;
}) {
  const now = new Date().toISOString();
  const transaction: WorkflowPlanTransaction = {
    schemaVersion: 1,
    id: `planner-transaction-${crypto.randomUUID()}`,
    workflowId: input.workflowId,
    mode: input.mode,
    baseRevision: input.baseRevision,
    basePlanVersion: input.basePlanVersion,
    status: "editing",
    draftPlan: input.mode === "initial" || input.mode === "fresh" ? emptyPlan() : normalizeWorkflowPlan(input.previousPlan || emptyPlan()),
    availableSkills: [...new Set(input.availableSkills)],
    availableMcpServers: [...new Set(input.availableMcpServers)],
    providerCapabilities: normalizeWorkflowProviderCapabilities(input.providerCapabilities),
    requestKey: input.requestKey,
    operations: [],
    validationErrors: [],
    note: null,
    digest: null,
    createdAt: now,
    updatedAt: now
  };
  writeJsonAtomically(target, transaction);
  return transaction;
}

export function openWorkflowPlanTransaction(target: string, input: {
  workflowId: string;
  mode: WorkflowPlanningMode;
  baseRevision: number;
  basePlanVersion: number;
  previousPlan: WorkflowPlan | null;
  availableSkills: string[];
  availableMcpServers: string[];
  providerCapabilities: WorkflowProviderCapabilitiesInput;
  requestKey?: string;
}) {
  if (!fs.existsSync(target)) return { transaction: createWorkflowPlanTransaction(target, input), resumed: false };
  const transaction = readWorkflowPlanTransaction(target);
  if (transaction.workflowId !== input.workflowId) throw new Error("规划事务与当前工作流不匹配");
  if (transaction.basePlanVersion !== input.basePlanVersion) throw new Error("规划事务基线版本已变化，不能复用旧草稿");
  if ((transaction.requestKey || "") !== (input.requestKey || "")) return { transaction: createWorkflowPlanTransaction(target, input), resumed: false };
  if (transaction.mode !== input.mode) return { transaction: createWorkflowPlanTransaction(target, input), resumed: false };
  if (["committed", "no_change", "aborted"].includes(transaction.status)) return { transaction: createWorkflowPlanTransaction(target, input), resumed: false };
  transaction.status = "editing";
  transaction.baseRevision = input.baseRevision;
  transaction.availableSkills = [...new Set(input.availableSkills)];
  transaction.availableMcpServers = [...new Set(input.availableMcpServers)];
  transaction.providerCapabilities = normalizeWorkflowProviderCapabilities(input.providerCapabilities);
  transaction.note = null;
  transaction.validationErrors = [];
  transaction.digest = null;
  return { transaction: writeTransaction(target, transaction), resumed: true };
}

export function readWorkflowPlanTransaction(target: string) {
  const value = JSON.parse(fs.readFileSync(target, "utf8")) as WorkflowPlanTransaction;
  if (value.schemaVersion !== 1 || !value.id || !value.workflowId) throw new Error("规划事务文件格式无效");
  value.providerCapabilities = normalizeWorkflowProviderCapabilities(value.providerCapabilities);
  return value;
}

function writeTransaction(target: string, transaction: WorkflowPlanTransaction) {
  transaction.updatedAt = new Date().toISOString();
  writeJsonAtomically(target, transaction);
  return transaction;
}

export function replaceWorkflowPlanDraft(target: string, plan: unknown) {
  return withTransactionFileLock(target, () => {
    const transaction = readWorkflowPlanTransaction(target);
    if (!["editing", "validated"].includes(transaction.status)) throw new Error("规划事务已经结束，不能继续修改");
    transaction.draftPlan = normalizeWorkflowPlan(plan);
    transaction.status = "editing";
    transaction.validationErrors = [];
    transaction.digest = null;
    transaction.operations.push({ id: `operation-${crypto.randomUUID()}`, createdAt: new Date().toISOString(), operation: { type: "set_plan_fields", fields: { fullReplacement: true } } });
    return writeTransaction(target, transaction);
  });
}

export function applyWorkflowPlanOperations(target: string, operations: WorkflowPlanEditOperation[]) {
  return withTransactionFileLock(target, () => {
    const transaction = readWorkflowPlanTransaction(target);
    if (!["editing", "validated"].includes(transaction.status)) throw new Error("规划事务已经结束，不能继续修改");
    const raw = JSON.parse(JSON.stringify(transaction.draftPlan)) as Record<string, unknown>;
    const nodes = Array.isArray(raw.nodes) ? raw.nodes as Array<Record<string, unknown>> : [];
    for (const operation of operations) {
      if (operation.type === "set_plan_fields") {
        const fields = { ...(operation.fields || {}) };
        delete fields.nodes;
        Object.assign(raw, fields);
      } else if (operation.type === "upsert_node") {
        const node = { ...(operation.node || {}) };
        const nodeId = String(node.id || operation.nodeId || "").trim();
        if (!nodeId) throw new Error("upsert_node 缺少 node.id");
        node.id = nodeId;
        const index = nodes.findIndex((item) => String(item.id) === nodeId);
        if (index >= 0) nodes[index] = node; else nodes.push(node);
      } else if (operation.type === "update_node") {
        const nodeId = String(operation.nodeId || "").trim();
        const index = nodes.findIndex((item) => String(item.id) === nodeId);
        if (index < 0) throw new Error(`节点「${nodeId}」不存在`);
        const fields = { ...(operation.fields || {}) };
        delete fields.id;
        nodes[index] = { ...nodes[index], ...fields, id: nodeId };
      } else if (operation.type === "remove_node") {
        const nodeId = String(operation.nodeId || "").trim();
        const index = nodes.findIndex((item) => String(item.id) === nodeId);
        if (index < 0) throw new Error(`节点「${nodeId}」不存在`);
        nodes.splice(index, 1);
      } else if (operation.type === "set_dependencies") {
        const nodeId = String(operation.nodeId || "").trim();
        const index = nodes.findIndex((item) => String(item.id) === nodeId);
        if (index < 0) throw new Error(`节点「${nodeId}」不存在`);
        nodes[index] = { ...nodes[index], dependsOn: [...new Set(operation.dependsOn || [])] };
      }
      transaction.operations.push({ id: `operation-${crypto.randomUUID()}`, createdAt: new Date().toISOString(), operation });
    }
    raw.nodes = nodes;
    transaction.draftPlan = normalizeWorkflowPlan(raw);
    transaction.status = "editing";
    transaction.validationErrors = [];
    transaction.digest = null;
    return writeTransaction(target, transaction);
  });
}

export function validateWorkflowPlanTransaction(target: string) {
  return withTransactionFileLock(target, () => validateWorkflowPlanTransactionUnlocked(target));
}

function validateWorkflowPlanTransactionUnlocked(target: string) {
  const transaction = readWorkflowPlanTransaction(target);
  if (!["editing", "validated"].includes(transaction.status)) throw new Error("规划事务已经结束，不能执行校验");
  transaction.draftPlan = normalizeWorkflowPlan(transaction.draftPlan);
  transaction.validationErrors = validateWorkflowPlan(
    transaction.draftPlan,
    new Set(transaction.availableSkills),
    new Set(transaction.availableMcpServers),
    transaction.providerCapabilities
  );
  transaction.status = transaction.validationErrors.length ? "editing" : "validated";
  transaction.digest = transaction.validationErrors.length ? null : planDigest(transaction.draftPlan);
  writeTransaction(target, transaction);
  return { valid: transaction.validationErrors.length === 0, errors: transaction.validationErrors, digest: transaction.digest, plan: transaction.draftPlan };
}

export function commitWorkflowPlanTransaction(target: string) {
  return withTransactionFileLock(target, () => {
    const validation = validateWorkflowPlanTransactionUnlocked(target);
    if (!validation.valid) throw new Error(`候选计划校验未通过：${validation.errors.join("；")}`);
    const transaction = readWorkflowPlanTransaction(target);
    transaction.status = "committed";
    transaction.digest = validation.digest;
    return writeTransaction(target, transaction);
  });
}

export function finishWorkflowPlanTransactionWithoutChange(target: string, note: string) {
  return withTransactionFileLock(target, () => {
    const transaction = readWorkflowPlanTransaction(target);
    if (!["editing", "validated"].includes(transaction.status)) throw new Error("规划事务已经结束");
    transaction.status = "no_change";
    transaction.note = note.trim() || "用户没有提出需要修改计划的明确要求";
    transaction.validationErrors = [];
    transaction.digest = planDigest(transaction.draftPlan);
    return writeTransaction(target, transaction);
  });
}

export function abortWorkflowPlanTransaction(target: string, note: string) {
  return withTransactionFileLock(target, () => {
    const transaction = readWorkflowPlanTransaction(target);
    if (["committed", "no_change"].includes(transaction.status)) return transaction;
    transaction.status = "aborted";
    transaction.note = note.trim() || "规划事务已中止";
    return writeTransaction(target, transaction);
  });
}
