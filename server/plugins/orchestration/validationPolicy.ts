import type { WorkflowNodeCheck, WorkflowNodeResult, WorkflowRecord } from "./types.js";

export type WorkflowValidationPolicy = {
  requested: "standard" | "strict" | "deterministic";
  effective: "strict" | "single-node-review" | "deterministic";
  reason: string;
};

/** A test-shaped claim by a model is not trusted evidence. The caller supplies host checkpoint checks. */
export function workflowValidationPolicy(workflow: WorkflowRecord, hostChecks: ReadonlyMap<string, readonly WorkflowNodeCheck[]>): WorkflowValidationPolicy {
  const requested = workflow.plan?.validationMode || "strict";
  if (requested === "strict") return { requested, effective: "strict", reason: "保留已批准的完整整合与独立验收" };
  const standard = (reason: string): WorkflowValidationPolicy => ({ requested, effective: workflow.nodes.length === 1 && workflow.nodes[0].status === "completed" ? "single-node-review" : "strict", reason });
  if (requested === "standard") return standard("单节点可直接沿用真实成果作为候选，仍进行独立语义验收；多节点保留整合");
  if (!workflow.plan || workflow.plan.questions.length || workflow.plan.risks.length || workflow.plan.assumptions.length || !workflow.nodes.length) return standard("计划仍有假设、问题或风险，需要语义验收");
  // Host-only finalization is deliberately limited to independent, machine-specified tasks.
  for (const node of workflow.nodes) {
    const result = node.summary;
    if (node.status !== "completed" || !result || result.outcome !== "completed" || !result.fileIntegrity) return standard("有节点缺少已验证完成结果，保留语义验收");
    if (node.dependsOn.length || node.mcpServers.length || node.constraints.length || node.nonGoals.length) return standard("存在依赖、业务工具或语义约束，需要语义验收");
    if (result.warnings.length || result.unresolved.length || result.decisions.length || result.handoff.constraints.length || result.handoff.nextAgentInstructions.length) return standard("结果仍含语义决定或待判断风险，需要独立验收");
    if (!result.outputs.length || result.outputs.some((output) => !output.path || !["file", "code", "data"].includes(output.type))) return standard("存在研究、文字或目录交付，需要语义验收");
    if (!node.verificationCommands.length || !node.acceptance.length || node.acceptance.some((criterion) => !node.verificationCommands.includes(criterion))) return standard("验收标准并非全部可由已批准命令直接判定，保留语义验收");
    const checks = hostChecks.get(node.id) || [];
    if (checks.some((check) => check.status !== "passed") || node.verificationCommands.some((command) => !checks.some((check) => check.command === command && check.status === "passed" && check.exitCode === 0))) return standard("缺少可信宿主命令成功证据，保留语义验收");
  }
  return { requested, effective: "deterministic", reason: "用户批准机器验收；所有标准都有宿主命令证据，且无待解释语义或跨节点依赖" };
}

export function aggregateWorkflowResults(workflow: WorkflowRecord): WorkflowNodeResult {
  const results = workflow.nodes.flatMap((node) => node.summary ? [{ node, result: node.summary }] : []);
  const single = results.length === 1 ? results[0].result : null;
  return {
    outcome: "completed",
    humanSummary: single?.humanSummary || results.map(({ node, result }) => `${node.title}：${result.humanSummary}`).join("\n\n"),
    outputs: results.flatMap(({ node, result }) => result.outputs.map((output) => ({ ...output, id: single ? output.id : `${node.id}:${output.id}` }))),
    changedFiles: [...new Set(results.flatMap(({ result }) => result.changedFiles))],
    checks: results.flatMap(({ result }) => result.checks),
    decisions: results.flatMap(({ result }) => result.decisions),
    handoff: {
      facts: results.flatMap(({ result }) => result.handoff.facts),
      constraints: results.flatMap(({ result }) => result.handoff.constraints),
      nextAgentInstructions: results.flatMap(({ result }) => result.handoff.nextAgentInstructions)
    },
    warnings: [...new Set(results.flatMap(({ result }) => result.warnings))],
    unresolved: [...new Set(results.flatMap(({ result }) => result.unresolved))],
    machineResultPath: null
  };
}
