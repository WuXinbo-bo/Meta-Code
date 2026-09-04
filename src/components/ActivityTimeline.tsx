import { Activity, ChevronRight, Eye, FileCode2, Search, TerminalSquare, Wrench } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { commandActivitySummary } from "./AgentActivityEntry";
import { ActivityRenderer } from "./ActivityRenderer";
import { AgentPlanView } from "./AgentPlanView";
import { activityActionLabel, activityCategoryLabel, activityVisualTier, agentPlanSnapshot, isRoutineActivityStatus, normalizeActivityLogs, type AgentPlanSnapshot, type ActivityViewLog } from "./activityModel";

type ActivityItem =
  | { type: "log"; log: ActivityViewLog }
  | { type: "current"; log: ActivityViewLog }
  | { type: "group"; id: string; logs: ActivityViewLog[] }
  | { type: "summary"; id: string; category: ActivityViewLog["category"]; logs: ActivityViewLog[] }
  | { type: "plan"; id: string; snapshot: AgentPlanSnapshot; history: AgentPlanSnapshot[] };

const COLLAPSIBLE_CATEGORIES = new Set(["command", "file", "read", "search", "tool", "mcp", "todo", "status"]);
const SUMMARY_CATEGORIES = new Set<ActivityViewLog["category"]>(["command", "file", "read", "search", "tool", "mcp", "todo"]);
const LIVE_STATUSES = new Set(["active", "integrating", "planning", "queued", "running", "validating", "waiting"]);
function canCollapse(left: ActivityViewLog, right: ActivityViewLog) {
  return COLLAPSIBLE_CATEGORIES.has(left.category) && left.category === right.category;
}

function collapseRepeatingActivities(logs: ActivityViewLog[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const log of logs) {
    const previous = items.at(-1);
    if (previous?.type === "group" && canCollapse(previous.logs.at(-1)!, log)) {
      previous.logs.push(log);
    } else if (previous?.type === "log" && canCollapse(previous.log, log)) {
      items[items.length - 1] = { type: "group", id: `activity-group-${previous.log.id}`, logs: [previous.log, log] };
    } else {
      items.push({ type: "log", log });
    }
  }
  return items;
}

function planAwareActivities(logs: ActivityViewLog[], provider: string): ActivityItem[] {
  const snapshots = logs.flatMap((log) => {
    const snapshot = agentPlanSnapshot(log, provider);
    return snapshot ? [{ log, snapshot }] : [];
  });
  if (!snapshots.length) return collapseRepeatingActivities(logs);
  const latest = snapshots.at(-1)!;
  const planIds = new Set(snapshots.map(({ log }) => log.id));
  const items = collapseRepeatingActivities(logs.filter((log) => !planIds.has(log.id)));
  const latestIndex = logs.findIndex((log) => log.id === latest.log.id);
  const insertionIndex = items.findIndex((item) => {
    const source = item.type === "group" ? item.logs[0] : item.type === "log" ? item.log : null;
    return source ? logs.findIndex((log) => log.id === source.id) > latestIndex : false;
  });
  const plan: ActivityItem = { type: "plan", id: `agent-plan-${latest.snapshot.id}`, snapshot: latest.snapshot, history: snapshots.slice(0, -1).map(({ snapshot }) => snapshot) };
  items.splice(insertionIndex < 0 ? items.length : insertionIndex, 0, plan);
  return items;
}

function categoryIcon(category: ActivityViewLog["category"]) {
  if (category === "command") return <TerminalSquare size={13} />;
  if (category === "file") return <FileCode2 size={13} />;
  if (category === "read") return <Eye size={13} />;
  if (category === "search") return <Search size={13} />;
  if (["tool", "mcp", "todo"].includes(category)) return <Wrench size={13} />;
  return <Activity size={13} />;
}

function activityGroupLabel(category: ActivityViewLog["category"], count: number) {
  if (category === "command") return `运行 ${count} 个命令`;
  if (category === "file") return `修改 ${count} 项文件`;
  if (category === "read") return `读取 ${count} 项资料`;
  if (category === "search") return `搜索 ${count} 次`;
  if (category === "mcp") return `调用 ${count} 个 MCP`;
  if (category === "tool") return `调用 ${count} 个工具`;
  return `${activityCategoryLabel(category)} ${count} 项`;
}

function normalizedStatus(status: string) {
  return status.trim().toLowerCase().replace(/[ -]/g, "_");
}

function isLiveTimeline(status: string) {
  return LIVE_STATUSES.has(normalizedStatus(status));
}

function settledActivityItems(logs: ActivityViewLog[]): ActivityItem[] {
  const summaries = new Map<ActivityViewLog["category"], Extract<ActivityItem, { type: "summary" }>>();
  const retained: ActivityItem[] = [];
  for (const log of logs) {
    if (SUMMARY_CATEGORIES.has(log.category)) {
      const current = summaries.get(log.category);
      if (current) {
        current.logs.push(log);
      } else {
        const summary: Extract<ActivityItem, { type: "summary" }> = {
          type: "summary",
          id: `activity-summary-${log.category}-${log.id}`,
          category: log.category,
          logs: [log]
        };
        summaries.set(log.category, summary);
        retained.push(summary);
      }
      continue;
    }
    if (log.category === "error" || log.kind === "error" || log.category === "message" || log.category === "result") {
      retained.push({ type: "log", log });
    }
  }
  return retained;
}

function liveActivityItems(logs: ActivityViewLog[], provider: string): ActivityItem[] {
  const latestOperational = [...logs].reverse().find((log) => !["message", "result", "error"].includes(log.category));
  const retained = logs.filter((log) => log.category === "message" || log.category === "result" || log.category === "error" || log.kind === "error");
  if (latestOperational && !retained.some((log) => log.id === latestOperational.id)) retained.push(latestOperational);
  retained.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return planAwareActivities(retained, provider).map((item) => item.type === "log" && item.log.id === latestOperational?.id
    ? { type: "current", log: item.log }
    : item);
}

function CompletedActivitySummary({ item, status, provider, providerLabel, providerIcon, providerAccent, messageLabel, renderMessage, workspaceId }: {
  item: Extract<ActivityItem, { type: "summary" }>;
  status: string;
  provider: string;
  providerLabel?: string;
  providerIcon?: string;
  providerAccent?: string;
  messageLabel?: string;
  renderMessage?: (text: string) => ReactNode;
  workspaceId?: string;
}) {
  const [open, setOpen] = useState(false);
  const categoryLabel = activityCategoryLabel(item.category);
  return <details className={`activity-summary-group activity-visual-${activityVisualTier(item.category)} category-${item.category}`} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary title={`展开 ${item.logs.length} 条${categoryLabel}活动`}>
      <span className="agent-event-icon completed">{categoryIcon(item.category)}</span>
      <strong>{activityGroupLabel(item.category, item.logs.length)}</strong>
      <ChevronRight className="agent-event-chevron" size={14} />
    </summary>
    {open && <div className="activity-summary-details">
      {item.logs.map((log) => <ActivityRenderer key={log.id} log={log} status={status} provider={provider} providerLabel={providerLabel} providerIcon={providerIcon} providerAccent={providerAccent} messageLabel={messageLabel} renderMessage={renderMessage} workspaceId={workspaceId} />)}
    </div>}
  </details>;
}

function CollapsedActivityGroup({ item, status, provider, providerLabel, providerIcon, providerAccent, messageLabel, renderMessage, workspaceId }: {
  item: Extract<ActivityItem, { type: "group" }>;
  status: string;
  provider: string;
  providerLabel?: string;
  providerIcon?: string;
  providerAccent?: string;
  messageLabel?: string;
  renderMessage?: (text: string) => ReactNode;
  workspaceId?: string;
}) {
  const [open, setOpen] = useState(false);
  const latest = item.logs.at(-1)!;
  const time = new Date(latest.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const summary = (latest.category === "command" ? commandActivitySummary(latest) : latest.text || "状态已更新").replace(/\s+/g, " ").trim();
  const latestStatus = latest.phase === "failed" || latest.kind === "error" ? "failed" : latest.phase === "completed" ? "completed" : latest.phase === "running" ? "running" : status;
  const categoryLabel = activityCategoryLabel(latest.category);
  const groupLabel = activityGroupLabel(latest.category, item.logs.length);
  return <details className={`agent-stream-cluster activity-visual-${activityVisualTier(latest.category)} category-${latest.category}`} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary title={`展开 ${item.logs.length} 条${categoryLabel}活动`}>
      <span className={`agent-event-icon ${latestStatus}`}>{categoryIcon(latest.category)}</span>
      <span className="agent-stream-copy"><strong>{groupLabel}</strong><small>{summary}</small></span>
      <time>{time}</time>
      <span className="agent-stream-group-count">{item.logs.length}</span>
      <ChevronRight className="agent-event-chevron" size={14} />
    </summary>
    {open && <div className="agent-stream-cluster-items">
      {item.logs.map((log) => <ActivityRenderer key={log.id} log={log} status={status} provider={provider} providerLabel={providerLabel} providerIcon={providerIcon} providerAccent={providerAccent} messageLabel={messageLabel} renderMessage={renderMessage} workspaceId={workspaceId} />)}
    </div>}
  </details>;
}

function minimalActivities(logs: readonly unknown[], provider: string, status: string) {
  const normalized = normalizeActivityLogs(logs);
  const latest = [...normalized].reverse().find((log) => !isRoutineActivityStatus(log));
  const visible: ActivityViewLog[] = [];
  for (const log of normalized) {
    if (isRoutineActivityStatus(log)) continue;
    const displayLog = log.category === "reasoning"
      ? { ...log, title: "思考", text: "", detail: undefined, transient: status === "running" && latest?.id === log.id }
      : { ...log, title: activityActionLabel(log, provider) };
    if (displayLog.category === "reasoning" && visible.at(-1)?.category === "reasoning") visible[visible.length - 1] = displayLog;
    else visible.push(displayLog);
  }
  return isLiveTimeline(status) ? liveActivityItems(visible, provider) : settledActivityItems(visible);
}

export function ActivityTimeline({ logs, status, provider, providerLabel, providerIcon, providerAccent, messageLabel, renderMessage, workspaceId }: {
  logs: readonly unknown[];
  status: string;
  provider: string;
  providerLabel?: string;
  providerIcon?: string;
  providerAccent?: string;
  messageLabel?: string;
  renderMessage?: (text: string) => ReactNode;
  workspaceId?: string;
  showProvider?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => minimalActivities(logs, provider, status), [logs, provider, status]);
  const virtualized = items.length > 80;
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 32,
    overscan: 10,
    enabled: virtualized
  });

  const renderItem = (item: ActivityItem) => item.type === "group"
    ? <CollapsedActivityGroup key={item.id} item={item} status={status} provider={provider} providerLabel={providerLabel} providerIcon={providerIcon} providerAccent={providerAccent} messageLabel={messageLabel} renderMessage={renderMessage} workspaceId={workspaceId} />
    : item.type === "summary"
      ? <CompletedActivitySummary key={item.id} item={item} status={status} provider={provider} providerLabel={providerLabel} providerIcon={providerIcon} providerAccent={providerAccent} messageLabel={messageLabel} renderMessage={renderMessage} workspaceId={workspaceId} />
    : item.type === "current"
      ? <div className="activity-live-current" key={`current-${item.log.id}`}><ActivityRenderer log={item.log} status={status} provider={provider} providerLabel={providerLabel} providerIcon={providerIcon} providerAccent={providerAccent} messageLabel={messageLabel} renderMessage={renderMessage} workspaceId={workspaceId} /></div>
    : item.type === "plan"
      ? <AgentPlanView key={item.id} snapshot={item.snapshot} history={item.history} />
    : <ActivityRenderer key={item.log.id} log={item.log} status={status} provider={provider} providerLabel={providerLabel} providerIcon={providerIcon} providerAccent={providerAccent} messageLabel={messageLabel} renderMessage={renderMessage} workspaceId={workspaceId} />;

  const rows = virtualized ? virtualizer.getVirtualItems() : [];
  return <div className="activity-timeline single-layer">
    <div className={`activity-timeline-list ${virtualized ? "virtualized" : ""}`} ref={scrollRef}>
      {virtualized
        ? <div className="activity-virtual-content" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {rows.map((row) => <div className="activity-virtual-row" data-index={row.index} ref={virtualizer.measureElement} key={row.key} style={{ transform: `translateY(${row.start}px)` }}>{renderItem(items[row.index])}</div>)}
        </div>
        : items.map(renderItem)}
    </div>
  </div>;
}
