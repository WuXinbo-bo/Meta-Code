import type { Express } from "express";
import fs from "node:fs/promises";
import type { Session } from "../workbench/types.js";
import type { WorkflowRecord } from "../plugins/orchestration/types.js";
import { normalizeProviderId } from "../agents/types.js";
import { latestTaskHandoffForRoot, redactTaskText, renderTaskHandoff, sessionHandoff, taskRootKey, taskRootsEqual, TaskContextStore, type TaskHandoff } from "./context.js";

type TaskContextPorts = {
  store: TaskContextStore;
  sessionById: (id: string, ownerUserId: string) => Session | undefined;
  workflowById: (id: string, ownerUserId: string) => WorkflowRecord | null;
  executionRootForSession: (session: Session) => string | undefined;
  createConversation: (input: { ownerUserId: string; workspaceId: string; title: string; engine: string; taskContextId: string; executionRoot?: string; handoff: string }) => Promise<Session>;
  publishWorkflowResult: (workflow: WorkflowRecord) => void;
};

export function workflowHandoff(workflow: WorkflowRecord): TaskHandoff {
  const finalResult = ["completed", "needs_review"].includes(workflow.status) && !workflow.nodes.some((node) => node.staleReason) ? workflow.finalResult : null;
  const results = [...workflow.nodes.filter((node) => node.status === "completed" && !node.staleReason).map((node) => node.summary), finalResult].filter((result) => Boolean(result));
  return {
    source: { kind: "workflow", id: workflow.id, executionRoot: workflow.executionRoot || workflow.workDirectory }, sourceRevision: workflow.revision,
    goal: redactTaskText(workflow.originalPrompt).slice(0, 4000),
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
      if (preferredSession) ports.store.link(context.id, { kind: "session", id: preferredSession.id, executionRoot }, ownerUserId, context.workspaceId);
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
      const latest = source ? workflowHandoff(source) : latestTaskHandoffForRoot(ports.store.get(context.id, ownerUserId), executionRoot);
      const creation = ports.createConversation({ ownerUserId, workspaceId: context.workspaceId, title: context.title, engine, taskContextId: context.id, executionRoot, handoff: latest ? renderTaskHandoff(latest) : "" });
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
