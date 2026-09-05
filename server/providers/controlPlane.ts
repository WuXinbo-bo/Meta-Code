import path from "node:path";
import type { AuthMethod, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentDescriptor, AgentProviderModelSelection } from "../agents/types.js";
import type { RuntimeSource } from "../runtime/types.js";
import type { ProviderAuthMode, ProviderConnectionProfile } from "./connections.js";
import type { ProviderHostSnapshot } from "./types.js";

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
    source: RuntimeSource;
    managed: boolean;
    updating: boolean;
    message: string;
  };
  connection: {
    profileId: string;
    profileName: string;
    profileCount: number;
    authMode: ProviderAuthMode | "native";
    status: ProviderControlStatus;
    lastCheckedAt: string;
    latencyMs: number;
    message: string;
  };
  capabilities: AgentDescriptor["capabilities"];
  operations: ProviderControlOperations;
  configuration: {
    scope: "global" | "profile" | "session";
    modelSource: "adapter" | "static" | "session" | "none";
    model: string;
    reasoningValue?: string | number | boolean;
    reasoning: NonNullable<AgentDescriptor["configurationSchema"]>["reasoning"];
    fields: NonNullable<AgentDescriptor["configurationSchema"]>["fields"];
    sessionOptions: SessionConfigOption[];
  };
  isDefault: boolean;
};

export type ProviderControlSnapshotInput = {
  descriptor: AgentDescriptor;
  transport?: ProviderHostSnapshot;
  runtime: {
    available: boolean;
    source: RuntimeSource;
    version: string;
    message: string;
    managed?: { installed: boolean };
  };
  profiles?: ProviderConnectionProfile[];
  selection?: AgentProviderModelSelection | null;
  defaultProviderId?: string;
  marketIcon?: string;
  updating?: boolean;
  operations?: Partial<ProviderControlOperations>;
};

export type ProviderConfigurationField = {
  env: string;
  label: string;
  kind: "text" | "url" | "boolean" | "secret";
  description?: string;
  placeholder?: string;
  defaultValue?: string;
  authMethodIds?: string[];
};

type ProviderConfigurationDefinition = {
  homeEnv?: string;
  authMethods?: Array<{ id: string; name: string; description: string; type: "agent" | "terminal" }>;
  fields: ProviderConfigurationField[];
};

// Provider-specific facts live in one declarative catalog. The market UI and
// session runtime consume the same generic control-plane contract.
const DEFINITIONS: Record<string, ProviderConfigurationDefinition> = {
  codex: {
    authMethods: [
      { id: "workbench-account", name: "工作台独立账号", description: "使用 Meta Code 独立的 Codex 配置和登录状态，不影响系统 Codex。", type: "agent" },
      { id: "system-account", name: "复用系统账号", description: "读取当前 Windows 用户的 Codex 登录状态，不复制或修改系统账号。", type: "agent" },
      { id: "openai-api-key", name: "OpenAI API", description: "使用 OpenAI API Key 和官方接口。", type: "agent" },
      { id: "openai-compatible", name: "兼容接口", description: "使用自定义 OpenAI Responses 兼容端点。", type: "agent" }
    ],
    fields: [
      { env: "OPENAI_BASE_URL", label: "Base URL", kind: "url", authMethodIds: ["openai-compatible"], placeholder: "https://api.example.com" },
      { env: "OPENAI_API_KEY", label: "API Key", kind: "secret", authMethodIds: ["openai-api-key", "openai-compatible"], placeholder: "sk-..." }
    ]
  },
  claude: {
    authMethods: [
      { id: "workbench-account", name: "工作台独立账号", description: "使用 Meta Code 独立的 Claude 配置和登录状态，不影响系统 Claude。", type: "agent" },
      { id: "system-account", name: "复用系统账号", description: "读取当前 Windows 用户的 Claude 登录状态，不复制或修改系统账号。", type: "agent" },
      { id: "anthropic-api-key", name: "Anthropic API", description: "使用 Anthropic API Key 和官方接口。", type: "agent" },
      { id: "anthropic-compatible", name: "兼容接口", description: "使用自定义 Anthropic Messages 兼容端点。", type: "agent" }
    ],
    fields: [
      { env: "ANTHROPIC_BASE_URL", label: "Base URL", kind: "url", authMethodIds: ["anthropic-compatible"], placeholder: "https://api.example.com" },
      { env: "ANTHROPIC_API_KEY", label: "API Key", kind: "secret", authMethodIds: ["anthropic-api-key", "anthropic-compatible"], placeholder: "sk-ant-..." }
    ]
  },
  gemini: {
    homeEnv: "GEMINI_CLI_HOME",
    fields: [
      { env: "GEMINI_API_KEY", label: "Gemini API Key", kind: "secret", authMethodIds: ["gemini-api-key"], placeholder: "Google AI Studio API Key" },
      { env: "GOOGLE_API_KEY", label: "Google API Key", kind: "secret", authMethodIds: ["vertex-ai"] },
      { env: "GOOGLE_CLOUD_PROJECT", label: "Google Cloud 项目", kind: "text", authMethodIds: ["oauth-personal", "vertex-ai"], placeholder: "project-id" },
      { env: "GOOGLE_GENAI_USE_VERTEXAI", label: "启用 Vertex AI", kind: "boolean", defaultValue: "true", authMethodIds: ["vertex-ai"] },
      { env: "GOOGLE_GEMINI_BASE_URL", label: "API 网关地址", kind: "url", authMethodIds: ["gateway", "gemini-api-key"], placeholder: "https://gateway.example.com" },
      { env: "GEMINI_MODEL", label: "默认模型", kind: "text", placeholder: "由 Agent 自动选择" }
    ]
  }
};

export function providerConfiguration(providerId: string, authMethods: AuthMethod[] = []) {
  const definition = DEFINITIONS[providerId] || { fields: [] };
  return {
    providerId,
    authMethods: authMethods.length ? authMethods.map((method) => ({
      id: method.id,
      name: method.name,
      description: method.description || "",
      type: "type" in method && method.type === "terminal" ? "terminal" as const : "agent" as const
    })) : structuredClone(definition.authMethods || []),
    fields: definition.fields
  };
}

export function providerActiveEnvironment(providerId: string, authMethodId: string | undefined, environment: Record<string, string>) {
  const fields = DEFINITIONS[providerId]?.fields || [];
  if (!fields.length || !authMethodId) return { ...environment };
  const inactive = new Set(fields
    .filter((field) => field.authMethodIds?.length && !field.authMethodIds.includes(authMethodId))
    .map((field) => field.env));
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !inactive.has(key)));
}

export function providerManagedEnvironment(providerId: string, authMode: ProviderAuthMode | undefined, root: string) {
  const homeEnv = DEFINITIONS[providerId]?.homeEnv;
  if (!homeEnv || authMode === "system-profile") return {};
  return { [homeEnv]: path.join(root, providerId) };
}

export function createProviderControlSnapshot(input: ProviderControlSnapshotInput): ProviderControlSnapshot {
  const { descriptor, runtime } = input;
  const profiles = [...(input.profiles || [])].sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
  const profile = profiles[0];
  const transport = input.transport?.transport || "native";
  const capabilities = effectiveProviderCapabilities(descriptor.capabilities, input.transport);
  let status: ProviderControlStatus = "unavailable";
  let connectionMessage = runtime.message || "CLI 不可用";

  if (runtime.available && transport === "native" && !profile) {
    status = "attention";
    connectionMessage = "CLI 已安装，请配置账号或 API 并测试连接";
  } else if (runtime.available && transport === "native" && profile?.healthStatus === "ready") {
    status = "ready";
    connectionMessage = profile.healthMessage || "账号与连接已验证";
  } else if (runtime.available && transport === "native" && profile?.healthStatus === "checking") {
    status = "checking";
    connectionMessage = profile.healthMessage || "正在验证账号与连接";
  } else if (runtime.available && transport === "native") {
    status = "attention";
    connectionMessage = profile?.healthMessage || "连接方案尚未验证";
  } else if (runtime.available && !profile) {
    status = "attention";
    connectionMessage = "CLI 可用，尚未配置连接方案";
  } else if (runtime.available && profile?.healthStatus === "checking") {
    status = "checking";
    connectionMessage = profile.healthMessage || "正在验证连接";
  } else if (runtime.available && profile?.healthStatus === "ready") {
    status = "ready";
    connectionMessage = profile.healthMessage || "连接已验证";
  } else if (runtime.available) {
    status = "attention";
    connectionMessage = profile?.healthMessage || "连接方案尚未验证";
  }

  const schema = descriptor.configurationSchema;
  const modelSource = transport === "acp" && schema?.modelSource === "none"
    ? "session"
    : schema?.modelSource || "none";
  return {
    schemaVersion: 1,
    providerId: descriptor.id,
    identity: {
      displayName: descriptor.displayName,
      shortName: descriptor.shortName,
      description: descriptor.description,
      icon: input.marketIcon || descriptor.branding.icon,
      accent: descriptor.branding.accent,
      transport,
      enhanced: Boolean(input.transport?.enhanced)
    },
    lifecycle: {
      stage: input.updating
        ? "updating"
        : !runtime.available
          ? runtime.managed?.installed ? "installed" : "missing"
          : status === "ready"
            ? "ready"
            : "needs-connection",
      installed: runtime.available || Boolean(runtime.managed?.installed),
      runtimeAvailable: runtime.available,
      version: runtime.version || "",
      source: runtime.source,
      managed: Boolean(runtime.managed?.installed),
      updating: Boolean(input.updating),
      message: runtime.message || ""
    },
    connection: {
      profileId: profile?.id || "",
      profileName: profile?.name || (transport === "native" ? "兼容配置" : ""),
      profileCount: profiles.length,
      authMode: profile?.authMode || (transport === "native" ? "native" : "native-account"),
      status: input.updating ? "checking" : status,
      lastCheckedAt: profile?.healthCheckedAt || "",
      latencyMs: profile?.healthLatencyMs || 0,
      message: input.updating ? "正在安装或更新 CLI" : connectionMessage
    },
    capabilities,
    operations: {
      setDefault: Boolean(input.operations?.setDefault) && capabilities.sessions.create && status === "ready" && !input.updating,
      testConnection: Boolean(input.operations?.testConnection),
      discoverModels: Boolean(input.operations?.discoverModels),
      selectModel: Boolean(input.operations?.selectModel),
      authenticate: Boolean(input.operations?.authenticate),
      manageProfiles: Boolean(input.operations?.manageProfiles),
      dynamicSessionConfig: Boolean(input.operations?.dynamicSessionConfig)
    },
    configuration: {
      scope: transport === "acp" ? "profile" : "global",
      modelSource,
      model: input.selection?.model || schema?.defaultModel || "",
      ...(input.selection?.reasoningValue !== undefined ? { reasoningValue: input.selection.reasoningValue } : {}),
      reasoning: structuredClone(schema?.reasoning || { type: "none" }),
      fields: structuredClone(schema?.fields || []),
      sessionOptions: structuredClone(profile?.configOptions || [])
    },
    isDefault: descriptor.id === input.defaultProviderId
  };
}

function effectiveProviderCapabilities(capabilities: AgentDescriptor["capabilities"], transport: ProviderHostSnapshot | undefined) {
  const effective = structuredClone(capabilities);
  if (transport?.transport !== "acp" || !transport.acp?.capabilities) return effective;
  const handshake = transport.acp.capabilities as unknown as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(handshake, "mainAgentSupport")) {
    effective.sessions.create = handshake.mainAgentSupport !== false;
  }
  const sessionCapabilities = handshake.sessionCapabilities && typeof handshake.sessionCapabilities === "object"
    ? handshake.sessionCapabilities as Record<string, unknown>
    : null;
  if (sessionCapabilities) effective.sessions.resume = Boolean(sessionCapabilities.resume);
  else if (Object.prototype.hasOwnProperty.call(handshake, "loadSession")) effective.sessions.resume = handshake.loadSession === true;
  return effective;
}
