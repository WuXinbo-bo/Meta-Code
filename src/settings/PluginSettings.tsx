import { useState } from "react";
import { LoaderCircle, Puzzle } from "lucide-react";

export type WorkbenchPlugin = {
  id: string;
  displayName: string;
  description: string;
  version: string;
  enabled: boolean;
  health: "healthy" | "disabled" | "degraded";
};

export function PluginSettings({ plugins, request, onChanged }: {
  plugins: WorkbenchPlugin[];
  request: <T>(url: string, init?: RequestInit) => Promise<T>;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
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
  return <div className="settings-section">
    <div className="settings-page-heading"><h2>工作台插件</h2><p>按需启用协作委派与任务编排。停用后保留历史任务、日志和成果；运行中的任务需先暂停或完成。</p></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="settings-provider-config-grid">
      {plugins.map((plugin) => <section className="settings-provider-panel" key={plugin.id}>
        <header><Puzzle size={20} /><span><strong>{plugin.displayName}</strong><small>v{plugin.version} · {plugin.health === "degraded" ? "需要检查" : plugin.enabled ? "已启用" : "已停用"}</small></span></header>
        <div className="settings-grid"><p className="wide">{plugin.description}</p>
          <label className="toggle-row wide"><span>{pending === plugin.id && <LoaderCircle className="spin" size={14} />}启用 {plugin.displayName}</span><input type="checkbox" role="switch" checked={plugin.enabled} disabled={pending !== null} onChange={() => void toggle(plugin)} /></label>
        </div>
      </section>)}
    </div>
  </div>;
}
