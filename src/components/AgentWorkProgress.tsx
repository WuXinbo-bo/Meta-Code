import { LoaderCircle } from "lucide-react";
import "./activity-progress.css";

const WORKING_STATUSES = new Set(["active", "integrating", "planning", "running", "validating"]);

export function agentWorkProgressLabel(status: string, loading = false) {
  const normalized = status.trim().toLowerCase().replace(/[ -]/g, "_");
  if (WORKING_STATUSES.has(normalized)) return "智能体正在工作";
  if (normalized === "queued") return "等待智能体开始";
  if (normalized === "waiting") return "正在等待智能体响应";
  return loading ? "正在读取活动日志…" : "";
}

/** A shared, visible tail indicator for main and child Agent transcripts. */
export function AgentWorkProgress({ status, loading = false, className = "" }: { status: string; loading?: boolean; className?: string }) {
  const label = agentWorkProgressLabel(status, loading);
  if (!label) return null;
  return <div className={`agent-work-progress ${className}`.trim()} role="status" aria-live="polite" aria-atomic="true">
    <LoaderCircle className="agent-work-progress__spinner" size={15} aria-hidden="true" />
    <span>{label}</span>
    <span className="agent-work-progress__dots" aria-hidden="true"><i /><i /><i /></span>
  </div>;
}
