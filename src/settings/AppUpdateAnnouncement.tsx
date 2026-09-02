import { useCallback, useEffect, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import { realtimeCoordinator } from "../realtimeCoordinator";
import { appUpdateRequest, type AppUpdateStatus } from "./appUpdate";

export function AppUpdateAnnouncement({ hidden = false, onOpen }: { hidden?: boolean; onOpen: () => void }) {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const load = useCallback(async () => {
    try { setStatus(await appUpdateRequest("/api/app-update/status")); }
    catch { /* The main workbench remains usable when update checks fail. */ }
  }, []);
  useEffect(() => {
    void load();
    const unsubscribe = realtimeCoordinator.subscribe("app-update.changed", () => { void load(); });
    return unsubscribe;
  }, [load]);
  if (hidden || !status?.announcementVisible || !status.release) return null;
  return <aside className="app-update-announcement" role="status" aria-live="polite">
    <button type="button" className="app-update-announcement-main" onClick={onOpen}><span>Meta Code {status.release.version}</span><small>有新版本可用</small><ChevronRight size={14} /></button>
    <button type="button" className="app-update-announcement-close" aria-label="明天提醒" title="明天提醒" onClick={() => { void appUpdateRequest("/api/app-update/remind", { method: "POST", body: JSON.stringify({ afterHours: 24, expectedRevision: status.revision }), headers: { "Content-Type": "application/json" } }).then(setStatus).catch(() => undefined); }}><X size={14} /></button>
  </aside>;
}
