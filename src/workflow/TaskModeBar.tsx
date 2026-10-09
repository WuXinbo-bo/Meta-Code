import { useEffect, useRef, useState } from "react";
import { FileCheck2, LoaderCircle, MessageSquare, Plus, Route, Send, X } from "lucide-react";
import { realtimeCoordinator } from "../realtimeCoordinator";
import { coalescedWorkflowRefresh } from "./eventRefresh";
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

export function CompactWorkflowProgress({ workflowId, onOpen }: { workflowId: string; onOpen: () => void }) {
  const [workflow, setWorkflow] = useState<{ id: string; revision?: number; title: string; status: string; plan?: unknown; plannerEngine: string; nodes: Array<{ status: string }>; pendingMaintenance?: unknown; finalResult?: { humanSummary: string } | null } | null>(null);
  const [intent, setIntent] = useState<"question" | "adjust" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [answer, setAnswer] = useState("");
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
    setWorkflow(null); setFeedback(""); setAnswer(""); setIntent(null); setNote(""); setBusy(false);
    const load = async () => {
      try {
        const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`, { signal: controller.signal });
        if (response.ok) { const value = await response.json(); if (!disposed && generation.current === current) acceptWorkflow(value); }
        const maintenance = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/maintenance`, { signal: controller.signal });
        if (maintenance.ok) { const value: unknown = await maintenance.json(); const messages = value && typeof value === "object" && Array.isArray((value as { messages?: unknown }).messages) ? (value as { messages: Array<{ role?: string; text?: unknown }> }).messages : []; const latest = messages.filter((message) => message.role === "assistant").at(-1); if (!disposed && generation.current === current && currentWorkflowId.current === workflowId) setAnswer(typeof latest?.text === "string" ? latest.text : ""); }
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
      setFeedback(value.queuedUntilCheckpoint ? "已收到，等待当前节点完成后处理" : "正在处理；调整计划仍需批准后执行");
      setNote("");
    } catch (error) { if (isCurrent()) setFeedback(error instanceof Error ? error.message : String(error)); }
    finally { if (isCurrent()) setBusy(false); }
  };
  return <section className="task-workflow-card" aria-label="当前任务编排">
    <button type="button" className="task-workflow-progress" onClick={onOpen} title="查看编排详情">
    {active ? <LoaderCircle size={15} className="spin" /> : <FileCheck2 size={15} />}
    <span><strong>{workflow.title}</strong><small>{workflow.finalResult?.humanSummary || `${workflow.nodes.filter((node) => node.status === "completed").length} / ${workflow.nodes.length} 项已完成`}</small></span><Route size={14} />
    </button>
    {workflow.plan !== undefined && workflow.plan !== null && <div className="task-workflow-actions"><button type="button" className={intent === "question" ? "active" : ""} onClick={() => setIntent((current) => current === "question" ? null : "question")}><MessageSquare size={12} />询问编排</button><button type="button" className={intent === "adjust" ? "active" : ""} onClick={() => setIntent((current) => current === "adjust" ? null : "adjust")}><Route size={12} />调整计划</button>{workflow.pendingMaintenance ? <small><LoaderCircle size={12} className="spin" />等待检查点</small> : workflow.status === "awaiting_approval" ? <button type="button" onClick={onOpen}>查看并批准计划</button> : null}</div>}
    {intent && <form className="task-workflow-input" onSubmit={(event) => { event.preventDefault(); void requestMaintenance(); }}><input aria-label={intent === "question" ? "编排问题" : "计划调整要求"} placeholder={intent === "question" ? "询问进度、结果或下一步" : "保留哪些成果，调整哪些任务…"} value={note} onChange={(event) => setNote(event.target.value)} disabled={busy || Boolean(workflow.pendingMaintenance)} /><button type="submit" aria-label="发送编排请求" disabled={busy || Boolean(workflow.pendingMaintenance) || !note.trim()}>{busy ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />}</button></form>}
    {feedback && <p className="task-workflow-feedback" role="status">{feedback}</p>}
    {answer && intent && <details className="task-workflow-answer"><summary>最近回复</summary><p>{answer}</p></details>}
  </section>;
}
