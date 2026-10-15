import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeWorkflowPlan, normalizeWorkflowProviderCapabilities, resolveWorkflowProvider, validateWorkflowPlan, type WorkflowProviderCapabilitiesInput } from "./plan.js";
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
  submissionBudget?: { failures: number; sameErrors: number; errorDigest: string | null; stopped: boolean; lastToolEventId?: string };
  operations: Array<{ id: string; createdAt: string; operation: WorkflowPlanEditOperation }>;
  validationErrors: string[];
  note: string | null;
  digest: string | null;
  createdAt: string;
  updatedAt: string;
};

const emptyPlan = (): WorkflowPlan => normalizeWorkflowPlan({
  title: "任务编排",
  // This is an unapproved placeholder, not a user delivery contract. Keep
  // the planner from inferring strict validation or creating a deliverables
  // directory before the model has understood the request.
  validationMode: "standard",
  finalDelivery: { required: false, directory: ".", primary: null, format: "", additional: [], producerNodeId: null, reason: "尚待规划确认用户成果" },
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

/** Fill mechanical fields without inventing goals, permissions or evidence. */
export function compileWorkflowPlanDraft(value: unknown, capabilities: WorkflowProviderCapabilitiesInput): WorkflowPlan {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const usedIds = new Set(Array.isArray(source.nodes) ? source.nodes.flatMap((item) => item && typeof item === "object" && item.id !== undefined ? [String(item.id).trim()] : []) : []);
  const nodes = Array.isArray(source.nodes) ? source.nodes.map((item) => {
    const node = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const access = node.workspaceAccess === "write" ? "write" : "read";
    const provider = String(node.provider || "auto");
    // IDs for unreferenced steps are mechanical. Existing references are never
    // remapped; referenced nodes should still carry an explicit stable ID.
    const generatedId = `step-${crypto.createHash("sha256").update(JSON.stringify([node.title || "", node.objective || "", access, node.writeScope || [], node.acceptance || []])).digest("hex").slice(0, 16)}`;
    let id = node.id;
    if (id === undefined) {
      let occurrence = 1;
      id = generatedId;
      while (usedIds.has(String(id))) id = `${generatedId}-${++occurrence}`;
      usedIds.add(String(id));
    }
    return { ...node, id, title: node.title || id, provider,
      providerReason: node.providerReason || `使用${provider === "auto" ? `工作区 ${access} 默认引擎 ${resolveWorkflowProvider(provider, access, capabilities)}` : `计划指定引擎 ${provider}`}；用户审批后执行` };
  }) : [];
  const plan = normalizeWorkflowPlan({ ...source, validationMode: source.validationMode || "standard", nodes });
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const depths = new Map<string, number>();
  const longest = (id: string, visited = new Set<string>()): number => {
    if (visited.has(id)) return 0; // Cycles remain errors in the normal validator.
    if (depths.has(id)) return depths.get(id)!;
    const node = byId.get(id); if (!node) return 0;
    const next = new Set([...visited, id]);
    const depth = 1 + Math.max(0, ...node.dependsOn.map((dependency) => longest(dependency, next)));
    depths.set(id, depth);
    return depth;
  };
  const notes: Record<string, string> = {
    "dependency-minimality": "宿主校验依赖存在、环路与传递性冗余；业务依赖合理性仍由规划与审批决定",
    "critical-path": `计划最长依赖链 ${Math.max(0, ...plan.nodes.map((node) => longest(node.id)))} 个节点；未推断工作时长`,
    "concurrency-utilization": `首批无依赖节点 ${plan.nodes.filter((node) => !node.dependsOn.length).length} 个；实际并发由调度器及范围锁控制`,
    "read-write-consistency": `写入节点 ${plan.nodes.filter((node) => node.workspaceAccess === "write").length} 个；权限范围与冲突由宿主门禁复核`,
    "provider-allocation": plan.nodes.map((node) => `${node.id}: ${node.providerReason}`).join("；") || "尚无节点",
    "final-delivery": plan.finalDelivery.required ? `主交付 ${plan.finalDelivery.primary || "未声明"}；生产节点 ${plan.finalDelivery.producerNodeId || "未声明"}` : plan.finalDelivery.reason || "无需独立文件的原因待说明"
  };
  for (const [key, note] of Object.entries(notes)) if (!plan.audit.checks.some((check) => check.key === key)) plan.audit.checks.push({ key, status: "passed", note });
  return plan;
}

export function submitWorkflowPlan(target: string, plan: unknown) {
  return withTransactionFileLock(target, () => {
    const transaction = readWorkflowPlanTransaction(target);
    let candidate: WorkflowPlan;
    try { candidate = compileWorkflowPlanDraft(plan, transaction.providerCapabilities); }
    catch (error) {
      if (!["editing", "validated"].includes(transaction.status)) throw error;
      const issue = workflowPlannerSubmissionIssue(transaction);
      if (issue) throw new Error(issue);
      transaction.validationErrors = [error instanceof Error ? error.message : String(error)];
      recordSubmissionValidation(transaction, transaction.validationErrors);
      transaction.status = "editing";
      transaction.digest = null;
      return writeTransaction(target, transaction);
    }
    if (transaction.status === "committed") {
      if (planDigest(candidate) !== transaction.digest) throw new Error("候选计划已封存，不能覆盖已提交版本");
      return transaction;
    }
    if (!["editing", "validated"].includes(transaction.status)) throw new Error("规划事务已经结束，不能继续修改");
    const budgetIssue = workflowPlannerSubmissionIssue(transaction);
    if (budgetIssue) throw new Error(budgetIssue);
    transaction.draftPlan = candidate;
    transaction.validationErrors = validateWorkflowPlan(candidate, new Set(transaction.availableSkills), new Set(transaction.availableMcpServers), transaction.providerCapabilities);
    recordSubmissionValidation(transaction, transaction.validationErrors);
    transaction.status = transaction.validationErrors.length ? "editing" : "committed";
    transaction.digest = transaction.validationErrors.length ? null : planDigest(candidate);
    transaction.operations.push({ id: `operation-${crypto.randomUUID()}`, createdAt: new Date().toISOString(), operation: { type: "set_plan_fields", fields: { fullReplacement: true } } });
    return writeTransaction(target, transaction);
  });
}

function recordSubmissionValidation(transaction: WorkflowPlanTransaction, errors: string[]) {
  const previous = transaction.submissionBudget || { failures: 0, sameErrors: 0, errorDigest: null, stopped: false };
  if (!errors.length) {
    transaction.submissionBudget = { ...previous, sameErrors: 0, errorDigest: null };
    return;
  }
  // Changing a title or summary cannot make a repeated format failure progress.
  const errorDigest = crypto.createHash("sha256").update(JSON.stringify([...new Set(errors)].sort())).digest("hex");
  const failures = previous.failures + 1;
  const sameErrors = previous.errorDigest === errorDigest ? previous.sameErrors + 1 : 1;
  transaction.submissionBudget = { failures, sameErrors, errorDigest, stopped: sameErrors >= 3 || failures >= 12 };
}

export function workflowPlannerSubmissionIssue(transaction: WorkflowPlanTransaction): string | null {
  return transaction.submissionBudget?.stopped
    ? "规划格式修复连续无进展或超过预算，已停止自动提交；请根据字段错误调整任务后显式重新规划"
    : null;
}

/** Schema failures before the MCP handler must count toward the same budget. */
export function recordWorkflowPlannerToolFailure(target: string, eventId: string, message: string) {
  return withTransactionFileLock(target, () => {
    const transaction = readWorkflowPlanTransaction(target);
    if (!["editing", "validated"].includes(transaction.status) || transaction.submissionBudget?.lastToolEventId === eventId) return transaction;
    const safeMessage = message.replace(/(?:sk-|sess-)[A-Za-z0-9._-]{12,}/gi, "[REDACTED]").slice(0, 2000);
    recordSubmissionValidation(transaction, [safeMessage || "规划工具参数格式错误"]);
    transaction.submissionBudget!.lastToolEventId = eventId;
    return writeTransaction(target, transaction);
  });
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
    const budgetIssue = workflowPlannerSubmissionIssue(transaction);
    if (budgetIssue) throw new Error(budgetIssue);
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
    const budgetIssue = workflowPlannerSubmissionIssue(transaction);
    if (budgetIssue) throw new Error(budgetIssue);
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
  const budgetIssue = workflowPlannerSubmissionIssue(transaction);
  if (budgetIssue) throw new Error(budgetIssue);
  transaction.draftPlan = normalizeWorkflowPlan(transaction.draftPlan);
  transaction.validationErrors = validateWorkflowPlan(
    transaction.draftPlan,
    new Set(transaction.availableSkills),
    new Set(transaction.availableMcpServers),
    transaction.providerCapabilities
  );
  recordSubmissionValidation(transaction, transaction.validationErrors);
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
