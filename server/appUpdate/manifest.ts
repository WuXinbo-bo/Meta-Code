import { z } from "zod";
import type { AppUpdateConfig, AppUpdateManifest, AppUpdateRelease } from "./types.js";

const sha256 = /^[a-f0-9]{64}$/i;
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  productId: z.string().min(1).max(80),
  productName: z.string().min(1).max(120),
  version: z.string().min(1).max(80),
  channel: z.enum(["stable", "beta"]),
  publishedAt: z.string().datetime(),
  releaseNotes: z.string().max(200_000),
  releaseUrl: z.string().url(),
  compatibility: z.object({
    minDataSchemaVersion: z.number().int().positive(),
    maxDataSchemaVersion: z.number().int().positive(),
    launcherProtocolVersion: z.number().int().positive()
  }),
  assets: z.array(z.object({
    platform: z.string().min(1),
    arch: z.string().min(1),
    url: z.string().url(),
    sha256: z.string().regex(sha256),
    size: z.number().int().positive().optional(),
    signature: z.string().min(1).optional()
  })).max(64)
});

export function parseAppUpdateManifest(input: unknown, config: AppUpdateConfig): AppUpdateManifest {
  const manifest = manifestSchema.parse(input) as AppUpdateManifest;
  if (manifest.productId !== config.productId) throw new Error(`更新清单产品不匹配：${manifest.productId}`);
  if (manifest.compatibility.minDataSchemaVersion > manifest.compatibility.maxDataSchemaVersion) throw new Error("更新清单的数据兼容范围无效");
  return manifest;
}

export function releaseFromManifest(manifest: AppUpdateManifest, config: AppUpdateConfig, actualDataSchemaVersion = config.dataSchemaVersion): AppUpdateRelease {
  const dataCompatible = actualDataSchemaVersion >= manifest.compatibility.minDataSchemaVersion
    && actualDataSchemaVersion <= manifest.compatibility.maxDataSchemaVersion;
  const launcherCompatible = config.launcherProtocolVersion === manifest.compatibility.launcherProtocolVersion;
  const incompatibilityReason = !dataCompatible
    ? `需要数据架构 ${manifest.compatibility.minDataSchemaVersion}-${manifest.compatibility.maxDataSchemaVersion}，当前为 ${actualDataSchemaVersion}`
    : !launcherCompatible
      ? `需要启动器协议 ${manifest.compatibility.launcherProtocolVersion}，当前为 ${config.launcherProtocolVersion}`
      : "";
  return {
    version: manifest.version,
    channel: manifest.channel,
    publishedAt: manifest.publishedAt,
    releaseNotes: manifest.releaseNotes,
    releaseUrl: manifest.releaseUrl,
    source: "manifest",
    compatible: !incompatibilityReason,
    installable: false,
    incompatibilityReason,
    assets: manifest.assets,
    compatibility: structuredClone(manifest.compatibility)
  };
}

export function refreshReleaseCompatibility(release: AppUpdateRelease, config: AppUpdateConfig, actualDataSchemaVersion: number) {
  if (!release.compatibility) return { ...release, compatible: true, installable: false, incompatibilityReason: "" };
  const manifest = {
    schemaVersion: 1, productId: config.productId, productName: config.productName,
    version: release.version, channel: release.channel, publishedAt: release.publishedAt,
    releaseNotes: release.releaseNotes, releaseUrl: release.releaseUrl,
    compatibility: release.compatibility, assets: release.assets
  } as AppUpdateManifest;
  return releaseFromManifest(manifest, config, actualDataSchemaVersion);
}
