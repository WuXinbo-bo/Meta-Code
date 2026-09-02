import crypto from "node:crypto";
import { canonicalActivityFromEngineEvent } from "../activity/fromEngineEvent.js";
import { canonicalActivity } from "../activity/normalize.js";
import type { NormalizedEngineEvent } from "../engines/types.js";
import type { WorkflowNodeLog } from "./types.js";

export type WorkflowLogContext = Pick<WorkflowNodeLog, "attempt" | "runId" | "contextId">;

function workflowActivityMetadata(event: NormalizedEngineEvent): { category: string; phase: NonNullable<WorkflowNodeLog["phase"]> } {
  if (event.category && event.phase) return { category: event.category, phase: event.phase };
  if (event.type === "error") return { category: "error", phase: "failed" as const };
  if (event.type === "assistant") return { category: "message", phase: "completed" as const };
  if (event.type === "reasoning") return { category: "reasoning", phase: "running" as const };
  const tool = String(event.toolName || "").toLowerCase();
  const category = ["edit", "write", "notebookedit"].includes(tool) ? "file"
    : ["read", "glob", "grep"].includes(tool) ? "read"
    : ["websearch", "webfetch"].includes(tool) ? "search"
    : tool === "bash" ? "command"
    : tool.includes("mcp") ? "mcp"
    : ["todowrite", "taskcreate", "taskget", "tasklist", "taskoutput", "taskstop", "taskupdate"].includes(tool) ? "todo"
    : ["session.started", "turn.started", "turn.completed", "status"].includes(event.type) ? "status"
    : "tool";
  const phase = event.type === "tool.completed" || event.type === "turn.completed" ? "completed"
    : event.type === "tool.started" || event.type === "turn.started" ? "running"
    : "started";
  return { category, phase };
}

function compactDetail(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const detail = { ...(value as Record<string, unknown>) };
  if (typeof detail.output === "string" && detail.output.length > 24_000) detail.output = `${detail.output.slice(0, 24_000)}\n\n[命令输出过长，已截断；原始结果不受影响]`;
  if (detail.result !== undefined) {
    const serialized = JSON.stringify(detail.result);
    if (serialized.length > 24_000) detail.result = { truncated: true, preview: serialized.slice(0, 24_000) };
  }
  return detail;
}

export function workflowLog(
  kind: WorkflowNodeLog["kind"],
  title: string,
  text: string,
  id?: string,
  context: WorkflowLogContext = {}
): WorkflowNodeLog {
  const createdAt = new Date().toISOString();
  const logId = id || `workflow-log_${crypto.randomUUID()}`;
  const semanticType = kind === "message" ? "message" : kind === "reasoning" ? "reasoning" : kind === "error" ? "error" : kind === "tool" ? "tool" : "status";
  return {
    id: logId,
    createdAt,
    kind,
    title,
    text,
    activity: canonicalActivity({
      id: logId,
      rawType: `workflow.${semanticType}`,
      provider: "workbench",
      actor: { kind: "workflow", ...(context.runId ? { id: context.runId } : {}) },
      scope: { ...(context.runId ? { workflowId: context.runId } : {}), ...(context.attempt !== undefined ? { attempt: context.attempt } : {}) },
      semanticType,
      phase: kind === "error" ? "failed" : kind === "message" ? "completed" : "started",
      occurredAt: createdAt,
      title,
      summary: text
    }),
    ...context
  };
}

export function workflowLogFromEngineEvent(
  event: NormalizedEngineEvent,
  prefix = "engine",
  context: WorkflowLogContext = {}
): WorkflowNodeLog {
  const kind = event.type === "error" ? "error"
    : event.type === "assistant" ? "message"
    : event.type === "reasoning" ? "reasoning"
    : event.type.startsWith("tool") ? "tool"
    : "status";
  const labels: Record<string, string> = {
    "session.started": "新上下文已创建",
    "turn.started": "开始运行",
    "turn.completed": "任务完成",
    reasoning: "分析与推理",
    assistant: "Agent 回复",
    status: "状态更新",
    error: "执行失败"
  };
  const phase = event.type === "tool.completed" ? "完成" : "";
  const title = event.toolName ? `${event.toolName}${phase}` : labels[event.type] || event.type;
  const rawText = event.text || title;
  const trimmed = rawText.trim();
  const machinePayload = event.type === "assistant" && (trimmed.startsWith("{") || trimmed.startsWith("```")) && (trimmed.includes('"outcome"') || trimmed.includes('"nodes"'));
  const result = workflowLog(kind, machinePayload ? "机器结果已接收" : title, machinePayload ? "正在解析并校验结构化结果" : rawText, `${prefix}:${event.sourceId || event.type}`, context);
  const activity = workflowActivityMetadata(event);
  result.category = activity.category;
  result.phase = activity.phase;
  result.detail = compactDetail(event.detail);
  const provider = prefix.toLowerCase().includes("codex") ? "codex" : prefix.toLowerCase().includes("claude") ? "claude" : "unknown";
  result.activity = canonicalActivityFromEngineEvent(event, {
    provider,
    actor: { kind: "workflow", ...(context.runId ? { id: context.runId } : {}) },
    scope: { ...(context.runId ? { workflowId: context.runId } : {}), ...(context.contextId ? { threadId: context.contextId } : {}), ...(context.attempt !== undefined ? { attempt: context.attempt } : {}) },
    id: result.id,
    occurredAt: result.createdAt,
    title: result.title
  });
  return result;
}

export function upsertWorkflowLog(logs: WorkflowNodeLog[], log: WorkflowNodeLog, limit = 300) {
  const existing = logs.findIndex((item) => item.id === log.id);
  if (existing >= 0) logs[existing] = { ...log, detail: log.detail ?? logs[existing].detail };
  else logs.push(log);
  logs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (logs.length > limit) logs.splice(0, logs.length - limit);
}
