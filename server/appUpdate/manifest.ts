import crypto from "node:crypto";
import { z } from "zod";
import type { AppUpdateConfig, AppUpdateManifest, AppUpdateRelease } from "./types.js";

const sha256 = /^[a-f0-9]{64}$/i;
const positiveRange = z.object({ min: z.number().int().positive(), max: z.number().int().positive() });
const manifestSchema = z.object({
  schemaVersion: z.literal(2),
  productId: z.string().min(1).max(80),
  productName: z.string().min(1).max(120),
  version: z.string().min(1).max(80),
  buildId: z.string().min(1).max(160),
  channel: z.enum(["stable", "beta"]),
  publishedAt: z.string().datetime(),
  releaseNotes: z.string().max(200_000),
  releaseUrl: z.string().url(),
  compatibility: z.object({
    data: z.object({
      readsFrom: positiveRange,
      writesTo: z.number().int().positive(),
      migratesFrom: positiveRange,
      migrationProtocolVersion: z.number().int().positive(),
      downgradePolicy: z.literal("blocked")
    }),
    launcherProtocol: positiveRange
  }),
  assets: z.array(z.object({
    platform: z.string().min(1),
    arch: z.string().min(1),
    url: z.string().url(),
    sha256: z.string().regex(sha256),
    size: z.number().int().positive().optional()
  })).min(1).max(64),
  signature: z.object({ algorithm: z.literal("Ed25519"), keyId: z.string().min(1), value: z.string().min(1) })
});

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item)]));
}

export function canonicalManifestPayload(manifest: Omit<AppUpdateManifest, "signature">) {
  return Buffer.from(JSON.stringify(canonicalValue(manifest)), "utf8");
}

export function manifestDigest(manifest: AppUpdateManifest) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalValue(manifest))).digest("hex");
}

function validRange(range: { min: number; max: number }) { return range.min <= range.max; }

export function parseAppUpdateManifest(input: unknown, config: AppUpdateConfig): AppUpdateManifest {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    const suppliedVersion = input && typeof input === "object" && "schemaVersion" in input
      ? Number((input as { schemaVersion?: unknown }).schemaVersion)
      : 0;
    if (suppliedVersion > 0 && suppliedVersion < 2) {
      throw new Error(`远程更新清单仍为旧版 v${suppliedVersion}，当前客户端要求带签名和兼容范围的 v2 清单；已安全拒绝该更新，请等待发布方替换 latest.json`);
    }
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "root"))].slice(0, 6);
    throw new Error(`远程更新清单格式无效${fields.length ? `（字段：${fields.join("、")}）` : ""}；已安全拒绝该更新`);
  }
  const manifest = parsed.data as AppUpdateManifest;
  if (manifest.productId !== config.productId) throw new Error(`更新清单产品不匹配：${manifest.productId}`);
  if (!validRange(manifest.compatibility.data.readsFrom) || !validRange(manifest.compatibility.data.migratesFrom) || !validRange(manifest.compatibility.launcherProtocol)) throw new Error("更新清单的兼容范围无效");
  const encodedKey = config.manifestSigning.trustedKeys[manifest.signature.keyId];
  if (!encodedKey) throw new Error(`更新清单使用了不受信任的签名密钥：${manifest.signature.keyId}`);
  let verified = false;
  try {
    const publicKey = crypto.createPublicKey({ key: Buffer.from(encodedKey, "base64"), format: "der", type: "spki" });
    const { signature: _signature, ...unsigned } = manifest;
    verified = crypto.verify(null, canonicalManifestPayload(unsigned), publicKey, Buffer.from(manifest.signature.value, "base64"));
  } catch { verified = false; }
  if (!verified) throw new Error("更新清单签名验证失败");
  return manifest;
}

function compatibilityResult(compatibility: AppUpdateManifest["compatibility"], config: AppUpdateConfig, actualDataSchemaVersion: number) {
  const data = compatibility.data;
  const readable = actualDataSchemaVersion >= data.readsFrom.min && actualDataSchemaVersion <= data.readsFrom.max;
  const migratable = actualDataSchemaVersion >= data.migratesFrom.min && actualDataSchemaVersion <= data.migratesFrom.max;
  const downgradeBlocked = actualDataSchemaVersion > data.writesTo;
  const migrationProtocolCompatible = readable || !migratable
    || data.migrationProtocolVersion <= config.dataCompatibility.migrationProtocolVersion;
  const launcherVersion = config.launcherProtocol.min;
  const launcherCompatible = launcherVersion >= compatibility.launcherProtocol.min && launcherVersion <= compatibility.launcherProtocol.max;
  const incompatibilityReason = downgradeBlocked
    ? `当前数据架构 ${actualDataSchemaVersion} 高于目标版本写入架构 ${data.writesTo}，禁止降级覆盖`
    : !readable && !migratable
      ? `目标版本的数据架构只能读取 ${data.readsFrom.min}-${data.readsFrom.max} 或迁移 ${data.migratesFrom.min}-${data.migratesFrom.max}，当前为 ${actualDataSchemaVersion}`
      : !migrationProtocolCompatible
        ? `目标版本需要数据迁移协议 ${data.migrationProtocolVersion}，当前启动器仅支持 ${config.dataCompatibility.migrationProtocolVersion}`
      : !launcherCompatible
        ? `目标版本需要启动器协议 ${compatibility.launcherProtocol.min}-${compatibility.launcherProtocol.max}，当前为 ${launcherVersion}`
        : "";
  return { compatible: !incompatibilityReason, incompatibilityReason };
}

export function releaseFromManifest(manifest: AppUpdateManifest, config: AppUpdateConfig, actualDataSchemaVersion = config.dataSchemaVersion): AppUpdateRelease {
  const compatibility = compatibilityResult(manifest.compatibility, config, actualDataSchemaVersion);
  return {
    version: manifest.version,
    buildId: manifest.buildId,
    manifestDigest: manifestDigest(manifest),
    channel: manifest.channel,
    publishedAt: manifest.publishedAt,
    releaseNotes: manifest.releaseNotes,
    releaseUrl: manifest.releaseUrl,
    source: "manifest",
    compatible: compatibility.compatible,
    installable: false,
    incompatibilityReason: compatibility.incompatibilityReason,
    assets: manifest.assets,
    compatibility: structuredClone(manifest.compatibility)
  };
}

export function refreshReleaseCompatibility(release: AppUpdateRelease, config: AppUpdateConfig, actualDataSchemaVersion: number) {
  if (!release.compatibility) return { ...release, compatible: true, installable: false, incompatibilityReason: "" };
  const compatibility = compatibilityResult(release.compatibility, config, actualDataSchemaVersion);
  return { ...release, compatible: compatibility.compatible, incompatibilityReason: compatibility.incompatibilityReason };
}
