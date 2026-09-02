import { z } from "zod";
import type { AcpLaunchSpec } from "../types.js";

export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const npxDistribution = z.object({
  package: z.string().min(1),
  args: z.array(z.string()).optional(),
  // Registry-provided environment is metadata only. Launch conversion copies
  // allowlisted literal values; it never expands shell expressions.
  env: z.record(z.string(), z.string()).optional()
}).strict();
const uvxDistribution = z.object({
  package: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional()
}).strict();
const binaryAsset = z.object({
  archive: z.string().url(),
  cmd: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional()
}).strict();
const registryAgent = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(""),
  repository: z.string().url().optional(),
  website: z.string().url().optional(),
  authors: z.array(z.string()).default([]),
  license: z.string().default("unknown"),
  icon: z.string().url().optional(),
  distribution: z.object({
    npx: npxDistribution.optional(),
    uvx: uvxDistribution.optional(),
    binary: z.record(z.string(), binaryAsset).optional()
  }).passthrough()
}).passthrough();

const registryDocument = z.object({
  version: z.string().min(1),
  agents: z.array(registryAgent),
  extensions: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional()
});

export type AcpRegistryAgent = z.infer<typeof registryAgent>;
export type AcpRegistryDocument = z.infer<typeof registryDocument>;

export class AcpRegistryClient {
  private cache: { expiresAt: number; value: AcpRegistryDocument } | null = null;

  constructor(private readonly url = ACP_REGISTRY_URL, private readonly ttlMs = 15 * 60_000) {}

  async list(force = false) {
    if (!force && this.cache && this.cache.expiresAt > Date.now()) return structuredClone(this.cache.value);
    const response = await fetch(this.url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`ACP Registry 请求失败（HTTP ${response.status}）`);
    const parsed = parseAcpRegistry(await response.json());
    this.cache = { expiresAt: Date.now() + this.ttlMs, value: parsed };
    return structuredClone(parsed);
  }
}

export function acpRegistryPlatform() {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
  return `${os}-${arch}`;
}

export function parseAcpRegistry(input: unknown): AcpRegistryDocument {
  const parsed = registryDocument.parse(input);
  const ids = new Set<string>();
  for (const agent of parsed.agents) {
    if (ids.has(agent.id)) throw new Error(`ACP Registry Provider ID 重复：${agent.id}`);
    ids.add(agent.id);
    if (agent.icon && new URL(agent.icon).protocol !== "https:") throw new Error(`ACP Registry 图标必须使用 HTTPS：${agent.id}`);
  }
  return parsed;
}

export function npxLaunchSpec(agent: AcpRegistryAgent): AcpLaunchSpec | null {
  const distribution = agent.distribution.npx;
  if (!distribution) return null;
  const packageSpec = distribution.package.trim();
  if (!packageSpec.endsWith(`@${agent.version}`)) throw new Error(`ACP Registry 包版本未锁定到 ${agent.version}：${agent.id}`);
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["--yes", packageSpec, ...(distribution.args || [])],
    ...(distribution.env ? { env: { ...distribution.env } } : {}),
    registryId: agent.id,
    package: packageSpec,
    version: agent.version
  };
}
