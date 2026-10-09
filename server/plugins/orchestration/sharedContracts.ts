import type { WorkflowPlanNode, WorkflowSharedContract } from "./types.js";

const PREFIX = "[共享合同 ";
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const key = (contract: WorkflowSharedContract) => `${contract.id}@${contract.version}`;

/** Expand once at the host boundary; the model defines each shared rule in one place. */
export function compileWorkflowSharedContracts(source: Record<string, unknown>, nodes: WorkflowPlanNode[]) {
  if (source.sharedContracts !== undefined && !Array.isArray(source.sharedContracts)) throw new Error("共享合同必须为数组");
  const rawContracts = Array.isArray(source.sharedContracts) ? source.sharedContracts : [];
  if (rawContracts.length > 40) throw new Error("共享合同最多 40 项");
  const sharedContracts = rawContracts.map((value): WorkflowSharedContract => {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (!ID.test(String(raw.id || "")) || !Number.isSafeInteger(raw.version) || Number(raw.version) < 1) throw new Error("共享合同需要合法 id 和正整数 version");
    if (!Array.isArray(raw.constraints) || !raw.constraints.length || raw.constraints.length > 40 || raw.constraints.some((clause) => typeof clause !== "string" || !clause.trim() || clause.length > 4000)) throw new Error("共享合同约束必须为非空文字列表，每项最多 4000 字符");
    return { id: String(raw.id), version: Number(raw.version), constraints: [...new Set(raw.constraints.map((clause) => String(clause).trim()))] };
  });
  const byKey = new Map(sharedContracts.map((contract) => [key(contract), contract]));
  if (byKey.size !== sharedContracts.length) throw new Error("共享合同 id@version 重复");
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const compiled = nodes.map((node, index) => {
    const raw = rawNodes[index] && typeof rawNodes[index] === "object" ? rawNodes[index] as Record<string, unknown> : {};
    if (raw.contractRefs !== undefined && (!Array.isArray(raw.contractRefs) || raw.contractRefs.some((ref) => typeof ref !== "string" || !/^[a-z][a-z0-9-]{0,63}@[1-9][0-9]*$/.test(ref)))) throw new Error("共享合同引用必须为 id@version 字符串数组");
    const refs = Array.isArray(raw.contractRefs) ? [...new Set(raw.contractRefs as string[])] : [];
    if (refs.length > 40) throw new Error("单节点共享合同引用最多 40 项");
    if (!refs.length && !sharedContracts.length && raw.contractRefs === undefined && source.sharedContracts === undefined) return node;
    const constraints = node.constraints.filter((clause) => !clause.startsWith(PREFIX));
    for (const ref of refs) {
      const contract = byKey.get(ref);
      if (contract) constraints.push(...contract.constraints.map((clause) => `${PREFIX}${ref}] ${clause}`));
    }
    return { ...node, constraints, ...(refs.length || raw.contractRefs !== undefined ? { contractRefs: refs } : {}) };
  });
  return { nodes: compiled, ...(sharedContracts.length || source.sharedContracts !== undefined ? { sharedContracts } : {}) };
}

export function workflowSharedContractIssues(plan: { sharedContracts?: WorkflowSharedContract[]; nodes: WorkflowPlanNode[] }) {
  const keys = new Set((plan.sharedContracts || []).map(key));
  return plan.nodes.flatMap((node) => (node.contractRefs || []).filter((ref) => !keys.has(ref)).map((ref) => `节点「${node.id}」引用不存在的共享合同：${ref}`));
}
