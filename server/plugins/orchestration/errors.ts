import type { WorkflowNodeResult } from "./types.js";
export class WorkflowNodeOutcomeError extends Error {
  constructor(readonly result: WorkflowNodeResult, readonly allowAutomaticRetry = true) {
    const detail = result.unresolved.join("；") || result.warnings.join("；") || result.humanSummary;
    super(result.outcome === "blocked" ? `节点阻塞：${detail}` : result.outcome === "partial" ? `执行契约未满足：${detail}` : `节点执行失败：${detail}`);
    this.name = "WorkflowNodeOutcomeError";
  }
}

export class WorkflowNodeStageRetryError extends Error {
  constructor(readonly stage: "snapshot" | "verification", message: string) {
    super(message);
    this.name = "WorkflowNodeStageRetryError";
  }
}
