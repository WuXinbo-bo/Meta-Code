import type { ThreadEvent } from "@openai/codex-sdk";
import { canonicalActivity } from "../../activity/normalize.js";
import type { ActivityActor, ActivityScope, CanonicalActivityRecord } from "../../activity/types.js";

export type CodexTurnTerminalState = { completed: boolean; failed: boolean };
export type CodexTurnConsumption = CodexTurnTerminalState & { lastError: string; forcedByDurableResult: boolean };

type CodexThreadLike = {
  runStreamed: (prompt: string, options: { signal: AbortSignal }) => Promise<{ events: AsyncIterable<ThreadEvent> }>;
};

export type CodexSessionTurnOptions = {
  createThread: (threadId?: string | null) => CodexThreadLike;
  threadId?: string | null;
  prompt: string;
  signal: AbortSignal;
  onThreadId?: (threadId: string) => Promise<void> | void;
  onEvent: (event: ThreadEvent) => Promise<void> | void;
  isDurableResultCommitted?: () => boolean;
  durableResultGraceMs?: number;
  missingCompletionMessage: string;
  terminalReason?: string;
};

export type CodexSessionTurnOutcome = CodexTurnConsumption & { threadId: string | null; failure: string };
export type CodexActivityCategory = CanonicalActivityRecord["semanticType"];
export type CodexActivityPhase = "started" | "running" | "completed" | "failed";
export type CodexActivityPresentation = { id: string; category: CodexActivityCategory; phase: CodexActivityPhase; title: string; summary: string; detail?: unknown; schemaVersion: number; rawType: string; provider: "codex"; actor: ActivityActor; scope?: ActivityScope; diagnostics?: CanonicalActivityRecord["diagnostics"] };

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function itemPhase(rawType: string, item: Record<string, unknown>): CodexActivityPhase {
  const status = String(item.status || "");
  if (status === "failed" || item.type === "error") return "failed";
  if (rawType === "item.completed" || status === "completed") return "completed";
  return rawType === "item.started" ? "started" : "running";
}

function presentation(input: { id: string; rawType: string; category: CodexActivityCategory; phase: CodexActivityPhase; title: string; summary: string; detail?: unknown; diagnostics?: CanonicalActivityRecord["diagnostics"] }): CodexActivityPresentation {
  const activity = canonicalActivity({ ...input, semanticType: input.category, provider: "codex", actor: { kind: "main" } });
  return { id: activity.id, category: activity.semanticType, phase: activity.phase, title: activity.title, summary: activity.summary, detail: activity.detail, schemaVersion: activity.schemaVersion, rawType: activity.rawType, provider: "codex", actor: activity.actor, diagnostics: activity.diagnostics };
}

/** Canonical presentation adapter shared by chat, delegated agents and workflows. */
export function codexActivityFromEvent(event: ThreadEvent | unknown): CodexActivityPresentation {
  const raw = recordOf(event);
  const rawType = typeof raw.type === "string" ? raw.type : "unknown";
  if (rawType === "thread.started") {
    const threadId = String(raw.thread_id || "unknown");
    return presentation({ id: `thread:${threadId}`, rawType, category: "status", phase: "started", title: "Codex 会话已创建", summary: "已建立可恢复的 Codex Thread", detail: { threadId } });
  }
  if (rawType === "turn.started") return presentation({ id: "turn", rawType, category: "status", phase: "running", title: "开始运行", summary: "Codex 正在处理任务" });
  if (rawType === "turn.completed") {
    const usage = recordOf(raw.usage);
    return presentation({ id: "turn", rawType, category: "status", phase: "completed", title: "任务完成", summary: `本轮使用 ${Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0)} tokens`, detail: { usage } });
  }
  if (rawType === "turn.failed") {
    const error = recordOf(raw.error);
    const message = String(error.message || "Codex 任务执行失败");
    return presentation({ id: "turn", rawType, category: "error", phase: "failed", title: "任务执行失败", summary: message, detail: { error: message } });
  }
  if (rawType === "error") {
    const message = String(raw.message || "Codex 连接异常");
    return presentation({ id: "stream", rawType, category: "status", phase: "running", title: "连接异常", summary: message, detail: { message } });
  }
  const item = recordOf(raw.item);
  if (!["item.started", "item.updated", "item.completed"].includes(rawType) || !Object.keys(item).length) {
    return presentation({ id: String(raw.id || `unknown:${rawType}`), rawType, category: "unknown", phase: "started", title: "未识别的 Codex 活动", summary: rawType, detail: raw, diagnostics: [{ code: "unknown_codex_event", level: "info", message: `当前工作台尚未识别 ${rawType}，已保留原始事件` }] });
  }
  const itemType = String(item.type || "unknown");
  const id = String(item.id || `${rawType}:${itemType}`);
  const phase = itemPhase(rawType, item);
  if (itemType === "agent_message") return presentation({ id, rawType: itemType, category: "message", phase, title: "Codex 回复", summary: String(item.text || "") });
  if (itemType === "reasoning") return presentation({ id, rawType: itemType, category: "reasoning", phase, title: "分析与推理", summary: String(item.text || "") });
  if (itemType === "command_execution") return presentation({ id, rawType: itemType, category: "command", phase, title: "执行命令", summary: String(item.command || "命令执行"), detail: { command: item.command, status: item.status, exitCode: item.exit_code ?? null, output: item.aggregated_output } });
  if (itemType === "file_change") {
    const action = { add: "新增", update: "修改", delete: "删除" } as const;
    const changes = Array.isArray(item.changes) ? item.changes.map(recordOf) : [];
    return presentation({ id, rawType: itemType, category: "file", phase, title: "文件变更", summary: changes.map((change) => `${action[change.kind as keyof typeof action] || "变更"} ${String(change.path || "")}`).join("；") || "文件变更已提交", detail: { status: item.status, changes } });
  }
  if (itemType === "mcp_tool_call") {
    const error = recordOf(item.error);
    return presentation({ id, rawType: itemType, category: "mcp", phase, title: `MCP · ${String(item.server || "")}.${String(item.tool || "")}`, summary: item.status === "failed" ? String(error.message || "调用失败") : item.status === "completed" ? "调用完成" : "正在调用", detail: { server: item.server, tool: item.tool, arguments: item.arguments, status: item.status, result: item.result, error: item.error } });
  }
  if (itemType === "web_search") return presentation({ id, rawType: itemType, category: "search", phase, title: "网络搜索", summary: String(item.query || ""), detail: { query: item.query } });
  if (itemType === "todo_list") {
    const items = Array.isArray(item.items) ? item.items.map(recordOf) : [];
    const completed = items.filter((todo) => todo.completed).length;
    return presentation({ id, rawType: itemType, category: "todo", phase, title: "计划更新", summary: `${completed}/${items.length} 项已完成`, detail: { items } });
  }
  return presentation({ id, rawType: itemType, category: "unknown", phase, title: "未识别的 Codex 活动", summary: itemType, detail: item, diagnostics: [{ code: "unknown_codex_item", level: "info", message: `当前工作台尚未识别 ${itemType}，已保留原始内容` }] });
}

// The SDK can emit recoverable `error` events before the final completion
// event. Only `turn.failed` is terminal; completion wins over earlier stream
// transport errors.
export function recordCodexTurnTerminalState(state: CodexTurnTerminalState, eventType: ThreadEvent["type"]): CodexTurnTerminalState {
  if (eventType === "turn.completed") return { completed: true, failed: false };
  if (eventType === "turn.failed") return { ...state, failed: true };
  return state;
}

export function codexTurnFailure(state: CodexTurnTerminalState, lastError: string, missingCompletionMessage: string) {
  if (state.completed) return "";
  return lastError || missingCompletionMessage;
}

export async function consumeCodexTurnEvents(
  events: AsyncIterable<ThreadEvent>,
  onEvent: (event: ThreadEvent) => Promise<void> | void,
  options: {
    isDurableResultCommitted?: () => boolean;
    durableResultGraceMs?: number;
    pollIntervalMs?: number;
    onTerminal?: () => void;
  } = {}
): Promise<CodexTurnConsumption> {
  const iterator = events[Symbol.asyncIterator]();
  let pending = iterator.next();
  let state: CodexTurnTerminalState = { completed: false, failed: false };
  let lastError = "";
  let durableResultObservedAt: number | null = null;
  let forcedByDurableResult = false;
  const pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250);
  const durableResultGraceMs = Math.max(0, options.durableResultGraceMs ?? 3_000);
  try {
    while (true) {
      const next = await Promise.race([
        pending.then((result) => ({ kind: "event" as const, result })),
        new Promise<{ kind: "poll" }>((resolve) => setTimeout(() => resolve({ kind: "poll" }), pollIntervalMs))
      ]);
      if (next.kind === "poll") {
        if (!options.isDurableResultCommitted?.()) { durableResultObservedAt = null; continue; }
        durableResultObservedAt ??= Date.now();
        if (Date.now() - durableResultObservedAt < durableResultGraceMs) continue;
        forcedByDurableResult = true;
        state = { completed: true, failed: false };
        options.onTerminal?.();
        break;
      }
      if (next.result.done) break;
      const event = next.result.value;
      await onEvent(event);
      state = recordCodexTurnTerminalState(state, event.type);
      if (event.type === "turn.failed" || event.type === "error") lastError = summarizeCodexEvent(event) || lastError;
      if (event.type === "turn.completed" || event.type === "turn.failed") { options.onTerminal?.(); break; }
      pending = iterator.next();
    }
  } finally {
    try {
      const cleanup = iterator.return?.();
      if (cleanup) void cleanup.catch(() => undefined);
    } catch { /* The terminal state is already durable; stream cleanup is best effort. */ }
  }
  return { ...state, lastError, forcedByDurableResult };
}

/** Shared Codex SDK turn lifecycle for normal chat and workflow agents. */
export async function runCodexSessionTurn(options: CodexSessionTurnOptions): Promise<CodexSessionTurnOutcome> {
  let threadId = options.threadId || null;
  const thread = options.createThread(threadId);
  const streamController = new AbortController();
  const { events } = await thread.runStreamed(options.prompt, {
    signal: AbortSignal.any([options.signal, streamController.signal])
  });
  const terminal = await consumeCodexTurnEvents(events, async (event) => {
    if (event.type === "thread.started") {
      threadId = event.thread_id;
      await options.onThreadId?.(event.thread_id);
    }
    await options.onEvent(event);
  }, {
    isDurableResultCommitted: options.isDurableResultCommitted,
    durableResultGraceMs: options.durableResultGraceMs,
    onTerminal: () => streamController.abort(new Error(options.terminalReason || "Codex 任务已到达终态"))
  });
  return { ...terminal, threadId, failure: codexTurnFailure(terminal, terminal.lastError, options.missingCompletionMessage) };
}

export function isCodexReconnectMessage(message: string) {
  return /(?:reconnecting|retrying)(?:\.\.\.)?/i.test(message) && !/(?:retries exhausted|retry limit|failed after)/i.test(message);
}

export function summarizeCodexEvent(event: ThreadEvent): string {
  return codexActivityFromEvent(event).summary;
}
