import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, GitBranch, Link2, LoaderCircle, RefreshCw, Unlink } from "lucide-react";
import type { CodexLinkBinding } from "./model";

type LinkThread = {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  modelProvider: string;
  sourceKind: string;
  createdAt: number;
  updatedAt: number;
  status: { type: string; activeFlags?: string[] };
  forkedFromId: string | null;
  isPinned: boolean;
  turnCount?: number;
  historyMode: "legacy" | "paginated" | "unknown";
  resumable: boolean;
};

type TurnSummary = {
  id: string;
  status: string;
  userText: string;
  assistantText: string;
};

type SessionRef = {
  id: string;
  title: string;
  workspaceId: string;
  engine: "claude" | "codex";
};

type Props = {
  workspace: { id: string; name: string; root: string } | null;
  activeSession: SessionRef | null;
  onNotice: (message: string, type?: "error" | "success" | "info") => void;
  onLinked: (binding: CodexLinkBinding) => void | Promise<void>;
  onUnlinked: (binding: CodexLinkBinding) => void | Promise<void>;
};

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json", ...(options?.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload as T;
}

function dateLabel(value: number) {
  if (!value) return "未知时间";
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(milliseconds));
}

function statusLabel(thread: LinkThread) {
  if (thread.historyMode === "paginated") return "分页历史 · 只读";
  if (thread.historyMode !== "legacy") return "兼容模式 · 只读";
  const status = thread.status;
  if (status.type === "active") return status.activeFlags?.includes("waitingOnApproval") ? "等待审批" : "执行中";
  if (status.type === "notLoaded") return "可接管";
  return status.type || "未知";
}

export function CodexLinkView({ workspace, activeSession, onNotice, onLinked, onUnlinked }: Props) {
  const [threads, setThreads] = useState<LinkThread[]>([]);
  const [bindings, setBindings] = useState<CodexLinkBinding[]>([]);
  const [connection, setConnection] = useState<{ available: boolean; officialHome: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyThreadId, setBusyThreadId] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [turns, setTurns] = useState<TurnSummary[]>([]);
  const [totalTurnCount, setTotalTurnCount] = useState(0);
  const [inspectionMessage, setInspectionMessage] = useState("");

  const bindingByThread = useMemo(() => new Map(bindings.map((binding) => [binding.threadId, binding])), [bindings]);
  const currentBinding = useMemo(() => bindings.find((binding) => binding.sessionId === activeSession?.id), [activeSession?.id, bindings]);

  const load = useCallback(async () => {
    if (!workspace) {
      setThreads([]);
      setBindings([]);
      return;
    }
    setLoading(true);
    try {
      const [status, result] = await Promise.all([
        request<{ available: boolean; officialHome: string; message: string }>("/api/codex-link/status"),
        request<{ threads: LinkThread[]; bindings: CodexLinkBinding[] }>(`/api/codex-link/threads?workspaceId=${encodeURIComponent(workspace.id)}`)
      ]);
      setConnection(status);
      setThreads(result.threads);
      setBindings(result.bindings);
    } catch (error) {
      setConnection((current) => ({ available: false, officialHome: current?.officialHome || "~/.codex", message: error instanceof Error ? error.message : String(error) }));
      onNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setLoading(false);
    }
  }, [onNotice, workspace]);

  useEffect(() => { void load(); }, [load]);

  const inspect = async (threadId: string) => {
    if (!workspace) return;
    if (selectedThreadId === threadId) {
      setSelectedThreadId("");
      setTurns([]);
      setInspectionMessage("");
      return;
    }
    setBusyThreadId(threadId);
    try {
      const result = await request<{ turns: TurnSummary[]; totalTurnCount: number; compatibilityMessage?: string | null }>(`/api/codex-link/threads/${encodeURIComponent(threadId)}?workspaceId=${encodeURIComponent(workspace.id)}`);
      setSelectedThreadId(threadId);
      setTurns(result.turns);
      setTotalTurnCount(result.totalTurnCount);
      setInspectionMessage(result.compatibilityMessage || "");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusyThreadId("");
    }
  };

  const bind = async (threadId: string) => {
    if (!workspace || !activeSession) return;
    setBusyThreadId(threadId);
    try {
      const result = await request<{ binding: CodexLinkBinding }>("/api/codex-link/bindings", {
        method: "POST",
        body: JSON.stringify({ workspaceId: workspace.id, sessionId: activeSession.id, threadId })
      });
      setBindings((current) => [result.binding, ...current.filter((binding) => binding.id !== result.binding.id && binding.sessionId !== activeSession.id)]);
      await onLinked(result.binding);
      onNotice(result.binding.accessMode === "resume" ? "已关联并接管官方 Codex 对话" : "已建立只读关联；该分页历史暂不能续接", "success");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusyThreadId("");
    }
  };

  const unbind = async (binding: CodexLinkBinding) => {
    setBusyThreadId(binding.threadId);
    try {
      await request(`/api/codex-link/bindings/${encodeURIComponent(binding.id)}`, { method: "DELETE" });
      setBindings((current) => current.filter((item) => item.id !== binding.id));
      await onUnlinked(binding);
      onNotice("已解除线程映射", "success");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusyThreadId("");
    }
  };

  const fork = async (threadId: string) => {
    if (!workspace) return;
    setBusyThreadId(threadId);
    try {
      const result = await request<{ thread: LinkThread }>(`/api/codex-link/threads/${encodeURIComponent(threadId)}/fork`, {
        method: "POST",
        body: JSON.stringify({ workspaceId: workspace.id })
      });
      setThreads((current) => [result.thread, ...current.filter((thread) => thread.id !== result.thread.id)]);
      onNotice("已从官方 Codex 历史创建独立支线", "success");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusyThreadId("");
    }
  };

  if (!workspace) return <section className="content-view codex-link-view"><div className="codex-link-empty"><Link2 size={22} /><strong>请选择工作区</strong><span>联动功能按项目发现官方 Codex 对话。</span></div></section>;

  return <section className="content-view codex-link-view">
    <div className="section-heading codex-link-heading">
      <div><h1>Codex 联动</h1><p>发现当前项目的官方 Codex 对话，建立任务映射，并从任意历史节点创建支线。</p></div>
      <button type="button" onClick={() => void load()} disabled={loading}>{loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}刷新</button>
    </div>
    <div className={`codex-link-connection ${connection?.available ? "ready" : "offline"}`}>
      <span className="codex-link-connection-mark">{connection?.available ? <Check size={14} /> : <Link2 size={14} />}</span>
      <div><strong>{connection?.message || "正在检测官方 Codex"}</strong><small>{connection?.officialHome || "~/.codex"}</small></div>
      <i>{connection?.available ? "已连接" : "未连接"}</i>
    </div>
    <div className="codex-link-context">
      <div><span>当前项目</span><strong>{workspace.name}</strong><small>{workspace.root}</small></div>
      <div><span>当前普通任务</span><strong>{activeSession?.engine === "codex" ? activeSession.title : "未选择 Codex 任务"}</strong><small>{currentBinding ? `已关联 ${currentBinding.threadId}` : "可续接线程会接入当前任务；分页历史只建立只读映射"}</small></div>
    </div>
    <div className="codex-link-list-heading"><span>项目线程</span><small>{threads.length} 条</small></div>
    <div className="codex-link-list">
      {threads.map((thread) => {
        const binding = bindingByThread.get(thread.id);
        const busy = busyThreadId === thread.id;
        const selected = selectedThreadId === thread.id;
        return <article className={`codex-link-thread ${selected ? "selected" : ""}`} key={thread.id}>
          <button type="button" className="codex-link-thread-main" onClick={() => void inspect(thread.id)}>
            <span className={`codex-link-thread-state ${thread.status.type === "active" ? "active" : ""}`} />
            <span><strong>{thread.name || thread.preview || "未命名 Codex 任务"}</strong><small>{thread.preview || thread.id}</small></span>
            <span className="codex-link-thread-meta"><i>{statusLabel(thread)}</i><small>{dateLabel(thread.updatedAt)}</small></span>
          </button>
          <div className="codex-link-thread-actions">
            {binding ? <button type="button" onClick={() => void unbind(binding)} disabled={busy}><Unlink size={13} />解除</button>
              : <button type="button" onClick={() => void bind(thread.id)} disabled={busy || activeSession?.engine !== "codex" || activeSession.workspaceId !== workspace.id}><Link2 size={13} />{thread.resumable ? "关联并接管" : "只读关联"}</button>}
            <button type="button" onClick={() => void fork(thread.id)} disabled={busy || thread.status.type === "active" || !thread.resumable} title={!thread.resumable ? "分页历史暂不支持创建支线" : undefined}><GitBranch size={13} />创建支线</button>
          </div>
          {selected && <div className="codex-link-turns">
            <header><strong>最近对话</strong><small>显示最近 {turns.length} / {totalTurnCount} 轮</small></header>
            {turns.map((turn) => <div className="codex-link-turn" key={turn.id}>
              {turn.userText && <p><b>你</b><span>{turn.userText}</span></p>}
              {turn.assistantText && <p><b>Codex</b><span>{turn.assistantText}</span></p>}
            </div>)}
            {!turns.length && <p className="codex-link-no-turns">{inspectionMessage || "该线程暂无可展示的对话摘要。"}</p>}
          </div>}
        </article>;
      })}
      {!loading && !threads.length && <div className="codex-link-empty"><Link2 size={22} /><strong>当前项目没有可发现的官方 Codex 对话</strong><span>在 Codex CLI、IDE 或官方客户端中以此项目目录创建任务后，再刷新此处。</span></div>}
    </div>
  </section>;
}
