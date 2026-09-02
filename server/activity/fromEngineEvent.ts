import type { NormalizedEngineEvent } from "../engines/types.js";
import { canonicalActivity } from "./normalize.js";
import type { ActivityActor, ActivityProvider, ActivityScope, ActivitySemanticType } from "./types.js";

const FILE_TOOLS = new Set(["edit", "write", "notebookedit"]);
const READ_TOOLS = new Set(["read", "glob", "grep"]);
const SEARCH_TOOLS = new Set(["websearch", "webfetch"]);
const TODO_TOOLS = new Set(["todowrite", "taskcreate", "taskget", "tasklist", "taskoutput", "taskstop", "taskupdate"]);

export function engineEventSemanticType(event: NormalizedEngineEvent): ActivitySemanticType {
  const explicit = event.category;
  if (explicit && ["message", "reasoning", "command", "file", "read", "search", "mcp", "tool", "todo", "status", "result", "error", "unknown"].includes(explicit)) return explicit as ActivitySemanticType;
  if (event.type === "error") return "error";
  if (event.type === "assistant") return "message";
  if (event.type === "reasoning") return "reasoning";
  if (["session.started", "turn.started", "turn.completed", "status"].includes(event.type)) return "status";
  const tool = String(event.toolName || "").toLowerCase();
  if (FILE_TOOLS.has(tool)) return "file";
  if (READ_TOOLS.has(tool)) return "read";
  if (SEARCH_TOOLS.has(tool)) return "search";
  if (tool === "bash" || tool === "shell" || tool === "powershell") return "command";
  if (tool.includes("mcp")) return "mcp";
  if (TODO_TOOLS.has(tool)) return "todo";
  return event.type.startsWith("tool") ? "tool" : "unknown";
}

function engineEventPhase(event: NormalizedEngineEvent) {
  if (event.phase) return event.phase;
  if (event.type === "error") return "failed" as const;
  if (["assistant", "tool.completed", "turn.completed"].includes(event.type)) return "completed" as const;
  if (["reasoning", "tool.started", "turn.started"].includes(event.type)) return "running" as const;
  return "started" as const;
}

function engineEventTitle(event: NormalizedEngineEvent, semanticType: ActivitySemanticType) {
  if (event.toolName) return event.type === "tool.completed" ? `${event.toolName}完成` : event.toolName;
  const labels: Record<string, string> = {
    "session.started": "新上下文已创建",
    "turn.started": "开始运行",
    "turn.completed": "任务完成",
    assistant: "Agent 回复",
    reasoning: "分析与推理",
    status: "状态更新",
    error: "执行失败",
    unknown: "未识别活动"
  };
  return labels[event.type] || labels[semanticType] || "状态更新";
}

export function canonicalActivityFromEngineEvent(event: NormalizedEngineEvent, options: {
  provider: ActivityProvider;
  actor: ActivityActor;
  scope?: ActivityScope;
  id?: string;
  occurredAt?: string;
  title?: string;
}) {
  const semanticType = engineEventSemanticType(event);
  return canonicalActivity({
    id: options.id || event.sourceId || `${event.type}:${event.toolName || "event"}`,
    ...(event.sourceId ? { sourceId: event.sourceId } : {}),
    rawType: event.rawType || event.type,
    provider: options.provider,
    actor: options.actor,
    ...(options.scope ? { scope: options.scope } : {}),
    semanticType,
    phase: engineEventPhase(event),
    ...(options.occurredAt ? { occurredAt: options.occurredAt } : {}),
    title: options.title || engineEventTitle(event, semanticType),
    summary: event.text || options.title || engineEventTitle(event, semanticType),
    detail: event.detail ?? event.payload
  });
}
