import "./PluginSettings.css";
import { useState } from "react";
import { LoaderCircle, Puzzle, RefreshCw, CircleCheck, CircleAlert } from "lucide-react";

export type WorkbenchPlugin = {
  id: string;
  displayName: string;
  description: string;
  version: string;
  enabled: boolean;
  health: "healthy" | "disabled" | "degraded";
  apiVersion?: number;
  capabilities?: string[];
  diagnostics?: { message: string; checkedAt: string | null; activeRequests: number; busy: boolean };
};

export function PluginSettings({ plugins, request, onChanged }: {
  plugins: WorkbenchPlugin[];
  request: <T>(url: string, init?: RequestInit) => Promise<T>;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const refresh = async () => {
    if (pending) return;
    setPending("refresh"); setError("");
    try { await onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setPending(null); }
  };
  const capabilityNames: Record<string, string> = { "agent.delegation": "跨 Agent 委派", "agent.activity": "实时活动", "agent.drawer": "Agent 抽屉", "execution.collaborative": "协作执行", "workflow.planning": "计划审批", "workflow.execution": "依赖调度", "workflow.maintenance": "检查点维护", "workflow.activity": "节点活动" };
  const toggle = async (plugin: WorkbenchPlugin) => {
    if (pending) return;
    setPending(plugin.id);
    setError("");
    try {
      await request(`/api/plugins/${encodeURIComponent(plugin.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !plugin.enabled }) });
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  };
  return <div className="settings-section plugin-settings">
    <div className="settings-page-heading"><h2>工作台插件</h2><p>按需启用协作委派与任务编排。停用后保留历史任务、日志和成果；运行中的任务需先暂停或完成。运行状态描述插件宿主；模型接口连接请在 Provider 设置中测试。</p><button type="button" className="plugin-refresh" disabled={pending !== null} onClick={() => void refresh()}><RefreshCw size={14} className={pending === "refresh" ? "spin" : ""} />刷新状态</button></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="settings-provider-config-grid">
      {plugins.map((plugin) => <section className="settings-provider-panel" key={plugin.id}>
        <header><Puzzle size={20} /><span><strong>{plugin.displayName}</strong><small>v{plugin.version} · API {plugin.apiVersion || 1} · {plugin.health === "degraded" ? "需要检查" : plugin.diagnostics?.busy ? "运行中" : plugin.enabled ? "已启用" : "已停用"}</small></span></header>
        <div className="settings-grid"><p className="wide">{plugin.description}</p>
          <div className="wide plugin-capabilities">{plugin.capabilities?.map((capability) => <span key={capability}>{capabilityNames[capability] || capability}</span>)}</div>
          {plugin.diagnostics && <div className={`wide plugin-runtime-status ${plugin.health}`} role="status">{plugin.health === "degraded" ? <CircleAlert size={14} /> : <CircleCheck size={14} />}<span>{plugin.diagnostics.message}{plugin.diagnostics.checkedAt && <small>最近检查 {new Date(plugin.diagnostics.checkedAt).toLocaleTimeString()}</small>}{plugin.diagnostics.activeRequests > 0 && <small>{plugin.diagnostics.activeRequests} 个请求正在处理</small>}</span></div>}
          <label className="toggle-row wide"><span>{pending === plugin.id && <LoaderCircle className="spin" size={14} />}启用 {plugin.displayName}</span><input type="checkbox" role="switch" checked={plugin.enabled} disabled={pending !== null} onChange={() => void toggle(plugin)} /></label>
        </div>
      </section>)}
    </div>
  </div>;
}
