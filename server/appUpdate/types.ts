export type AppUpdateChannel = "stable" | "beta";
export type AppUpdateCheckState = "idle" | "checking" | "completed" | "error";
export type AppUpdateSourceState = "unconfigured" | "manifest" | "github" | "error";

export type AppUpdateAsset = {
  platform: string;
  arch: string;
  url: string;
  sha256: string;
  size?: number;
  signature?: string;
};

export type AppUpdateManifest = {
  schemaVersion: 1;
  productId: string;
  productName: string;
  version: string;
  channel: AppUpdateChannel;
  publishedAt: string;
  releaseNotes: string;
  releaseUrl: string;
  compatibility: {
    minDataSchemaVersion: number;
    maxDataSchemaVersion: number;
    launcherProtocolVersion: number;
  };
  assets: AppUpdateAsset[];
};

export type AppUpdateRelease = {
  version: string;
  channel: AppUpdateChannel;
  publishedAt: string;
  releaseNotes: string;
  releaseUrl: string;
  source: "manifest" | "github";
  compatible: boolean;
  installable: boolean;
  incompatibilityReason: string;
  assets: AppUpdateAsset[];
  compatibility?: AppUpdateManifest["compatibility"];
};

export type AppUpdatePreferences = {
  autoCheck: boolean;
  channel: AppUpdateChannel;
  skippedVersion: string;
  remindAfter: string | null;
};

export type AppUpdatePersistedState = {
  schemaVersion: 2;
  revision: number;
  preferences: AppUpdatePreferences;
  lastCheckedAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastError: string;
  release: AppUpdateRelease | null;
  checkedByVersion: string;
};

export type AppUpdateStatus = {
  schemaVersion: 1;
  revision: number;
  product: { id: string; name: string; currentVersion: string };
  capabilities: { check: true; download: false; apply: false; launcher: false };
  source: {
    state: AppUpdateSourceState;
    label: string;
    githubRepository: string;
    manifestConfigured: boolean;
  };
  checkState: AppUpdateCheckState;
  preferences: AppUpdatePreferences;
  lastCheckedAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastError: string;
  release: AppUpdateRelease | null;
  updateAvailable: boolean;
  announcementVisible: boolean;
};

export type AppUpdateConfig = {
  schemaVersion: 1;
  productId: string;
  productName: string;
  currentVersion: string;
  dataSchemaVersion: number;
  launcherProtocolVersion: number;
  githubRepository: string;
  manifestUrls: Record<AppUpdateChannel, string>;
  defaultChannel: AppUpdateChannel;
  defaultCheckIntervalHours: number;
};
