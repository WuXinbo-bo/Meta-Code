import crypto from "node:crypto";
import type { AgentCapabilities as AcpAgentCapabilities, SessionConfigOption } from "@agentclientprotocol/sdk";

export type ProviderAuthMode = "native-account" | "official-api" | "custom-endpoint" | "system-profile";
export type ProviderConnectionHealthStatus = "unknown" | "checking" | "ready" | "failed";

export type ProviderConnectionProfile = {
  id: string;
  ownerUserId: string;
  providerId: string;
  name: string;
  authMode: ProviderAuthMode;
  authMethodId: string;
  baseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  baseUrlEnv: string;
  env: Record<string, string>;
  secretEnv: Record<string, string>;
  isDefault: boolean;
  healthStatus: ProviderConnectionHealthStatus;
  healthCheckedAt: string;
  healthLatencyMs: number;
  healthMessage: string;
  configOptions: SessionConfigOption[];
  configValues: Record<string, string | boolean>;
  negotiatedCapabilities: AcpAgentCapabilities | null;
  negotiatedRuntimeVersion: string;
  negotiatedAt: string;
  createdAt: string;
  updatedAt: string;
};

const AUTH_MODES = new Set<ProviderAuthMode>(["native-account", "official-api", "custom-endpoint", "system-profile"]);
const RESERVED_ENV = new Set(["PATH", "PATHEXT", "COMSPEC", "HOME", "USERPROFILE", "NODE_OPTIONS", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]);

function providerId(value: unknown) {
  const id = String(value || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(id)) throw new Error("Provider ID 无效");
  return id;
}

function envName(value: unknown, label: string, allowEmpty = true) {
  const name = String(value || "").trim();
  if (!name && allowEmpty) return "";
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/i.test(name) || RESERVED_ENV.has(name.toUpperCase()) || name.toUpperCase().startsWith("WORKBENCH_")) throw new Error(`${label}无效`);
  return name;
}

function publicEnv(input: unknown) {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [envName(key, "环境变量名称", false), String(value || "").slice(0, 4_096)]));
}

function secretEnv(input: unknown) {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [envName(key, "密钥变量名称", false), String(value || "").slice(0, 16_384)]));
}

function optionValues(option: SessionConfigOption) {
  if (option.type !== "select") return [];
  return option.options.flatMap((item) => "options" in item ? item.options.map((nested) => nested.value) : [item.value]);
}

function providerConfigValues(input: unknown, options: SessionConfigOption[]) {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const output: Record<string, string | boolean> = {};
  for (const option of options) {
    const value = source[option.id];
    if (option.type === "boolean" && typeof value === "boolean") output[option.id] = value;
    if (option.type === "select" && typeof value === "string" && optionValues(option).includes(value)) output[option.id] = value;
  }
  return output;
}

function negotiatedCapabilities(input: unknown, fallback: AcpAgentCapabilities | null = null) {
  if (input === undefined) return fallback ? structuredClone(fallback) : null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const serialized = JSON.stringify(input);
  if (serialized.length > 64 * 1024) throw new Error("ACP 能力快照过大");
  return JSON.parse(serialized) as AcpAgentCapabilities;
}

export function normalizeProviderConnection(input: Partial<ProviderConnectionProfile>, ownerUserId: string, existing?: ProviderConnectionProfile, options: { trustPersistedHealth?: boolean } = {}): ProviderConnectionProfile {
  const now = new Date().toISOString();
  const authMode = AUTH_MODES.has(input.authMode as ProviderAuthMode) ? input.authMode as ProviderAuthMode : existing?.authMode || "native-account";
  let baseUrl = String(input.baseUrl ?? existing?.baseUrl ?? "").trim().replace(/\/+$/, "");
  const configOptions = structuredClone(Array.isArray(input.configOptions) ? input.configOptions : existing?.configOptions || []);
  if (baseUrl) {
    const parsed = new URL(baseUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("Base URL 仅支持 HTTP 或 HTTPS");
    baseUrl = parsed.toString().replace(/\/+$/, "");
  }
  const normalized = {
    id: existing?.id || String(input.id || `provider-profile-${crypto.randomUUID()}`),
    ownerUserId,
    providerId: providerId(input.providerId || existing?.providerId),
    name: String(input.name ?? existing?.name ?? "默认连接").trim().slice(0, 60) || "默认连接",
    authMode,
    authMethodId: String(input.authMethodId ?? existing?.authMethodId ?? "").trim().slice(0, 120),
    baseUrl,
    apiKey: String(input.apiKey ?? existing?.apiKey ?? ""),
    apiKeyEnv: envName(input.apiKeyEnv ?? existing?.apiKeyEnv ?? "", "API Key 环境变量"),
    baseUrlEnv: envName(input.baseUrlEnv ?? existing?.baseUrlEnv ?? "", "Base URL 环境变量"),
    env: publicEnv(input.env ?? existing?.env),
    secretEnv: secretEnv(input.secretEnv ?? existing?.secretEnv),
    isDefault: input.isDefault ?? existing?.isDefault ?? false,
    healthStatus: "unknown" as ProviderConnectionHealthStatus,
    healthCheckedAt: "",
    healthLatencyMs: 0,
    healthMessage: "",
    configOptions,
    configValues: providerConfigValues(input.configValues ?? existing?.configValues, configOptions),
    negotiatedCapabilities: negotiatedCapabilities(input.negotiatedCapabilities, existing?.negotiatedCapabilities || null),
    negotiatedRuntimeVersion: String(input.negotiatedRuntimeVersion ?? existing?.negotiatedRuntimeVersion ?? "").slice(0, 120),
    negotiatedAt: String(input.negotiatedAt ?? existing?.negotiatedAt ?? "").slice(0, 40),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  const connectionMaterial = (profile: Pick<ProviderConnectionProfile, "authMode" | "authMethodId" | "baseUrl" | "apiKey" | "apiKeyEnv" | "baseUrlEnv" | "env" | "secretEnv">) => JSON.stringify([
    profile.authMode, profile.authMethodId, profile.baseUrl, profile.apiKey, profile.apiKeyEnv, profile.baseUrlEnv, profile.env, profile.secretEnv
  ]);
  const preserveHealth = existing && connectionMaterial(existing) === connectionMaterial(normalized);
  const trustedHealth = options.trustPersistedHealth && (input.healthStatus === "ready" || input.healthStatus === "failed");
  if (preserveHealth || trustedHealth) {
    normalized.healthStatus = trustedHealth ? input.healthStatus as ProviderConnectionHealthStatus : existing!.healthStatus;
    normalized.healthCheckedAt = String((trustedHealth ? input.healthCheckedAt : existing!.healthCheckedAt) || "");
    normalized.healthLatencyMs = Math.max(0, Number((trustedHealth ? input.healthLatencyMs : existing!.healthLatencyMs) || 0));
    normalized.healthMessage = String((trustedHealth ? input.healthMessage : existing!.healthMessage) || "").slice(0, 1_000);
  }
  return normalized;
}

export function providerConnectionEnvironment(profile: ProviderConnectionProfile | undefined) {
  if (!profile) return {};
  const env = { ...profile.env, ...profile.secretEnv };
  if (profile.baseUrl && profile.baseUrlEnv) env[profile.baseUrlEnv] = profile.baseUrl;
  if (profile.apiKey && profile.apiKeyEnv) env[profile.apiKeyEnv] = profile.apiKey;
  return env;
}

export function providerConnectionConfigValues(
  profile: Pick<ProviderConnectionProfile, "configValues"> | undefined,
  overrides?: Record<string, unknown>
) {
  const explicit = Object.fromEntries(Object.entries(overrides || {}).filter((entry): entry is [string, string | boolean] =>
    typeof entry[1] === "string" || typeof entry[1] === "boolean"
  ));
  return { ...(profile?.configValues || {}), ...explicit };
}

export function publicProviderConnection(profile: ProviderConnectionProfile) {
  const { apiKey, secretEnv: secrets, ...publicProfile } = profile;
  return { ...publicProfile, secretEnvConfigured: Object.keys(secrets).filter((key) => Boolean(secrets[key])), apiKeyConfigured: Boolean(apiKey) };
}
