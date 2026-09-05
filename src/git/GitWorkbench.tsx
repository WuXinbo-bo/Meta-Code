import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, CircleDot, Clock3, FileCode2, GitBranch, GitCommitHorizontal, GitFork, LoaderCircle, MoreHorizontal, Plus, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { ProviderIcon } from "../branding/ProviderIcon";
import { confirmAction } from "../components/ConfirmationProvider";
import "./GitWorkbench.css";

type GitFile = { path: string; status: string; staged: boolean; unstaged: boolean; additions: number | null; deletions: number | null };
type GitStatus = { isRepository: boolean; root: string; branch: string; head: string; upstream?: string; ahead: number; behind: number; detached: boolean; conflicted: boolean; files: GitFile[]; refreshedAt: string };
type GitBranchItem = { name: string; fullName: string; remote: boolean; current: boolean; upstream?: string; ahead: number; behind: number; subject: string; sha: string };
type GitCommit = { sha: string; shortSha: string; parents: string[]; author: string; authoredAt: string; subject: string; refs: string[] };
type GitRemote = { name: string; fetchUrl: string; pushUrl?: string };
type GitActivity = { sessionId: string; sessionTitle: string; engine: string; activityId: string; type: string; title: string; paths: string[]; occurredAt: string };
type GraphRow = { commit: GitCommit; lane: number; before: string[]; after: string[] };
type TimelineGroup = { key: string; label: string; commits: GitCommit[] };

const GRAPH_COLORS = ["#2563eb", "#8b5cf6", "#0f9f6e", "#d97706", "#db2777", "#0891b2"];

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Git 数据读取失败");
  return body as T;
}

function normalizeCommit(value: Partial<GitCommit>): GitCommit {
  const sha = typeof value.sha === "string" ? value.sha : "";
  return { sha, shortSha: typeof value.shortSha === "string" && value.shortSha ? value.shortSha : sha.slice(0, 8), parents: Array.isArray(value.parents) ? value.parents.filter((item): item is string => typeof item === "string") : [], author: typeof value.author === "string" && value.author ? value.author : "未知作者", authoredAt: typeof value.authoredAt === "string" ? value.authoredAt : "", subject: typeof value.subject === "string" && value.subject ? value.subject : "（无提交说明）", refs: Array.isArray(value.refs) ? value.refs.filter((item): item is string => typeof item === "string") : [] };
}

function relativeTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value || "未知时间" : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function timelineGroups(commits: GitCommit[]): TimelineGroup[] {
  const groups = new Map<string, TimelineGroup>();
  commits.forEach((commit) => {
    const date = new Date(commit.authoredAt);
    const key = Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().slice(0, 10);
    const label = Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(date);
    const current = groups.get(key);
    if (current) current.commits.push(commit);
    else groups.set(key, { key, label, commits: [commit] });
  });
  return Array.from(groups.values());
}

function isVersionRef(ref: string) {
  return /^v?\d+\.\d+/i.test(ref.replace(/^tag[:/\s]*/i, ""));
}

function statusLabel(status: string) {
  return ({ modified: "修改", added: "新增", deleted: "删除", renamed: "重命名", copied: "复制", untracked: "未跟踪", conflicted: "冲突" } as Record<string, string>)[status] || status;
}

function buildGraphRows(commits: GitCommit[]): GraphRow[] {
  let lanes: string[] = [];
  return commits.map((commit) => {
    let lane = lanes.indexOf(commit.sha);
    if (lane < 0) { lane = lanes.length; lanes = [...lanes, commit.sha]; }
    const before = [...lanes];
    const after = [...lanes];
    const parents = commit.parents || [];
    if (parents.length) after[lane] = parents[0]; else after.splice(lane, 1);
    parents.slice(1).forEach((parent, index) => { if (!after.includes(parent)) after.splice(lane + index + 1, 0, parent); });
    lanes = after;
    return { commit, lane, before, after };
  });
}

function GraphLane({ row }: { row: GraphRow }) {
  const count = Math.max(1, row.before.length, row.after.length);
  const width = Math.max(42, count * 20 + 12);
  const point = (index: number) => 12 + index * 20;
  const color = (index: number) => GRAPH_COLORS[index % GRAPH_COLORS.length];
  return <svg className="version-graph-lane" width={width} height="68" viewBox={`0 0 ${width} 68`} aria-hidden="true">
    {row.before.map((identity, index) => { if (index === row.lane) return null; const nextIndex = row.after.indexOf(identity); if (nextIndex < 0) return null; return <path key={`pass-${identity}-${index}`} d={`M ${point(index)} 0 C ${point(index)} 34, ${point(nextIndex)} 34, ${point(nextIndex)} 68`} stroke={color(index)} />; })}
    <path d={`M ${point(row.lane)} 0 L ${point(row.lane)} 34`} stroke={color(row.lane)} />
    {(row.commit.parents || []).map((parent, index) => { const parentLane = row.after.indexOf(parent); if (parentLane < 0) return null; return <path key={`parent-${parent}`} d={`M ${point(row.lane)} 34 C ${point(row.lane)} 50, ${point(parentLane)} 50, ${point(parentLane)} 68`} stroke={color(index ? parentLane : row.lane)} />; })}
    <circle cx={point(row.lane)} cy="34" r="6" fill="var(--mc-surface, #fff)" stroke={color(row.lane)} strokeWidth="3" />
  </svg>;
}

function diffSummary(diff: string) {
  const lines = diff.split(/\r?\n/);
  return { files: lines.filter((line) => line.startsWith("diff --git ")).length, additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length, deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length, paths: lines.filter((line) => line.startsWith("+++ b/")).map((line) => line.slice(6).trim()).filter(Boolean) };
}

export function GitWorkbench({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranchItem[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [activities, setActivities] = useState<GitActivity[]>([]);
  const [selectedSha, setSelectedSha] = useState("");
  const [diff, setDiff] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [fetching, setFetching] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [technicalView, setTechnicalView] = useState(false);
  const [workingTreeOpen, setWorkingTreeOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

  const load = async (background = false) => {
    if (!workspaceId) return;
    background ? setRefreshing(true) : setLoading(true);
    setLoadError("");
    try {
      const [nextStatus, nextBranches, nextCommits] = await Promise.all([
        request<GitStatus>(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/status`),
        request<GitBranchItem[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/branches`),
        request<{ commits: Partial<GitCommit>[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/commits?limit=250`)
      ]);
      const normalizedCommits = (nextCommits.commits || []).map(normalizeCommit).filter((item) => item.sha);
      setStatus({ ...nextStatus, files: Array.isArray(nextStatus.files) ? nextStatus.files : [] });
      setBranches(Array.isArray(nextBranches) ? nextBranches : []);
      setCommits(normalizedCommits);
      setSelectedSha((current) => current && normalizedCommits.some((item) => item.sha === current) ? current : normalizedCommits[0]?.sha || "");
      const [nextRemotes, nextActivity] = await Promise.all([
        request<GitRemote[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/remotes`).catch(() => []),
        request<{ records: GitActivity[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/activity?limit=12`).catch(() => ({ records: [] }))
      ]);
      setRemotes(Array.isArray(nextRemotes) ? nextRemotes : []);
      setActivities(Array.isArray(nextActivity.records) ? nextActivity.records : []);
    } catch (cause) { setLoadError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); setRefreshing(false); }
  };

  useEffect(() => { void load(); }, [workspaceId]);
  useEffect(() => {
    setDiffOpen(false);
    if (!selectedSha) { setDiff(""); return; }
    let cancelled = false;
    setDiff("");
    void request<{ diff: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/commits/${encodeURIComponent(selectedSha)}/diff`).then((result) => { if (!cancelled) setDiff(result.diff || ""); }).catch((cause) => { if (!cancelled) setDiff(`读取提交变更失败：${cause instanceof Error ? cause.message : String(cause)}`); });
    return () => { cancelled = true; };
  }, [selectedSha, workspaceId]);

  const filteredCommits = useMemo(() => { const normalized = query.trim().toLocaleLowerCase(); return commits.filter((commit) => !normalized || `${commit.subject} ${commit.author} ${commit.sha} ${(commit.refs || []).join(" ")}`.toLocaleLowerCase().includes(normalized)); }, [commits, query]);
  const graphRows = useMemo(() => buildGraphRows(filteredCommits.slice(0, 180)), [filteredCommits]);
  const developmentGroups = useMemo(() => timelineGroups(filteredCommits.slice(0, 180)), [filteredCommits]);
  const selectedCommit = commits.find((item) => item.sha === selectedSha) || null;
  const selectedDiffSummary = useMemo(() => diffSummary(diff), [diff]);
  const localBranches = branches.filter((item) => !item.remote);
  const remoteBranches = branches.filter((item) => item.remote);
  const changeCounts = useMemo(() => { const files = status?.files || []; return { modified: files.filter((file) => file.status === "modified" || file.status === "renamed").length, added: files.filter((file) => file.status === "added" || file.status === "untracked").length, deleted: files.filter((file) => file.status === "deleted").length, conflicted: files.filter((file) => file.status === "conflicted").length }; }, [status?.files]);

  const mutate = async (endpoint: string, body: unknown) => {
    setActionBusy(true); setActionError("");
    try {
      await request<GitStatus>(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/${endpoint}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      setSelectedPaths([]); if (endpoint === "commit") setCommitMessage(""); await load(true);
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setActionBusy(false); }
  };

  const createLocalBranch = async () => {
    const name = branchName.trim();
    if (!name) return setActionError("请输入新分支名称");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,89}$/.test(name) || name.endsWith("/") || name.includes("..")) return setActionError("分支名称无效，只能使用字母、数字、点、下划线、短横线和斜杠");
    if (!await confirmAction(`创建并切换到本地分支“${name}”？`, { title: "创建本地分支", confirmLabel: "创建并切换" })) return;
    await mutate("branch", { name }); setBranchName("");
  };

  const checkoutLocalBranch = async (branch: GitBranchItem) => {
    if (branch.current || actionBusy) return;
    if (status?.files.length) return setActionError("当前工作树有未提交修改，请先提交后再切换分支");
    if (!await confirmAction(`切换到本地分支“${branch.name}”？`, { title: "切换本地分支", confirmLabel: "切换" })) return;
    await mutate("checkout", { name: branch.name }); setSelectedSha("");
  };

  const fetchRemoteRefs = async () => {
    if (!remotes.length || fetching || actionBusy) return;
    setFetching(true); setActionError("");
    try {
      await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/git/fetch`, { method: "POST", body: JSON.stringify({ remote: remotes[0].name }), headers: { "Content-Type": "application/json" } });
      await load(true);
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setFetching(false); }
  };

  if (loading) return <section className="git-workbench git-state"><LoaderCircle className="spin" size={20} /><strong>正在整理项目发展记录</strong><span>读取当前分支、修改状态和最近提交…</span></section>;
  if (loadError) return <section className="git-workbench git-state git-error"><AlertTriangle size={24} /><strong>版本记录暂时无法读取</strong><span>{loadError}</span><button type="button" onClick={() => void load()}><RefreshCw size={15} />重新读取</button></section>;
  if (!status?.isRepository) return <section className="git-workbench git-state"><GitBranch size={26} /><strong>当前工作区还没有版本记录</strong><span>当工作区成为 Git 仓库后，这里会自动显示项目发展图。</span></section>;

  return <section className="git-workbench simplified">
    <header className="version-hero"><div><span className="version-kicker"><GitFork size={15} />版本管理</span><h1>项目发展</h1><p>用时间线查看项目如何演进，需要时再进行轻量人工干预。</p></div><div className="version-hero-actions"><span className={`version-health ${status.conflicted ? "danger" : status.files.length ? "dirty" : "clean"}`}><i />{status.conflicted ? "存在冲突" : status.files.length ? `${status.files.length} 个文件待处理` : "项目状态正常"}</span><button type="button" className="icon-label-button" onClick={() => void load(true)} disabled={refreshing || fetching} title="刷新版本状态"><RefreshCw className={refreshing ? "spin" : undefined} size={16} />刷新</button></div></header>
    <div className="version-status-bar"><span className="current-branch"><CircleDot size={14} /><strong>{status.detached ? "分离 HEAD" : status.branch}</strong></span><span>{status.upstream ? `跟踪 ${status.upstream}` : "仅本地"}</span>{(status.ahead > 0 || status.behind > 0) && <span className="version-sync-count">↑ {status.ahead} · ↓ {status.behind}</span>}<span><Clock3 size={13} />{relativeTime(status.refreshedAt)}</span><button type="button" className={advancedOpen ? "active" : ""} onClick={() => setAdvancedOpen((value) => !value)}><MoreHorizontal size={16} />管理<ChevronDown size={13} /></button></div>
    {actionError && <div className="version-inline-error" role="alert"><AlertTriangle size={15} /><span>{actionError}</span><button type="button" aria-label="关闭提示" onClick={() => setActionError("")}><X size={14} /></button></div>}
    {advancedOpen && <section className="version-advanced-panel"><div className="advanced-block"><strong>切换本地分支</strong><div className="branch-chip-list">{localBranches.map((branch) => <button type="button" className={branch.current ? "active" : ""} key={branch.fullName} disabled={branch.current || actionBusy} onClick={() => void checkoutLocalBranch(branch)}><GitBranch size={13} />{branch.name}{branch.current && <em>当前</em>}</button>)}</div></div><div className="advanced-block"><strong>新建分支</strong><div className="branch-create-inline"><input value={branchName} onChange={(event) => setBranchName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createLocalBranch(); }} placeholder="输入分支名称" disabled={actionBusy} /><button type="button" disabled={!branchName.trim() || actionBusy} onClick={() => void createLocalBranch()}><Plus size={14} />创建</button></div></div><div className="advanced-block remote-block"><strong>远程记录</strong><span>{remotes.length ? `${remotes.map((remote) => remote.name).join("、")} · ${remoteBranches.length} 个远程分支` : "尚未配置远程仓库"}</span>{remotes.length > 0 && <button type="button" disabled={fetching || actionBusy} onClick={() => void fetchRemoteRefs()}><RefreshCw className={fetching ? "spin" : undefined} size={14} />{fetching ? "同步中" : "获取最新记录"}</button>}</div><div className="advanced-block technical-view-block"><strong>高级查看</strong><span>完整分支关系只在需要排查时显示。</span><button type="button" onClick={() => setTechnicalView((value) => !value)}><GitFork size={14} />{technicalView ? "返回项目发展" : "查看技术视图"}</button></div></section>}
    <main className="version-visual-layout">
      <section className="development-graph-panel"><header className="panel-heading"><div><strong>{technicalView ? "技术分支图" : "发展时间线"}</strong><span>{filteredCommits.length} 次提交</span></div><label className="version-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索发展记录" />{query && <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}><X size={14} /></button>}</label></header>{technicalView ? <div className="development-graph technical-graph" role="list">{graphRows.map((row) => { const isHead = row.commit.sha === status.head; return <button type="button" role="listitem" className={`development-row ${selectedSha === row.commit.sha ? "selected" : ""} ${isHead ? "head" : ""}`} key={row.commit.sha} onClick={() => setSelectedSha(row.commit.sha)}><GraphLane row={row} /><span className="development-copy"><strong>{row.commit.subject}{isHead && <em className="head-badge">当前 HEAD</em>}</strong><span>{row.commit.author} · {relativeTime(row.commit.authoredAt)}</span>{(row.commit.refs || []).length > 0 && <em>{row.commit.refs.slice(0, 3).join(" · ")}</em>}</span><code>{row.commit.shortSha}</code></button>; })}{!graphRows.length && <p className="version-empty">没有匹配的发展记录</p>}</div> : <div className="development-graph timeline-groups" role="list">{developmentGroups.map((group) => <section className="timeline-group" key={group.key}><header className="timeline-group-heading"><Clock3 size={13} /><strong>{group.label}</strong><span>{group.commits.length} 次记录</span></header><div className="timeline-list">{group.commits.map((commit, index) => { const isHead = commit.sha === status.head; const isStart = group.key === developmentGroups[developmentGroups.length - 1]?.key && index === group.commits.length - 1; const refs = (commit.refs || []).slice(0, 3); return <button type="button" role="listitem" className={`timeline-row ${selectedSha === commit.sha ? "selected" : ""} ${isHead ? "head" : ""}`} key={commit.sha} onClick={() => setSelectedSha(commit.sha)}><span className="timeline-marker" aria-hidden="true"><CircleDot size={16} /></span><span className="timeline-copy"><strong>{commit.subject}{isHead && <em className="head-badge">当前 HEAD</em>}{isStart && <em className="timeline-start-badge">项目开始</em>}</strong><span>{commit.author} · {relativeTime(commit.authoredAt)}</span>{refs.length > 0 && <span className="timeline-tags">{refs.map((ref) => <em className={isVersionRef(ref) ? "version-tag" : "branch-tag"} key={ref}>{ref}</em>)}</span>}</span><code>{commit.shortSha}</code></button>; })}</div></section>)}{!developmentGroups.length && <p className="version-empty">没有匹配的发展记录</p>}</div>}</section>
      <aside className="version-insight-panel"><div className="panel-heading"><div><strong>节点详情</strong><span>选择时间线节点查看</span></div></div>{selectedCommit ? <><section className="commit-summary-card"><GitCommitHorizontal size={18} /><h2>{selectedCommit.subject}</h2><code>{selectedCommit.shortSha}</code><div className="commit-author"><span>{selectedCommit.author}</span><time>{relativeTime(selectedCommit.authoredAt)}</time></div>{(selectedCommit.refs || []).length > 0 && <div className="commit-ref-list">{selectedCommit.refs.slice(0, 4).map((ref) => <span key={ref}>{ref}</span>)}</div>}</section><div className="change-overview"><span><strong>{selectedDiffSummary.files}</strong>文件</span><span className="added"><strong>+{selectedDiffSummary.additions}</strong>新增</span><span className="deleted"><strong>-{selectedDiffSummary.deletions}</strong>删除</span></div>{selectedDiffSummary.paths.length > 0 && <div className="changed-paths"><strong>涉及文件</strong>{selectedDiffSummary.paths.slice(0, 6).map((filePath) => <span key={filePath}><FileCode2 size={13} />{filePath}</span>)}{selectedDiffSummary.paths.length > 6 && <small>另有 {selectedDiffSummary.paths.length - 6} 个文件</small>}</div>}<button type="button" className="diff-disclosure" onClick={() => setDiffOpen((value) => !value)}>{diffOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}{diffOpen ? "收起具体变更" : "查看具体变更"}</button>{diffOpen && <pre className="version-diff"><code>{diff || "正在读取变更…"}</code></pre>}{activities.length > 0 && <div className="recent-agent-context"><strong><Sparkles size={14} />最近 Agent 活动</strong>{activities.slice(0, 3).map((activity) => <div key={activity.activityId}><ProviderIcon provider={activity.engine} size={16} /><span><b>{activity.title}</b><small>{activity.sessionTitle} · {relativeTime(activity.occurredAt)}</small></span></div>)}</div>}</> : <p className="version-empty">选择一个节点查看本次变化</p>}</aside>
    </main>
    <footer className={`working-tree-dock ${workingTreeOpen ? "open" : ""}`}><button type="button" className="working-tree-summary" onClick={() => setWorkingTreeOpen((value) => !value)}><span className={`working-tree-icon ${status.files.length ? "dirty" : "clean"}`}>{status.files.length ? <FileCode2 size={16} /> : <Check size={16} />}</span><span><strong>{status.files.length ? `当前有 ${status.files.length} 个文件变动` : "当前工作树干净"}</strong><small>{status.files.length ? `修改 ${changeCounts.modified} · 新增 ${changeCounts.added} · 删除 ${changeCounts.deleted}${changeCounts.conflicted ? ` · 冲突 ${changeCounts.conflicted}` : ""}` : "没有需要人工处理的内容"}</small></span><span className="working-tree-open-label">{status.files.length ? (workingTreeOpen ? "收起" : "查看与提交") : "查看"}{workingTreeOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span></button>{workingTreeOpen && <div className="working-tree-detail">{status.files.length ? <><div className="working-tree-actions"><button type="button" disabled={!selectedPaths.length || actionBusy} onClick={() => void mutate("stage", { paths: selectedPaths })}>暂存所选</button><button type="button" disabled={!selectedPaths.length || actionBusy || !status.files.some((item) => selectedPaths.includes(item.path) && item.staged)} onClick={() => void mutate("unstage", { paths: selectedPaths })}>取消暂存</button><input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="简单描述这次变化…" /><button type="button" className="primary" disabled={actionBusy || !commitMessage.trim() || !status.files.some((item) => item.staged)} onClick={async () => { if (await confirmAction("提交当前已暂存的文件？", { title: "保存项目节点", confirmLabel: "确认提交" })) await mutate("commit", { message: commitMessage }); }}>提交</button></div><div className="working-file-list">{status.files.map((file) => <label className={`working-file-row ${file.status === "conflicted" ? "danger" : ""} ${selectedPaths.includes(file.path) ? "selected" : ""}`} key={file.path}><input type="checkbox" checked={selectedPaths.includes(file.path)} onChange={() => setSelectedPaths((current) => current.includes(file.path) ? current.filter((item) => item !== file.path) : [...current, file.path])} /><span className="working-file-status">{file.status === "conflicted" ? "!" : file.status[0]?.toUpperCase()}</span><span>{file.path}</span><small>{statusLabel(file.status)}{file.additions !== null || file.deletions !== null ? ` · +${file.additions || 0} -${file.deletions || 0}` : ""}</small></label>)}</div></> : <p className="working-tree-clean"><Check size={15} />没有未提交修改</p>}</div>}</footer>
  </section>;
}
