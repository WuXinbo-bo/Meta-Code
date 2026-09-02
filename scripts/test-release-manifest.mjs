import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppUpdateConfig } from "../server/appUpdate/config.ts";
import { parseAppUpdateManifest } from "../server/appUpdate/manifest.ts";
import { createReleaseManifest, writeReleaseManifest } from "../server/appUpdate/release.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadAppUpdateConfig(root);
assert.equal(config.productName, "Meta Code");
assert.equal(config.currentVersion, "0.1.1", "发布版本必须保持为 0.1.1");

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "meta-code-release-"));
try {
  const asset = path.join(temporary, "meta-code-win32-x64.zip");
  const content = Buffer.from("deterministic Meta Code release fixture\n", "utf8");
  await fs.writeFile(asset, content);
  const manifest = await createReleaseManifest({
    config,
    channel: "stable",
    publishedAt: "2026-08-31T00:00:00.000Z",
    releaseNotes: "Meta Code 0.1.1",
    releaseUrl: "https://example.com/releases/0.1.1",
    assets: [{ file: asset, url: "https://example.com/meta-code-0.1.1.zip", platform: "win32", arch: "x64" }]
  });
  assert.equal(manifest.version, "0.1.1");
  assert.equal(manifest.assets[0].size, content.byteLength);
  assert.equal(manifest.assets[0].sha256, crypto.createHash("sha256").update(content).digest("hex"));
  const output = path.join(temporary, "release-artifacts", "meta-code-0.1.1", "stable", "latest.json");
  await writeReleaseManifest(output, manifest);
  const persisted = parseAppUpdateManifest(JSON.parse(await fs.readFile(output, "utf8")), config);
  assert.deepEqual(persisted, manifest);
  await assert.rejects(async () => parseAppUpdateManifest({ ...manifest, productId: "other" }, config), /产品不匹配/);
  console.log("release manifest: ok");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
