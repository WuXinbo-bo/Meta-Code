import { agentPlanSnapshot, formatAgentDuration, normalizeActivityLogs, summarizeAgentTurn, type SharedAgentLog } from "../components/activityModel";

export type WorkflowAgentResult = {
  outcome: "completed" | "partial" | "blocked" | "failed";
  humanSummary: string;
  outputs: Array<{ id: string; type: string; path: string | null; mediaType: string | null; description: string; consumableBy: string[] }>;
  changedFiles: string[];
  checks: Array<{ name: string; command: string | null; status: "passed" | "failed" | "not_run"; exitCode: number | null; evidence: string }>;
  decisions: Array<{ key: string; value: string; reason: string }>;
  handoff: { facts: string[]; constraints: string[]; nextAgentInstructions: string[] };
  warnings: string[];
  unresolved: string[];
  machineResultPath: string | null;
};

const stages: Record<string, string> = {
  draft: "待规划", planning: "正在规划", awaiting_approval: "等待批准", queued: "排队中", running: "正在执行", integrating: "正在验收",
  completed: "已完成", partial: "部分完成", needs_review: "需要处理", paused: "已暂停", failed: "未完成", canceled: "已取消",
  pending: "等待执行", ready: "准备执行", pause_requested: "正在暂停", restart_requested: "正在重启", retry_wait: "等待重试", blocked: "等待处理", interrupted: "等待恢复"
};
export const workflowStageLabel = (status: string) => stages[status] || status;
export const workflowTargetLabel = (target?: string) => target === "worktree" ? "Worktree" : target === "isolated" ? "隔离任务" : "当前项目";
export const workflowFolderLabel = (target?: string) => target === "worktree" ? "打开方案工作区" : target === "isolated" ? "打开任务目录" : "打开项目目录";
export const compactText = (text: string, max = 180) => text.replace(/\s+/gu, " ").trim().slice(0, max);

const genericAgentReplies = new Set(["agent 回复", "codex 回复", "claude 回复", "回复"]);

/** Machine receipts can be useful in the full transcript but are noise in a card preview. */
export function isWorkflowMachineActivity(log: { kind: string; title: string; text: string; detail?: unknown; category?: string }) {
  const text = log.text.trim();
  if (log.kind === "message") {
    if (genericAgentReplies.has(text.toLocaleLowerCase())) return true;
    // Parse known protocol envelopes only; business JSON is a valid Agent answer.
    if (text.startsWith("{")) {
      try {
        const value = JSON.parse(text) as Record<string, unknown>;
        if ((value.type === "result" && (typeof value.subtype === "string" || typeof value.session_id === "string"))
          || (typeof value.schemaVersion === "number" && typeof value.outcome === "string" && typeof value.humanSummary === "string")) return true;
      } catch { /* Partial text remains visible while streaming. */ }
    }
  }
  if (/^mcp__workbench[-_]workflow[-_](plan|result)__workflow_/u.test(log.title)) return true;
  const detail = log.detail && typeof log.detail === "object" && !Array.isArray(log.detail) ? log.detail as Record<string, unknown> : {};
  return typeof detail.server === "string" && /^workbench[-_]workflow[-_](plan|result)$/u.test(detail.server) && typeof detail.tool === "string" && detail.tool.startsWith("workflow_");
}

function activityText(log: { category: string; title: string; text: string }) {
  return log.category === "message" ? compactText(log.text, 90) : compactText(log.title, 90);
}

/** A business summary, not a percentage inferred from tool counts. */
export function workflowAgentPresentation(input: { status: string; provider: string; logs: readonly SharedAgentLog[]; objective?: string; result?: WorkflowAgentResult | null; now?: number }) {
  const logs = normalizeActivityLogs(input.logs);
  const plan = [...logs].reverse().map((log) => agentPlanSnapshot(log, input.provider)).find(Boolean);
  const visibleLogs = logs.filter((log) => !isWorkflowMachineActivity(log));
  const humanMessage = [...visibleLogs].reverse().find((log) => log.category === "message" && log.text.trim());
  const terminalActivity = [...visibleLogs].reverse().find((log) => log.phase === "failed" || log.category === "result" || (log.category === "status" && /完成|验收|通过|失败|阻塞|中断/u.test(`${log.title}${log.text}`)));
  const settled = ["completed", "failed", "canceled", "blocked"].includes(input.status);
  const activity = input.result || settled ? terminalActivity : [...visibleLogs].reverse().find((log) => ["message", "read", "file", "command", "todo"].includes(log.category) && log.text.trim()) || [...visibleLogs].reverse().find((log) => ["status", "result", "error"].includes(log.category) && log.text.trim());
  const stage = input.status === "running" && logs.some((log) => /开始系统验收/u.test(log.title)) ? "正在验收" : workflowStageLabel(input.status);
  const summarySource = input.result?.humanSummary
    || ((input.status === "planning" || input.status === "awaiting_approval" || input.status === "needs_review") && humanMessage?.text)
    || input.objective
    || activity?.text
    || "尚未开始执行";
  const summary = compactText(summarySource);
  const duration = summarizeAgentTurn(logs, input.status, input.now ?? Date.now()).activeDurationMs;
  const checks = input.result?.checks || [];
  const issueItems = [...new Set([...(input.result?.unresolved || []), ...(input.result?.warnings || [])])];
  return {
    stage, summary,
    activity: input.status === "completed" && !input.result ? "" : activity ? activityText(activity) : "",
    progress: plan?.total ? { completed: plan.completed, total: plan.total } : null,
    duration: duration > 0 ? formatAgentDuration(duration) : "",
    outputs: input.result?.outputs.length || 0,
    files: new Set(input.result?.changedFiles || []).size,
    checks: checks.length ? `${checks.filter((check) => check.status === "passed").length}/${checks.length} 验收` : "",
    issues: issueItems.length
  };
}

export function workflowOptionLabel(workflow: { title: string; status: string; activePlanVersion?: number; executionTarget?: string }) {
  return [compactText(workflow.title, 48), workflow.status ? workflowStageLabel(workflow.status) : "", workflow.activePlanVersion ? `v${workflow.activePlanVersion}` : "", workflow.executionTarget === "worktree" || workflow.executionTarget === "isolated" ? workflowTargetLabel(workflow.executionTarget) : ""].filter(Boolean).join(" · ");
}
