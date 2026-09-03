import { useCallback, useEffect, useState } from "react";
import { Check, CircleAlert, DatabaseBackup, FolderOpen, HardDrive, LoaderCircle, RefreshCw, Terminal } from "lucide-react";
import { HelpButton } from "../help/HelpProvider";

type BackupFile = { name: string; size: number; createdAt: string };
type BackupHealth = {
  status: "pending" | "running" | "healthy" | "busy" | "failed";
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  stale: boolean;
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
  const [backupHealth, setBackupHealth] = useState<BackupHealth | null>(null);
  const [loadingBackups, setLoadingBackups] = useState(true);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState("");
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostic[]>([]);

  const loadBackups = useCallback(async () => {
    setLoadingBackups(true);
    try {
      const result = await request<{ backups: BackupFile[]; health: BackupHealth | null }>("/api/data/backups");
      setBackups(result.backups);
      setBackupHealth(result.health);
    }
    catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setLoadingBackups(false); }
  }, [onNotice, request]);

  useEffect(() => { void loadBackups(); }, [loadBackups]);

  const createBackup = async () => {
    setCreatingBackup(true);
    try {
      const result = await request<{ backup: { files: number }; backups: BackupFile[]; health: BackupHealth | null }>("/api/data/backups", { method: "POST", timeoutMs: 30 * 60_000 });
      setBackups(result.backups);
      setBackupHealth(result.health);
      onNotice(`个人数据备份已完成：${result.backup.files} 个文件`, "success");
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
    <section className="settings-data-tool">
      <header><span><DatabaseBackup size={18} /><strong>个人数据备份</strong><small>会话、设置、凭据、Skill、MCP 与 Agent 配置，保留最近 3 组并限制总容量</small></span><div><button type="button" onClick={() => void openFolder("backups")}><FolderOpen size={14} />备份目录</button><button type="button" className="primary" disabled={creatingBackup} onClick={() => void createBackup()}>{creatingBackup ? <LoaderCircle className="spin" size={14} /> : <DatabaseBackup size={14} />}{creatingBackup ? "备份中" : "立即备份"}</button></div></header>
      {backupHealth && (backupHealth.stale || backupHealth.status === "failed" || backupHealth.status === "busy") && <div className={`settings-backup-health ${backupHealth.status}`}><CircleAlert size={15} /><span><strong>{backupHealth.status === "busy" ? "任务运行中，备份已顺延" : backupHealth.status === "failed" ? "自动备份暂未成功" : "备份已超过建议周期"}</strong><small>{backupHealth.lastError || (backupHealth.nextAttemptAt ? `下次尝试 ${new Date(backupHealth.nextAttemptAt).toLocaleString()}` : "可立即创建一份完整备份")}</small></span></div>}
      <div className="settings-backup-list">{loadingBackups ? <p><LoaderCircle className="spin" size={14} />正在读取备份</p> : backups.length ? backups.slice(0, 6).map((backup) => <div key={backup.name}><span><strong>{backup.name}</strong><small>{new Date(backup.createdAt).toLocaleString()}</small></span><em>{bytes(backup.size)}</em></div>) : <p>还没有可用备份。</p>}</div>
    </section>
    <section className="settings-data-tool">
      <header><span><Terminal size={18} /><strong>CLI 运行诊断</strong><small>{checkedAt ? `上次检查 ${new Date(checkedAt).toLocaleString()}` : "检查来源、版本、路径和托管状态"}</small></span><button type="button" disabled={checking} onClick={() => void runDiagnostics()}>{checking ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{checking ? "检查中" : diagnostics.length ? "重新检查" : "开始检查"}</button></header>
      {diagnostics.length > 0 && <div className="settings-diagnostic-list">{diagnostics.map((item) => <div key={item.id} className={item.status.available ? "ready" : "attention"}>{item.status.available ? <Check size={15} /> : <CircleAlert size={15} />}<span><strong>{item.label}</strong><small>{item.status.available ? `${sourceLabel(item.status.source)} · ${item.status.version || "版本未知"}` : item.status.message || "未检测到可用 CLI"}</small><code title={item.status.path || item.runtimeRoot}>{item.status.path || item.runtimeRoot}</code></span></div>)}</div>}
    </section>
    <p className="settings-data-note">CLI 程序位置与个人数据位置彼此独立；切换系统 CLI、指定路径或工作台托管版本不会自动迁移历史数据。</p>
  </div>;
}
