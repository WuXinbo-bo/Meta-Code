import type { AgentProviderDescriptor, AgentReasoningControl } from "../agents/types";
import type { AcpConfigOption } from "../chat/types";

export type ProviderControlStatus = "ready" | "attention" | "unavailable" | "checking";
export type ProviderLifecycleStage = "missing" | "installed" | "needs-connection" | "ready" | "updating";

/** Capability state returned by the provider negotiation endpoint.  The
 * frontend keeps this shape intentionally provider-neutral so new adapters
 * can advertise the same status without adding Provider-specific UI branches.
 */
export type ProviderCapabilityMode = "native" | "managed" | "degraded";
export type ProviderCapabilityRestriction = {
  capability?: string;
  reason?: string;
  scope?: string;
} | string;
export type ProviderCapabilityModeState = {
  available?: boolean;
  restrictions?: ProviderCapabilityRestriction[];
  reasons?: string[];
};
export type ProviderCapabilitySnapshot = {
  schemaVersion?: number;
  providerId: string;
  mode?: ProviderCapabilityMode;
  requestedMode?: ProviderCapabilityMode;
  nativeCapabilities?: AgentProviderDescriptor["capabilities"];
  workbenchCapabilities?: AgentProviderDescriptor["capabilities"];
  effectiveCapabilities?: AgentProviderDescriptor["capabilities"];
  transportCapabilities?: Record<string, unknown>;
  versionRequirements?: Record<string, unknown>;
  runtimeProbe?: {
    available?: boolean;
    status?: string;
    version?: string;
    source?: string;
    message?: string;
    error?: string;
    checkedAt?: string;
  };
  restrictions?: ProviderCapabilityRestriction[];
  degradedReasons?: string[];
  modes?: Partial<Record<ProviderCapabilityMode, ProviderCapabilityModeState>>;
  capturedAt?: string;
  featureDiagnostics?: Array<{ id: string; label: string; status: "unverified" | "disabled" | "unavailable"; message: string; action: string }>;
};

export type ProviderControlOperations = {
  setDefault: boolean;
  testConnection: boolean;
  discoverModels: boolean;
  selectModel: boolean;
  authenticate: boolean;
  manageProfiles: boolean;
  dynamicSessionConfig: boolean;
};

export type ProviderControlSnapshot = {
  schemaVersion: 1;
  providerId: string;
  identity: {
    displayName: string;
    shortName: string;
    description: string;
    icon: string;
    accent: string;
    transport: "native" | "acp";
    enhanced: boolean;
  };
  lifecycle: {
    stage: ProviderLifecycleStage;
    installed: boolean;
    runtimeAvailable: boolean;
    version: string;
    source: "configured" | "bundled" | "runtime" | "system" | "missing";
    managed: boolean;
    updating: boolean;
    message: string;
  };
  connection: {
    profileId: string;
    profileName: string;
    profileCount: number;
    authMode: "native-account" | "official-api" | "custom-endpoint" | "system-profile" | "native";
    status: ProviderControlStatus;
    lastCheckedAt: string;
    latencyMs: number;
    message: string;
  };
  capabilities: AgentProviderDescriptor["capabilities"];
  operations: ProviderControlOperations;
  configuration: {
    scope: "global" | "profile" | "session";
    modelSource: "adapter" | "static" | "session" | "none";
    model: string;
    reasoningValue?: string | number | boolean;
    reasoning: AgentReasoningControl;
    fields: NonNullable<NonNullable<AgentProviderDescriptor["configurationSchema"]>["fields"]>;
    sessionOptions: AcpConfigOption[];
  };
  isDefault: boolean;
};
