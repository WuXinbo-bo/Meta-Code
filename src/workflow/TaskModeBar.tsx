import { useEffect, useRef, useState } from "react";
import { ChevronDown, FileCheck2, LoaderCircle, MessageSquare, Plus, Route, Send, X } from "lucide-react";
import { realtimeCoordinator } from "../realtimeCoordinator";
import { coalescedWorkflowRefresh } from "./eventRefresh";
import { readWorkflowHandoff } from "../tasks/workflowHandoff";
import "./TaskModeBar.css";

type Execution = { kind: "session" | "workflow"; id: string };
type Context = { id: string; title: string; executions: Execution[] };

export function TaskModeBar({ sessionId, workflowId, engine, enabled, defaultGoal = "", onConversation, onWorkflow, onCreateWorkflow, onError }: {
  sessionId?: string; workflowId?: string; engine: string; enabled: boolean; defaultGoal?: string;
  onConversation: (id: string) => void; onWorkflow: (id: string) => void;
  onCreateWorkflow: (taskContextId: string, goal: string) => Promise<void>; onError: (message: string) => void;
}) {
  const [context, setContext] = useState<Context | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [goal, setGoal] = useState("");
  const generation = useRef(0);
  const sourceKey = JSON.stringify([sessionId || "", workflowId || "", engine]);
  const currentSource = useRef(sourceKey);
  currentSource.current = sourceKey;
  const operationSequence = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setContext(null);
    setCreating(false);
    setBusy(false);
    const query = sessionId ? `sessionId=${encodeURIComponent(sessionId)}` : workflowId ? `workflowId=${encodeURIComponent(workflowId)}` : "";
    const load = () => query && fetch(`/api/task-contexts/lookup?${query}`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("无法读取任务关联");
      return response.json();
    }).then((value) => { if (generation.current === current && currentSource.current === sourceKey) setContext(value); }).catch(() => undefined);
    void load();
    const refresh = coalescedWorkflowRefresh(async () => { await load(); });
    const unsubscribe = realtimeCoordinator.subscribe("workflow.changed", (detail) => {
      if (typeof detail.eventType === "string" && /\.(log|worker)$/.test(detail.eventType)) return;
      refresh.schedule();
    });
    const sessions = realtimeCoordinator.subscribe("sessions.changed", refresh.schedule);
    const reconcile = realtimeCoordinator.subscribeReconcile(refresh.schedule);
    return () => { generation.current += 1; controller.abort(); refresh.dispose(); unsubscribe(); sessions(); reconcile(); };
  }, [sessionId, workflowId, engine]);
  if (!sessionId && !workflowId) return null;
  const workflows = context?.executions.filter((execution) => execution.kind === "workflow") || [];
  const invoke = async (operation: (isCurrent: () => boolean) => Promise<void>) => {
    const current = generation.current;
    const sequence = ++operationSequence.current;
    const isCurrent = () => generation.current === current && currentSource.current === sourceKey && operationSequence.current === sequence;
    setBusy(true);
    try { await operation(isCurrent); }
    catch (error) { if (isCurrent()) onError(error instanceof Error ? error.message : String(error)); }
    finally { if (isCurrent()) setBusy(false); }
  };
  const begin = () => { setGoal(defaultGoal); setCreating(true); };
  const openConversation = async (isCurrent: () => boolean) => {
    if (sessionId) return;
    if (!context) return;
    const response = await fetch(`/api/task-contexts/${encodeURIComponent(context.id)}/conversation`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflowId, engine }) });
    const value = await response.json();
    if (!isCurrent()) return;
    if (!response.ok) throw new Error(value.error || "无法切回对话");
    onConversation(value.id);
  };
  return <nav className="task-mode-bar" aria-label="任务工作模式">
    <button type="button" className={sessionId ? "active" : ""} disabled={busy || !context} onClick={() => void invoke(openConversation)}><MessageSquare size={14} />对话</button>
    {workflows.length > 1 ? <select aria-label="编排方案" disabled={busy} value={workflowId || ""} onChange={(event) => { if (event.target.value) onWorkflow(event.target.value); }}><option value="" disabled>编排</option>{workflows.map((execution, index) => <option key={execution.id} value={execution.id}>方案 {index + 1}</option>)}</select>
      : <button type="button" className={workflowId ? "active" : ""} disabled={busy || !context || !enabled && !workflows.length} onClick={() => { const existing = workflows.at(-1); if (existing) onWorkflow(existing.id); else if (context) begin(); }}><Route size={14} />编排</button>}
    {sessionId && enabled && workflows.length > 0 && <button type="button" className="task-mode-new" title="追加一轮编排" aria-label="追加一轮编排" disabled={busy || !context} onClick={begin}><Plus size={14} /></button>}
    {busy && <LoaderCircle size={13} className="spin" />}
    {creating && <form className="task-mode-create" aria-label="本轮编排目标" onSubmit={(event) => { event.preventDefault(); if (!busy && context && goal.trim()) void invoke(async (isCurrent) => { await onCreateWorkflow(context.id, goal.trim()); if (isCurrent()) setCreating(false); }); }}>
      <header><strong>本轮编排目标</strong><button type="button" aria-label="关闭编排目标" onClick={() => setCreating(false)}><X size={14} /></button></header>
      <textarea autoFocus aria-label="编排目标" rows={3} value={goal} onChange={(event) => setGoal(event.target.value)} />
      <footer><small>沿用当前任务目录，生成计划后由你批准。</small><button type="submit" disabled={busy || !goal.trim()}><Route size={14} />生成计划</button></footer>
    </form>}
  </nav>;
}

export function CompactWorkflowProgress({ workflowId, onOpen, onContinueConversation }: { workflowId: string; onOpen: () => void; onContinueConversation?: () => void }) {
  const [workflow, setWorkflow] = useState<{ id: string; revision?: number; activePlanVersion?: number; title: string; status: string; plan?: unknown; plannerEngine: string; nodes: Array<{ status: string }>; pendingMaintenance?: unknown; finalResult?: { humanSummary: string; unresolved?: string[]; outputs?: Array<{ path?: string | null }> } | null; plannerLogs?: Array<{ title: string; text: string; createdAt: string }> } | null>(null);
  const [intent, setIntent] = useState<"question" | "adjust" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [answer, setAnswer] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const answerUpdatedAt = useRef("");
  const acceptAnswer = (text: string, createdAt = "") => {
    if (createdAt < answerUpdatedAt.current) return;
    answerUpdatedAt.current = createdAt;
    setAnswer(text);
  };
  const generation = useRef(0);
  const currentWorkflowId = useRef(workflowId);
  currentWorkflowId.current = workflowId;
  const acceptWorkflow = (value: NonNullable<typeof workflow>) => {
    if (currentWorkflowId.current !== workflowId || value.id !== workflowId) return;
    setWorkflow((current) => current?.id === workflowId && (current.revision || 0) > (value.revision || 0) ? current : value);
  };
  useEffect(() => {
    let disposed = false;
    const current = ++generation.current;
    const controller = new AbortController();
    answerUpdatedAt.current = "";
    setWorkflow(null); setFeedback(""); setAnswer(""); setIntent(null); setNote(""); setBusy(false); setCollapsed(false);
    const load = async () => {
      try {
        const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`, { signal: controller.signal });
        let latestQuery: { text: string; createdAt: string } | undefined;
        if (response.ok) { const value = await response.json(); latestQuery = value.plannerLogs?.filter((log: { title: string }) => log.title === "任务问答").at(-1); if (!disposed && generation.current === current) { acceptWorkflow(value); if (latestQuery) acceptAnswer(latestQuery.text, latestQuery.createdAt); } }
        const maintenance = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/maintenance`, { signal: controller.signal });
        if (maintenance.ok) {
          const value: unknown = await maintenance.json();
          const messages = value && typeof value === "object" && Array.isArray((value as { messages?: unknown }).messages) ? (value as { messages: Array<{ role?: string; text?: unknown; createdAt?: string }> }).messages : [];
          const latest = messages.filter((message) => message.role === "assistant").at(-1);
          if (!disposed && generation.current === current && currentWorkflowId.current === workflowId && typeof latest?.text === "string") acceptAnswer(latest.text, latest.createdAt);
        }
      } catch { /* Reconcile after reconnect. */ }
    };
    void load();
    const refresh = coalescedWorkflowRefresh(load);
    const unsubscribe = realtimeCoordinator.subscribe("workflow.changed", (detail) => {
      if (detail.workflowId !== workflowId || typeof detail.eventType === "string" && /\.(log|worker)$/.test(detail.eventType)) return;
      refresh.schedule();
    });
    const reconcile = realtimeCoordinator.subscribeReconcile(refresh.schedule);
    return () => { generation.current += 1; disposed = true; controller.abort(); refresh.dispose(); unsubscribe(); reconcile(); };
  }, [workflowId]);
  if (!workflow || workflow.id !== workflowId) return null;
  const active = ["planning", "queued", "running", "integrating"].includes(workflow.status);
  const requestMaintenance = async () => {
    if (busy || !note.trim() || !intent) return;
    const current = generation.current;
    const isCurrent = () => generation.current === current && currentWorkflowId.current === workflowId;
    setBusy(true); setFeedback("");
    try {
      const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "maintenance", mode: "refine", note: note.trim(), intent, plannerEngine: workflow.plannerEngine }) });
      const value = await response.json();
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(value.error || "请求未完成");
      if (value.workflow) acceptWorkflow(value.workflow);
      if (value.queriedSnapshot && typeof value.queryAnswer === "string") {
        const queryLog = value.workflow?.plannerLogs?.filter((log: { title: string }) => log.title === "任务问答").at(-1);
        acceptAnswer(value.queryAnswer, queryLog?.createdAt || value.capturedAt || new Date().toISOString());
      }
      setFeedback(value.queriedSnapshot ? "已根据当前快照回复，执行继续进行" : value.queuedUntilCheckpoint ? "已收到，等待当前节点完成后处理" : "正在处理；调整计划仍需批准后执行");
      setNote("");
    } catch (error) { if (isCurrent()) setFeedback(error instanceof Error ? error.message : String(error)); }
    finally { if (isCurrent()) setBusy(false); }
  };
  const completed = workflow.nodes.filter((node) => node.status === "completed").length;
  const remaining = Math.max(0, workflow.nodes.length - completed);
  const outputCount = workflow.finalResult?.outputs?.filter((output) => output.path).length || 0;
  const unresolved = workflow.finalResult?.unresolved || [];
  const transitionStatus: Record<string, string> = { draft: "编排待规划", planning: "正在规划", awaiting_approval: "编排等待批准", queued: "编排等待执行", running: "编排正在执行", integrating: "正在整合成果", completed: "编排已完成", paused: "编排已暂停", needs_review: "编排需要处理", failed: "编排未完成", canceled: "编排已取消" };
  const continueConversation = onContinueConversation || (() => { document.querySelector<HTMLTextAreaElement>(".composer textarea, textarea[aria-label*='任务']")?.focus(); });
  return <section className={`task-workflow-card task-transition-card ${collapsed ? "is-collapsed" : ""}`} aria-label="编排进度交接">
    <header className="task-transition-header">
      <div className="task-transition-kicker"><Route size={13} /><span>任务编排</span><em>{transitionStatus[workflow.status] || workflow.status}</em></div>
      <button type="button" className="task-transition-collapse" aria-label={collapsed ? "展开编排进度交接" : "收起编排进度交接"} aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}><ChevronDown size={14} /></button>
    </header>
    {!collapsed && <>
      <div className="task-transition-summary"><strong>{transitionStatus[workflow.status] || workflow.status}</strong>{workflow.finalResult?.humanSummary && <span>{workflow.finalResult.humanSummary}</span>}</div>
      <button type="button" className="task-workflow-progress" onClick={onOpen} title="查看编排详情">
        {active ? <LoaderCircle size={15} className="spin" /> : <FileCheck2 size={15} />}
        <span><strong>{workflow.title}</strong><small>{workflow.nodes.length ? `${completed} / ${workflow.nodes.length} 项已完成` : "尚未生成计划"}</small></span><Route size={14} />
      </button>
      <div className="task-transition-meta" aria-label="编排交接摘要">{workflow.nodes.length > 0 && <><span><strong>{completed}</strong>已完成</span><span><strong>{remaining}</strong>未完成</span></>}{Boolean(workflow.plan) && <span><strong>v{workflow.activePlanVersion || 1}</strong>计划</span>}{outputCount > 0 && <span><strong>{outputCount}</strong>项成果</span>}</div>
      {unresolved.length > 0 && <p className="task-transition-unresolved"><span>待处理</span>{unresolved.slice(0, 2).join("；")}{unresolved.length > 2 ? ` 等 ${unresolved.length} 项` : ""}</p>}
      <div className="task-workflow-actions"><button type="button" onClick={onOpen}><Route size={12} />查看编排</button><button type="button" className="task-transition-continue" onClick={continueConversation}><MessageSquare size={12} />继续对话</button>{workflow.plan !== undefined && workflow.plan !== null && <><button type="button" className={intent === "question" ? "active" : ""} onClick={() => setIntent((current) => current === "question" ? null : "question")}><MessageSquare size={12} />询问编排</button><button type="button" className={intent === "adjust" ? "active" : ""} onClick={() => setIntent((current) => current === "adjust" ? null : "adjust")}><Route size={12} />调整计划</button>{workflow.pendingMaintenance ? <small><LoaderCircle size={12} className="spin" />等待检查点</small> : workflow.status === "awaiting_approval" ? <button type="button" onClick={onOpen}>查看并批准计划</button> : null}</>}</div>
      {intent && <form className="task-workflow-input" onSubmit={(event) => { event.preventDefault(); void requestMaintenance(); }}><input aria-label={intent === "question" ? "编排问题" : "计划调整要求"} placeholder={intent === "question" ? "询问进度、结果或下一步" : "保留哪些成果，调整哪些任务…"} value={note} onChange={(event) => setNote(event.target.value)} disabled={busy || intent === "adjust" && Boolean(workflow.pendingMaintenance)} /><button type="submit" aria-label="发送编排请求" disabled={busy || intent === "adjust" && Boolean(workflow.pendingMaintenance) || !note.trim()}>{busy ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />}</button></form>}
      {feedback && <p className="task-workflow-feedback" role="status">{feedback}</p>}
      {answer && intent && <details className="task-workflow-answer"><summary>最近回复</summary><p>{answer}</p></details>}
    </>}
  </section>;
}

/**
 * Renders the durable handoff written when an orchestration is opened as a
 * conversation. Keeping this at the message boundary prevents the verbose
 * handoff prompt from looking like a second assistant answer while retaining
 * the original text for inspection.
 */
export function HandoffCard({ text, sourceKind = "workflow", workflowId, onOpenWorkflow, dataMessageId }: { text: string; sourceKind?: "session" | "workflow"; workflowId?: string; onOpenWorkflow?: () => void; dataMessageId?: string }) {
  const [collapsed, setCollapsed] = useState(true);
  const handoff = readWorkflowHandoff(text);
  const conversationSource = sourceKind === "session";
  const detailsLabel = conversationSource ? "上下文交接详情" : "编排交接详情";
  return <article className={`task-handoff-card ${collapsed ? "is-collapsed" : ""}`} data-message-id={dataMessageId} aria-label={conversationSource ? "任务上下文交接" : "编排进度交接"}>
    <header><div className="task-transition-kicker">{conversationSource ? <MessageSquare size={13} /> : <Route size={13} />}<span>{conversationSource ? "任务上下文交接" : handoff.completed ? "编排成果交接" : "编排进度交接"}</span><em>{conversationSource ? "来自同一任务对话" : handoff.completed ? "成果已回到当前对话" : "已回到同一任务对话"}</em></div><button type="button" className="task-transition-collapse" aria-label={`${collapsed ? "展开" : "收起"}${detailsLabel}`} aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}><ChevronDown size={14} /></button></header>
    <div className="task-handoff-summary"><strong title={handoff.title}>{handoff.title}</strong>{handoff.summary && <span className="task-handoff-result">{handoff.summary}</span>}</div>
    {(handoff.files.length > 0 || handoff.unresolved.length > 0) && <div className="task-transition-meta">{handoff.files.length > 0 && <span><strong>{handoff.files.length}</strong>项成果</span>}{handoff.unresolved.length > 0 && <span><strong>{handoff.unresolved.length}</strong>项未决</span>}</div>}
    {!collapsed && <div className="task-handoff-details"><dl><div><dt>来源</dt><dd>{conversationSource ? "普通对话" : "任务编排"}</dd></div>{handoff.files.length > 0 && <div><dt>成果</dt><dd>{handoff.files.join("\n")}</dd></div>}{handoff.decisions.length > 0 && <div><dt>决定</dt><dd>{handoff.decisions.join("\n")}</dd></div>}{handoff.unresolved.length > 0 && <div><dt>未决</dt><dd>{handoff.unresolved.join("\n")}</dd></div>}</dl><details><summary>交接原文</summary><pre>{text}</pre></details></div>}
    <footer>{workflowId && onOpenWorkflow && <button type="button" onClick={onOpenWorkflow}><Route size={12} />查看编排</button>}<button type="button" className="task-transition-continue" onClick={() => document.querySelector<HTMLTextAreaElement>(".composer textarea, textarea[aria-label*='任务']")?.focus()}><MessageSquare size={12} />继续对话</button></footer>
  </article>;
}
