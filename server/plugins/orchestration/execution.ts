import path from "node:path";
import type { WorkflowNodeCheck, WorkflowNodeOutput, WorkflowNodeRecord, WorkflowNodeResult } from "./types.js";

const stringList = (value: unknown) => Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
const nullableString = (value: unknown) => String(value || "").trim() || null;

export function workflowNodeCheckpointRoot(workDirectory: string, nodeId: string, planVersion: number) {
  return path.join(workDirectory, ".workflow", "nodes", nodeId, "plans", String(planVersion), "attempts");
}

function normalizeOutput(raw: unknown, index: number): WorkflowNodeOutput {
  const output = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const allowedTypes = new Set<WorkflowNodeOutput["type"]>(["file", "directory", "document", "data", "code", "text", "decision", "other"]);
  return {
    id: String(output.id || `output-${index + 1}`).trim(),
    type: allowedTypes.has(output.type as WorkflowNodeOutput["type"]) ? output.type as WorkflowNodeOutput["type"] : "other",
    path: nullableString(output.path),
    mediaType: nullableString(output.mediaType),
    description: String(output.description || "").trim(),
    consumableBy: stringList(output.consumableBy)
  };
}

function normalizeCheck(raw: unknown, index: number): WorkflowNodeCheck {
  const check = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const status: WorkflowNodeCheck["status"] = check.status === "passed" || check.status === "failed" ? check.status : "not_run";
  const exitCode = typeof check.exitCode === "number" && Number.isInteger(check.exitCode) ? check.exitCode : null;
  return { name: String(check.name || check.command || `检查 ${index + 1}`).trim(), command: nullableString(check.command), status, exitCode, evidence: String(check.evidence || "").trim() };
}

export function normalizeWorkflowNodeResult(value: unknown): WorkflowNodeResult {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const legacyArtifacts = stringList(source.artifacts);
  const outputs = Array.isArray(source.outputs)
    ? source.outputs.map(normalizeOutput).filter((output) => output.id && output.description)
    : legacyArtifacts.map((artifact, index) => ({ id: `legacy-output-${index + 1}`, type: "file" as const, path: artifact, mediaType: null, description: artifact, consumableBy: [] }));
  const legacyTests = Array.isArray(source.tests) ? source.tests : [];
  const checks = (Array.isArray(source.checks) ? source.checks : legacyTests).map(normalizeCheck).filter((check) => check.name);
  const decisions = Array.isArray(source.decisions) ? source.decisions.map((raw) => {
    const decision = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    return { key: String(decision.key || "").trim(), value: String(decision.value || "").trim(), reason: String(decision.reason || "").trim() };
  }).filter((decision) => decision.key && decision.value) : [];
  const handoffSource = source.handoff && typeof source.handoff === "object" && !Array.isArray(source.handoff) ? source.handoff as Record<string, unknown> : {};
  const outcome = source.outcome === "partial" || source.outcome === "blocked" || source.outcome === "failed" ? source.outcome : "completed";
  return {
    outcome,
    humanSummary: String(source.humanSummary || source.summary || "").trim(),
    outputs,
    changedFiles: stringList(source.changedFiles),
    checks,
    decisions,
    handoff: { facts: stringList(handoffSource.facts), constraints: stringList(handoffSource.constraints), nextAgentInstructions: stringList(handoffSource.nextAgentInstructions) },
    warnings: stringList(source.warnings).length ? stringList(source.warnings) : stringList(source.risks),
    unresolved: stringList(source.unresolved),
    machineResultPath: nullableString(source.machineResultPath)
  };
}

export function assertWorkflowNodeResultContract(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!source) throw new Error("执行结果必须是 JSON 对象");
  const requiredArrays = ["outputs", "changedFiles", "checks", "decisions", "warnings", "unresolved"];
  if (!(["completed", "partial", "blocked", "failed"] as unknown[]).includes(source.outcome)) throw new Error("执行结果缺少合法 outcome");
  if (!String(source.humanSummary || "").trim()) throw new Error("执行结果缺少 humanSummary");
  for (const key of requiredArrays) if (!Array.isArray(source[key])) throw new Error(`执行结果缺少数组字段 ${key}`);
  if (!source.handoff || typeof source.handoff !== "object" || Array.isArray(source.handoff)) throw new Error("执行结果缺少 handoff 对象");
  const handoff = source.handoff as Record<string, unknown>;
  for (const key of ["facts", "constraints", "nextAgentInstructions"]) if (!Array.isArray(handoff[key])) throw new Error(`执行结果 handoff 缺少数组字段 ${key}`);
  for (const [index, raw] of (source.outputs as unknown[]).entries()) {
    const output = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!output || !String(output.id || "").trim() || !String(output.type || "").trim() || !String(output.description || "").trim()) throw new Error(`执行结果 outputs[${index}] 不完整`);
    if (!["file", "directory", "document", "data", "code", "text", "decision", "other"].includes(String(output.type))) throw new Error(`执行结果 outputs[${index}] 类型无效`);
    if (!Array.isArray(output.consumableBy)) throw new Error(`执行结果 outputs[${index}] 缺少 consumableBy`);
  }
  for (const [index, raw] of (source.checks as unknown[]).entries()) {
    const check = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!check || !String(check.name || "").trim() || !["passed", "failed", "not_run"].includes(String(check.status))) throw new Error(`执行结果 checks[${index}] 不完整`);
  }
  for (const [index, raw] of (source.decisions as unknown[]).entries()) {
    const decision = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!decision || !String(decision.key || "").trim() || !String(decision.value || "").trim() || !String(decision.reason || "").trim()) throw new Error(`执行结果 decisions[${index}] 不完整`);
  }
  const outputIds = (source.outputs as Array<Record<string, unknown>>).map((output) => String(output.id).trim());
  if (new Set(outputIds).size !== outputIds.length) throw new Error("执行结果 outputs 包含重复 ID");
}

export function validateWorkflowNodeResultValue(value: unknown) {
  assertWorkflowNodeResultContract(value);
  return normalizeWorkflowNodeResult(value);
}

export function parseWorkflowNodeResult(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  const candidate = fenced || (start >= 0 && end > start ? text.slice(start, end + 1) : "");
  if (!candidate) throw new Error("执行 Agent 没有返回结构化结果 JSON");
  try {
    const parsed = JSON.parse(candidate);
    assertWorkflowNodeResultContract(parsed);
    return normalizeWorkflowNodeResult(parsed);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("执行结果")) throw error;
    throw new Error("执行 Agent 返回的结果 JSON 无效");
  }
}

export function workflowResultArtifactPaths(result: WorkflowNodeResult | null | undefined) {
  return result?.outputs.map((output) => output.path).filter((path): path is string => Boolean(path)) || [];
}

export type WorkflowNodeResultGateOptions = {
  downstreamNodeIds: string[];
  deliverables?: string[];
  artifactIssue?: (reportedPath: string) => string | null;
};

const pathRequiredOutputTypes = new Set<WorkflowNodeOutput["type"]>(["file", "directory", "document", "data", "code"]);

export function workflowNodeResultGateIssues(result: WorkflowNodeResult, options: WorkflowNodeResultGateOptions) {
  const issues: string[] = [];
  const downstream = new Set(options.downstreamNodeIds);
  const missingPaths = result.outputs.filter((output) => pathRequiredOutputTypes.has(output.type) && !output.path);
  if (missingPaths.length) issues.push(`文件类产物缺少路径：${missingPaths.map((output) => output.id).join(", ")}；无文件的结构化结论请改用 decision 或 text`);
  const invalidConsumers = result.outputs.flatMap((output) => output.consumableBy).filter((id) => !downstream.has(id));
  if (invalidConsumers.length) issues.push(`outputs 包含非下游消费节点：${[...new Set(invalidConsumers)].join(", ")}`);
  if (result.outcome === "completed" && result.unresolved.length) issues.push("outcome 为 completed 时 unresolved 必须为空；下游风险应写入 warnings 或 handoff");
  const failedChecks = result.checks.filter((check) => check.status === "failed");
  if (result.outcome === "completed" && failedChecks.length) issues.push(`completed 结果不能包含失败检查：${failedChecks.map((check) => check.name).join(", ")}`);
  for (const reportedPath of workflowResultArtifactPaths(result)) {
    const issue = options.artifactIssue?.(reportedPath);
    if (issue) issues.push(issue);
  }
  if (result.outcome === "completed") {
    const available = workflowResultArtifactPaths(result);
    const missingDeliverables = (options.deliverables || []).filter(looksLikeArtifactPath).filter((required) => !artifactMatches(required, available));
    if (missingDeliverables.length) issues.push(`缺少计划要求的文件产物声明：${missingDeliverables.join(", ")}`);
  }
  return [...new Set(issues)];
}

function looksLikeArtifactPath(value: string) {
  return /[\\/]/.test(value) || /\.[a-z0-9]{1,10}$/i.test(value.trim());
}

const normalizedArtifact = (value: string) => value.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();

export function artifactMatches(required: string, available: string[]) {
  const target = normalizedArtifact(required);
  return available.some((item) => {
    const candidate = normalizedArtifact(item);
    return candidate === target || candidate.endsWith(`/${target}`) || target.endsWith(`/${candidate}`);
  });
}

export function missingRequiredArtifacts(node: WorkflowNodeRecord, nodes: WorkflowNodeRecord[]) {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const upstreamArtifacts: string[] = [];
  const pending = [...node.dependsOn];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const upstream = byId.get(id);
    if (!upstream || upstream.status !== "completed") continue;
    upstreamArtifacts.push(...workflowResultArtifactPaths(upstream.summary));
    pending.push(...upstream.dependsOn);
  }
  return node.requiredArtifacts.filter((required) => !artifactMatches(required, upstreamArtifacts));
}

export function failedDependencyReason(node: WorkflowNodeRecord, nodes: WorkflowNodeRecord[]) {
  const failed = nodes.filter((item) => node.dependsOn.includes(item.id) && ["failed", "blocked", "canceled", "skipped"].includes(item.status));
  return failed.length ? `上游节点未成功：${failed.map((item) => `${item.title}（${item.status}）`).join("、")}` : null;
}

export type WorkflowFailureCategory = "transient" | "contract" | "scope" | "permanent";

export function workflowFailureCategory(error: unknown): WorkflowFailureCategory {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/timeout|超时|abort|中止|429|rate.?limit|econn|eai_again|socket|network|网络|temporar|unavailable|连接|host closed its stdout|exited with code 4294967295|thread.*(?:not found|missing|invalid)|(?:not found|missing|invalid).*thread/.test(message)) return "transient";
  if (/越出\s*writescope|write.?scope.*(?:outside|violation)|越界文件/.test(message)) return "scope";
  if (/结构化|json|产物|artifact|测试失败|检查失败|执行契约|缺少计划要求|summary|humansummary/.test(message)) return "contract";
  return "permanent";
}

export function workflowRetryLimit(category: WorkflowFailureCategory) {
  return category === "transient" ? 3 : category === "contract" ? 2 : 1;
}

export function workflowAgentRetryAllowed(provider: WorkflowNodeRecord["provider"], failurePolicy: WorkflowNodeRecord["failurePolicy"], attempt: number, retryLimit: number) {
  return provider !== "claude" && failurePolicy === "retry_then_review" && attempt < retryLimit;
}

export const WORKFLOW_CODEX_CONTEXT_RECOVERY_LIMIT = 1;

export function workflowCodexContextStrategy(node: Pick<WorkflowNodeRecord, "engineThreadId" | "contextRecoveryCount">) {
  const resume = Boolean(node.engineThreadId) && node.contextRecoveryCount < WORKFLOW_CODEX_CONTEXT_RECOVERY_LIMIT;
  return {
    mode: resume ? "resumed" as const : "fresh" as const,
    threadId: resume ? node.engineThreadId : null,
    recoveryCount: resume ? node.contextRecoveryCount + 1 : 0
  };
}
