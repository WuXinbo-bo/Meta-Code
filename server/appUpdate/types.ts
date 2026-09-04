export type AppUpdateChannel = "stable" | "beta";
export type AppUpdateCheckState = "idle" | "checking" | "completed" | "error";
export type AppUpdateSourceState = "unconfigured" | "manifest" | "github" | "error";
export type AppUpdateCheckPhase = "idle" | "resolving" | "connecting" | "verifying" | "completed" | "failed";

export type AppUpdateSourceAttempt = {
  source: "manifest" | "github";
  label: string;
  url: string;
  state: "succeeded" | "failed";
  durationMs: number;
  error: string;
};

export type AppUpdateAsset = {
  platform: string;
  arch: string;
  url: string;
  sha256: string;
  size?: number;
};

export type AppDataCompatibility = {
  readsFrom: { min: number; max: number };
  writesTo: number;
  migratesFrom: { min: number; max: number };
  migrationProtocolVersion: number;
  downgradePolicy: "blocked";
};

export type AppUpdateManifestSignature = {
  algorithm: "Ed25519";
  keyId: string;
  value: string;
};

export type AppUpdateManifest = {
  schemaVersion: 2;
  productId: string;
  productName: string;
  version: string;
  buildId: string;
  channel: AppUpdateChannel;
  publishedAt: string;
  releaseNotes: string;
  releaseUrl: string;
  compatibility: {
    data: AppDataCompatibility;
    launcherProtocol: { min: number; max: number };
  };
  assets: AppUpdateAsset[];
  signature: AppUpdateManifestSignature;
};

export type AppUpdateRelease = {
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
  schemaVersion: 3;
  revision: number;
  preferences: AppUpdatePreferences;
  lastCheckedAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastError: string;
  release: AppUpdateRelease | null;
  checkedByVersion: string;
  checkedByBuildId: string;
  lastSuccessfulSourceState: Exclude<AppUpdateSourceState, "error">;
  lastSuccessfulSourceLabel: string;
};

export type AppUpdateStatus = {
  schemaVersion: 1;
  revision: number;
  product: { id: string; name: string; currentVersion: string; currentBuildId: string };
  capabilities: { check: true; download: false; apply: false; launcher: false };
  source: {
    state: AppUpdateSourceState;
    label: string;
    githubRepository: string;
    manifestConfigured: boolean;
    usingCachedRelease: boolean;
    lastSuccessfulState: Exclude<AppUpdateSourceState, "error">;
    lastSuccessfulLabel: string;
  };
  checkState: AppUpdateCheckState;
  checkPhase: AppUpdateCheckPhase;
  checkStartedAt: string | null;
  sourceAttempts: AppUpdateSourceAttempt[];
  preferences: AppUpdatePreferences;
  lastCheckedAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastError: string;
  release: AppUpdateRelease | null;
  updateAvailable: boolean;
  announcementVisible: boolean;
};

export type AppUpdateConfig = {
  schemaVersion: 2;
  productId: string;
  productName: string;
  currentVersion: string;
  dataSchemaVersion: number;
  dataCompatibility: AppDataCompatibility;
  launcherProtocol: { min: number; max: number };
  currentBuildId: string;
  manifestSigning: { required: true; trustedKeys: Record<string, string> };
  githubRepository: string;
  manifestUrls: Record<AppUpdateChannel, string>;
  defaultChannel: AppUpdateChannel;
  defaultCheckIntervalHours: number;
};
