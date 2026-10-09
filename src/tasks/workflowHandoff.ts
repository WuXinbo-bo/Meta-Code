type HandoffMessage = { role: string; text: string; eventType?: string; sourceId?: string; payload?: unknown };

function handoffPayload(message: HandoffMessage) {
  return message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
    ? message.payload as Record<string, unknown> : null;
}

export function isWorkflowHandoffMessage(message: HandoffMessage) {
  if (message.role !== "assistant") return false;
  return message.eventType === "task.workflow.result"
    || message.eventType === "task.context.handoff"
    || /^编排(?:进度交接|已完成)[：:]/u.test(message.text.trim())
    || /^同一任务的上下文交接[：:]/u.test(message.text.trim());
}

export function workflowHandoffSourceId(message: HandoffMessage) {
  const payload = handoffPayload(message);
  if (payload?.sourceKind === "session") return "";
  if (typeof payload?.workflowId === "string") return payload.workflowId;
  if (payload?.sourceKind === "workflow" && typeof payload.sourceId === "string") return payload.sourceId;
  return /^workflow-result:([^:]+):/u.exec(message.sourceId || "")?.[1] || "";
}

export function workflowHandoffSourceKind(message: HandoffMessage) {
  return handoffPayload(message)?.sourceKind === "session" ? "session" : "workflow";
}

export function workflowHandoffKey(message: HandoffMessage) {
  const payload = handoffPayload(message);
  const sourceKind = workflowHandoffSourceKind(message);
  const sourceId = sourceKind === "session" && typeof payload?.sourceId === "string" ? payload.sourceId : workflowHandoffSourceId(message);
  const sourceVersion = /^workflow-result:[^:]+:([^:]+):/u.exec(message.sourceId || "")?.[1];
  const version = typeof payload?.planVersion === "number" ? `plan:${payload.planVersion}`
    : sourceVersion ? `plan:${sourceVersion}`
    : typeof payload?.sourceRevision === "number" ? `source:${payload.sourceRevision}` : "";
  return JSON.stringify([sourceKind, sourceId, version, message.text.trim()]);
}

export function readWorkflowHandoff(text: string) {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const heading = lines[0] || "";
  const sections = { goal: [] as string[], result: [] as string[], files: [] as string[], decisions: [] as string[], unresolved: [] as string[] };
  let section: keyof typeof sections | null = "result";
  const labels: Record<string, keyof typeof sections> = {
    "初始目标": "goal", "任务目标": "goal", "成果": "files", "成果文件": "files", "最终成果": "result", "助手参考": "result",
    "关键决定": "decisions", "执行方决定（未经用户确认，不覆盖用户要求）": "decisions", "待处理": "unresolved", "待解决": "unresolved", "未决事项": "unresolved"
  };
  for (const line of lines.slice(1)) {
    const label = /^([^：:]+)[：:]\s*(.*)$/u.exec(line);
    if (label && labels[label[1]]) {
      section = labels[label[1]];
      if (label[2]) sections[section].push(label[2]);
    } else if (/^(?:执行目录|最近用户请求|历史用户请求台账|用户历史|附件|用户)[\s[：:]/u.test(line)) {
      section = null;
    } else if (section) sections[section].push(line);
  }
  const title = heading.replace(/^(?:编排(?:进度交接|已完成)|同一任务的上下文交接)[：:]\s*/u, "");
  return {
    title: sections.goal[0] || title || "编排已将任务上下文交接给当前对话。",
    completed: /^编排已完成[：:]/u.test(heading),
    summary: sections.result.join("\n"),
    files: [...new Set(sections.files)],
    decisions: sections.decisions,
    unresolved: sections.unresolved
  };
}
