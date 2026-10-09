import type { Express } from "express";
import fs from "node:fs/promises";
import type { Session } from "../workbench/types.js";
import type { WorkflowRecord } from "../plugins/orchestration/types.js";
import { normalizeProviderId } from "../agents/types.js";
import { latestTaskHandoffForRoot, readTaskHistorySnapshot, redactTaskText, renderTaskHandoff, sessionHandoff, taskRootKey, taskRootsEqual, TaskContextStore, type TaskHandoff } from "./context.js";

type TaskContextPorts = {
  store: TaskContextStore;
  sessionById: (id: string, ownerUserId: string) => Session | undefined;
  workflowById: (id: string, ownerUserId: string) => WorkflowRecord | null;
  executionRootForSession: (session: Session) => string | undefined;
  createConversation: (input: { ownerUserId: string; workspaceId: string; title: string; engine: string; taskContextId: string; executionRoot?: string; handoff: string; handoffSource?: TaskHandoff["source"] & { sourceRevision: number } }) => Promise<Session>;
  publishWorkflowResult: (workflow: WorkflowRecord) => void;
};

export function workflowHandoff(workflow: WorkflowRecord): TaskHandoff {
  const finalResult = ["completed", "needs_review"].includes(workflow.status) && !workflow.nodes.some((node) => node.staleReason) ? workflow.finalResult : null;
  const results = [...workflow.nodes.filter((node) => node.status === "completed" && !node.staleReason).map((node) => node.summary), finalResult].filter((result) => Boolean(result));
  return {
    source: { kind: "workflow", id: workflow.id, executionRoot: workflow.executionRoot || workflow.workDirectory }, sourceRevision: workflow.revision,
    goal: redactTaskText(workflow.originalPrompt).slice(0, 4000),
    userRequests: [
      { messageId: `${workflow.id}:goal`, text: redactTaskText(workflow.originalPrompt) },
      ...(workflow.reviewNote?.trim() ? [{ messageId: `${workflow.id}:review:${workflow.activePlanVersion}`, text: redactTaskText(workflow.reviewNote) }] : [])
    ],
    messages: [{ id: workflow.id, role: "assistant", text: redactTaskText(results.map((result) => result!.humanSummary).join("\n")).slice(0, 12_000) }],
    attachments: [], decisions: results.flatMap((result) => result!.decisions.map((decision) => redactTaskText(`${decision.key}: ${decision.value}`))).slice(-30),
    files: [...new Set(results.flatMap((result) => result!.outputs.flatMap((output) => output.path ? [output.path] : [])))].slice(0, 100),
    unresolved: [...results.flatMap((result) => result!.unresolved), ...workflow.nodes.filter((node) => node.staleReason || ["failed", "blocked", "interrupted"].includes(node.status)).map((node) => `${node.title}: ${node.staleReason || node.error || "尚未完成"}`)].map(redactTaskText).slice(0, 30), createdAt: new Date().toISOString()
  };
}

export function registerTaskContextRoutes(app: Express, ports: TaskContextPorts) {
  // View switching may be retried by double clicks or reconnects. A native
  // session is created once per task/model/business root while the save awaits.
  const conversationCreations = new Map<string, Promise<Session>>();
  app.get("/api/task-contexts/lookup", (req, res) => {
    if (Boolean(req.query.sessionId) === Boolean(req.query.workflowId)) return res.status(400).json({ error: "请指定一个任务来源" });
    const ownerUserId = req.authUser!.id;
    const session = req.query.sessionId ? ports.sessionById(String(req.query.sessionId), ownerUserId) : undefined;
    const workflow = req.query.workflowId ? ports.workflowById(String(req.query.workflowId), ownerUserId) : null;
    if (!session && !workflow) return res.status(404).json({ error: "任务不存在" });
    const context = session
      ? ports.store.ensure({ kind: "session", id: session.id, executionRoot: ports.executionRootForSession(session) }, ownerUserId, session.workspaceId, session.title)
      : ports.store.ensure({ kind: "workflow", id: workflow!.id, executionRoot: workflow!.executionRoot || workflow!.workDirectory }, ownerUserId, workflow!.workspaceId, workflow!.title);
    res.json(context);
  });
  app.get("/api/task-contexts/:id", (req, res) => {
    const context = ports.store.get(req.params.id, req.authUser!.id);
    if (!context) return res.status(404).json({ error: "任务上下文不存在" });
    res.json(context);
  });
  app.get("/api/task-contexts/:id/history", (req, res) => {
    try {
      const ownerUserId = req.authUser!.id;
      const context = ports.store.get(req.params.id, ownerUserId);
      if (!context) return res.status(404).json({ error: "任务上下文不存在" });
      if (Boolean(req.query.sessionId) === Boolean(req.query.workflowId)) return res.status(400).json({ error: "请指定一个历史来源以确定执行目录" });
      const kind = req.query.sessionId ? "session" : "workflow";
      const sourceId = String(req.query.sessionId || req.query.workflowId);
      const source = context.executions.find((execution) => execution.kind === kind && execution.id === sourceId);
      if (!source?.executionRoot) return res.status(404).json({ error: "历史来源不存在或执行目录未绑定" });
      const snapshot = ports.store.exportHistorySnapshot(context.id, ownerUserId, source.executionRoot);
      res.json(readTaskHistorySnapshot(snapshot, {
        referenceId: typeof req.query.referenceId === "string" ? req.query.referenceId : undefined,
        query: typeof req.query.query === "string" ? req.query.query : undefined,
        offset: req.query.offset === undefined ? undefined : Number(req.query.offset),
        limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
        textOffset: req.query.textOffset === undefined ? undefined : Number(req.query.textOffset),
        maxChars: req.query.maxChars === undefined ? undefined : Number(req.query.maxChars)
      }));
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/task-contexts/:id/conversation", async (req, res) => {
    try {
      const ownerUserId = req.authUser!.id;
      const context = ports.store.get(req.params.id, ownerUserId);
      if (!context) return res.status(404).json({ error: "任务上下文不存在" });
      const sourceWorkflowId = String(req.body?.workflowId || "");
      const sourceSessionId = String(req.body?.sessionId || "");
      if (sourceWorkflowId && sourceSessionId) throw new Error("请指定一个任务来源");
      let source = sourceWorkflowId ? ports.workflowById(sourceWorkflowId, ownerUserId) : null;
      if (sourceWorkflowId && (!source || !context.executions.some((execution) => execution.kind === "workflow" && execution.id === sourceWorkflowId))) throw new Error("编排不属于当前任务");
      const sourceSession = sourceSessionId ? ports.sessionById(sourceSessionId, ownerUserId) : undefined;
      if (sourceSessionId && (!sourceSession || !context.executions.some((execution) => execution.kind === "session" && execution.id === sourceSessionId))) throw new Error("对话不属于当前任务");
      const sessions = [...context.executions].reverse().filter((execution) => execution.kind === "session")
        .map((execution) => ports.sessionById(execution.id, ownerUserId)).filter((session): session is Session => Boolean(session && !session.archivedAt))
        .sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0));
      const preferredSession = sourceSession || (!source ? sessions[0] : undefined);
      if (!source && !preferredSession) source = [...context.executions].reverse().filter((execution) => execution.kind === "workflow").map((execution) => ports.workflowById(execution.id, ownerUserId)).find((workflow) => Boolean(workflow)) || null;
      const engine = normalizeProviderId(req.body?.engine || source?.plannerEngine || preferredSession?.engine || "codex");
      const executionRoot = source?.executionRoot || source?.workDirectory || (preferredSession ? ports.executionRootForSession(preferredSession) : undefined);
      if (!executionRoot) throw new Error("当前任务没有可用的执行目录，请从对话或编排进入");
      if (!(await fs.stat(executionRoot)).isDirectory()) throw new Error("当前任务的执行目录不可用");
      if (preferredSession) {
        ports.store.link(context.id, { kind: "session", id: preferredSession.id, executionRoot }, ownerUserId, context.workspaceId);
        ports.store.handoff(context.id, ownerUserId, sessionHandoff(preferredSession, executionRoot));
      }
      const findExisting = () => [...(ports.store.get(context.id, ownerUserId)?.executions || [])].reverse().filter((execution) => execution.kind === "session")
        .map((execution) => ({ execution, session: ports.sessionById(execution.id, ownerUserId) }))
        .find(({ session }) => session?.engine === engine && session.workspaceId === context.workspaceId && !session.archivedAt && taskRootsEqual(ports.executionRootForSession(session), executionRoot));
      if (source) {
        ports.store.handoff(context.id, ownerUserId, workflowHandoff(source));
        ports.publishWorkflowResult(source);
      }
      const creationKey = JSON.stringify([ownerUserId, context.id, engine, taskRootKey(executionRoot)]);
      const pending = conversationCreations.get(creationKey);
      if (pending) return res.json(await pending);
      const existing = findExisting();
      if (existing?.session) return res.json(existing.session);
      const latest = latestTaskHandoffForRoot(ports.store.get(context.id, ownerUserId), executionRoot);
      const creation = ports.createConversation({ ownerUserId, workspaceId: context.workspaceId, title: context.title, engine, taskContextId: context.id, executionRoot, handoff: latest ? renderTaskHandoff(latest) : "", handoffSource: latest ? { ...latest.source, sourceRevision: latest.sourceRevision } : undefined });
      conversationCreations.set(creationKey, creation);
      try { res.status(201).json(await creation); }
      finally { if (conversationCreations.get(creationKey) === creation) conversationCreations.delete(creationKey); }
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/task-contexts/:id/handoff", (req, res) => {
    try {
      const context = ports.store.get(req.params.id, req.authUser!.id);
      const session = ports.sessionById(String(req.body?.sessionId || ""), req.authUser!.id);
      if (!context || !session || !context.executions.some((execution) => execution.kind === "session" && execution.id === session.id)) return res.status(404).json({ error: "任务或对话不存在" });
      const executionRoot = ports.executionRootForSession(session);
      if (!executionRoot) throw new Error("对话的执行目录不可用");
      ports.store.link(context.id, { kind: "session", id: session.id, executionRoot }, req.authUser!.id, session.workspaceId);
      res.json(ports.store.handoff(context.id, req.authUser!.id, sessionHandoff(session, executionRoot)));
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
