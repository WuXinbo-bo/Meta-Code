import fs from "node:fs";
import path from "node:path";
import type { SessionHealthIssue, SessionInventoryItem } from "./types.js";

type WorkbenchSessionLike = {
  id: string;
  title: string;
  engine: string;
  status: string;
  scopeKind: "workspace" | "standalone";
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  pinned?: boolean;
  codexThreadId?: string | null;
  engineSessionId?: string | null;
  messages?: unknown[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

type WorkspaceLike = { id: string; name: string; root: string };

export function workbenchInventoryItem(input: {
  session: WorkbenchSessionLike;
  workspace?: WorkspaceLike;
  linked: boolean;
  delegatedTaskCount: number;
  standaloneRoot?: string;
}): SessionInventoryItem {
  const { session, workspace, linked, delegatedTaskCount, standaloneRoot } = input;
  const branchAnchor = [...(Array.isArray(session.messages) ? session.messages : [])].reverse().find((message) => {
    const role = message && typeof message === "object" ? String((message as { role?: unknown }).role || "") : "";
    return role === "user" || role === "assistant";
  }) as { id?: unknown } | undefined;
  const issues: SessionHealthIssue[] = [];
  if (["running", "paused"].includes(session.status)) {
    issues.push({ code: "running", severity: "info", message: session.status === "paused" ? "任务已暂停，保留运行上下文" : "任务正在执行", repairable: false });
  }
  if (session.scopeKind === "workspace" && (!workspace || !fs.existsSync(workspace.root))) {
    issues.push({ code: "missing-workspace", severity: "error", message: "关联工作区不存在或路径已失效", repairable: false });
  }
  if (session.scopeKind === "standalone" && standaloneRoot && !fs.existsSync(standaloneRoot)) {
    issues.push({ code: "missing-workspace", severity: "error", message: "临时任务执行目录已丢失", repairable: false });
  }
  if (linked && !session.codexThreadId) {
    issues.push({ code: "inconsistent-index", severity: "warning", message: "存在 Codex 联动记录，但任务缺少原生线程 ID", repairable: true });
  }
  if (delegatedTaskCount > 0 && !session.engineSessionId && session.status !== "idle") {
    issues.push({ code: "inconsistent-index", severity: "warning", message: "子 Agent 记录存在，但主线程 ID 缺失", repairable: false });
  }
  const primary = issues.find((issue) => issue.severity === "error")?.code
    || issues.find((issue) => issue.severity === "warning")?.code
    || issues.find((issue) => issue.code === "running")?.code
    || "healthy";
  return {
    id: session.id,
    resourceId: session.id,
    kind: "session",
    source: "workbench",
    provider: session.engine,
    title: session.title,
    workspaceId: session.workspaceId || null,
    workspaceName: workspace?.name || (session.scopeKind === "standalone" ? "临时任务" : null),
    workspacePath: workspace?.root || (standaloneRoot ? path.resolve(standaloneRoot) : null),
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    usageTokens: Number(session.usage?.input_tokens || 0) + Number(session.usage?.output_tokens || 0),
    archivedAt: session.archivedAt || null,
    pinned: Boolean(session.pinned),
    branchAnchorId: branchAnchor?.id ? String(branchAnchor.id) : null,
    nativeThreadId: session.engineSessionId || session.codexThreadId || null,
    linked,
    health: primary,
    issues,
    capabilities: [
      "open", "export", "repair", "rename",
      ...(!session.archivedAt ? [session.pinned ? "unpin" : "pin"] as const : []),
      ...(session.archivedAt ? ["unarchive"] as const : ["archive"] as const),
      ...(["running", "paused"].includes(session.status) ? [] : branchAnchor?.id ? ["delete", "branch"] as const : ["delete"] as const)
    ]
  };
}
