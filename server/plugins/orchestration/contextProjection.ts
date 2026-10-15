import type { WorkflowNodeRecord, WorkflowNodeResult, WorkflowRecord } from "./types.js";

/** Retain approved business clauses while omitting logs, machine paths and unrelated branches. */
export function workflowNodeInputs(workflow: WorkflowRecord, node: WorkflowNodeRecord, verified: ReadonlyMap<string, WorkflowNodeResult>) {
  const byId = new Map(workflow.nodes.map((item) => [item.id, item]));
  const ancestors = new Set<string>();
  const pending = [...node.dependsOn];
  while (pending.length) {
    const id = pending.pop()!;
    if (ancestors.has(id)) continue;
    ancestors.add(id);
    pending.push(...(byId.get(id)?.dependsOn || []));
  }
  return {
    dependencies: node.dependsOn.flatMap((id) => {
      const source = byId.get(id);
      const result = verified.get(id);
      return source && result ? [{ nodeId: id, title: source.title, outcome: result.outcome, humanSummary: result.humanSummary, outputs: result.outputs, decisions: result.decisions, handoff: result.handoff, warnings: result.warnings, unresolved: result.unresolved }] : [];
    }),
    ancestorContracts: workflow.nodes.filter((item) => ancestors.has(item.id)).map((item) => ({ nodeId: item.id, objective: item.objective, nonGoals: item.nonGoals, constraints: item.constraints, acceptance: item.acceptance, deliverables: item.deliverables })),
    requiredArtifacts: node.requiredArtifacts
  };
}
