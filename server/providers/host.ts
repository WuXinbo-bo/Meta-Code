import { AGENT_ADAPTER_SDK_VERSION } from "../agents/types.js";
import { AgentAdapterRegistry } from "../agents/registry.js";
import type { AcpProviderRegistration, NativeProviderRegistration, ProviderHostSnapshot } from "./types.js";
import type { InitializeResponse } from "@agentclientprotocol/sdk";

/**
 * Internal provider boundary. Third-party providers enter through ACP; only
 * built-in enhanced providers bind Workbench-native execution extensions.
 */
export class ProviderHostRegistry<TMainRunner = never, TWorkflowPlannerRunner = never, TWorkflowWorkerRunner = never>
  extends AgentAdapterRegistry<TMainRunner, TWorkflowPlannerRunner, TWorkflowWorkerRunner> {
  private readonly transports = new Map<string, ProviderHostSnapshot>();

  registerNativeProvider(registration: NativeProviderRegistration<TMainRunner, TWorkflowPlannerRunner, TWorkflowWorkerRunner>) {
    this.registerV1Adapter({
      sdkVersion: AGENT_ADAPTER_SDK_VERSION,
      manifest: registration.manifest,
      mainSession: registration.mainSession,
      delegation: registration.delegation,
      workflow: registration.workflow,
      models: registration.models
    });
    this.transports.set(registration.manifest.id, {
      providerId: registration.manifest.id,
      transport: "native",
      enhanced: true
    });
    return this;
  }

  registerAcpProvider(registration: AcpProviderRegistration<TMainRunner>) {
    this.registerV1Adapter({
      sdkVersion: AGENT_ADAPTER_SDK_VERSION,
      manifest: registration.manifest,
      mainSession: registration.mainSession,
      delegation: registration.delegation
    });
    this.transports.set(registration.manifest.id, {
      providerId: registration.manifest.id,
      transport: "acp",
      enhanced: false,
      acp: { launch: withoutEnvironment(registration.launch) }
    });
    return this;
  }

  providerSnapshot(providerId: string): ProviderHostSnapshot | undefined {
    const value = this.transports.get(providerId);
    return value ? structuredClone(value) : undefined;
  }

  updateAcpHandshake(providerId: string, response: InitializeResponse) {
    const current = this.transports.get(providerId);
    if (!current || current.transport !== "acp" || !current.acp) throw new Error(`ACP Provider 未注册：${providerId}`);
    this.transports.set(providerId, {
      ...current,
      acp: {
        ...current.acp,
        protocolVersion: response.protocolVersion,
        ...(response.agentInfo ? { agentInfo: response.agentInfo } : {}),
        ...(response.agentCapabilities ? { capabilities: response.agentCapabilities } : {})
      }
    });
    return this.providerSnapshot(providerId)!;
  }

  providerSnapshots() {
    return this.list().flatMap((provider) => {
      const snapshot = this.providerSnapshot(provider.id);
      return snapshot ? [snapshot] : [];
    });
  }
}

function withoutEnvironment(launch: import("./types.js").AcpLaunchSpec) {
  const { env: _env, ...publicLaunch } = launch;
  return publicLaunch;
}
