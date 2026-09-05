import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Download, ExternalLink, LoaderCircle, RefreshCw, Search, Settings2, Undo2, Wrench } from "lucide-react";
import { confirmAction } from "../components/ConfirmationProvider";
import { runtimeInstallationAction, type InstallationRuntime } from "../runtimeInstallation";
import { ProviderIcon } from "../branding/ProviderIcon";
import { realtimeCoordinator } from "../realtimeCoordinator";
import { ProviderConnectionControl } from "./ProviderConnectionControl";
import type { ProviderControlSnapshot } from "../providers/types";

type MarketRuntimeStatus = InstallationRuntime & {
  available: boolean;
  source: "configured" | "bundled" | "runtime" | "system" | "missing";
  version: string;
  path: string;
  message: string;
  managed: { installed: boolean; healthy?: boolean; activeVersion: string; installedVersions: string[] };
};

type MarketInstallProgress = {
  phase: string;
  message: string;
  active: boolean;
  downloadedBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
};

type MarketInstallState = {
  providerId: string;
  phase: "installing" | "verifying" | "completed" | "failed";
  message: string;
  active: boolean;
};

type MarketItem = {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  authors: string[];
  license: string;
  icon?: string;
  accent: string;
  transport: "native" | "acp";
  native: boolean;
  installed: boolean;
  installable: boolean;
  installReason: string;
  distributionTypes: string[];
  rank: number;
  tier: "featured" | "recommended" | "ecosystem" | "experimental";
  region: "global" | "china";
  verified: boolean;
  maturity: "stable" | "preview" | "community";
  hiddenByDefault: boolean;
};

type MarketResponse = {
  registryWarning?: string;
  registryVersion: string;
  registrySource: "network" | "cache";
  items: MarketItem[];
  runtimes: Record<string, MarketRuntimeStatus>;
  controls: Record<string, ProviderControlSnapshot>;
  installStates: Record<string, MarketInstallState>;
};

function marketState(item: MarketItem, install: MarketInstallState | undefined, control: ProviderControlSnapshot | undefined) {
  if (install?.active) return { key: "working", label: "处理中" };
  if (!item.installed) return { key: "missing", label: item.installable ? "可安装" : "不可用" };
  if (!control?.lifecycle.runtimeAvailable) return { key: "attention", label: "需修复" };
  if (control.connection.status === "checking") return { key: "working", label: "检测中" };
  if (control.connection.status === "ready") return { key: "ready", label: "可使用" };
  return { key: "attention", label: "待连接" };
}

async function marketApi<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers || {}) }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function bytes(value = 0) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function MarketIcon({ item, size = 28 }: { item: MarketItem; size?: number }) {
  return <ProviderIcon provider={item.id} icon={item.icon} accent={item.accent} size={size} className="agent-market-icon" />;
}

export function AgentMarketSettings({ onNativeConfigure }: { onNativeConfigure(providerId: "codex" | "claude", runtime?: boolean): void }) {
  const [market, setMarket] = useState<MarketResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"featured" | "installed" | "available" | "china" | "all">("featured");
  const [selectedId, setSelectedId] = useState("codex");
  const [actionBusy, setActionBusy] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [installProgress, setInstallProgress] = useState<Record<string, MarketInstallProgress | null>>({});

  const loadMarket = useCallback(async (refresh = false) => {
    try {
      const result = await marketApi<MarketResponse>(`/api/agent-market${refresh ? "?refresh=1" : ""}`);
      setMarket(result);
      setError("");
      if (!result.items.some((item) => item.id === selectedId)) setSelectedId(result.items[0]?.id || "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [selectedId]);

  useEffect(() => { void loadMarket(); }, []);
  useEffect(() => {
    const changed = () => void loadMarket();
    const install = (detail: Record<string, unknown>) => {
      const state = detail as MarketInstallState;
      if (state.providerId) {
        setMarket((current) => current ? { ...current, installStates: { ...current.installStates, [state.providerId]: state } } : current);
        if (!state.active) void loadMarket();
      }
    };
    const unsubscribeChanged = realtimeCoordinator.subscribe("agent-market.changed", changed);
    const unsubscribeRuntime = realtimeCoordinator.subscribe("runtime.changed", changed);
    const unsubscribeInstall = realtimeCoordinator.subscribe("agent-market.install", install);
    const unsubscribeReconcile = realtimeCoordinator.subscribeReconcile(() => void loadMarket());
    return () => { unsubscribeChanged(); unsubscribeRuntime(); unsubscribeInstall(); unsubscribeReconcile(); };
  }, [loadMarket]);

  const selected = market?.items.find((item) => item.id === selectedId) || null;
  const selectedInstall = selected ? market?.installStates[selected.id] : undefined;

  useEffect(() => {
    const activeIds = Object.values(market?.installStates || {}).filter((state) => state.active).map((state) => state.providerId);
    if (!activeIds.length) return;
    let disposed = false;
    const sync = async () => {
      await Promise.all(activeIds.map(async (id) => {
        try {
          const result = await marketApi<{ state: MarketInstallState | null; progress: MarketInstallProgress | null }>(`/api/agent-market/${encodeURIComponent(id)}/install-status`);
          if (disposed) return;
          setInstallProgress((current) => ({ ...current, [id]: result.progress }));
          if (result.state) setMarket((current) => current ? { ...current, installStates: { ...current.installStates, [id]: result.state! } } : current);
          if (result.state && !result.state.active) void loadMarket();
        } catch { /* SSE remains the primary path. */ }
      }));
    };
    void sync();
    const timer = window.setInterval(sync, 1_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [Object.values(market?.installStates || {}).filter((state) => state.active).map((state) => state.providerId).join("|")]);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (market?.items || []).filter((item) => {
      if (!normalized && filter === "featured" && item.hiddenByDefault) return false;
      if (filter === "installed" && !item.installed) return false;
      if (filter === "available" && (item.installed || !item.installable)) return false;
      if (filter === "china" && item.region !== "china") return false;
      return !normalized || `${item.name} ${item.id} ${item.description}`.toLowerCase().includes(normalized);
    });
  }, [market?.items, filter, query]);

  const runAction = async (action: "install" | "update" | "rollback" | "repair") => {
    if (!selected) return;
    if (action === "repair" && !await confirmAction("重新安装工作台托管的 CLI，账号配置和任务数据保持不变。系统安装不会被修改。", { title: "修复 CLI", confirmLabel: "重新安装" })) return;
    setActionBusy(action);
    setActionNotice("");
    try {
      const result = await marketApi<{ accepted?: boolean; update?: { state: string } }>(`/api/agent-market/${encodeURIComponent(selected.id)}/${action}`, { method: "POST", body: "{}" });
      setActionNotice(action === "rollback" ? "已回退到上一版本" : action === "update" ? result.accepted ? "更新任务已开始" : result.update?.state === "external" ? "正在使用外部 CLI，可在运行环境中安装托管副本" : "当前版本无需更新" : action === "repair" ? "重新安装已开始" : "安装任务已开始");
      await loadMarket();
    } catch (cause) { setActionNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setActionBusy(""); }
  };

  const progress = selected ? installProgress[selected.id] : null;
  const selectedRuntime = selected ? market?.runtimes[selected.id] : undefined;
  const installation = runtimeInstallationAction(selectedRuntime);
  const percent = progress?.totalBytes ? Math.min(100, Math.round((progress.downloadedBytes || 0) / progress.totalBytes * 100)) : null;

  return <div className="agent-market-settings">
    <header className="agent-market-heading">
      <div><h2>Agent 市场</h2><span>{market ? `${market.items.filter((item) => item.installed).length} 已安装 · ${market.items.filter((item) => !item.hiddenByDefault).length} 个精选` : "加载中"}</span></div>
      <button type="button" title="刷新市场" onClick={() => void loadMarket(true)} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={15} /></button>
    </header>
    <div className="agent-market-toolbar">
      <label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Agent" /></label>
      <div role="group" aria-label="筛选 Agent">
        {([['featured', '精选'], ['installed', '已安装'], ['available', '可安装'], ['china', '国产 Agent'], ['all', '全部生态']] as const).map(([value, label]) => <button type="button" key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}
      </div>
    </div>
    {error && <div className="agent-market-error">{error}</div>}
    {market?.registryWarning && <div className="agent-market-notice">{market.registryWarning}</div>}
    <div className={`agent-market-layout ${detailOpen ? "detail-open" : ""}`}>
      <div className="agent-market-list" aria-busy={loading}>
        {loading && !market ? <div className="agent-market-loading"><LoaderCircle className="spin" size={18} />正在读取市场</div> : visibleItems.map((item) => {
          const install = market?.installStates[item.id];
          const control = market?.controls[item.id];
          const state = marketState(item, install, control);
          return <button type="button" key={item.id} className={`agent-market-card ${selectedId === item.id ? "selected" : ""}`} onClick={() => { setSelectedId(item.id); setActionNotice(""); setDetailOpen(true); }}>
            <MarketIcon item={item} />
            <span className="agent-market-card-copy"><strong>{item.name}</strong><small>{item.description || item.id}</small><i>{item.native ? "原生增强" : "ACP"} · {item.verified ? "官方" : "社区"}{item.maturity === "preview" ? " · 预览版" : ""}</i></span>
            <span className={`agent-market-state ${state.key}`}>{state.key === "working" ? <LoaderCircle className="spin" size={12} /> : state.key === "ready" ? <Check size={12} /> : null}{state.label}</span>
          </button>;
        })}
        {!loading && !visibleItems.length && <div className="agent-market-empty">没有匹配的 Agent</div>}
      </div>
      {selected && <aside className="agent-market-detail">
        <button type="button" className="agent-market-back" onClick={() => setDetailOpen(false)}><ArrowLeft size={14} />返回 Agent 列表</button>
        <header><MarketIcon item={selected} size={34} /><div><strong>{selected.name}</strong><span>{selected.native ? "原生增强" : "ACP 标准接入"}</span></div><i className={marketState(selected, selectedInstall, market?.controls[selected.id]).key}>{marketState(selected, selectedInstall, market?.controls[selected.id]).label}</i></header>
        <p>{selected.description}</p>
        <div className="agent-market-badges"><span>{selected.verified ? "官方发布" : "社区维护"}</span><span>{selected.maturity === "stable" ? "稳定" : selected.maturity === "preview" ? "开发者预览" : "社区生态"}</span>{selected.region === "china" && <span>国产 Agent</span>}</div>
        <dl><div><dt>版本</dt><dd>{selected.version || "未知"}</dd></div><div><dt>许可</dt><dd>{selected.license}</dd></div><div><dt>分发</dt><dd>{selected.distributionTypes.join(" / ")}</dd></div><div><dt>运行时</dt><dd>{market?.runtimes[selected.id]?.source || (selected.installed ? "待检测" : "未安装")}</dd></div></dl>
        {(selected.repository || selected.website) && <div className="agent-market-links">{selected.repository && <a href={selected.repository} target="_blank" rel="noreferrer"><ExternalLink size={12} />源码</a>}{selected.website && <a href={selected.website} target="_blank" rel="noreferrer"><ExternalLink size={12} />官网</a>}</div>}
        {selectedInstall?.active && <div className="agent-market-progress"><div><span>{selectedInstall.message}</span>{percent !== null && <b>{percent}%</b>}</div><i>{percent !== null ? <span style={{ width: `${percent}%` }} /> : <span className="indeterminate" />}</i>{progress?.downloadedBytes ? <small>{bytes(progress.downloadedBytes)}{progress.totalBytes ? ` / ${bytes(progress.totalBytes)}` : ""}{progress.bytesPerSecond ? ` · ${bytes(progress.bytesPerSecond)}/s` : ""}</small> : null}</div>}
        {selectedInstall?.phase === "failed" && <div className="agent-market-error">{selectedInstall.message}</div>}
        <div className="agent-market-actions">
          {!selected.installed ? <button type="button" className="primary" disabled={!selected.installable || !installation.supported || Boolean(selectedInstall?.active) || Boolean(actionBusy)} title={selected.installReason} onClick={() => void runAction("install")}><Download size={14} />{actionBusy === "install" ? "提交中" : "安装"}</button> : <>
            {(installation.repair || !selectedRuntime?.available) && <button type="button" className="primary" disabled={!installation.supported || Boolean(selectedInstall?.active) || Boolean(actionBusy)} onClick={() => void runAction("repair")}><Wrench size={14} />重新安装修复</button>}
            {selectedRuntime?.available && <button type="button" disabled={Boolean(selectedInstall?.active) || Boolean(actionBusy)} onClick={() => void runAction("update")}><RefreshCw className={actionBusy === "update" ? "spin" : ""} size={14} />检查更新</button>}
            {(selectedRuntime?.managed.installedVersions.length || 0) > 1 && <button type="button" disabled={Boolean(selectedInstall?.active) || Boolean(actionBusy)} onClick={() => void runAction("rollback")}><Undo2 size={14} />回退</button>}
          </>}
          {selected.native && <button type="button" onClick={() => onNativeConfigure(selected.id as "codex" | "claude", !selectedRuntime?.available)}><Settings2 size={14} />{selectedRuntime?.available ? "配置账号 / API" : "使用已有 CLI"}</button>}
        </div>
        {installation.environmentMessage && <small className="agent-market-reason">{installation.environmentMessage}</small>}
        {!selected.native && !selected.installed && <small className="agent-market-reason">{selected.installReason}</small>}
        {!selected.native && selected.installed && <ProviderConnectionControl providerId={selected.id} />}
        {actionNotice && <div className="agent-market-notice">{actionNotice}</div>}
      </aside>}
    </div>
  </div>;
}
