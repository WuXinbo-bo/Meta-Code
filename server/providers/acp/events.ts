import type { ContentBlock, SessionNotification, SessionUpdate, ToolCallContent, ToolKind, ToolCallStatus } from "@agentclientprotocol/sdk";
import type { NormalizedEngineEvent } from "../../engines/types.js";

export function normalizedEventFromAcp(notification: SessionNotification): NormalizedEngineEvent | null {
  const update = notification.update;
  const rawType = `acp.${update.sessionUpdate}`;
  if (update.sessionUpdate === "user_message_chunk") return null;
  if (update.sessionUpdate === "agent_message_chunk") return {
    type: "assistant", sourceId: update.messageId || undefined, text: contentText(update.content), rawType, payload: notification, category: "message", phase: "completed"
  };
  if (update.sessionUpdate === "agent_thought_chunk") return {
    type: "reasoning", sourceId: update.messageId || undefined, text: contentText(update.content) || "Agent 正在分析", rawType, payload: notification, category: "reasoning", phase: "running"
  };
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const phase = toolPhase(update.status);
    const semantic = toolSemanticType(update.kind, update.content);
    return {
      type: phase === "completed" || phase === "failed" ? "tool.completed" : "tool.started",
      sourceId: update.toolCallId,
      toolName: update.name || update.kind || "ACP Tool",
      text: update.title || toolContentText(update.content) || "Agent 工具活动",
      rawType,
      payload: notification,
      category: semantic,
      phase,
      detail: toolDetail(update)
    };
  }
  if (update.sessionUpdate === "plan") return {
    type: "tool.completed", sourceId: "acp-plan", toolName: "plan", text: planSummary(update.entries), rawType, payload: notification, category: "todo", phase: planPhase(update.entries),
    detail: { items: update.entries.map((entry, index) => ({ id: String(index), text: entry.content, status: entry.status, completed: entry.status === "completed", priority: entry.priority })) }
  };
  if (update.sessionUpdate === "plan_update") return {
    type: "status", sourceId: `acp-plan:${update.plan.planId}`, text: "Agent 计划已更新", rawType, payload: notification, category: "todo", phase: "running", detail: update.plan
  };
  if (update.sessionUpdate === "plan_removed") return {
    type: "status", sourceId: `acp-plan:${update.planId}`, text: "Agent 计划已移除", rawType, payload: notification, category: "todo", phase: "completed", detail: update
  };
  if (update.sessionUpdate === "usage_update") return {
    type: "status", sourceId: "acp-usage", text: `上下文 ${update.used}/${update.size}`, rawType, payload: notification, category: "status", phase: "running", detail: update
  };
  return {
    type: "status", sourceId: acpUpdateId(update), text: acpUpdateSummary(update), rawType, payload: notification, category: "status", phase: "running", detail: update
  };
}

/**
 * ACP message and thought updates are chunks. The workbench message store is
 * snapshot based, so accumulate them before upserting by source id.
 */
export class AcpEventNormalizer {
  private readonly chunks = new Map<string, string>();

  normalize(notification: SessionNotification) {
    const event = normalizedEventFromAcp(notification);
    if (!event || (event.type !== "assistant" && event.type !== "reasoning")) return event;
    const key = `${event.type}:${event.sourceId || "default"}`;
    const text = `${this.chunks.get(key) || ""}${event.text}`;
    this.chunks.set(key, text);
    return { ...event, text };
  }

  clear() {
    this.chunks.clear();
  }
}

function contentText(content: ContentBlock) {
  if (content.type === "text") return content.text;
  if (content.type === "resource_link") return content.title || content.name || content.uri;
  if (content.type === "resource" && "text" in content.resource) return content.resource.text;
  return "";
}

function toolContentText(content: ToolCallContent[] | null | undefined) {
  return (content || []).map((item) => item.type === "content" ? contentText(item.content) : item.type === "diff" ? item.path : `终端 ${item.terminalId}`).filter(Boolean).join(" · ");
}

function toolSemanticType(kind?: ToolKind | null, content?: ToolCallContent[] | null): NormalizedEngineEvent["category"] {
  if (content?.some((item) => item.type === "diff")) return "file";
  if (kind === "execute") return "command";
  if (kind === "read") return "read";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file";
  if (kind === "search" || kind === "fetch") return "search";
  if (kind === "think") return "reasoning";
  return "tool";
}

function toolPhase(status?: ToolCallStatus | null): NonNullable<NormalizedEngineEvent["phase"]> {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "in_progress") return "running";
  return "started";
}

function toolDetail(update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>) {
  const diffs = (update.content || []).filter((item): item is Extract<ToolCallContent, { type: "diff" }> => item.type === "diff");
  return {
    toolCallId: update.toolCallId,
    kind: update.kind,
    status: update.status,
    locations: update.locations || [],
    rawInput: update.rawInput,
    rawOutput: update.rawOutput,
    content: update.content || [],
    ...(diffs.length ? { changes: diffs.map((diff) => ({ path: diff.path, kind: diff.oldText == null ? "add" : "update", oldText: diff.oldText, newText: diff.newText })) } : {})
  };
}

function planSummary(entries: Extract<SessionUpdate, { sessionUpdate: "plan" }>["entries"]) {
  const completed = entries.filter((entry) => entry.status === "completed").length;
  return `计划 ${completed}/${entries.length} 已完成`;
}

function planPhase(entries: Extract<SessionUpdate, { sessionUpdate: "plan" }>["entries"]): NonNullable<NormalizedEngineEvent["phase"]> {
  return entries.length > 0 && entries.every((entry) => entry.status === "completed") ? "completed" : "running";
}

function acpUpdateId(update: SessionUpdate) {
  if (update.sessionUpdate === "config_option_update") return `acp-config:${update.configOptions.map((item) => item.id).join(",")}`;
  if (update.sessionUpdate === "session_info_update") return "acp-session-info";
  if (update.sessionUpdate === "current_mode_update") return "acp-mode";
  if (update.sessionUpdate === "available_commands_update") return "acp-commands";
  if (update.sessionUpdate === "compaction_update") return `acp-compaction:${update.compactionId}`;
  if (update.sessionUpdate === "compaction_summary_chunk") return `acp-compaction:${update.compactionId}`;
  return `acp:${update.sessionUpdate}`;
}

function acpUpdateSummary(update: SessionUpdate) {
  if (update.sessionUpdate === "config_option_update") return "会话配置已更新";
  if (update.sessionUpdate === "session_info_update") return update.title || "会话信息已更新";
  if (update.sessionUpdate === "current_mode_update") return `运行模式：${update.currentModeId}`;
  if (update.sessionUpdate === "available_commands_update") return `可用命令 ${update.availableCommands.length} 个`;
  if (update.sessionUpdate === "compaction_update") return `上下文整理：${update.status}`;
  if (update.sessionUpdate === "compaction_summary_chunk") return contentText(update.content) || "上下文摘要更新";
  return update.sessionUpdate;
}
