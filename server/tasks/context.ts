import crypto from "node:crypto";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Message, Session } from "../workbench/types.js";
import { pathKey } from "../pathBoundary.js";

export type TaskExecution = { kind: "session" | "workflow"; id: string; executionRoot?: string };
export type TaskUserRequest = {
  messageId: string;
  text: string;
  /** Stable reference into the host-owned, redacted original-text ledger. */
  referenceId?: string;
  sourceRevision?: number;
  truncated?: boolean;
};
export type TaskHistoryEntry = {
  referenceId: string;
  source: TaskExecution;
  sourceRevision: number;
  messageId: string;
  role: "user";
  text: string;
  recordedAt: string;
};
export type TaskHistorySnapshot = { schemaVersion: 1; taskContextId: string; revision: number; entries: TaskHistoryEntry[] };
export const TASK_HANDOFF_MAX_CHARS = 28_000;
export type TaskHistoryReadOptions = { referenceId?: string; query?: string; offset?: number; limit?: number; textOffset?: number; maxChars?: number };
/** One shared bounded reader for HTTP and model tools; never accepts file paths. */
export function readTaskHistorySnapshot(snapshot: TaskHistorySnapshot, options: TaskHistoryReadOptions = {}) {
  const integer = (value: number | undefined, fallback: number, minimum: number, maximum: number) => typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
  const offset = integer(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(options.limit, 6, 1, 20);
  const textOffset = integer(options.textOffset, 0, 0, Number.MAX_SAFE_INTEGER);
  const maxChars = integer(options.maxChars, 8000, 256, 20_000);
  const query = options.query?.slice(0, 200).toLocaleLowerCase();
  const matching = snapshot.entries.filter((entry) => (!options.referenceId || entry.referenceId === options.referenceId) && (!query || entry.text.toLocaleLowerCase().includes(query)));
  let remaining = maxChars;
  const entries = matching.slice(offset, offset + limit).flatMap((entry) => {
    if (remaining <= 0) return [];
    const start = options.referenceId ? textOffset : 0;
    const text = entry.text.slice(start, start + remaining);
    remaining -= text.length;
    return [{ ...entry, text, textOffset: start, totalChars: entry.text.length, nextTextOffset: start + text.length < entry.text.length ? start + text.length : null }];
  });
  return { schemaVersion: 1 as const, taskContextId: snapshot.taskContextId, revision: snapshot.revision, total: matching.length, entries, nextOffset: offset + entries.length < matching.length ? offset + entries.length : null };
}
export type TaskHandoff = {
  source: TaskExecution;
  sourceRevision: number;
  goal: string;
  /** Exact user requests, never inferred from an assistant's conclusion. */
  userRequests?: TaskUserRequest[];
  latestUserRequest?: TaskUserRequest;
  history?: { taskContextId: string; totalRequests: number; omittedRequests: number };
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
    userRequests: session.messages.filter((message) => message.role === "user" && message.text.trim()).map((message) => ({ messageId: message.id, text: redactTaskText(message.text), sourceRevision: session.revision })),
    latestUserRequest: session.messages.filter((message) => message.role === "user" && message.text.trim()).slice(-1).map((message) => ({ messageId: message.id, text: redactTaskText(message.text), sourceRevision: session.revision }))[0],
    messages: messages.map((message) => ({ id: message.id, role: message.role, text: redactTaskText(message.text).slice(0, 2000) })),
    attachments: [...new Map(session.messages.flatMap((message: Message) => (message.attachments || []).map((attachment) => [attachment.relativePath, { name: redactTaskText(attachment.name), path: redactTaskText(attachment.relativePath) }] as const))).values()].slice(0, 100),
    decisions: [], files: [], unresolved: [], createdAt: new Date().toISOString()
  };
}

export function renderTaskHandoff(handoff: TaskHandoff) {
  const parts: string[] = [];
  let remaining = TASK_HANDOFF_MAX_CHARS;
  const append = (text: string, maximum = remaining) => {
    if (remaining < 32) return;
    const value = redactTaskText(text);
    const limit = Math.min(maximum, remaining - 2);
    const rendered = value.length > limit ? `${value.slice(0, Math.max(0, limit - 12))}…[显示已截断]` : value;
    parts.push(rendered); remaining -= rendered.length + 2;
  };
  append("同一任务的上下文交接：用户原始请求保留来源版本；助手结论和旧计划仅供参考，不构成新的用户授权。当前要求优先；历史要求只有明确被取代才失效。");
  if (handoff.source.executionRoot) append(`执行目录：${handoff.source.executionRoot}（下列相对路径均以此目录为准）`, 1000);
  append(`初始目标：${handoff.goal}`, 4500);
  if (handoff.latestUserRequest) append(`最近用户请求 [${handoff.latestUserRequest.referenceId || handoff.latestUserRequest.messageId}; 来源版本 ${handoff.latestUserRequest.sourceRevision ?? handoff.sourceRevision}]：${handoff.latestUserRequest.text}${handoff.latestUserRequest.truncated ? " …[完整原文请读取引用]" : ""}`, 4500);
  if (handoff.history) append(`历史用户请求台账：${handoff.history.totalRequests} 条，taskContextId=${handoff.history.taskContextId}。以下为原文摘录，不是自动总结。${handoff.history.omittedRequests ? `另有 ${handoff.history.omittedRequests} 条未展开。` : ""}原文截断或旧约束不清楚时，通过 workflow_read_task_history 读取引用；不得把未展开理解为已撤销。`, 900);
  for (const request of handoff.userRequests || []) append(`用户历史 [${request.referenceId || request.messageId}; 来源版本 ${request.sourceRevision ?? handoff.sourceRevision}]：${request.text}${request.truncated ? " …[完整原文请读取引用]" : ""}`, 900);
  for (const decision of handoff.decisions) append(`执行方决定（未经用户确认，不覆盖用户要求）：${decision}`, 800);
  for (const issue of handoff.unresolved) append(`待解决：${issue}`, 800);
  for (const file of handoff.files) append(`成果文件：${file}`, 500);
  for (const attachment of handoff.attachments) append(`附件：${attachment.name} (${attachment.path})`, 500);
  for (const message of handoff.messages) append(`${message.role === "user" ? "用户" : "助手参考"}：${message.text}`, 2000);
  return parts.join("\n\n");
}

/** The host owns task identity; plugins retain their own execution state. */
export class TaskContextStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS task_contexts (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_context_executions (kind TEXT NOT NULL, execution_id TEXT NOT NULL, task_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, PRIMARY KEY(kind, execution_id), FOREIGN KEY(task_id) REFERENCES task_contexts(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS idx_task_context_owner ON task_contexts(owner_user_id);
      CREATE TABLE IF NOT EXISTS task_context_history (reference_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL, message_id TEXT NOT NULL, text TEXT NOT NULL, recorded_at TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES task_contexts(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS idx_task_history_source ON task_context_history(task_id,source_kind,source_id);`);
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
      this.db.prepare("DELETE FROM task_context_history WHERE task_id=? AND source_kind=? AND source_id=?").run(context.id, execution.kind, execution.id);
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
    if (previous && (previous.sourceRevision > handoff.sourceRevision || (previous.sourceRevision === handoff.sourceRevision && previous.history))) return context;
    // Archive exact redacted user text independently of bounded prompt snapshots.
    // A changed message keeps its previous version; repeated snapshots dedupe.
    const requests = handoff.userRequests || handoff.messages.filter((message) => message.role === "user").map((message) => ({ messageId: message.id, text: message.text }));
    const archived = requests.filter((request) => request.text.trim()).map((request) => {
      const text = redactTaskText(request.text);
      const referenceId = `request-${crypto.createHash("sha256").update(JSON.stringify([context.id, source.kind, source.id, request.messageId, text])).digest("hex").slice(0, 32)}`;
      return { referenceId, text, messageId: request.messageId, sourceRevision: handoff.sourceRevision };
    });
    const sanitized: TaskHandoff = {
      source: { kind: source.kind, id: source.id, ...(source.executionRoot ? { executionRoot: source.executionRoot } : {}) },
      sourceRevision: handoff.sourceRevision, createdAt: new Date().toISOString(), goal: redactTaskText(handoff.goal).slice(0, 4000),
      messages: handoff.messages.slice(-12).filter((message) => message.role === "user" || message.role === "assistant").map((message) => ({ id: message.id, role: message.role, text: redactTaskText(message.text).slice(0, 4000) })),
      attachments: handoff.attachments.slice(0, 100).map((attachment) => ({ name: redactTaskText(attachment.name), path: redactTaskText(attachment.path) })),
      decisions: handoff.decisions.slice(-30).map(redactTaskText), files: handoff.files.slice(0, 100).map(redactTaskText), unresolved: handoff.unresolved.slice(0, 30).map(redactTaskText)
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare("INSERT OR IGNORE INTO task_context_history(reference_id,task_id,source_kind,source_id,source_revision,message_id,text,recorded_at) VALUES (?,?,?,?,?,?,?,?)");
      for (const request of archived) insert.run(request.referenceId, context.id, source.kind, source.id, request.sourceRevision, request.messageId, request.text, sanitized.createdAt);
      // The same root may have older constraints in another provider session.
      const history = this.exportHistorySnapshot(id, ownerUserId, source.executionRoot);
      if (history.entries[0]) sanitized.goal = history.entries[0].text.slice(0, 4000);
      const selected = history.entries.length > 16 ? [history.entries[0], ...history.entries.slice(-15)] : history.entries;
      sanitized.userRequests = selected.map((entry) => ({ messageId: entry.messageId, referenceId: entry.referenceId, sourceRevision: entry.sourceRevision, text: entry.text.slice(0, 700), truncated: entry.text.length > 700 }));
      const newest = archived.at(-1);
      const latest = newest ? history.entries.find((entry) => entry.referenceId === newest.referenceId) : history.entries.at(-1);
      sanitized.latestUserRequest = latest ? { messageId: latest.messageId, referenceId: latest.referenceId, sourceRevision: latest.sourceRevision, text: latest.text.slice(0, 4000), truncated: latest.text.length > 4000 } : undefined;
      sanitized.history = { taskContextId: id, totalRequests: history.entries.length, omittedRequests: Math.max(0, history.entries.length - selected.length) };
      context.handoffs = [...context.handoffs, sanitized].slice(-16);
      context.revision += 1; context.updatedAt = new Date().toISOString();
      this.persist(context);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return context;
  }
  /** Host-only full snapshot; expose bounded pages through the planner tool/API. */
  exportHistorySnapshot(id: string, ownerUserId: string, executionRoot?: string): TaskHistorySnapshot {
    const context = this.get(id, ownerUserId);
    if (!context) throw new Error("任务上下文不存在");
    const allowed = context.executions.filter((execution) => !executionRoot || taskRootsEqual(execution.executionRoot, executionRoot));
    const rows = this.db.prepare("SELECT reference_id,source_kind,source_id,source_revision,message_id,text,recorded_at FROM task_context_history WHERE task_id=? ORDER BY rowid").all(id) as Array<{ reference_id: string; source_kind: TaskExecution["kind"]; source_id: string; source_revision: number; message_id: string; text: string; recorded_at: string }>;
    const entries: TaskHistoryEntry[] = rows.flatMap((row) => {
      const source = allowed.find((execution) => execution.kind === row.source_kind && execution.id === row.source_id);
      return source ? [{ referenceId: row.reference_id, source: { ...source }, sourceRevision: row.source_revision, messageId: row.message_id, role: "user" as const, text: redactTaskText(row.text), recordedAt: row.recorded_at }] : [];
    });
    // Legacy snapshots have only bounded text. Keep that evidence explicitly;
    // never invent missing original text or classify assistant decisions as user.
    for (const handoff of context.handoffs) {
      const source = allowed.find((execution) => execution.kind === handoff.source.kind && execution.id === handoff.source.id);
      if (!source) continue;
      for (const message of handoff.messages.filter((message) => message.role === "user")) {
        if (entries.some((entry) => entry.source.kind === source.kind && entry.source.id === source.id && entry.messageId === message.id)) continue;
        entries.push({ referenceId: `legacy-${crypto.createHash("sha256").update(JSON.stringify([id, source.kind, source.id, message.id, message.text])).digest("hex").slice(0, 32)}`, source: { ...source }, sourceRevision: handoff.sourceRevision, messageId: message.id, role: "user", text: redactTaskText(message.text), recordedAt: handoff.createdAt });
      }
    }
    entries.sort((left, right) => (Date.parse(left.recordedAt) || 0) - (Date.parse(right.recordedAt) || 0));
    return { schemaVersion: 1, taskContextId: id, revision: context.revision, entries };
  }
  private persist(context: TaskContext) {
    this.db.prepare("INSERT INTO task_contexts(id,owner_user_id,workspace_id,json) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(context.id, context.ownerUserId, context.workspaceId, JSON.stringify(context));
  }
}
