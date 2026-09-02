export type RuntimeUseMode = "system" | "custom" | "managed";
export type RuntimeProxyMode = "system" | "off" | "custom";
export type RuntimeRegistryMode = "auto" | "official" | "custom";

export type RuntimeSelection = {
  mode: RuntimeUseMode;
  systemPath: string;
  customPath: string;
};

export type RuntimeNetworkConfig = {
  proxyMode: RuntimeProxyMode;
  proxyUrl: string;
  registryMode: RuntimeRegistryMode;
  customRegistry: string;
  inactivityTimeoutSeconds: number;
};

export type RuntimeConfiguration = {
  network: RuntimeNetworkConfig;
  selections: Record<string, RuntimeSelection>;
};

export const DEFAULT_RUNTIME_CONFIGURATION: RuntimeConfiguration = {
  network: {
    proxyMode: "system",
    proxyUrl: "",
    registryMode: "auto",
    customRegistry: "",
    inactivityTimeoutSeconds: 120
  },
  selections: {
    codex: { mode: "system", systemPath: "", customPath: "" },
    claude: { mode: "system", systemPath: "", customPath: "" }
  }
};

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;
const INITIAL_PROXY_ENV = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T) {
  return allowed.includes(value as T) ? value as T : fallback;
}

function normalizedUrl(value: unknown, label: string, allowEmpty = true) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw && allowEmpty) return "";
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`${label}格式无效`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${label}仅支持 HTTP 或 HTTPS`);
  if (!parsed.hostname) throw new Error(`${label}缺少主机名`);
  return parsed.toString().replace(/\/+$/, "");
}

export function normalizeRuntimeConfiguration(input: unknown): RuntimeConfiguration {
  const source = input && typeof input === "object" ? input as Partial<RuntimeConfiguration> : {};
  const network = source.network && typeof source.network === "object" ? source.network as Partial<RuntimeNetworkConfig> : {};
  const selections = source.selections && typeof source.selections === "object" ? source.selections as Record<string, Partial<RuntimeSelection>> : {};
  const proxyMode = oneOf(network.proxyMode, ["system", "off", "custom"] as const, "system");
  const registryMode = oneOf(network.registryMode, ["auto", "official", "custom"] as const, "auto");
  const proxyUrl = normalizedUrl(network.proxyUrl, "代理地址");
  const customRegistry = normalizedUrl(network.customRegistry, "自定义 npm Registry");
  if (proxyMode === "custom" && !proxyUrl) throw new Error("使用自定义代理时必须填写代理地址");
  if (registryMode === "custom" && !customRegistry) throw new Error("使用自定义 Registry 时必须填写地址");
  const rawTimeout = Number(network.inactivityTimeoutSeconds);
  const inactivityTimeoutSeconds = Number.isFinite(rawTimeout) ? Math.min(600, Math.max(30, Math.round(rawTimeout))) : 120;
  const normalizeSelection = (id: string): RuntimeSelection => {
    const selection = selections[id] || {};
    const legacyMode = String(selection.mode || "");
    const mode = legacyMode === "auto" ? "system" : oneOf(selection.mode, ["system", "custom", "managed"] as const, "system");
    const systemPath = String(selection.systemPath || "").trim();
    const customPath = String(selection.customPath || "").trim();
    if (mode === "custom" && !customPath) throw new Error(`${id} 自定义 CLI 路径不能为空`);
    return { mode, systemPath, customPath };
  };
  const runtimeIds = [...new Set([...Object.keys(DEFAULT_RUNTIME_CONFIGURATION.selections), ...Object.keys(selections)])]
    .filter((id) => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id));
  return {
    network: { proxyMode, proxyUrl, registryMode, customRegistry, inactivityTimeoutSeconds },
    selections: Object.fromEntries(runtimeIds.map((id) => [id, normalizeSelection(id)]))
  };
}

export function runtimeChildEnvironment(config: RuntimeNetworkConfig) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_USE_ENV_PROXY: "1" };
  if (config.proxyMode === "off") for (const key of PROXY_ENV_KEYS) delete env[key];
  if (config.proxyMode === "custom") {
    for (const key of PROXY_ENV_KEYS) env[key] = config.proxyUrl;
  }
  return env;
}

export function applyRuntimeNetworkEnvironment(config: RuntimeNetworkConfig) {
  for (const key of PROXY_ENV_KEYS) {
    const value = config.proxyMode === "custom" ? config.proxyUrl : config.proxyMode === "system" ? INITIAL_PROXY_ENV[key] : undefined;
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
  process.env.NODE_USE_ENV_PROXY = "1";
}

export function registryCandidates(config: RuntimeNetworkConfig) {
  const official = "https://registry.npmjs.org";
  const mirror = "https://registry.npmmirror.com";
  const values = config.registryMode === "official"
    ? [official]
    : config.registryMode === "custom"
      ? [config.customRegistry]
      : [config.customRegistry, mirror, official];
  return [...new Set(values.map((item) => item.trim().replace(/\/+$/, "")).filter(Boolean))];
}
