import { AlertCircle, Check, ExternalLink, RefreshCw, ShieldAlert, X } from "lucide-react";
import type { AppUpdateStatus } from "./appUpdate";
import { appUpdateResult } from "./appUpdatePresentation";

type Props = {
  status: AppUpdateStatus;
  onClose: () => void;
  onRetry?: () => void;
  onRemind?: () => void;
  onSkip?: () => void;
};

export function AppUpdateResultDialog({ status, onClose, onRetry, onRemind, onSkip }: Props) {
  const result = appUpdateResult(status);
  const release = status.release;
  const Icon = result.kind === "current" ? Check : result.kind === "failed" ? AlertCircle : result.kind === "incompatible" ? ShieldAlert : RefreshCw;
  return <div className="dialog-backdrop app-update-result-backdrop" role="presentation">
    <section className={`dialog app-update-result-dialog ${result.kind}`} role="dialog" aria-modal="true" aria-labelledby="app-update-result-title">
      <header><h2 id="app-update-result-title">检查更新</h2><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={16} /></button></header>
      <div className="app-update-result-body">
        <span className="app-update-result-icon"><Icon size={24} /></span>
        <div><strong>{result.title}</strong><p>{result.message}</p></div>
      </div>
      {release && status.updateAvailable && result.kind !== "failed" && <div className="app-update-result-release">
        <span><b>版本</b>{status.product.currentVersion}{status.updateAvailable ? ` → ${release.version}` : ""}</span>
        {release.releaseNotes && <p>{release.releaseNotes}</p>}
        {!release.compatible && release.incompatibilityReason && <small>{release.incompatibilityReason}</small>}
      </div>}
      <footer className="dialog-actions">
        {result.kind === "failed" && onRetry && <button type="button" onClick={onRetry}><RefreshCw size={14} />重新检查</button>}
        {(result.kind === "available" || result.kind === "incompatible") && onSkip && <button type="button" onClick={onSkip}>跳过此版本</button>}
        {(result.kind === "available" || result.kind === "incompatible") && onRemind && <button type="button" onClick={onRemind}>明天提醒</button>}
        {release?.releaseUrl && status.updateAvailable && <a className="primary" href={release.releaseUrl} target="_blank" rel="noreferrer">查看更新<ExternalLink size={14} /></a>}
        {(result.kind === "current" || (!onRetry && result.kind === "failed")) && <button type="button" className="primary" onClick={onClose}>知道了</button>}
      </footer>
    </section>
  </div>;
}
