export type SharedAgentLog = {
  schemaVersion?: number;
  id: string;
  createdAt: string;
  kind: "status" | "message" | "tool" | "result" | "error" | "reasoning";
  title: string;
  text: string;
  category?: string;
  phase?: "started" | "running" | "completed" | "failed";
  detail?: unknown;
  rawType?: string;
  provider?: string;
  actor?: { kind: "main" | "native" | "delegated" | "workflow" | "unknown"; id?: string; parentId?: string; name?: string };
  scope?: { sessionId?: string; threadId?: string; turnId?: string; workflowId?: string; nodeId?: string; attempt?: number };
  artifactRefs?: Array<{ id: string; kind: string; mediaType?: string; size?: number; path?: string }>;
  diagnostics?: Array<{ code: string; message: string; level: "info" | "warning" | "error" }>;
  activity?: {
    schemaVersion: number;
    id: string;
    sourceId?: string;
    rawType: string;
    provider: string;
    actor: { kind: "main" | "native" | "delegated" | "workflow" | "unknown"; id?: string; parentId?: string; name?: string };
    scope?: SharedAgentLog["scope"];
    semanticType: ActivityCategory;
    phase: ActivityPhase;
    occurredAt: string;
    title: string;
    summary: string;
    detail?: unknown;
    artifactRefs?: SharedAgentLog["artifactRefs"];
    diagnostics?: SharedAgentLog["diagnostics"];
  };
  transient?: boolean;
};

export type ActivityCategory = "command" | "tool" | "file" | "read" | "search" | "reasoning" | "mcp" | "todo" | "status" | "result" | "error" | "message" | "unknown";
export type ActivityPhase = "started" | "running" | "completed" | "failed";
export type ActivityViewLog = SharedAgentLog & { category: ActivityCategory; phase: ActivityPhase; fingerprint: string };
export type ActivityVisualTier = "command" | "file" | "external" | "response";
export type AgentPlanItemStatus = "pending" | "in_progress" | "completed" | "blocked" | "failed";
export type AgentPlanItem = { id: string; text: string; status: AgentPlanItemStatus };
export type AgentPlanSnapshot = {
  id: string;
  title: string;
  items: AgentPlanItem[];
  completed: number;
  total: number;
  updatedAt: string;
  provider: string;
};
export type AgentTurnSummary = {
  startedAt: number | null;
  endedAt: number | null;
  activeDurationMs: number;
  state: "running" | "paused" | "completed" | "failed" | "waiting" | "historical";
  counts: Partial<Record<ActivityCategory, number>>;
};

const normalized = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
const LOG_KINDS = new Set<SharedAgentLog["kind"]>(["status", "message", "tool", "result", "error", "reasoning"]);
const LOG_PHASES = new Set<NonNullable<SharedAgentLog["phase"]>>(["started", "running", "completed", "failed"]);
const ACTIVITY_CATEGORIES = new Set<ActivityCategory>(["command", "tool", "file", "read", "search", "reasoning", "mcp", "todo", "status", "result", "error", "message", "unknown"]);

function recordOf(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function planItemStatus(value: unknown, completed: unknown): AgentPlanItemStatus {
  if (completed === true) return "completed";
  const status = typeof value === "string" ? normalized(value).replace(/[ -]/g, "_") : "";
  if (["completed", "complete", "done", "succeeded", "success"].includes(status)) return "completed";
  if (["in_progress", "inprogress", "active", "running", "started"].includes(status)) return "in_progress";
  if (["blocked", "waiting", "paused"].includes(status)) return "blocked";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "failed";
  return "pending";
}

function planItemsFrom(value: unknown): AgentPlanItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const item = recordOf(entry);
    const text = [item.text, item.content, item.subject, item.title, item.description]
      .find((candidate) => typeof candidate === "string" && candidate.trim());
    if (typeof text !== "string") return [];
    return [{
      id: String(item.id ?? item.taskId ?? item.task_id ?? index),
      text: text.trim(),
      status: planItemStatus(item.status, item.completed)
    }];
  });
}

/** Converts provider-specific TodoWrite/todo_list payloads into one view model. */
export function agentPlanSnapshot(log: ActivityViewLog, provider: string): AgentPlanSnapshot | null {
  if (log.category !== "todo") return null;
  const detail = recordOf(log.detail);
  const input = recordOf(detail.input);
  const candidates = [detail.items, detail.todos, detail.tasks, input.items, input.todos, input.tasks];
  const items = candidates.map(planItemsFrom).find((candidate) => candidate.length > 0) || [];
  if (!items.length) return null;
  const title = [detail.title, input.title].find((candidate) => typeof candidate === "string" && candidate.trim());
  return {
    id: log.id,
    title: typeof title === "string" ? title.trim() : "计划",
    items,
    completed: items.filter((item) => item.status === "completed").length,
    total: items.length,
    updatedAt: log.createdAt,
    provider
  };
}

function validTimestamp(value: unknown, index: number) {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  return new Date(index).toISOString();
}

/** Runtime boundary for current events, historical state and workflow logs. */
export function normalizeAgentStreamLog(value: unknown, index = 0): SharedAgentLog {
  const source = recordOf(value);
  const activity = recordOf(source.activity);
  const kindValue = typeof source.kind === "string" ? source.kind as SharedAgentLog["kind"] : "status";
  const kind = LOG_KINDS.has(kindValue) ? kindValue : "status";
  const title = typeof activity.title === "string" && activity.title.trim()
    ? activity.title
    : typeof source.title === "string" && source.title.trim()
    ? source.title
    : kind === "message" ? "Agent 回复" : kind === "error" ? "执行失败" : "状态更新";
  const phaseValue = typeof activity.phase === "string" ? activity.phase as NonNullable<SharedAgentLog["phase"]> : typeof source.phase === "string" ? source.phase as NonNullable<SharedAgentLog["phase"]> : undefined;
  return {
    schemaVersion: typeof activity.schemaVersion === "number" ? activity.schemaVersion : typeof source.schemaVersion === "number" ? source.schemaVersion : undefined,
    id: typeof activity.id === "string" && activity.id ? activity.id : typeof source.id === "string" && source.id ? source.id : `legacy-agent-log-${index}`,
    createdAt: validTimestamp(activity.occurredAt ?? source.createdAt, index),
    kind,
    title,
    text: typeof activity.summary === "string" ? activity.summary : typeof source.text === "string" ? source.text : title,
    category: typeof activity.semanticType === "string" ? activity.semanticType : typeof source.category === "string" ? source.category : undefined,
    phase: phaseValue && LOG_PHASES.has(phaseValue) ? phaseValue : undefined,
    detail: activity.detail ?? source.detail,
    rawType: typeof activity.rawType === "string" ? activity.rawType : typeof source.rawType === "string" ? source.rawType : undefined,
    provider: typeof (activity.provider ?? source.provider) === "string" && String(activity.provider ?? source.provider).trim() ? String(activity.provider ?? source.provider) : undefined,
    actor: activity.actor && typeof activity.actor === "object" && !Array.isArray(activity.actor) ? activity.actor as SharedAgentLog["actor"] : source.actor && typeof source.actor === "object" && !Array.isArray(source.actor) ? source.actor as SharedAgentLog["actor"] : undefined,
    scope: activity.scope && typeof activity.scope === "object" && !Array.isArray(activity.scope) ? activity.scope as SharedAgentLog["scope"] : source.scope && typeof source.scope === "object" && !Array.isArray(source.scope) ? source.scope as SharedAgentLog["scope"] : undefined,
    artifactRefs: Array.isArray(activity.artifactRefs) ? activity.artifactRefs as SharedAgentLog["artifactRefs"] : Array.isArray(source.artifactRefs) ? source.artifactRefs as SharedAgentLog["artifactRefs"] : undefined,
    diagnostics: Array.isArray(activity.diagnostics) ? activity.diagnostics as SharedAgentLog["diagnostics"] : Array.isArray(source.diagnostics) ? source.diagnostics as SharedAgentLog["diagnostics"] : undefined,
    activity: Object.keys(activity).length ? activity as SharedAgentLog["activity"] : undefined,
    transient: source.transient === true
  };
}

export function agentStreamVersion(logs: readonly unknown[]) {
  const latest = normalizeAgentStreamLog(logs.at(-1), Math.max(0, logs.length - 1));
  return `${logs.length}|${latest.id}|${latest.createdAt}|${latest.text.length}`;
}

export function activityCategory(log: SharedAgentLog): ActivityCategory {
  if (log.category && ACTIVITY_CATEGORIES.has(log.category as ActivityCategory)) return log.category as ActivityCategory;
  const title = normalized(log.title);
  const value = normalized(`${log.title} ${log.text}`);
  if (log.kind === "error") return "error";
  if (log.kind === "message") return "message";
  if (log.kind === "reasoning" || /推理|分析与推理|分析中|thinking/.test(title)) return "reasoning";
  if (/command_execution|命令|terminal|bash|powershell|shell/.test(title)) return "command";
  if (/file_change|修改文件|创建文件|删除文件|写入文件|\b(edit|write|notebookedit)\b/.test(title)) return "file";
  if (/file_read|读取文件|read\b|glob|grep/.test(title)) return "read";
  if (/web_search|网络搜索|网页搜索|搜索|\b(websearch|webfetch)\b/.test(title)) return "search";
  if (/mcp_tool_call|mcp 调用/.test(title)) return "mcp";
  if (/todo_list|计划更新|待办/.test(title)) return "todo";
  if (/tool_call|工具调用|skill/.test(title) || log.kind === "tool") return "tool";
  if (log.kind === "result" || /最终回复|交付|执行完成|任务完成/.test(title)) return "result";
  if (/失败|报错|错误|拒绝|未授权/.test(title)) return "error";
  return "status";
}

export function activityPhase(log: SharedAgentLog): ActivityPhase {
  if (log.phase) return log.phase;
  const title = normalized(log.title);
  if (log.kind === "error" || /失败|报错|错误|拒绝|未授权|中断/.test(title)) return "failed";
  if (log.kind === "result" || /完成|成功|通过|已提交|已生成|已恢复|completed|passed/.test(title)) return "completed";
  if (log.kind === "tool" || log.kind === "reasoning" || /开始|正在|运行|处理中|调用|读取|搜索|working|started|progress/.test(title)) return "running";
  return "started";
}

function logFingerprint(log: SharedAgentLog) {
  return normalized(`${activityCategory(log)}|${log.title}|${log.text}`);
}

/**
 * Turns provider-specific event streams into one stable presentation stream.
 * Stable ids are updated in place, adjacent duplicate partials are removed,
 * and timestamps are normalized to chronological order.
 */
export function normalizeActivityLogs(logs: readonly unknown[]): ActivityViewLog[] {
  const byId = new Map<string, ActivityViewLog>();
  const ordered: ActivityViewLog[] = [];
  for (const [index, value] of logs.entries()) {
    const raw = normalizeAgentStreamLog(value, index);
    const log: ActivityViewLog = {
      ...raw,
      category: activityCategory(raw),
      phase: activityPhase(raw),
      fingerprint: logFingerprint(raw)
    };
    const existing = byId.get(log.id);
    if (existing) {
      const index = ordered.indexOf(existing);
      if (index >= 0) ordered[index] = log;
      byId.set(log.id, log);
      continue;
    }
    const previous = ordered.at(-1);
    const time = Date.parse(log.createdAt);
    const previousTime = previous ? Date.parse(previous.createdAt) : Number.NaN;
    if (previous && previous.fingerprint === log.fingerprint && Number.isFinite(time) && Number.isFinite(previousTime) && Math.abs(time - previousTime) < 2_000) continue;
    byId.set(log.id, log);
    ordered.push(log);
  }
  return ordered.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

const PAUSE_PATTERN = /(?:^|\b)(?:paused|pause requested)(?:\b|$)|已暂停|请求暂停|等待继续/i;
const RESUME_PATTERN = /(?:^|\b)(?:resumed|resume|continued)(?:\b|$)|继续执行|已恢复|恢复成功|重新排队/i;

function turnState(status: string, logs: ActivityViewLog[]): AgentTurnSummary["state"] {
  const normalizedStatus = normalized(status).replace(/[ -]/g, "_");
  if (["paused", "pause_requested"].includes(normalizedStatus)) return "paused";
  if (["failed", "error", "blocked", "cancelled", "canceled"].includes(normalizedStatus)) return "failed";
  if (["completed", "complete", "succeeded", "success", "done"].includes(normalizedStatus)) return "completed";
  if (["queued", "pending", "waiting"].includes(normalizedStatus)) return "waiting";
  if (["running", "planning", "integrating", "validating", "active"].includes(normalizedStatus)) return "running";
  const latest = logs.at(-1);
  if (latest?.phase === "failed") return "failed";
  if (latest?.phase === "running") return "running";
  return latest?.phase === "completed" ? "completed" : "waiting";
}

/** Builds presentation-only timing from persisted events and excludes known paused intervals. */
export function summarizeAgentTurn(logs: readonly unknown[], status: string, now = Date.now()): AgentTurnSummary {
  const activity = normalizeActivityLogs(logs);
  const times = activity.map((log) => Date.parse(log.createdAt)).filter(Number.isFinite);
  const startedAt = times.length ? Math.min(...times) : null;
  const latestAt = times.length ? Math.max(...times) : null;
  const requestedState = turnState(status, activity);
  // Old partial event groups predate terminal events. They are historical
  // records, not live work; the runners stop after 15 minutes of inactivity.
  const state = requestedState === "running" && latestAt !== null && now - latestAt > 20 * 60_000 ? "historical" : requestedState;
  const terminal = state === "completed" || state === "failed" || state === "historical";
  const endedAt = terminal ? latestAt : null;
  const effectiveEnd = endedAt ?? now;
  let pausedAt: number | null = null;
  let pausedDuration = 0;
  for (const log of activity) {
    const timestamp = Date.parse(log.createdAt);
    if (!Number.isFinite(timestamp)) continue;
    const value = `${log.title} ${log.text}`;
    if (pausedAt === null && PAUSE_PATTERN.test(value)) pausedAt = timestamp;
    else if (pausedAt !== null && RESUME_PATTERN.test(value)) {
      pausedDuration += Math.max(0, timestamp - pausedAt);
      pausedAt = null;
    }
  }
  if (pausedAt !== null) pausedDuration += Math.max(0, effectiveEnd - pausedAt);
  const counts: AgentTurnSummary["counts"] = {};
  for (const log of activity) counts[log.category] = (counts[log.category] || 0) + 1;
  return {
    startedAt,
    endedAt,
    activeDurationMs: startedAt === null ? 0 : Math.max(0, effectiveEnd - startedAt - pausedDuration),
    state,
    counts
  };
}

export function formatAgentDuration(durationMs: number) {
  if (durationMs < 1_000) return "少于 1 秒";
  const seconds = Math.floor(durationMs / 1_000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}分${remainingSeconds}秒` : `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}小时${remainingMinutes}分钟` : `${hours}小时`;
}

const IMPORTANT_STATUS_PATTERN = /失败|错误|报错|阻塞|中断|暂停|等待用户|需要确认|重试|重连|已恢复|恢复成功|未授权|拒绝|限流|额度|failed|error|blocked|interrupted|paused|retry|reconnect|unauthorized|rate.?limit/i;

/** Routine lifecycle events stay available in the full log, but do not compete with useful work in the default view. */
export function isRoutineActivityStatus(log: ActivityViewLog) {
  return log.category === "status" && log.phase !== "failed" && !IMPORTANT_STATUS_PATTERN.test(`${log.title} ${log.text}`);
}

export function activityCategoryLabel(category: ActivityCategory) {
  return ({ command: "命令", tool: "工具", file: "文件", read: "读取", search: "搜索", reasoning: "推理", mcp: "MCP", todo: "计划", status: "状态", result: "结果", error: "错误", message: "回复", unknown: "活动" } satisfies Record<ActivityCategory, string>)[category];
}

export function activityVisualTier(category: ActivityCategory): ActivityVisualTier {
  if (category === "command") return "command";
  if (category === "file" || category === "read") return "file";
  if (category === "message" || category === "result") return "response";
  return "external";
}

/**
 * Codex already provides a meaningful structured title. Claude tool events are
 * normalized here so both providers read as the same concise action stream.
 */
export function activityActionLabel(log: ActivityViewLog, provider: string) {
  if (log.category === "reasoning") return "Thinking";
  if (provider !== "claude") return log.title || activityCategoryLabel(log.category);

  const source = normalized(log.title);
  if (/^(read|glob|grep)$/.test(source)) return "读取文件";
  if (/^(edit|write|notebookedit)$/.test(source)) return "修改文件";
  if (source === "bash") return "执行命令";
  if (/^(websearch|webfetch)$/.test(source)) return "网络搜索";
  if (/^(todowrite|task|taskcreate|taskupdate)$/.test(source)) return "更新计划";
  if (source === "skill") return "使用 Skill";
  if (source.includes("mcp")) return "调用 MCP";
  return log.title || activityCategoryLabel(log.category);
}
