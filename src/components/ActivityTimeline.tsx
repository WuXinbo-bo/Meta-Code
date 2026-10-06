import { Activity, ChevronRight, Eye, FileCode2, Search, TerminalSquare, Wrench, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { commandActivitySummary } from "./AgentActivityEntry";
import { ActivityRenderer } from "./ActivityRenderer";
import { AgentPlanView } from "./AgentPlanView";
import { activityActionLabel, activityCategoryLabel, activityVisualTier, agentPlanSnapshot, isRoutineActivityStatus, normalizeActivityLogs, type ActivityCategory, type AgentPlanSnapshot, type ActivityViewLog } from "./activityModel";

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
  const retained: ActivityItem[] = [];
  for (const log of logs) {
    if (SUMMARY_CATEGORIES.has(log.category)) {
      const current = retained.at(-1);
      if (current?.type === "summary" && current.category === log.category) {
        current.logs.push(log);
      } else {
        const summary: Extract<ActivityItem, { type: "summary" }> = {
          type: "summary",
          id: `activity-summary-${log.category}-${log.id}`,
          category: log.category,
          logs: [log]
        };
        retained.push(summary);
      }
      continue;
    }
    if (log.category !== "reasoning" && !isRoutineActivityStatus(log)) {
      retained.push({ type: "log", log });
    }
  }
  return retained;
}

function liveActivityItems(logs: ActivityViewLog[], provider: string): ActivityItem[] {
  // Keep the completed portion of every open turn. The old implementation
  // retained only the newest operational event, which made earlier commands
  // and file changes disappear while a later tool was running. Build the
  // current segment with the same grouping rules as the settled timeline, then
  // mark the newest active event as the live focus without removing its peers.
  const boundary = logs.findLastIndex((log) => log.category === "message" || log.category === "result");
  const history = settledActivityItems(logs.slice(0, boundary + 1));
  const currentLogs = logs.slice(boundary + 1).filter((log) => log.category !== "message" && log.category !== "result");
  const latestOperational = [...currentLogs].reverse().find((log) => log.category !== "error");
  const latestActive = [...currentLogs].reverse().find((log) => log.phase === "running" || log.phase === "started") || latestOperational;
  const currentItems = planAwareActivities(currentLogs, provider);
  return [...history, ...currentItems.map((item): ActivityItem => item.type === "log" && item.log.id === latestActive?.id
    ? { type: "current", log: item.log }
    : item)];
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
  return <details className={`agent-stream-cluster activity-visual-${activityVisualTier(latest.category)} category-${latest.category} phase-${latestStatus}`} onToggle={(event) => setOpen(event.currentTarget.open)}>
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
      ? { ...log, title: "思考", text: "", detail: undefined, transient: isLiveTimeline(status) && log.phase === "running" && latest?.id === log.id }
      : { ...log, title: activityActionLabel(log, provider) };
    if (displayLog.category === "reasoning" && visible.at(-1)?.category === "reasoning") visible[visible.length - 1] = displayLog;
    else visible.push(displayLog);
  }
  return isLiveTimeline(status) ? liveActivityItems(visible, provider) : settledActivityItems(visible);
}

export function ActivityTimeline({ logs, status, provider, providerLabel, providerIcon, providerAccent, messageLabel, renderMessage, workspaceId, showProvider = true, showFilters = true, hiddenCategories = [], scrollRef: externalScrollRef }: {
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
  showFilters?: boolean;
  hiddenCategories?: readonly ActivityCategory[];
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const localScrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [phaseFilter, setPhaseFilter] = useState("all");
  const normalizedLogs = useMemo(() => normalizeActivityLogs(logs).filter((log) => !hiddenCategories.includes(log.category)), [logs, hiddenCategories]);
  const hasFilters = showFilters && Boolean(query.trim() || categoryFilter !== "all" || phaseFilter !== "all");
  const failureCount = useMemo(() => normalizedLogs.filter((log) => log.phase === "failed").length, [normalizedLogs]);
  const categories = useMemo(() => [...new Set(normalizedLogs.map((log) => log.category))].sort(), [normalizedLogs]);
  const filteredLogs = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return normalizedLogs.filter((log) => {
      if (categoryFilter !== "all" && log.category !== categoryFilter) return false;
      if (phaseFilter !== "all" && log.phase !== phaseFilter) return false;
      if (!needle) return true;
      return `${log.title} ${log.text} ${log.rawType || ""}`.toLocaleLowerCase().includes(needle);
    });
  }, [normalizedLogs, query, categoryFilter, phaseFilter]);
  // Search is an inspection view: every match remains individually accessible,
  // including historical live tools and reasoning/status events hidden by the
  // concise default presentation.
  const items = useMemo<ActivityItem[]>(() => hasFilters
    ? filteredLogs.map((log) => ({ type: "log", log: { ...log, transient: false } }))
    : minimalActivities(filteredLogs, provider, status), [filteredLogs, provider, status, hasFilters]);
  const virtualized = items.length > 40;
  const [scrollMargin, setScrollMargin] = useState(0);
  const [externalScrollElement, setExternalScrollElement] = useState<HTMLDivElement | null>(null);
  const filterKey = `${query}\u0000${categoryFilter}\u0000${phaseFilter}`;
  const previousFilterKeyRef = useRef(filterKey);
  useLayoutEffect(() => {
    if (previousFilterKeyRef.current === filterKey) return;
    previousFilterKeyRef.current = filterKey;
    const container = externalScrollRef?.current || localScrollRef.current;
    const list = listRef.current;
    if (container) container.scrollTop = externalScrollRef && list
      ? list.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      : 0;
  }, [filterKey, externalScrollRef]);
  // Parent refs are attached after child layout effects. Resolve an external
  // viewport after commit so an initially virtualized drawer cannot stay blank.
  useEffect(() => {
    if (!externalScrollRef) return;
    const container = externalScrollRef.current;
    const list = listRef.current;
    if (!container || !list) return;
    setExternalScrollElement(container);
    const measure = () => setScrollMargin(list.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    if (container.firstElementChild) observer.observe(container.firstElementChild);
    return () => observer.disconnect();
  }, [externalScrollRef, virtualized]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getItemKey: (index) => {
      const item = items[index];
      return item.type === "log" || item.type === "current" ? `${item.type}-${item.log.id}` : item.id;
    },
    getScrollElement: () => externalScrollRef ? externalScrollElement : localScrollRef.current,
    estimateSize: () => 32,
    overscan: 10,
    // Dynamic Markdown is measured during React commits and ResizeObserver
    // callbacks. Let React batch these updates instead of nesting flushSync.
    useFlushSync: false,
    useAnimationFrameWithResizeObserver: true,
    enabled: virtualized,
    scrollMargin
  });

  const renderItem = (item: ActivityItem) => item.type === "group"
    ? <CollapsedActivityGroup key={item.id} item={item} status={status} provider={provider} providerLabel={providerLabel} providerIcon={providerIcon} providerAccent={providerAccent} messageLabel={messageLabel} renderMessage={renderMessage} workspaceId={workspaceId} />
    : item.type === "summary"
      ? <CompletedActivitySummary key={item.id} item={item} status={status} provider={provider} providerLabel={providerLabel} providerIcon={providerIcon} providerAccent={providerAccent} messageLabel={messageLabel} renderMessage={renderMessage} workspaceId={workspaceId} />
    : item.type === "current"
      ? <div className="activity-live-current" key={`current-${item.log.id}`}><ActivityRenderer log={item.log} status={status} provider={provider} providerLabel={providerLabel} providerIcon={providerIcon} providerAccent={providerAccent} messageLabel={messageLabel} renderMessage={renderMessage} workspaceId={workspaceId} showProvider={showProvider} /></div>
    : item.type === "plan"
      ? <AgentPlanView key={item.id} snapshot={item.snapshot} history={item.history} />
    : <ActivityRenderer key={item.log.id} log={item.log} status={status} provider={provider} providerLabel={providerLabel} providerIcon={providerIcon} providerAccent={providerAccent} messageLabel={messageLabel} renderMessage={renderMessage} workspaceId={workspaceId} showProvider={showProvider} showReasoning={hasFilters} />;

  const rows = virtualized ? virtualizer.getVirtualItems() : [];
  return <div className="activity-timeline single-layer">
    {showFilters && (normalizedLogs.length > 3 || hasFilters || failureCount > 0) && <div className="activity-timeline-controls" role="search" aria-label="筛选活动">
      <Search size={13} aria-hidden="true" />
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索活动" aria-label="搜索活动" />
      <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} aria-label="活动类型">
        <option value="all">全部类型</option>
        {categories.map((category) => <option value={category} key={category}>{activityCategoryLabel(category)}</option>)}
      </select>
      <select value={phaseFilter} onChange={(event) => setPhaseFilter(event.target.value)} aria-label="活动状态">
        <option value="all">全部状态</option><option value="running">运行中</option><option value="completed">已完成</option><option value="failed">失败</option><option value="started">已开始</option>
      </select>
      {failureCount > 0 && <button className="activity-failure-filter" type="button" title="查看失败活动" aria-label={`查看 ${failureCount} 条失败活动`} aria-pressed={phaseFilter === "failed"} onClick={() => { setQuery(""); setCategoryFilter("all"); setPhaseFilter("failed"); }}>失败 {failureCount}</button>}
      {(query || categoryFilter !== "all" || phaseFilter !== "all") && <button type="button" title="清除筛选" aria-label="清除筛选" onClick={() => { setQuery(""); setCategoryFilter("all"); setPhaseFilter("all"); }}><X size={13} /></button>}
    </div>}
    {hasFilters && <p className="activity-timeline-result-count" role="status">匹配 {filteredLogs.length} / {normalizedLogs.length} 条活动</p>}
    {!items.length && normalizedLogs.length > 0 && <p className="activity-timeline-no-results" role="status">没有匹配的活动</p>}
    <div className={`activity-timeline-list ${virtualized ? "virtualized" : ""} ${externalScrollRef ? "external-scroll" : ""}`} ref={externalScrollRef ? listRef : localScrollRef}>
      {virtualized
        ? <div className="activity-virtual-content" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {rows.map((row) => <div className="activity-virtual-row" data-index={row.index} ref={virtualizer.measureElement} key={row.key} style={{ transform: `translateY(${row.start - scrollMargin}px)` }}>{renderItem(items[row.index])}</div>)}
        </div>
        : items.map(renderItem)}
    </div>
  </div>;
}
