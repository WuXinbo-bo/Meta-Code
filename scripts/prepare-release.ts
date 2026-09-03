import path from "node:path";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadAppUpdateConfig } from "../server/appUpdate/config.js";
import { createReleaseManifest, writeReleaseManifest } from "../server/appUpdate/release.js";
import type { AppUpdateChannel } from "../server/appUpdate/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
};
const required = (name: string) => {
  const result = value(name);
  if (!result) throw new Error(`缺少参数 ${name}`);
  return result;
};

const channel = (value("--channel") || "stable") as AppUpdateChannel;
if (channel !== "stable" && channel !== "beta") throw new Error("--channel 只能是 stable 或 beta");
const config = loadAppUpdateConfig(root);
const assetFile = path.resolve(required("--asset"));
const signingKeyFile = path.resolve(required("--signing-key"));
const outputRoot = path.resolve(value("--out") || path.join(root, "release-artifacts"));
const manifest = await createReleaseManifest({
  config,
  channel,
  publishedAt: value("--published-at") || new Date().toISOString(),
  releaseNotes: value("--notes") || `${config.productName} ${config.currentVersion}`,
  releaseUrl: required("--release-url"),
  buildId: value("--build-id") || process.env.METACODE_SOURCE_COMMIT || `${config.currentVersion}-${Date.now()}`,
  signingKeyId: value("--signing-key-id") || "meta-code-release-2026",
  signingPrivateKey: await fsp.readFile(signingKeyFile),
  assets: [{
    file: assetFile,
    url: required("--asset-url"),
    platform: value("--platform") || process.platform,
    arch: value("--arch") || process.arch
  }]
});
const destination = path.join(outputRoot, `${config.productId}-${config.currentVersion}`, channel, "latest.json");
await writeReleaseManifest(destination, manifest);
console.log(destination);
