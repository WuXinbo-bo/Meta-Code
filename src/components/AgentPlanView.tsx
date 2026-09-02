import { AlertCircle, Check, ChevronRight, Circle, ListChecks, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { AgentPlanItem, AgentPlanSnapshot } from "./activityModel";

function planItemIcon(item: AgentPlanItem) {
  if (item.status === "completed") return <Check size={12} />;
  if (item.status === "in_progress") return <LoaderCircle className="spin" size={12} />;
  if (item.status === "blocked" || item.status === "failed") return <AlertCircle size={12} />;
  return <Circle size={10} />;
}

function planStatus(snapshot: AgentPlanSnapshot) {
  if (snapshot.items.some((item) => item.status === "failed")) return "存在失败步骤";
  if (snapshot.items.some((item) => item.status === "blocked")) return "存在受阻步骤";
  if (snapshot.completed === snapshot.total) return "已完成";
  if (snapshot.items.some((item) => item.status === "in_progress")) return "执行中";
  return "待执行";
}

export function AgentPlanView({ snapshot, history }: { snapshot: AgentPlanSnapshot; history: AgentPlanSnapshot[] }) {
  const complete = snapshot.total > 0 && snapshot.completed === snapshot.total;
  const [open, setOpen] = useState(!complete);
  const time = new Date(snapshot.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return <details className={`agent-plan-view ${complete ? "complete" : "active"}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <span className="agent-plan-icon"><ListChecks size={14} /></span>
      <span className="agent-plan-heading"><strong>{snapshot.title}</strong><small>{planStatus(snapshot)}</small></span>
      <span className="agent-plan-progress">{snapshot.completed}/{snapshot.total}</span>
      <time>{time}</time>
      <ChevronRight className="agent-event-chevron" size={14} />
    </summary>
    <div className="agent-plan-content">
      <ol>
        {snapshot.items.map((item) => <li className={item.status} key={item.id}>
          <span>{planItemIcon(item)}</span>
          <p>{item.text}</p>
        </li>)}
      </ol>
      {history.length > 0 && <details className="agent-plan-history">
        <summary>查看 {history.length} 次更新</summary>
        <div>{history.map((revision) => <p key={revision.id}><time>{new Date(revision.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span>{revision.completed}/{revision.total} 项已完成</span></p>)}</div>
      </details>}
    </div>
  </details>;
}
