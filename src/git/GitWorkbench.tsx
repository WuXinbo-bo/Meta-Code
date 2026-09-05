import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, CircleDot, GitBranch, GitCommitHorizontal, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import "./GitWorkbench.css";

type GitFile = { path: string; status: string; staged: boolean; unstaged: boolean; additions: number | null; deletions: number | null };
type GitStatus = { isRepository: boolean; root: string; branch: string; head: string; upstream?: string; ahead: number; behind: number; detached: boolean; conflicted: boolean; files: GitFile[]; refreshedAt: string };
type GitBranch = { name: string; fullName: string; remote: boolean; current: boolean; upstream?: string; ahead: number; behind: number; subject: string; sha: string };
type GitCommit = { sha: string; shortSha: string; parents: string[]; author: string; authoredAt: string; subject: string; refs: string[] };

async function request<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Git 数据读取失败");
  return body as T;
}

function relativeTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function statusLabel(status: string) {
  return ({ modified: "修改", added: "新增", deleted: "删除", renamed: "重命名", copied: "复制", untracked: "未跟踪", conflicted: "冲突" } as Record<string, string>)[status] || status;
}

export function GitWorkbench({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [selectedSha, setSelectedSha] = useState("");
  const [diff, setDiff] = useState("");
  const [query, setQuery] = useState("");
  const [showRemote, setShowRemote] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = async (background = false) => {
    if (!workspaceId) return;
    background ? setRefreshing(true) : setLoading(true);
    setError("");
    try {
      const [nextStatus, nextBranches, nextCommits] = await Promise.all([
        request<GitStatus>(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/status`),
        request<GitBranch[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/branches`),
        request<{ commits: GitCommit[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/commits?limit=250`)
      ]);
      setStatus(nextStatus); setBranches(nextBranches); setCommits(nextCommits.commits);
      setSelectedSha((current) => current && nextCommits.commits.some((item) => item.sha === current) ? current : nextCommits.commits[0]?.sha || "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); setRefreshing(false); }
  };

  useEffect(() => { void load(); }, [workspaceId]);
  useEffect(() => {
    if (!selectedSha) { setDiff(""); return; }
    let cancelled = false;
    void request<{ diff: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/commits/${encodeURIComponent(selectedSha)}/diff`).then((result) => { if (!cancelled) setDiff(result.diff); }).catch((cause) => { if (!cancelled) setDiff(`读取提交 Diff 失败：${cause instanceof Error ? cause.message : String(cause)}`); });
    return () => { cancelled = true; };
  }, [selectedSha, workspaceId]);

  const filteredCommits = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return commits.filter((commit) => !normalized || `${commit.subject} ${commit.author} ${commit.sha} ${commit.refs.join(" ")}`.toLocaleLowerCase().includes(normalized));
  }, [commits, query]);
  const localBranches = branches.filter((item) => !item.remote);
  const remoteBranches = branches.filter((item) => item.remote);

  if (loading) return <section className="git-workbench git-state"><LoaderCircle className="spin" size={18} /><strong>正在读取版本管理</strong><span>检测 Git 仓库、当前分支和最近提交…</span></section>;
  if (error) return <section className="git-workbench git-state git-error"><AlertTriangle size={22} /><strong>无法读取版本管理</strong><span>{error}</span><button type="button" onClick={() => void load()}><RefreshCw size={14} />重试</button></section>;
  if (!status?.isRepository) return <section className="git-workbench git-state"><GitBranch size={24} /><strong>当前工作区还不是 Git 仓库</strong><span>版本管理需要工作区内存在 Git 仓库。初始化操作将在后续版本提供，并且会要求明确确认。</span></section>;

  return <section className="git-workbench">
    <header className="git-toolbar"><div><span className="git-kicker"><GitBranch size={14} />版本管理</span><h1>{status.branch === "(detached)" ? "分离 HEAD" : status.branch}</h1><p>{status.root} · {status.head.slice(0, 8)}</p></div><div className="git-toolbar-actions"><span className={`git-clean-state ${status.conflicted ? "danger" : status.files.length ? "dirty" : "clean"}`}><i />{status.conflicted ? "存在冲突" : status.files.length ? `${status.files.length} 个未提交文件` : "工作树干净"}</span><button type="button" onClick={() => void load(true)} disabled={refreshing} title="刷新版本状态"><RefreshCw className={refreshing ? "spin" : undefined} size={15} />刷新</button></div></header>
    <div className="git-summary"><span><strong>{status.branch}</strong>{status.upstream ? ` · 跟踪 ${status.upstream}` : " · 未设置远程跟踪"}</span><span className="git-sync">↑ {status.ahead} · ↓ {status.behind}</span><span>最近刷新 {relativeTime(status.refreshedAt)}</span></div>
    <div className="git-layout">
      <aside className="git-branches"><div className="git-panel-title"><strong>分支</strong><span>{branches.length}</span></div><button className="git-branch-row current" type="button"><CircleDot size={14} /><span>{status.branch}</span><em>当前</em></button><small className="git-group-label">本地分支</small>{localBranches.map((branch) => <button className={`git-branch-row ${branch.current ? "current" : ""}`} type="button" key={branch.fullName}><GitBranch size={14} /><span>{branch.name}</span>{branch.current && <em>当前</em>}</button>)}<button className="git-group-toggle" type="button" onClick={() => setShowRemote((value) => !value)}><GitBranch size={13} />远程分支 <span>{remoteBranches.length}</span></button>{showRemote && remoteBranches.map((branch) => <button className="git-branch-row remote" type="button" key={branch.fullName}><GitBranch size={13} /><span>{branch.name}</span></button>)}</aside>
      <div className="git-history"><div className="git-panel-title"><strong>提交历史</strong><span>{filteredCommits.length}</span></div><label className="git-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提交、作者或分支" />{query && <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}><X size={13} /></button>}</label><div className="git-commit-list">{filteredCommits.map((commit) => <button type="button" className={`git-commit-row ${selectedSha === commit.sha ? "selected" : ""}`} key={commit.sha} onClick={() => setSelectedSha(commit.sha)}><span className="git-graph-node"><i /></span><span className="git-commit-copy"><strong>{commit.subject || "（无提交说明）"}</strong><small>{commit.author} · {relativeTime(commit.authoredAt)}</small><em>{commit.refs.length ? commit.refs.join(" · ") : commit.shortSha}</em></span></button>)}{!filteredCommits.length && <p className="git-empty">没有匹配的提交</p>}</div></div>
      <aside className="git-detail"><div className="git-panel-title"><strong>提交详情</strong></div>{selectedSha ? (() => { const commit = commits.find((item) => item.sha === selectedSha); if (!commit) return null; return <><div className="git-detail-heading"><GitCommitHorizontal size={17} /><strong>{commit.subject}</strong><code>{commit.shortSha}</code></div><dl className="git-detail-meta"><div><dt>作者</dt><dd>{commit.author}</dd></div><div><dt>时间</dt><dd>{relativeTime(commit.authoredAt)}</dd></div><div><dt>父提交</dt><dd>{commit.parents.length ? commit.parents.map((parent) => parent.slice(0, 8)).join("、") : "根提交"}</dd></div></dl><pre className="git-diff"><code>{diff || "正在读取 Diff…"}</code></pre></>; })() : <p className="git-empty">选择一个提交查看详情</p>}</aside>
    </div>
    <footer className="git-working-tree"><div className="git-panel-title"><strong>当前工作树</strong><span>{status.files.length} 个文件</span></div>{status.files.length ? <div className="git-file-grid">{status.files.map((file) => <div className={`git-file-row ${file.status === "conflicted" ? "danger" : ""}`} key={file.path}><span className="git-file-status">{file.status === "conflicted" ? "!" : file.status[0]?.toUpperCase()}</span><span>{file.path}</span><small>{statusLabel(file.status)}{file.additions !== null || file.deletions !== null ? ` · +${file.additions || 0} -${file.deletions || 0}` : ""}</small></div>)}</div> : <p className="git-clean-note"><Check size={14} />当前没有未提交修改</p>}</footer>
  </section>;
}
