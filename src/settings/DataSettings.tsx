import { useCallback, useEffect, useState } from "react";
import { ArchiveRestore, Check, CircleAlert, Clock3, DatabaseBackup, Download, FolderOpen, HardDrive, HardDriveDownload, LoaderCircle, RefreshCw, ShieldCheck, Terminal, X } from "lucide-react";
import { HelpButton } from "../help/HelpProvider";

type BackupFile = {
  name: string;
  size: number;
  createdAt: string;
  fileCount: number;
  appVersion: string;
  dataSchemaVersion: number;
  trigger: "manual" | "automatic";
  verifiedAt: string | null;
  verificationLevel: "restore-rehearsal" | null;
  compatibility: "ready" | "unverified" | "newer" | "unsupported";
};
type BackupPolicy = { schemaVersion: 1; automaticEnabled: boolean; intervalMs: number; retentionCount: number };
type BackupHealth = {
  status: "disabled" | "pending" | "running" | "healthy" | "busy" | "failed";
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  stale: boolean;
  automaticEnabled: boolean;
  currentTrigger: "manual" | "automatic" | null;
  lastTrigger: "manual" | "automatic" | null;
};
type BackupResponse = { backups: BackupFile[]; policy: BackupPolicy; health: BackupHealth | null; restore?: { desktopAvailable: boolean } };
type RestorePreflight = {
  name: string;
  ready: boolean;
  desktopAvailable: boolean;
  checks: Array<{ id: string; label: string; ok: boolean; message: string }>;
  backup: { createdAt: string; appVersion: string; dataSchemaVersion: number; files: number; totalBytes: number; trigger: "manual" | "automatic"; verifiedAt: string };
};
type RuntimeDiagnostic = {
  id: string;
  label: string;
  status: { available: boolean; version?: string; path?: string; source?: string; message?: string };
  activeVersion: string;
  installedVersions: string[];
  runtimeRoot: string;
  npmAvailable: boolean;
};

type Request = <T>(url: string, options?: RequestInit & { timeoutMs?: number }) => Promise<T>;

function bytes(value = 0) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function sourceLabel(source = "") {
  return source === "runtime" ? "工作台托管" : source === "custom" ? "指定路径" : source === "system" ? "系统 CLI" : "未检测";
}

export function DataSettings({ dataHome, claudeHome, codexHome, request, onNotice }: { dataHome: string; claudeHome: string; codexHome: string; request: Request; onNotice: (message: string, tone?: "success" | "warning" | "error") => void }) {
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [backupPolicy, setBackupPolicy] = useState<BackupPolicy | null>(null);
  const [backupHealth, setBackupHealth] = useState<BackupHealth | null>(null);
  const [desktopRestoreAvailable, setDesktopRestoreAvailable] = useState(false);
  const [loadingBackups, setLoadingBackups] = useState(true);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState("");
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostic[]>([]);
  const [verifyingBackup, setVerifyingBackup] = useState("");
  const [updatingBackupPolicy, setUpdatingBackupPolicy] = useState(false);
  const [restoreCandidate, setRestoreCandidate] = useState<BackupFile | null>(null);
  const [restorePreflight, setRestorePreflight] = useState<RestorePreflight | null>(null);
  const [restoreChecking, setRestoreChecking] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const loadBackups = useCallback(async (showLoading = true) => {
    if (showLoading) setLoadingBackups(true);
    try {
      const result = await request<BackupResponse>("/api/data/backups");
      setBackups(result.backups);
      setBackupPolicy(result.policy);
      setBackupHealth(result.health);
      setDesktopRestoreAvailable(Boolean(result.restore?.desktopAvailable));
    }
    catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { if (showLoading) setLoadingBackups(false); }
  }, [onNotice, request]);

  useEffect(() => {
    void loadBackups();
    const timer = window.setInterval(() => void loadBackups(false), 30_000);
    return () => window.clearInterval(timer);
  }, [loadBackups]);

  useEffect(() => {
    if (!restoreCandidate || restoring) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setRestoreCandidate(null);
      setRestorePreflight(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [restoreCandidate, restoring]);

  const createBackup = async () => {
    setCreatingBackup(true);
    try {
      const result = await request<{ backup: { files: number }; backups: BackupFile[]; policy: BackupPolicy; health: BackupHealth | null }>("/api/data/backups", { method: "POST", timeoutMs: 30 * 60_000 });
      setBackups(result.backups);
      setBackupPolicy(result.policy);
      setBackupHealth(result.health);
      onNotice(`备份和恢复演练均已通过：${result.backup.files} 个文件`, "success");
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setCreatingBackup(false); }
  };

  const runDiagnostics = async () => {
    setChecking(true);
    try {
      const result = await request<{ checkedAt: string; runtimes: RuntimeDiagnostic[] }>("/api/data/diagnostics", { timeoutMs: 45_000 });
      setDiagnostics(result.runtimes);
      setCheckedAt(result.checkedAt);
      const unavailable = result.runtimes.filter((item) => !item.status.available).length;
      onNotice(unavailable ? `诊断完成，${unavailable} 个 CLI 需要处理` : "CLI 运行环境检查通过", unavailable ? "warning" : "success");
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setChecking(false); }
  };

  const openFolder = async (target: "data" | "backups") => {
    try { await request("/api/data/open-folder", { method: "POST", body: JSON.stringify({ target }) }); }
    catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
  };

  const verifyBackup = async (backup: BackupFile) => {
    setVerifyingBackup(backup.name);
    try {
      const result = await request<{ files: number; totalBytes: number }>(`/api/data/backups/${encodeURIComponent(backup.name)}/verify`, { method: "POST", timeoutMs: 5 * 60_000 });
      onNotice(`备份校验通过：${result.files} 个文件，${bytes(result.totalBytes)}`, "success");
      await loadBackups(false);
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setVerifyingBackup(""); }
  };

  const setAutomaticBackup = async (enabled: boolean) => {
    setUpdatingBackupPolicy(true);
    try {
      const result = await request<{ policy: BackupPolicy; health: BackupHealth | null }>("/api/data/backup-policy", {
        method: "PATCH",
        body: JSON.stringify({ automaticEnabled: enabled })
      });
      setBackupPolicy(result.policy);
      setBackupHealth(result.health);
      onNotice(enabled ? "自动备份已开启" : "自动备份已关闭", "success");
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setUpdatingBackupPolicy(false); }
  };

  const inspectRestore = async (backup: BackupFile) => {
    setRestoreCandidate(backup);
    setRestorePreflight(null);
    setRestoreChecking(true);
    try {
      const result = await request<RestorePreflight>(`/api/data/backups/${encodeURIComponent(backup.name)}/restore-preflight`, { method: "POST", timeoutMs: 5 * 60_000 });
      setRestorePreflight(result);
      await loadBackups(false);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), "error");
    } finally { setRestoreChecking(false); }
  };

  const restoreBackup = async () => {
    if (!restoreCandidate || !restorePreflight?.ready || !window.metaCodeDesktop?.restoreBackup) return;
    setRestoring(true);
    try {
      await window.metaCodeDesktop.restoreBackup(restoreCandidate.name);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), "error");
      setRestoring(false);
      await loadBackups(false);
    }
  };

  const automaticStatus = backupHealth?.status === "running" && backupHealth.currentTrigger === "automatic"
    ? "正在创建并验证恢复点"
    : backupHealth?.status === "busy"
      ? "任务运行中，已自动顺延"
      : backupHealth?.status === "failed"
        ? backupHealth.lastError || "上次自动备份失败"
        : backupHealth?.nextAttemptAt
          ? `下次预计 ${new Date(backupHealth.nextAttemptAt).toLocaleString()}`
          : "开启后每天在工作台空闲时备份";

  return <div className="settings-section settings-data-section">
    <div className="settings-page-heading"><div><span className="help-inline-heading"><h2>数据</h2><HelpButton topic="data-and-backups" /></span><p>个人数据独立于程序源码保存，可在卸载或升级后继续保留。</p></div></div>
    <section className="settings-data-primary">
      <header><HardDrive size={20} /><span><strong>工作台数据</strong><small>任务、工作区、Skill、MCP、日志与凭据</small></span><button type="button" onClick={() => void openFolder("data")}><FolderOpen size={14} />打开目录</button></header>
      <code>{dataHome}</code>
      <div className="settings-data-boundaries">
        <div><strong>Claude 原生配置</strong><span>通过 CLAUDE_CONFIG_DIR 隔离</span><code>{claudeHome}</code></div>
        <div><strong>Codex 原生配置</strong><span>通过 CODEX_HOME 隔离</span><code>{codexHome}</code></div>
      </div>
    </section>
    <section className="settings-data-tool settings-backup-tool">
      <header><span><DatabaseBackup size={18} /><strong>个人数据备份</strong><small>会话、设置、凭据、Skill、MCP 与 Agent 配置；只保留最近 2 个已验证恢复点</small></span><div><button type="button" onClick={() => void openFolder("backups")}><FolderOpen size={15} />备份目录</button></div></header>
      <div className="settings-backup-controls">
        <div><Clock3 size={17} /><span><strong>自动备份</strong><small>{backupPolicy?.automaticEnabled === false ? "已关闭，不会影响现有恢复点" : automaticStatus}</small></span><button type="button" className="agent-switch" role="switch" aria-checked={backupPolicy?.automaticEnabled !== false} aria-label="自动备份" disabled={!backupPolicy || updatingBackupPolicy} onClick={() => void setAutomaticBackup(!(backupPolicy?.automaticEnabled !== false))}><span /></button></div>
        <div><HardDriveDownload size={17} /><span><strong>立即备份</strong><small>创建后自动完成完整性检查和隔离恢复演练</small></span><button type="button" disabled={creatingBackup} onClick={() => void createBackup()}>{creatingBackup ? <LoaderCircle className="spin" size={15} /> : <HardDriveDownload size={15} />}{creatingBackup ? "备份并验证中" : "立即备份"}</button></div>
      </div>
      {backupHealth?.automaticEnabled && (backupHealth.stale || backupHealth.status === "failed" || backupHealth.status === "busy") && <div className={`settings-backup-health ${backupHealth.status}`}><CircleAlert size={15} /><span><strong>{backupHealth.status === "busy" ? "任务运行中，备份已顺延" : backupHealth.status === "failed" ? "备份暂未成功" : "备份已超过建议周期"}</strong><small>{backupHealth.lastError || (backupHealth.nextAttemptAt ? `下次尝试 ${new Date(backupHealth.nextAttemptAt).toLocaleString()}` : "可立即创建一份完整备份")}</small></span></div>}
      <div className="settings-backup-list-heading"><strong>恢复点</strong><span>{backups.length}/2</span></div>
      <div className="settings-backup-list">{loadingBackups ? <p><LoaderCircle className="spin" size={14} />正在读取备份</p> : backups.length ? backups.slice(0, 2).map((backup) => <div key={backup.name}><span><strong>{new Date(backup.createdAt).toLocaleString()}</strong><small>{backup.trigger === "automatic" ? "自动备份" : "立即备份"} · Meta Code {backup.appVersion} · 数据结构 v{backup.dataSchemaVersion}</small><small className={backup.compatibility === "ready" ? "verified" : "attention"}>{backup.compatibility === "ready" ? `已完成恢复演练${backup.verifiedAt ? ` · ${new Date(backup.verifiedAt).toLocaleString()}` : ""}` : backup.compatibility === "newer" ? "需要更新 Meta Code 后恢复" : "需要重新验证"}</small></span><em>{bytes(backup.size)}</em><div className="settings-backup-actions"><button type="button" disabled={Boolean(verifyingBackup)} onClick={() => void verifyBackup(backup)}>{verifyingBackup === backup.name ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}验证</button><button type="button" disabled={restoreChecking || restoring} onClick={() => void inspectRestore(backup)}><ArchiveRestore size={13} />回到此备份点</button></div></div>) : <p>还没有可用恢复点。</p>}</div>
      <p className="settings-data-note">恢复点不包含工作区源码和可重新下载的 CLI。自动备份仅在 Meta Code 运行且任务空闲时执行。</p>
    </section>
    <section className="settings-data-tool">
      <header><span><Terminal size={18} /><strong>运行诊断</strong><small>{checkedAt ? `上次检查 ${new Date(checkedAt).toLocaleString()}` : "检查 Agent、CLI 和最近任务状态"}</small></span><div><a className="settings-diagnostic-export" href="/api/data/diagnostics/export" download><Download size={14} />导出诊断</a><button type="button" disabled={checking} onClick={() => void runDiagnostics()}>{checking ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{checking ? "检查中" : diagnostics.length ? "重新检查" : "开始检查"}</button></div></header>
      {diagnostics.length > 0 && <div className="settings-diagnostic-list">{diagnostics.map((item) => <div key={item.id} className={item.status.available ? "ready" : "attention"}>{item.status.available ? <Check size={15} /> : <CircleAlert size={15} />}<span><strong>{item.label}</strong><small>{item.status.available ? `${sourceLabel(item.status.source)} · ${item.status.version || "版本未知"}` : item.status.message || "未检测到可用 CLI"}</small><code title={item.status.path || item.runtimeRoot}>{item.status.path || item.runtimeRoot}</code></span></div>)}</div>}
    </section>
    <p className="settings-data-note">CLI 程序位置与个人数据位置彼此独立；切换系统 CLI、指定路径或工作台托管版本不会自动迁移历史数据。</p>
    {restoreCandidate && <div className="data-restore-layer" role="presentation"><button type="button" className="data-restore-backdrop" aria-label="关闭恢复窗口" onClick={() => { if (!restoring) { setRestoreCandidate(null); setRestorePreflight(null); } }} /><section className="data-restore-dialog" role="dialog" aria-modal="true" aria-labelledby="data-restore-title"><header><span><ArchiveRestore size={19} /><strong id="data-restore-title">回到备份点</strong></span><button type="button" aria-label="关闭" disabled={restoring} onClick={() => { setRestoreCandidate(null); setRestorePreflight(null); }}><X size={16} /></button></header><div className="data-restore-summary"><strong>{new Date(restoreCandidate.createdAt).toLocaleString()}</strong><span>{restoreCandidate.trigger === "automatic" ? "自动备份" : "立即备份"} · {bytes(restoreCandidate.size)} · Meta Code {restoreCandidate.appVersion}</span></div>{restoreChecking ? <div className="data-restore-checking"><LoaderCircle className="spin" size={17} />正在执行恢复前检查与隔离演练</div> : restorePreflight ? <div className="data-restore-checks">{restorePreflight.checks.map((check) => <div className={check.ok ? "ready" : "blocked"} key={check.id}>{check.ok ? <Check size={15} /> : <CircleAlert size={15} />}<span><strong>{check.label}</strong><small>{check.message}</small></span></div>)}</div> : null}<p>恢复会替换会话、设置、Skill、MCP、Provider 配置与凭据，不会改动工作区源码。恢复期间 Meta Code 将自动重启；任何步骤失败都会换回当前数据。</p><footer><button type="button" disabled={restoring} onClick={() => { setRestoreCandidate(null); setRestorePreflight(null); }}>取消</button><button type="button" className="primary" disabled={!restorePreflight?.ready || restoring || !desktopRestoreAvailable} onClick={() => void restoreBackup()}>{restoring ? <LoaderCircle className="spin" size={14} /> : <ArchiveRestore size={14} />}{restoring ? "正在恢复并重启" : restorePreflight?.ready ? "确认恢复并重启" : "检查未通过"}</button></footer></section></div>}
  </div>;
}
