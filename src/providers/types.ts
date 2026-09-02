import type { AgentProviderDescriptor, AgentReasoningControl } from "../agents/types";
import type { AcpConfigOption } from "../chat/types";

export type ProviderControlStatus = "ready" | "attention" | "unavailable" | "checking";
export type ProviderLifecycleStage = "missing" | "installed" | "needs-connection" | "ready" | "updating";

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
