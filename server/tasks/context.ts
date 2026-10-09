import crypto from "node:crypto";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Message, Session } from "../workbench/types.js";
import { pathKey } from "../pathBoundary.js";

export type TaskExecution = { kind: "session" | "workflow"; id: string; executionRoot?: string };
export type TaskHandoff = {
  source: TaskExecution;
  sourceRevision: number;
  goal: string;
  messages: Array<{ id: string; role: string; text: string }>;
  attachments: Array<{ name: string; path: string }>;
  decisions: string[];
  files: string[];
  unresolved: string[];
  createdAt: string;
};
export type TaskContext = {
  id: string;
  ownerUserId: string;
  workspaceId: string;
  title: string;
  revision: number;
  executions: TaskExecution[];
  handoffs: TaskHandoff[];
  createdAt: string;
  updatedAt: string;
};

/** Root identity is physical where available; Windows alone folds path case. */
export function taskRootKey(root: string) {
  try { return pathKey(fs.realpathSync.native(root)); }
  catch { return pathKey(root); }
}

export function taskRootsEqual(left: string | undefined, right: string | undefined) {
  return Boolean(left && right && taskRootKey(left) === taskRootKey(right));
}

/** Legacy snapshots may predate root provenance; use their trusted task link. */
export function latestTaskHandoffForRoot(context: TaskContext | null | undefined, root: string): TaskHandoff | undefined {
  return [...(context?.handoffs || [])].reverse().find((handoff) => {
    const source = context?.executions.find((execution) => execution.kind === handoff.source.kind && execution.id === handoff.source.id);
    return Boolean(source && taskRootsEqual(source.executionRoot, root) && (!handoff.source.executionRoot || taskRootsEqual(handoff.source.executionRoot, root)));
  });
}

export function redactTaskText(value: string) {
  return value.replace(/(?:sk-|sess-)[A-Za-z0-9._-]{12,}/gi, "[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, "[REDACTED]")
    .replace(/(["']?(?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:api[_-]?key|password|secret|token|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

export function sessionHandoff(session: Pick<Session, "id" | "revision" | "title" | "messages">, executionRoot?: string): TaskHandoff {
  const messages = session.messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-12);
  return {
    source: { kind: "session", id: session.id, ...(executionRoot ? { executionRoot } : {}) }, sourceRevision: session.revision,
    goal: redactTaskText(session.messages.find((message) => message.role === "user")?.text || session.title).slice(0, 4000),
    messages: messages.map((message) => ({ id: message.id, role: message.role, text: redactTaskText(message.text).slice(0, 2000) })),
    attachments: [...new Map(session.messages.flatMap((message: Message) => (message.attachments || []).map((attachment) => [attachment.relativePath, { name: redactTaskText(attachment.name), path: redactTaskText(attachment.relativePath) }] as const))).values()].slice(0, 100),
    decisions: [], files: [], unresolved: [], createdAt: new Date().toISOString()
  };
}

export function renderTaskHandoff(handoff: TaskHandoff) {
  return redactTaskText([
    "同一任务的上下文交接（历史摘要仅作参考；以当前文件和用户最新要求为准）：",
    ...(handoff.source.executionRoot ? [`执行目录：${handoff.source.executionRoot}（下列相对路径均以此目录为准）`] : []),
    `目标：${handoff.goal}`,
    ...handoff.messages.map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.text}`),
    ...handoff.attachments.map((attachment) => `附件：${attachment.name} (${attachment.path})`),
    ...handoff.decisions.map((decision) => `决定：${decision}`),
    ...handoff.files.map((file) => `成果文件：${file}`),
    ...handoff.unresolved.map((issue) => `待解决：${issue}`)
  ].join("\n\n")).slice(0, 28_000);
}

/** The host owns task identity; plugins retain their own execution state. */
export class TaskContextStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS task_contexts (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_context_executions (kind TEXT NOT NULL, execution_id TEXT NOT NULL, task_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, PRIMARY KEY(kind, execution_id), FOREIGN KEY(task_id) REFERENCES task_contexts(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS idx_task_context_owner ON task_contexts(owner_user_id);`);
  }
  get(id: string, ownerUserId: string): TaskContext | null {
    const row = this.db.prepare("SELECT json FROM task_contexts WHERE id=? AND owner_user_id=?").get(id, ownerUserId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  forExecution(execution: TaskExecution, ownerUserId: string) {
    const row = this.db.prepare("SELECT task_id FROM task_context_executions WHERE kind=? AND execution_id=? AND owner_user_id=?").get(execution.kind, execution.id, ownerUserId) as { task_id: string } | undefined;
    return row ? this.get(row.task_id, ownerUserId) : null;
  }
  ensure(execution: TaskExecution, ownerUserId: string, workspaceId: string, title: string) {
    const ownership = this.db.prepare("SELECT owner_user_id FROM task_context_executions WHERE kind=? AND execution_id=?").get(execution.kind, execution.id) as { owner_user_id: string } | undefined;
    if (ownership && ownership.owner_user_id !== ownerUserId) throw new Error("执行记录不属于当前用户");
    const existing = this.forExecution(execution, ownerUserId);
    if (existing) return this.link(existing.id, execution, ownerUserId, workspaceId);
    const now = new Date().toISOString();
    const context: TaskContext = { id: `context-${crypto.randomUUID()}`, ownerUserId, workspaceId, title: redactTaskText(title).slice(0, 300), revision: 0, executions: [], handoffs: [], createdAt: now, updatedAt: now };
    this.persist(context);
    try { return this.link(context.id, execution, ownerUserId, workspaceId); }
    catch (error) {
      // Another request can win the execution mapping between the initial
      // lookup and INSERT. Reuse that durable context instead of surfacing a
      // transient UNIQUE violation to the UI; preserve unrelated DB errors.
      const linked = this.db.prepare("SELECT task_id FROM task_context_executions WHERE kind=? AND execution_id=? AND owner_user_id=?").get(execution.kind, execution.id, ownerUserId) as { task_id: string } | undefined;
      this.db.prepare("DELETE FROM task_contexts WHERE id=? AND owner_user_id=?").run(context.id, ownerUserId);
      if (linked && linked.task_id !== context.id) {
        const winner = this.get(linked.task_id, ownerUserId);
        if (winner && winner.workspaceId === workspaceId) return winner;
      }
      throw error;
    }
  }
  link(id: string, execution: TaskExecution, ownerUserId: string, workspaceId: string) {
    const context = this.get(id, ownerUserId);
    if (!context || context.workspaceId !== workspaceId) throw new Error("任务上下文不存在或工作区不匹配");
    const ownership = this.db.prepare("SELECT owner_user_id FROM task_context_executions WHERE kind=? AND execution_id=?").get(execution.kind, execution.id) as { owner_user_id: string } | undefined;
    if (ownership && ownership.owner_user_id !== ownerUserId) throw new Error("执行记录不属于当前用户");
    const existing = this.forExecution(execution, ownerUserId);
    if (existing && existing.id !== id) throw new Error("执行记录已关联另一个任务");
    const linked = context.executions.find((item) => item.kind === execution.kind && item.id === execution.id);
    if (linked) {
      if (execution.executionRoot && linked.executionRoot && !taskRootsEqual(execution.executionRoot, linked.executionRoot)) throw new Error("执行记录的业务目录已绑定，不能静默更换");
      if (execution.executionRoot && !linked.executionRoot) {
        linked.executionRoot = execution.executionRoot;
        for (const handoff of context.handoffs) if (handoff.source.kind === execution.kind && handoff.source.id === execution.id && !handoff.source.executionRoot) handoff.source.executionRoot = execution.executionRoot;
        context.revision += 1; context.updatedAt = new Date().toISOString();
        this.persist(context);
      }
      return context;
    }
    context.executions.push({ kind: execution.kind, id: execution.id, ...(execution.executionRoot ? { executionRoot: execution.executionRoot } : {}) });
    context.revision += 1;
    context.updatedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO task_context_executions(kind,execution_id,task_id,owner_user_id) VALUES (?,?,?,?)").run(execution.kind, execution.id, id, ownerUserId);
      this.persist(context);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return context;
  }
  /** Removes failed creations/deleted executions without retaining dangling task links. */
  unlink(execution: TaskExecution, ownerUserId: string): TaskContext | null {
    const context = this.forExecution(execution, ownerUserId);
    if (!context) return null;
    context.executions = context.executions.filter((item) => item.kind !== execution.kind || item.id !== execution.id);
    context.handoffs = context.handoffs.filter((item) => item.source.kind !== execution.kind || item.source.id !== execution.id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM task_context_executions WHERE kind=? AND execution_id=? AND owner_user_id=?").run(execution.kind, execution.id, ownerUserId);
      if (context.executions.length) {
        context.revision += 1; context.updatedAt = new Date().toISOString();
        this.persist(context);
      } else this.db.prepare("DELETE FROM task_contexts WHERE id=? AND owner_user_id=?").run(context.id, ownerUserId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return context.executions.length ? context : null;
  }
  handoff(id: string, ownerUserId: string, handoff: TaskHandoff) {
    const context = this.get(id, ownerUserId);
    if (!context) throw new Error("任务上下文不存在");
    const source = context.executions.find((execution) => execution.kind === handoff.source.kind && execution.id === handoff.source.id);
    if (!source) throw new Error("交接来源不属于当前任务");
    if (handoff.source.executionRoot && source.executionRoot && !taskRootsEqual(handoff.source.executionRoot, source.executionRoot)) throw new Error("交接来源的执行目录不匹配");
    if (!Number.isInteger(handoff.sourceRevision) || handoff.sourceRevision < 0) throw new Error("交接来源版本无效");
    const previous = context.handoffs.filter((item) => item.source.kind === handoff.source.kind && item.source.id === handoff.source.id).at(-1);
    if (previous && previous.sourceRevision >= handoff.sourceRevision) return context;
    const sanitized: TaskHandoff = {
      source: { kind: source.kind, id: source.id, ...(source.executionRoot ? { executionRoot: source.executionRoot } : {}) },
      sourceRevision: handoff.sourceRevision, createdAt: new Date().toISOString(), goal: redactTaskText(handoff.goal).slice(0, 4000),
      messages: handoff.messages.slice(-12).filter((message) => message.role === "user" || message.role === "assistant").map((message) => ({ id: message.id, role: message.role, text: redactTaskText(message.text).slice(0, 4000) })),
      attachments: handoff.attachments.slice(0, 100).map((attachment) => ({ name: redactTaskText(attachment.name), path: redactTaskText(attachment.path) })),
      decisions: handoff.decisions.slice(-30).map(redactTaskText), files: handoff.files.slice(0, 100).map(redactTaskText), unresolved: handoff.unresolved.slice(0, 30).map(redactTaskText)
    };
    context.handoffs = [...context.handoffs, sanitized].slice(-16);
    context.revision += 1; context.updatedAt = new Date().toISOString();
    this.persist(context);
    return context;
  }
  private persist(context: TaskContext) {
    this.db.prepare("INSERT INTO task_contexts(id,owner_user_id,workspace_id,json) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(context.id, context.ownerUserId, context.workspaceId, JSON.stringify(context));
  }
}
