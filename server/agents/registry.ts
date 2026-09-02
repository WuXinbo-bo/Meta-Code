import {
  agentCapabilityError,
  assessAgentCapabilities,
  assertAgentAdapterV1,
  hasAgentCapabilities,
  normalizeAgentProviderManifest,
  normalizeProviderId,
  type AgentAdapterV1,
  type AgentDescriptor,
  type AgentModelAdapter,
  type AgentProviderId,
  type DelegationExecutionAdapter,
  type DelegationRequest
} from "./types.js";

export class AgentAdapterRegistry<TMainRunner = never, TWorkflowPlannerRunner = never, TWorkflowWorkerRunner = never> {
  private readonly descriptors = new Map<AgentProviderId, AgentDescriptor>();
  private readonly adapters = new Map<AgentProviderId, DelegationExecutionAdapter>();
  private readonly v1Adapters = new Map<AgentProviderId, AgentAdapterV1<TMainRunner, TWorkflowPlannerRunner, TWorkflowWorkerRunner>>();

  constructor(descriptors: AgentDescriptor[] = []) {
    for (const descriptor of descriptors) this.registerDescriptor(descriptor);
  }

  registerDescriptor(descriptor: AgentDescriptor) {
    const id = normalizeProviderId(descriptor.id);
    if (this.descriptors.has(id)) throw new Error(`Agent Provider 已注册：${id}`);
    this.descriptors.set(id, normalizeAgentProviderManifest({ ...descriptor, id }));
    return this;
  }

  registerAdapter(adapter: DelegationExecutionAdapter) {
    const id = normalizeProviderId(adapter.descriptor.id);
    const descriptor = this.descriptors.get(id);
    if (!descriptor) this.registerDescriptor(adapter.descriptor);
    else if (descriptor.adapterId !== adapter.descriptor.adapterId) throw new Error(`Agent Adapter 与 Provider 描述不匹配：${id}`);
    this.adapters.set(id, adapter);
    return this;
  }

  registerV1Adapter(adapter: AgentAdapterV1<TMainRunner, TWorkflowPlannerRunner, TWorkflowWorkerRunner>) {
    const manifest = assertAgentAdapterV1(adapter as AgentAdapterV1<unknown, unknown, unknown>);
    const id = normalizeProviderId(manifest.id);
    const descriptor = this.descriptors.get(id);
    if (!descriptor) this.registerDescriptor(manifest);
    else if (descriptor.adapterId !== manifest.adapterId) throw new Error(`Agent Adapter 与 Provider 描述不匹配：${id}`);
    if (this.v1Adapters.has(id)) throw new Error(`Agent Adapter V1 已注册：${id}`);
    const normalized = { ...adapter, manifest } as AgentAdapterV1<TMainRunner, TWorkflowPlannerRunner, TWorkflowWorkerRunner>;
    this.v1Adapters.set(id, normalized);
    if (adapter.delegation) this.adapters.set(id, { descriptor: manifest, ...adapter.delegation });
    return this;
  }

  list() {
    return [...this.descriptors.values()]
      .map((descriptor) => structuredClone(descriptor))
      .sort((left, right) => left.displayOrder - right.displayOrder || left.displayName.localeCompare(right.displayName));
  }

  descriptor(providerId: string) {
    return this.descriptors.get(normalizeProviderId(providerId));
  }

  requireDescriptor(providerId: string) {
    const descriptor = this.descriptor(providerId);
    if (!descriptor) throw new Error(`未注册的 Agent Provider：${providerId}`);
    return descriptor;
  }

  supports(providerId: string, requirements: string[] = []) {
    const descriptor = this.descriptor(providerId);
    return Boolean(descriptor && hasAgentCapabilities(descriptor, requirements));
  }

  requireCapabilities(providerId: string, requirements: string[] = []) {
    const descriptor = this.requireDescriptor(providerId);
    const assessment = assessAgentCapabilities(descriptor, requirements);
    const error = agentCapabilityError(descriptor, assessment);
    if (error) throw new Error(error);
    return assessment.normalized;
  }

  adapter(providerId: string) {
    return this.v1Adapters.get(normalizeProviderId(providerId));
  }

  mainRunner(providerId: string): TMainRunner | undefined {
    return this.adapter(providerId)?.mainSession;
  }

  workflowPlannerRunner(providerId: string): TWorkflowPlannerRunner | undefined {
    return this.adapter(providerId)?.workflow?.planner;
  }

  workflowWorkerRunner(providerId: string): TWorkflowWorkerRunner | undefined {
    return this.adapter(providerId)?.workflow?.worker;
  }

  modelAdapter(providerId: string): AgentModelAdapter | undefined {
    return this.adapter(providerId)?.models;
  }

  registeredCapabilities(providerId: string) {
    const adapter = this.adapter(providerId);
    return {
      mainSession: Boolean(adapter?.mainSession),
      delegation: Boolean(adapter?.delegation),
      workflowPlanner: Boolean(adapter?.workflow?.planner),
      workflowWorker: Boolean(adapter?.workflow?.worker),
      models: Boolean(adapter?.models)
    };
  }

  async execute(request: DelegationRequest) {
    const providerId = normalizeProviderId(request.providerId);
    const descriptor = this.requireDescriptor(providerId);
    if (!descriptor.capabilities.delegation.worker) throw new Error(`${descriptor.displayName} 不支持工作台委派`);
    const capabilityRequirements = this.requireCapabilities(providerId, request.capabilityRequirements);
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error(`${descriptor.displayName} 尚未绑定执行 Adapter`);
    return adapter.execute({ ...request, providerId, capabilityRequirements });
  }

  async cancel(providerId: string, taskId: string) {
    const adapter = this.adapters.get(normalizeProviderId(providerId));
    await adapter?.cancel?.(taskId);
  }
}
