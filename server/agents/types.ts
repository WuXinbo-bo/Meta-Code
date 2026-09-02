export type AgentProviderId = string;
export type AgentAdapterId = string;

export const AGENT_ADAPTER_SDK_VERSION = 1 as const;
export type AgentAdapterSdkVersion = typeof AGENT_ADAPTER_SDK_VERSION;

export type AgentReasoningOption = {
  value: string;
  label: string;
  rank?: number;
};

export type AgentReasoningControl =
  | { type: "enum"; options: AgentReasoningOption[]; defaultValue?: string }
  | { type: "number"; minimum: number; maximum: number; step: number; defaultValue?: number; unit?: string }
  | { type: "boolean"; defaultValue?: boolean; enabledLabel?: string; disabledLabel?: string }
  | { type: "none" };

export type AgentModelDescriptor = {
  id: string;
  displayName: string;
  description?: string;
  createdAt?: string;
  reasoning?: AgentReasoningControl;
  contextWindow?: number;
  capabilities?: Partial<Pick<AgentCapabilities["tools"], "web" | "mcp">>;
};

export type AgentConfigurationField = {
  key: string;
  label: string;
  description?: string;
  type: "text" | "secret" | "boolean" | "select" | "number";
  required?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
};

export type AgentProviderConfigurationSchema = {
  modelSource: "adapter" | "static" | "none";
  defaultModel?: string;
  reasoning: AgentReasoningControl;
  models?: AgentModelDescriptor[];
  fields?: AgentConfigurationField[];
};

export type AgentProviderModelSelection = {
  model: string;
  reasoningValue?: string | number | boolean;
};

export type AgentModelCatalog = {
  models: AgentModelDescriptor[];
  source: "adapter" | "static" | "cache";
  fetchedAt: string;
};

export type AgentCapabilities = {
  sessions: {
    create: boolean;
    resume: boolean;
    fork: boolean;
  };
  execution: {
    stream: boolean;
    cancel: boolean;
    steer: boolean;
  };
  workspace: {
    read: boolean;
    write: boolean;
  };
  tools: {
    shell: boolean;
    web: boolean;
    mcp: boolean;
  };
  delegation: {
    worker: boolean;
    nativeSubagents: boolean;
  };
  workflow: {
    planner: boolean;
    worker: boolean;
  };
  configuration: {
    models: boolean;
    reasoningEffort: boolean;
    reasoningEffortValues: string[];
    permissionProfile: boolean;
  };
};

export type AgentBranding = {
  icon: string;
  accent: string;
};

export type AgentSkillProjection = {
  strategy: "codex-home" | "claude-home" | "prompt" | "none";
  invocationPrefix: string;
  workspacePath?: string;
};

export type AgentDescriptor = {
  id: AgentProviderId;
  adapterId: AgentAdapterId;
  runtimeId: string;
  displayName: string;
  shortName: string;
  description: string;
  displayOrder: number;
  capabilities: AgentCapabilities;
  branding: AgentBranding;
  skillProjection: AgentSkillProjection;
  /** Present for V1 manifests; omitted only by legacy persisted descriptors. */
  sdkVersion?: AgentAdapterSdkVersion;
  configurationSchema?: AgentProviderConfigurationSchema;
};

export type AgentProviderManifestV1 = AgentDescriptor & {
  sdkVersion: AgentAdapterSdkVersion;
  configurationSchema: AgentProviderConfigurationSchema;
};

export type DelegationMode = "analysis" | "review" | "implementation";

export type DelegationRequest = {
  schemaVersion: 3;
  taskId?: string;
  parentTaskId?: string;
  providerId: AgentProviderId;
  cwd?: string;
  prompt?: string;
  acceptance?: string[];
  nickname?: string;
  mode?: DelegationMode;
  depth?: number;
  idempotencyKey?: string;
  capabilityRequirements?: string[];
  adapterOptions?: Record<string, unknown>;
};

export type DelegationAdmissionResult = {
  ok: true;
  accepted: true;
  deduplicated: boolean;
  taskId: string;
  parentTaskId: string;
  status: string;
};

export type DelegationExecutionAdapter = {
  descriptor: AgentDescriptor;
  execute(request: DelegationRequest): Promise<unknown>;
  cancel?(taskId: string): void | Promise<void>;
};

export type AgentModelAdapter = {
  listModels(input?: Record<string, unknown>): Promise<AgentModelCatalog>;
  getSelection(): AgentProviderModelSelection;
  updateSelection(selection: AgentProviderModelSelection): Promise<AgentProviderModelSelection>;
  testConnection?(input?: Record<string, unknown>): Promise<{ ok: true; detail?: Record<string, unknown> }>;
};

/**
 * One provider binding used by built-in and third-party adapters. Optional
 * surfaces are advertised through capabilities and must be bound together.
 */
export type AgentAdapterV1<TMainRunner = never, TWorkflowPlannerRunner = never, TWorkflowWorkerRunner = never> = {
  sdkVersion: AgentAdapterSdkVersion;
  manifest: AgentProviderManifestV1;
  delegation?: Omit<DelegationExecutionAdapter, "descriptor">;
  mainSession?: TMainRunner;
  workflow?: {
    planner?: TWorkflowPlannerRunner;
    worker?: TWorkflowWorkerRunner;
  };
  models?: AgentModelAdapter;
};

export function normalizeProviderId(value: unknown) {
  const id = String(value || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(id)) throw new Error("Agent Provider ID 无效");
  return id;
}

const AGENT_CAPABILITY_ALIASES: Record<string, string> = {
  "session-create": "sessions.create",
  "session-resume": "sessions.resume",
  "session-fork": "sessions.fork",
  stream: "execution.stream",
  cancel: "execution.cancel",
  steer: "execution.steer",
  "workspace-read": "workspace.read",
  "workspace-write": "workspace.write",
  terminal: "tools.shell",
  shell: "tools.shell",
  network: "tools.web",
  web: "tools.web",
  mcp: "tools.mcp",
  "delegation-worker": "delegation.worker",
  "native-subagents": "delegation.nativeSubagents",
  "workflow-planner": "workflow.planner",
  "workflow-worker": "workflow.worker",
  models: "configuration.models",
  reasoning: "configuration.reasoningEffort",
  permissions: "configuration.permissionProfile"
};

export type AgentCapabilityAssessment = {
  normalized: string[];
  unsupported: string[];
  unknown: string[];
};

export function normalizeAgentCapabilityRequirement(value: unknown) {
  const requirement = String(value || "").trim();
  const alias = requirement.toLowerCase().replace(/_/g, "-");
  return AGENT_CAPABILITY_ALIASES[alias] || requirement.toLowerCase();
}

export function assessAgentCapabilities(descriptor: AgentDescriptor, requirements: string[] = []): AgentCapabilityAssessment {
  const source = descriptor.capabilities as unknown as Record<string, unknown>;
  const normalized = [...new Set(requirements.map(normalizeAgentCapabilityRequirement).filter(Boolean))];
  const unsupported: string[] = [];
  const unknown: string[] = [];
  for (const requirement of normalized) {
    const parts = requirement.split(".").filter(Boolean);
    let current: unknown = source;
    for (const part of parts) {
      if (!current || typeof current !== "object" || !(part in current)) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (current === false) unsupported.push(requirement);
    else if (current !== true) unknown.push(requirement);
  }
  return { normalized, unsupported, unknown };
}

export function agentCapabilityError(descriptor: AgentDescriptor, assessment: AgentCapabilityAssessment) {
  const reasons = [
    assessment.unsupported.length ? `未启用：${assessment.unsupported.join("、")}` : "",
    assessment.unknown.length ? `未知能力：${assessment.unknown.join("、")}` : ""
  ].filter(Boolean);
  return reasons.length ? `${descriptor.displayName} 不满足本次委派所需能力（${reasons.join("；")}）` : "";
}

export function hasAgentCapabilities(descriptor: AgentDescriptor, requirements: string[] = []) {
  const assessment = assessAgentCapabilities(descriptor, requirements);
  return assessment.unsupported.length === 0 && assessment.unknown.length === 0;
}

export function normalizeReasoningControl(value: AgentReasoningControl | undefined, legacyValues: string[] = []): AgentReasoningControl {
  if (!value) return legacyValues.length
    ? { type: "enum", options: legacyValues.map((item, rank) => ({ value: item, label: item, rank })) }
    : { type: "none" };
  if (value.type === "enum") {
    const seen = new Set<string>();
    const options = value.options.flatMap((option, rank) => {
      const normalized = String(option.value || "").trim();
      if (!normalized || seen.has(normalized)) return [];
      seen.add(normalized);
      return [{ value: normalized, label: String(option.label || normalized), rank: Number.isFinite(option.rank) ? option.rank : rank }];
    });
    return { type: "enum", options, ...(value.defaultValue && seen.has(value.defaultValue) ? { defaultValue: value.defaultValue } : {}) };
  }
  if (value.type === "number") {
    const minimum = Number.isFinite(value.minimum) ? value.minimum : 0;
    const maximum = Number.isFinite(value.maximum) ? Math.max(minimum, value.maximum) : minimum;
    const step = Number.isFinite(value.step) && value.step > 0 ? value.step : 1;
    return { ...value, minimum, maximum, step };
  }
  return { ...value };
}

export function normalizeAgentProviderManifest(descriptor: AgentDescriptor): AgentProviderManifestV1 {
  const reasoning = normalizeReasoningControl(
    descriptor.configurationSchema?.reasoning,
    descriptor.capabilities.configuration.reasoningEffortValues
  );
  return {
    ...structuredClone(descriptor),
    id: normalizeProviderId(descriptor.id),
    sdkVersion: AGENT_ADAPTER_SDK_VERSION,
    configurationSchema: {
      modelSource: descriptor.configurationSchema?.modelSource || (descriptor.capabilities.configuration.models ? "adapter" : "none"),
      ...(descriptor.configurationSchema?.defaultModel ? { defaultModel: descriptor.configurationSchema.defaultModel } : {}),
      reasoning,
      ...(descriptor.configurationSchema?.models ? { models: structuredClone(descriptor.configurationSchema.models) } : {}),
      ...(descriptor.configurationSchema?.fields ? { fields: structuredClone(descriptor.configurationSchema.fields) } : {})
    }
  };
}

export function assertAgentAdapterV1(adapter: AgentAdapterV1<unknown, unknown, unknown>) {
  if (adapter.sdkVersion !== AGENT_ADAPTER_SDK_VERSION) throw new Error(`不支持的 Agent Adapter SDK 版本：${adapter.sdkVersion}`);
  const manifest = normalizeAgentProviderManifest(adapter.manifest);
  const missing: string[] = [];
  if (manifest.capabilities.sessions.create && !adapter.mainSession) missing.push("mainSession");
  if (manifest.capabilities.delegation.worker && !adapter.delegation) missing.push("delegation");
  if (manifest.capabilities.workflow.planner && !adapter.workflow?.planner) missing.push("workflow.planner");
  if (manifest.capabilities.workflow.worker && !adapter.workflow?.worker) missing.push("workflow.worker");
  if (manifest.capabilities.configuration.models && !adapter.models) missing.push("models");
  if (missing.length) throw new Error(`${manifest.displayName} 声明的能力缺少绑定：${missing.join("、")}`);
  return manifest;
}
