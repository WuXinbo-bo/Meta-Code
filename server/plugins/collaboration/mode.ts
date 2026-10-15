import type { ExecutionMode, SkillPolicies } from "../../workbench/types.js";
/** Read compatibility only. This name is never used as a runtime capability. */
export const LEGACY_DELEGATION_SKILL = "claude-codex-planner";
export function resolveExecutionMode(value: unknown, legacyPolicies: SkillPolicies = {}): ExecutionMode {
  if (value === "native" || value === "collaborative") return value;
  return ["auto", "always"].includes(legacyPolicies[LEGACY_DELEGATION_SKILL]) ? "collaborative" : "native";
}
export function withoutDelegationSkill(policies: SkillPolicies): SkillPolicies {
  return Object.fromEntries(Object.entries(policies).filter(([name]) => name !== LEGACY_DELEGATION_SKILL));
}

/** New queued turns carry a mode snapshot; legacy turns retain their policy semantics. */
export function resolveTurnExecutionMode(value: unknown, policies: SkillPolicies, fallback: ExecutionMode): ExecutionMode {
  if (value === "native" || value === "collaborative" || policies[LEGACY_DELEGATION_SKILL] !== undefined) return resolveExecutionMode(value, policies);
  return fallback;
}
