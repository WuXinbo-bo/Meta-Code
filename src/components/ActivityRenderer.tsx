import { Activity, ChevronRight } from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";
import { AgentActivityEntry } from "./AgentActivityEntry";
import type { ActivityCategory, ActivityViewLog } from "./activityModel";

export type ActivityRendererProps = {
  log: ActivityViewLog;
  status: string;
  provider: string;
  providerLabel?: string;
  providerIcon?: string;
  providerAccent?: string;
  messageLabel?: string;
  renderMessage?: (text: string) => ReactNode;
  workspaceId?: string;
  expanded?: boolean;
};

function GenericActivityRenderer({ log, expanded = false }: ActivityRendererProps) {
  const [open, setOpen] = useState(expanded);
  const time = new Date(log.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const diagnostics = log.diagnostics || log.activity?.diagnostics || [];
  return <details className={`agent-stream-event activity-visual-external status category-unknown phase-${log.phase}`} open={expanded || undefined} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <span className="agent-event-icon neutral"><Activity size={13} /></span>
      <span><strong>{log.title || "未识别活动"}</strong><small>{log.text || log.rawType || "活动内容已保留"}</small></span>
      <time>{time}</time><span className="agent-stream-group-count" aria-hidden="true" /><ChevronRight className="agent-event-chevron" size={14} />
    </summary>
    {open && <div className="agent-event-detail">
      <p>{log.text || "该事件来自较新的 CLI 协议，工作台已保留原始内容。"}</p>
      {diagnostics.map((diagnostic) => <p key={`${diagnostic.code}:${diagnostic.message}`}>{diagnostic.message}</p>)}
      {log.detail !== undefined && <details><summary>技术详情</summary><pre>{JSON.stringify(log.detail, null, 2)}</pre></details>}
    </div>}
  </details>;
}

const ACTIVITY_RENDERERS: Partial<Record<ActivityCategory, ComponentType<ActivityRendererProps>>> = {
  unknown: GenericActivityRenderer
};

/** One registry owns rendering for main, native, delegated and workflow activity surfaces. */
export function ActivityRenderer(props: ActivityRendererProps) {
  const Renderer = ACTIVITY_RENDERERS[props.log.category];
  return Renderer ? <Renderer {...props} /> : <AgentActivityEntry {...props} />;
}
