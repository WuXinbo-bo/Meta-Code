export type AppUpdateChannel = "stable" | "beta";

export type AppUpdateStatus = {
  schemaVersion: 1;
  revision: number;
  product: { id: string; name: string; currentVersion: string; currentBuildId: string };
  capabilities: { check: boolean; download: boolean; apply: boolean; launcher: boolean };
  source: { state: "unconfigured" | "manifest" | "github" | "error"; label: string; githubRepository: string; manifestConfigured: boolean; usingCachedRelease: boolean; lastSuccessfulState: "unconfigured" | "manifest" | "github"; lastSuccessfulLabel: string };
  checkState: "idle" | "checking" | "completed" | "error";
  checkPhase: "idle" | "resolving" | "connecting" | "verifying" | "completed" | "failed";
  checkStartedAt: string | null;
  sourceAttempts: Array<{ source: "manifest" | "github"; label: string; url: string; state: "succeeded" | "failed"; durationMs: number; error: string }>;
  preferences: { autoCheck: boolean; channel: AppUpdateChannel; skippedVersion: string; remindAfter: string | null };
  lastCheckedAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastError: string;
  release: null | {
    version: string;
    buildId: string;
    manifestDigest: string;
    channel: AppUpdateChannel;
    publishedAt: string;
    releaseNotes: string;
    releaseUrl: string;
    source: "manifest" | "github";
    compatible: boolean;
    installable: boolean;
    incompatibilityReason: string;
  };
  updateAvailable: boolean;
  announcementVisible: boolean;
};

export async function appUpdateRequest(url: string, options?: RequestInit): Promise<AppUpdateStatus> {
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...options?.headers }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `更新服务请求失败（HTTP ${response.status}）`);
  return body as AppUpdateStatus;
}

export function appUpdateTime(value: string | null) {
  if (!value) return "尚未检查";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}
