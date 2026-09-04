import { useCallback, useEffect, useState } from "react";
import { realtimeCoordinator } from "../realtimeCoordinator";
import { appUpdateRequest, type AppUpdateStatus } from "./appUpdate";
import { AppUpdateResultDialog } from "./AppUpdateResultDialog";

export function AppUpdateAnnouncement({ hidden = false }: { hidden?: boolean }) {
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
  const remind = () => { void appUpdateRequest("/api/app-update/remind", { method: "POST", body: JSON.stringify({ afterHours: 24, expectedRevision: status.revision }), headers: { "Content-Type": "application/json" } }).then(setStatus).catch(() => undefined); };
  const skip = () => { void appUpdateRequest("/api/app-update/skip", { method: "POST", body: JSON.stringify({ version: status.release?.version, expectedRevision: status.revision }), headers: { "Content-Type": "application/json" } }).then(setStatus).catch(() => undefined); };
  return <AppUpdateResultDialog status={status} onClose={remind} onRemind={remind} onSkip={skip} />;
}
