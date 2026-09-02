import type { AgentProviderId } from "../agents/types.js";

export type EngineName = AgentProviderId;
export type SkillPolicy = "auto" | "always" | "manual" | "off";
export type AgentRuntimeStatus = "running" | "completed" | "failed" | "interrupted";

export type RestartableSession = {
  status?: string;
  stopReason?: string;
  lastError?: string;
  runFinishedAt?: string;
  updatedAt?: string;
  revision?: number;
};

export type RestartableDelegatedTask = {
  status: string;
  lastError?: string;
  updatedAt?: string;
  completedAt?: string;
};

export function recoverSessionAfterRestart<T extends RestartableSession>(session: T, now: string) {
  if (session.status !== "running") return { session, shouldResume: false };
  return {
    session: {
      ...session,
      status: "interrupted",
      stopReason: "crash",
      lastError: "工作台曾在任务运行中重启；正在自动恢复主任务上下文",
      runFinishedAt: now,
      updatedAt: now,
      revision: (session.revision || 0) + 1
    },
    shouldResume: true
  };
}

export function recoverDelegatedTaskAfterRestart<T extends RestartableDelegatedTask>(task: T, now: string) {
  if (task.status !== "queued" && task.status !== "running") return { task, changed: false };
  return {
    task: {
      ...task,
      status: "interrupted",
      lastError: "工作台服务曾重启；该子任务无法安全续接，主任务可根据结果决定是否补做",
      updatedAt: now,
      completedAt: task.completedAt || now
    },
    changed: true
  };
}

export function skillPolicyEnabled(policy: SkillPolicy | undefined, explicitlyInvoked = false) {
  return policy === "always" || policy === "auto" || (policy === "manual" && explicitlyInvoked);
}

export function delegationAdmission(parentOpenCount: number, globalOpenCount: number, perParentLimit: number, globalLimit: number) {
  if (parentOpenCount >= perParentLimit) return { accepted: false, reason: "parent-limit" as const };
  if (globalOpenCount >= globalLimit) return { accepted: false, reason: "global-limit" as const };
  return { accepted: true as const };
}

export function delegationIdempotency(existingFingerprint: string | undefined, requestFingerprint: string) {
  if (!existingFingerprint) return { deduplicated: true as const };
  if (existingFingerprint === requestFingerprint) return { deduplicated: true as const };
  return { deduplicated: false as const, conflict: true as const };
}

export function orchestrationCapabilities(engine: EngineName, delegationEnabled: boolean) {
  return {
    engine,
    nativeAgents: !delegationEnabled,
    bridgeClaude: delegationEnabled,
    bridgeCodex: delegationEnabled,
    requiresAcceptanceBarrier: delegationEnabled
  };
}

export function agentStatusForParent(status: AgentRuntimeStatus, parentIsRunning: boolean): AgentRuntimeStatus {
  return !parentIsRunning && status === "running" ? "interrupted" : status;
}

export function mergeAgentRuntimeStatus(existing: AgentRuntimeStatus, incoming: AgentRuntimeStatus): AgentRuntimeStatus {
  const terminal = new Set<AgentRuntimeStatus>(["completed", "failed"]);
  if (terminal.has(existing)) return existing;
  if (terminal.has(incoming)) return incoming;
  return incoming;
}

export function codexTerminalStatusFromMarkers(markers: string[]): Extract<AgentRuntimeStatus, "completed" | "failed"> | undefined {
  for (const value of markers) {
    const marker = value.trim().toLowerCase();
    if (marker === "turn.completed" || marker === "task_complete") return "completed";
    if (marker === "turn.failed" || marker === "task_failed") return "failed";
  }
  return undefined;
}
