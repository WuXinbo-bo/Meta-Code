import type { Dispatcher } from "undici";
import { Agent, EnvHttpProxyAgent, ProxyAgent, request } from "undici";
import type { RuntimeNetworkConfig } from "./config.js";
import { registryCandidates } from "./config.js";
import type { RuntimeSourceProbe } from "./types.js";

type NpmDist = { tarball?: string; integrity?: string; shasum?: string };
type NpmVersion = { name?: string; version?: string; dist?: NpmDist; optionalDependencies?: Record<string, string>; dependencies?: Record<string, string> };

function packagePath(packageName: string) {
  return encodeURIComponent(packageName);
}

export function networkDispatcher(config: RuntimeNetworkConfig): Dispatcher {
  if (config.proxyMode === "custom") return new ProxyAgent(config.proxyUrl);
  if (config.proxyMode === "system") return new EnvHttpProxyAgent();
  return new Agent();
}

async function readJson<T>(url: string, config: RuntimeNetworkConfig, timeoutMs = 20_000) {
  const dispatcher = networkDispatcher(config);
  try {
    const response = await request(url, { dispatcher, headersTimeout: timeoutMs, bodyTimeout: timeoutMs, headers: { accept: "application/json" } });
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`HTTP ${response.statusCode}`);
    return await response.body.json() as T;
  } finally {
    await dispatcher.close();
  }
}

export async function probeRuntimeSources(packageName: string, requestedVersion: string, config: RuntimeNetworkConfig, registries = registryCandidates(config)) {
  const probes = await Promise.all(registries.map(async (registry): Promise<RuntimeSourceProbe & { manifest?: NpmVersion }> => {
    const started = performance.now();
    try {
      const manifest = await readJson<NpmVersion>(`${registry}/${packagePath(packageName)}/${encodeURIComponent(requestedVersion)}`, config, 15_000);
      const resolvedVersion = String(manifest.version || "");
      const available = Boolean(resolvedVersion && manifest.dist?.tarball);
      return { registry, latencyMs: Math.round(performance.now() - started), available, version: resolvedVersion, error: available ? "" : `未找到 ${requestedVersion}`, manifest };
    } catch (error) {
      return { registry, latencyMs: Math.round(performance.now() - started), available: false, version: "", error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const official = probes.find((item) => item.registry === "https://registry.npmjs.org" && item.available);
  const targetVersion = requestedVersion === "latest"
    ? official?.version || probes.filter((item) => item.available).sort((a, b) => a.latencyMs - b.latencyMs)[0]?.version || ""
    : requestedVersion;
  const compatible = probes.filter((item) => item.available && item.version === targetVersion && item.manifest?.dist?.tarball);
  const selected = compatible.sort((a, b) => a.latencyMs - b.latencyMs)[0];
  if (!selected || !targetVersion) throw new Error(`没有下载源提供 ${packageName}@${requestedVersion}`);
  return {
    selected: selected.registry,
    version: targetVersion,
    probes: probes.map(({ manifest: _manifest, ...probe }) => probe),
    manifest: selected.manifest!
  };
}

function platformSuffix() {
  if (process.platform === "win32") return `win32-${process.arch}`;
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  return `linux-${process.arch}`;
}

export type ResolvedNpmArtifact = { packageName: string; installName: string; version: string; url: string; integrity: string };

function parseOptionalSpec(installName: string, spec: string) {
  if (!spec.startsWith("npm:")) return { packageName: installName, version: spec };
  const alias = spec.slice(4);
  const splitAt = alias.lastIndexOf("@");
  if (splitAt <= 0) throw new Error(`${installName} 的 npm 别名格式无效`);
  return { packageName: alias.slice(0, splitAt), version: alias.slice(splitAt + 1) };
}

export async function resolveNpmArtifacts(packageName: string, requestedVersion: string, config: RuntimeNetworkConfig, registryOverrides?: string[]) {
  const source = await probeRuntimeSources(packageName, requestedVersion, config, registryOverrides);
  const registries = [source.selected, ...source.probes.filter((probe) => probe.available).map((probe) => probe.registry)].filter((item, index, values) => values.indexOf(item) === index);
  let lastError: unknown;
  for (const registry of registries) {
    try {
      const rootManifest = registry === source.selected
        ? source.manifest
        : await readJson<NpmVersion>(`${registry}/${packagePath(packageName)}/${encodeURIComponent(source.version)}`, config, 15_000);
      const rootDist = rootManifest.dist;
      if (!rootDist?.tarball || !rootDist.integrity) throw new Error(`${packageName}@${source.version} 缺少可校验的下载信息`);
      const artifacts: ResolvedNpmArtifact[] = [{ packageName, installName: packageName, version: source.version, url: rootDist.tarball, integrity: rootDist.integrity }];
      const suffix = platformSuffix();
      const optional = Object.entries(rootManifest.optionalDependencies || {}).find(([name]) => name.endsWith(suffix) && !name.endsWith(`${suffix}-musl`));
      if (optional) {
        const [platformInstallName, platformSpec] = optional;
        const { packageName: platformPackage, version: platformVersion } = parseOptionalSpec(platformInstallName, platformSpec);
        const manifest = await readJson<NpmVersion>(`${registry}/${packagePath(platformPackage)}/${encodeURIComponent(platformVersion)}`, config, 15_000);
        if (!manifest?.dist?.tarball || !manifest.dist.integrity) throw new Error(`${platformPackage}@${platformVersion} 缺少可校验的下载信息`);
        artifacts.push({ packageName: platformPackage, installName: platformInstallName, version: platformVersion, url: manifest.dist.tarball, integrity: manifest.dist.integrity });
      }
      return { ...source, selected: registry, manifest: rootManifest, artifacts };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${packageName}@${source.version} 没有完整的当前平台安装包`);
}
