import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseAppUpdateManifest } from "./manifest.js";
import type { AppUpdateChannel, AppUpdateConfig, AppUpdateManifest } from "./types.js";

export type ReleaseAssetInput = {
  file: string;
  url: string;
  platform: string;
  arch: string;
  signature?: string;
};

export async function createReleaseManifest(input: {
  config: AppUpdateConfig;
  channel: AppUpdateChannel;
  publishedAt: string;
  releaseNotes: string;
  releaseUrl: string;
  assets: ReleaseAssetInput[];
}) {
  const assets = await Promise.all(input.assets.map(async (asset) => {
    const content = await fsp.readFile(asset.file);
    return {
      platform: asset.platform,
      arch: asset.arch,
      url: asset.url,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      size: content.byteLength,
      ...(asset.signature ? { signature: asset.signature } : {})
    };
  }));
  const manifest: AppUpdateManifest = {
    schemaVersion: 1,
    productId: input.config.productId,
    productName: input.config.productName,
    version: input.config.currentVersion,
    channel: input.channel,
    publishedAt: input.publishedAt,
    releaseNotes: input.releaseNotes,
    releaseUrl: input.releaseUrl,
    compatibility: {
      minDataSchemaVersion: input.config.dataSchemaVersion,
      maxDataSchemaVersion: input.config.dataSchemaVersion,
      launcherProtocolVersion: input.config.launcherProtocolVersion
    },
    assets
  };
  return parseAppUpdateManifest(manifest, input.config);
}

export async function writeReleaseManifest(file: string, manifest: AppUpdateManifest) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, file);
}
