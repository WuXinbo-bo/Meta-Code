import type { RuntimeUseMode } from "./config.js";

export type CliRuntimeId = string;
export type RuntimeSource = "configured" | "bundled" | "runtime" | "system" | "missing";

export type RuntimeStatus = {
  id: CliRuntimeId;
  available: boolean;
  source: RuntimeSource;
  path: string;
  version: string;
  npmAvailable: boolean;
  networkRequired: boolean;
  message: string;
  managedVersion?: string;
  selectionMode: RuntimeUseMode;
  candidates?: RuntimeCandidate[];
  managed: {
    installed: boolean;
    activeVersion: string;
    installedVersions: string[];
  };
};

export type RuntimeInstallCandidate = {
  runtimeId: CliRuntimeId;
  version: string;
  root: string;
  executable: string;
  previousVersion: string;
};

export type RuntimeInstallOptions = {
  ensureCanActivate?: () => void | Promise<void>;
  certify?: (candidate: RuntimeInstallCandidate) => void | Promise<void>;
};

export type RuntimeExecutionIdentity = {
  schemaVersion: 1;
  runtimeId: CliRuntimeId;
  providerId: string;
  adapterId: string;
  source: RuntimeSource;
  path: string;
  version: string;
  capabilityFingerprint: string;
  capturedAt: string;
};

export type RuntimeCandidate = {
  source: RuntimeSource;
  path: string;
  version: string;
  label: string;
};

export type RuntimeUpdateState = "not-installed" | "latest" | "available" | "newer-local" | "external";

export type RuntimeUpdateStatus = {
  runtimeId: CliRuntimeId;
  mode: RuntimeUseMode;
  currentVersion: string;
  latestVersion: string;
  state: RuntimeUpdateState;
  action: "install" | "update" | "install-managed" | "none";
  selectedRegistry: string;
  probes: RuntimeSourceProbe[];
};

export type RuntimeSourceProbe = {
  registry: string;
  latencyMs: number;
  available: boolean;
  version: string;
  error: string;
};

export type NpmDistribution = {
  kind: "npm";
  packageName: string;
  defaultVersion: string;
};

export type BinaryDistribution = {
  kind: "binary";
  version: string;
  platforms: Record<string, {
    url: string;
    sha256: string;
    executable: string;
    archive?: "zip" | "tar.gz" | "raw";
    args?: string[];
    env?: Record<string, string>;
  }>;
};

export type CliDistribution = NpmDistribution | BinaryDistribution;

export type CliDefinition = {
  id: CliRuntimeId;
  providerId: string;
  adapterId: string;
  label: string;
  displayOrder?: number;
  command: string;
  distribution: CliDistribution;
  executableCandidates(root: string): string[];
  bundledRoots(projectRoot: string): string[];
  systemCandidates(): Promise<string[]>;
  probe(candidate: string): Promise<string>;
  finalizeInstallation?(root: string): Promise<void>;
  validateInstallation?(root: string, executable: string): Promise<void>;
};

export type RuntimeInstallProgress = {
  runtimeId: CliRuntimeId;
  operationId: string;
  sequence: number;
  phase: "started" | "probing" | "downloading" | "installing" | "verifying" | "certifying" | "activated" | "failed" | "interrupted";
  message: string;
  version?: string;
  startedAt: string;
  updatedAt: string;
  active: boolean;
  resumable?: boolean;
  registry?: string;
  artifact?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  sourceProbes?: RuntimeSourceProbe[];
};
