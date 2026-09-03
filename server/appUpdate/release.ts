import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { canonicalManifestPayload, parseAppUpdateManifest } from "./manifest.js";
import type { AppUpdateChannel, AppUpdateConfig, AppUpdateManifest } from "./types.js";

export type ReleaseAssetInput = {
  file: string;
  url: string;
  platform: string;
  arch: string;
};

export async function createReleaseManifest(input: {
  config: AppUpdateConfig;
  channel: AppUpdateChannel;
  publishedAt: string;
  releaseNotes: string;
  releaseUrl: string;
  buildId: string;
  signingKeyId: string;
  signingPrivateKey: string | Buffer;
  assets: ReleaseAssetInput[];
}) {
  const assets = await Promise.all(input.assets.map(async (asset) => {
    const content = await fsp.readFile(asset.file);
    return {
      platform: asset.platform,
      arch: asset.arch,
      url: asset.url,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      size: content.byteLength
    };
  }));
  const unsigned: Omit<AppUpdateManifest, "signature"> = {
    schemaVersion: 2,
    productId: input.config.productId,
    productName: input.config.productName,
    version: input.config.currentVersion,
    buildId: input.buildId,
    channel: input.channel,
    publishedAt: input.publishedAt,
    releaseNotes: input.releaseNotes,
    releaseUrl: input.releaseUrl,
    compatibility: {
      data: structuredClone(input.config.dataCompatibility),
      launcherProtocol: structuredClone(input.config.launcherProtocol)
    },
    assets
  };
  const privateKey = crypto.createPrivateKey(input.signingPrivateKey);
  const manifest: AppUpdateManifest = {
    ...unsigned,
    signature: { algorithm: "Ed25519", keyId: input.signingKeyId, value: crypto.sign(null, canonicalManifestPayload(unsigned), privateKey).toString("base64") }
  };
  return parseAppUpdateManifest(manifest, input.config);
}

export async function writeReleaseManifest(file: string, manifest: AppUpdateManifest) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, file);
}
