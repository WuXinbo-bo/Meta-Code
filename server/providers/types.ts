import type { AgentCapabilities as AcpAgentCapabilities, InitializeResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentProviderManifestV1 } from "../agents/types.js";

export type ProviderTransportKind = "native" | "acp";

export type AcpLaunchSpec = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  registryId?: string;
  package?: string;
  version?: string;
};

export type ProviderTransportInfo = {
  kind: ProviderTransportKind;
  enhanced: boolean;
  standard: "native" | "acp-v1";
};

export type ProviderHostSnapshot = {
  providerId: string;
  transport: ProviderTransportKind;
  enhanced: boolean;
  acp?: {
    protocolVersion?: number;
    agentInfo?: InitializeResponse["agentInfo"];
    capabilities?: AcpAgentCapabilities;
    launch: Omit<AcpLaunchSpec, "env">;
  };
};

export type ProviderSessionConfiguration = SessionConfigOption;

export type NativeProviderRegistration<TMainRunner, TWorkflowPlannerRunner, TWorkflowWorkerRunner> = {
  manifest: AgentProviderManifestV1;
  mainSession: TMainRunner;
  delegation?: {
    execute(request: import("../agents/types.js").DelegationRequest): Promise<unknown>;
    cancel?(taskId: string): void | Promise<void>;
  };
  workflow?: { planner?: TWorkflowPlannerRunner; worker?: TWorkflowWorkerRunner };
  models?: import("../agents/types.js").AgentModelAdapter;
};

export type AcpProviderRegistration<TMainRunner> = {
  manifest: AgentProviderManifestV1;
  launch: AcpLaunchSpec;
  /** Supplied by the Workbench ACP host, never by the third-party Agent. */
  mainSession: TMainRunner;
  /** Workbench-owned bridge that lets an ACP Agent run as a delegated worker. */
  delegation?: {
    execute(request: import("../agents/types.js").DelegationRequest): Promise<unknown>;
    cancel?(taskId: string): void | Promise<void>;
  };
};
