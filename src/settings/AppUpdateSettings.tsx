import { useCallback, useEffect, useState } from "react";
import { Check, Clock3, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { realtimeCoordinator } from "../realtimeCoordinator";
import { ProductLogo } from "../branding/ProductLogo";
import { HelpButton } from "../help/HelpProvider";
import { appUpdateRequest, appUpdateTime, type AppUpdateChannel, type AppUpdateStatus } from "./appUpdate";
import { AppUpdateResultDialog } from "./AppUpdateResultDialog";

export function AppUpdateSettings() {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [resultOpen, setResultOpen] = useState(false);

  const load = useCallback(async () => {
    try { setStatus(await appUpdateRequest("/api/app-update/status")); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);

  useEffect(() => {
    void load();
    const unsubscribe = realtimeCoordinator.subscribe("app-update.changed", () => { void load(); });
    const unsubscribeReconcile = realtimeCoordinator.subscribeReconcile(() => { void load(); });
    return () => { unsubscribe(); unsubscribeReconcile(); };
  }, [load]);

  const mutate = async (key: string, url: string, method: string, body: Record<string, unknown> = {}) => {
    setBusy(key); setError("");
    try {
      const next = await appUpdateRequest(url, { method, body: JSON.stringify({ ...body, expectedRevision: status?.revision }) });
      setStatus(next);
      if (key === "check") setResultOpen(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); if (key === "check") setResultOpen(true); }
    finally { setBusy(""); }
  };

  const updatePreferences = (values: { autoCheck?: boolean; channel?: AppUpdateChannel }) => mutate("preferences", "/api/app-update/preferences", "PATCH", values);

  if (!status) return <div className="settings-section app-update-settings"><div className="app-update-loading"><LoaderCircle className="spin" size={16} />正在读取版本信息</div>{error && <p className="app-update-error">{error}</p>}</div>;

  const release = status.release;
  const checkUnknown = status.source.state === "error";
  const retryCheck = () => { setResultOpen(false); void mutate("check", "/api/app-update/check", "POST"); };
  const remind = async () => { setResultOpen(false); await mutate("remind", "/api/app-update/remind", "POST", { afterHours: 24 }); };
  const skip = async () => { setResultOpen(false); await mutate("skip", "/api/app-update/skip", "POST", { version: release?.version }); };
  return <div className="settings-section app-update-settings">
    <div className="settings-page-heading"><div><span className="help-inline-heading"><h2>软件更新</h2><HelpButton topic="updates" /></span><p>Meta Code 的版本、发布频道与更新公告。</p></div></div>
    <section className="app-update-current">
      <div className="app-update-mark"><ProductLogo variant="mark" /></div>
      <div><strong>{status.product.name}</strong><span>当前版本 {status.product.currentVersion}</span></div>
      <i className={status.updateAvailable ? "available" : checkUnknown ? "unknown" : "current"}>{status.checkState === "checking" ? "正在检查新版本" : checkUnknown ? "检查未完成" : status.updateAvailable ? `发现 ${release?.version}` : "当前版本"}</i>
    </section>
    <div className="app-update-rows">
      <div className="app-update-row"><span><strong>自动检查</strong><small>启动后与运行期间定期检查</small></span><button type="button" className="settings-switch" role="switch" aria-checked={status.preferences.autoCheck} disabled={busy !== ""} onClick={() => void updatePreferences({ autoCheck: !status.preferences.autoCheck })}><span /></button></div>
      <div className="app-update-row"><span><strong>发布频道</strong><small>稳定版适合日常使用</small></span><select value={status.preferences.channel} disabled={busy !== ""} onChange={(event) => void updatePreferences({ channel: event.target.value as AppUpdateChannel })}><option value="stable">稳定版</option><option value="beta">测试版</option></select></div>
      <div className="app-update-row"><span><strong>检查更新</strong><small>检查 Meta Code 是否有可用的新版本</small></span><button type="button" disabled={busy !== "" || status.checkState === "checking"} onClick={() => void mutate("check", "/api/app-update/check", "POST")}><RefreshCw className={busy === "check" || status.checkState === "checking" ? "spin" : ""} size={14} />{status.checkState === "checking" ? "检查中" : "立即检查"}</button></div>
    </div>
    <div className="app-update-check-meta"><Clock3 size={13} /><span>最近检查：{appUpdateTime(status.lastCheckedAt)}</span>{status.lastSuccessfulCheckAt && <span>最近成功：{appUpdateTime(status.lastSuccessfulCheckAt)}</span>}</div>
    {release && status.updateAvailable && <section className="app-update-release available">
      <header><div>{status.updateAvailable ? <RefreshCw size={16} /> : checkUnknown ? <Clock3 size={16} /> : <Check size={16} />}<span><strong>{status.updateAvailable ? `Meta Code ${release.version}` : checkUnknown ? `上次检查到 ${release.version}` : `已是最新版本 ${release.version}`}</strong><small>{appUpdateTime(release.publishedAt)}</small></span></div>{release.releaseUrl && <a href={release.releaseUrl} target="_blank" rel="noreferrer">查看更新<ExternalLink size={13} /></a>}</header>
      {release.releaseNotes && <p>{release.releaseNotes}</p>}
      {!release.compatible && <div className="app-update-compatibility"><ShieldCheck size={14} /><span>{release.incompatibilityReason}</span></div>}
      {status.updateAvailable && <footer><button type="button" disabled={busy !== ""} onClick={() => void mutate("remind", "/api/app-update/remind", "POST", { afterHours: 24 })}>明天提醒</button><button type="button" disabled={busy !== ""} onClick={() => void mutate("skip", "/api/app-update/skip", "POST", { version: release.version })}>跳过此版本</button></footer>}
    </section>}
    {resultOpen && <AppUpdateResultDialog status={status} onClose={() => setResultOpen(false)} onRetry={retryCheck} onRemind={status.updateAvailable ? remind : undefined} onSkip={status.updateAvailable ? skip : undefined} />}
  </div>;
}
