export type TaskDeletionKind = "session" | "workflow";

export type TaskDeletionPolicy = {
  action: "delete" | "terminate-and-delete";
  requiresTermination: boolean;
  reason: string | null;
};

const ACTIVE_SESSION_STATUSES = new Set(["running", "paused"]);
const ACTIVE_WORKFLOW_STATUSES = new Set(["planning", "queued", "running", "integrating", "paused"]);

export function taskDeletionPolicy(kind: TaskDeletionKind, status: string, runtimeActive = false): TaskDeletionPolicy {
  const activeByStatus = kind === "session"
    ? ACTIVE_SESSION_STATUSES.has(status)
    : ACTIVE_WORKFLOW_STATUSES.has(status);
  const requiresTermination = activeByStatus || runtimeActive;
  return {
    action: requiresTermination ? "terminate-and-delete" : "delete",
    requiresTermination,
    reason: requiresTermination
      ? kind === "session"
        ? status === "paused" ? "任务已暂停，需要先结束保留的运行状态" : "任务仍在运行，需要先停止"
        : status === "paused" ? "任务编排已暂停，需要先取消" : "任务编排仍在执行，需要先取消并等待 Agent 退出"
      : null
  };
}
