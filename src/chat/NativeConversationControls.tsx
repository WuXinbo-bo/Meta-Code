import { useEffect, useRef, useState } from "react";
import { Check, GitBranch, ListChecks, LoaderCircle, ShieldCheck, X } from "lucide-react";
import "./NativeConversationControls.css";

type Options = { mode: "execute" | "plan"; approvals: "inherit" | "ask"; customAgent: string | null };
type Prompt = { id: string; kind: "approval" | "question"; title: string; detail: string; canAccept?: boolean; questions?: { id: string; header?: string; question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean; secret?: boolean }[] };
type Snapshot = { options: Options; agents: { name: string; displayName: string; description?: string }[]; canFork: boolean; busy: boolean };
type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
export function NativeConversationControls({ sessionId, provider, running, collaborative, request, onFork, onChanged }: {
  sessionId: string; provider: string; running: boolean; collaborative: boolean; request: Request; onFork: (session: any) => void; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false), [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [prompts, setPrompts] = useState<Prompt[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/native`;
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { const result = await request<{ requests: Prompt[] }>(endpoint + "/requests", { signal: controller.signal }); if (!controller.signal.aborted) { setPrompts(result.requests); setError(""); } }
      catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
      if (!controller.signal.aborted && running) timer = setTimeout(refresh, 1_500);
    };
    void refresh(); return () => { controller.abort(); clearTimeout(timer); };
  }, [endpoint, running, request]);
  useEffect(() => {
    const controller = new AbortController();
    void request<Snapshot>(endpoint, { signal: controller.signal }).then(v => { if (!controller.signal.aborted) setSnapshot(v); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [endpoint, open, running, request]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  const save = async (patch: Partial<Options>) => {
    if (!snapshot || busy) return; setBusy(true); setError("");
    try { const result = await request<{ options: Options }>(endpoint, { method: "PATCH", body: JSON.stringify({ ...snapshot.options, ...patch }) }); setSnapshot({ ...snapshot, options: result.options }); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const fork = async () => {
    setBusy(true); setError("");
    try { onFork(await request(endpoint + "/fork", { method: "POST", body: "{}" })); setOpen(false); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return <div className="native-conversation-control" ref={root}>
    <button type="button" className={`composer-control-button ${snapshot?.options.mode === "plan" ? "active" : ""}`} title="原生计划、审批与 Agent" aria-label="原生会话控制" aria-expanded={open} onClick={() => setOpen(v => !v)}>{snapshot?.options.mode === "plan" ? <ListChecks size={15} /> : <ShieldCheck size={15} />}{snapshot?.options.mode === "plan" && <span>计划</span>}</button>
    {open && <div className="native-conversation-menu" role="dialog" aria-label="原生会话设置">
      <header><strong>当前任务 · 原生能力</strong><button type="button" aria-label="关闭原生会话设置" onClick={() => setOpen(false)}><X size={14} /></button></header>
      <p>{collaborative ? "切换为原生运行模式后使用这些设置" : "设置只影响当前任务，保留原生会话历史"}</p>
      <fieldset disabled={busy || running || collaborative || !snapshot}>
        <div className="native-mode-options" role="group" aria-label="原生工作模式"><button type="button" aria-pressed={snapshot?.options.mode === "execute"} onClick={() => void save({ mode: "execute" })}><Check size={14} />执行</button><button type="button" aria-pressed={snapshot?.options.mode === "plan"} onClick={() => void save({ mode: "plan" })}><ListChecks size={14} />计划</button></div>
        <label>工具审批<select aria-label="当前任务工具审批" value={snapshot?.options.approvals || "inherit"} onChange={e => void save({ approvals: e.target.value as Options["approvals"] })}><option value="inherit">沿用已有权限</option><option value="ask">需要时询问我</option></select></label>
        <label>{provider === "codex" ? "原生子 Agent" : "原生会话 Agent"}<select aria-label="选择原生自定义 Agent" value={snapshot?.options.customAgent || ""} onChange={e => void save({ customAgent: e.target.value || null })}><option value="">默认</option>{snapshot?.agents.map(agent => <option key={agent.name} value={agent.name}>{agent.displayName}</option>)}</select></label>
        {snapshot?.options.customAgent && <small>{snapshot.agents.find(a => a.name === snapshot.options.customAgent)?.description}</small>}
      </fieldset>
      {!snapshot?.agents.length && <small>读取当前项目与已选原生配置中的 Agent 定义</small>}
      <button type="button" className="native-fork-action" disabled={busy || running || collaborative || !snapshot?.canFork} onClick={() => void fork()}><GitBranch size={14} />从当前完整历史创建原生分支</button>
      {running && <small>当前运行结束后可切换模式</small>}
      {busy && <small><LoaderCircle className="spin" size={13} />正在应用</small>}
      {error && <p role="alert" className="native-control-error">{error}</p>}
    </div>}
    {prompts.length > 0 && <div className="native-prompt-stack" aria-live="polite">{prompts.map(prompt => <NativePromptCard key={prompt.id} prompt={prompt} request={request} endpoint={endpoint} onResolved={() => setPrompts(v => v.filter(p => p.id !== prompt.id))} />)}</div>}
    {!open && error && prompts.length === 0 && <span className="native-control-error" role="status">{error}</span>}
  </div>;
}

function NativePromptCard({ prompt, request, endpoint, onResolved }: { prompt: Prompt; request: Request; endpoint: string; onResolved: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({}), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submit = async (decision?: "accept" | "decline") => {
    if (busy) return; setBusy(true); setError("");
    try { await request(endpoint + `/requests/${encodeURIComponent(prompt.id)}`, { method: "POST", body: JSON.stringify({ decision, answers }) }); onResolved(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return <section className="native-prompt-card" aria-label={prompt.title}>
    <header><ShieldCheck size={16} /><strong>{prompt.title}</strong><small>原生请求</small></header>
    <details><summary>查看请求内容</summary><pre>{prompt.detail}</pre></details>
    {prompt.questions?.map(q => <div className="native-question" key={q.id}><span>{q.header && <b>{q.header} · </b>}{q.question}</span>{q.options?.length ? q.multiSelect ? <div role="group" aria-label={q.question}>{q.options.map(o => <label className="native-question-choice" key={o.label}><input type="checkbox" checked={answers[q.id]?.includes(o.label) || false} onChange={e => setAnswers(v => ({ ...v, [q.id]: e.target.checked ? [...(v[q.id] || []), o.label] : (v[q.id] || []).filter(a => a !== o.label) }))} />{o.label}{o.description && <small>{o.description}</small>}</label>)}</div> : <select aria-label={q.question} value={answers[q.id]?.[0] || ""} onChange={e => setAnswers(v => ({ ...v, [q.id]: e.target.value ? [e.target.value] : [] }))}><option value="">选择回答</option>{q.options.map(o => <option key={o.label} value={o.label}>{o.label}{o.description ? ` — ${o.description}` : ""}</option>)}</select> : null}<input aria-label={`自定义回答：${q.question}`} type={q.secret ? "password" : "text"} value={(answers[q.id] || []).filter(a => !q.options?.some(o => o.label === a)).join(", ")} onChange={e => setAnswers(v => ({ ...v, [q.id]: [...(q.multiSelect ? (v[q.id] || []).filter(a => q.options?.some(o => o.label === a)) : []), ...(e.target.value ? [e.target.value] : [])] }))} placeholder="填写回答" autoComplete="off" /></div>)}
    {error && <p role="alert">{error}</p>}
    <footer>{prompt.kind === "approval" ? <><button type="button" disabled={busy} onClick={() => void submit("decline")}>拒绝</button><button type="button" className="primary" disabled={busy || prompt.canAccept === false} onClick={() => void submit("accept")}>批准这一次</button></> : <button type="button" className="primary" disabled={busy || prompt.questions?.some(q => !answers[q.id]?.some(a => a.trim()))} onClick={() => void submit()}>回答并继续</button>}</footer>
  </section>;
}
