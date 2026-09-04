import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppUpdateConfig } from "../server/appUpdate/config.ts";
import { canonicalManifestPayload, parseAppUpdateManifest } from "../server/appUpdate/manifest.ts";
import { createReleaseManifest, writeReleaseManifest } from "../server/appUpdate/release.ts";
import { CURRENT_STATE_SCHEMA_VERSION } from "../server/stateStore.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadAppUpdateConfig(root);
const signingKeys = crypto.generateKeyPairSync("ed25519");
const signingKeyId = "release-test-key";
config.manifestSigning.trustedKeys[signingKeyId] = signingKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
assert.equal(config.productName, "Meta Code");
assert.equal(config.currentVersion, "0.1.3", "发布版本必须保持为 0.1.3");
assert.equal(config.dataSchemaVersion, CURRENT_STATE_SCHEMA_VERSION, "发布清单的数据 Schema 必须与状态存储一致");

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "meta-code-release-"));
try {
  const asset = path.join(temporary, "meta-code-win32-x64.zip");
  const content = Buffer.from("deterministic Meta Code release fixture\n", "utf8");
  await fs.writeFile(asset, content);
  const manifest = await createReleaseManifest({
    config,
    channel: "stable",
    publishedAt: "2026-08-31T00:00:00.000Z",
    releaseNotes: "Meta Code 0.1.3",
    releaseUrl: "https://example.com/releases/0.1.3",
    buildId: "test-build-0.1.3",
    signingKeyId,
    signingPrivateKey: signingKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
    assets: [{ file: asset, url: "https://example.com/meta-code-0.1.3.zip", platform: "win32", arch: "x64" }]
  });
  assert.equal(manifest.version, "0.1.3");
  assert.equal(manifest.buildId, "test-build-0.1.3");
  assert.equal(manifest.assets[0].size, content.byteLength);
  assert.equal(manifest.assets[0].sha256, crypto.createHash("sha256").update(content).digest("hex"));
  const output = path.join(temporary, "release-artifacts", "meta-code-0.1.3", "stable", "latest.json");
  await writeReleaseManifest(output, manifest);
  const persisted = parseAppUpdateManifest(JSON.parse(await fs.readFile(output, "utf8")), config);
  assert.deepEqual(persisted, manifest);
  assert.throws(
    () => parseAppUpdateManifest({ schemaVersion: 1, productId: "meta-code", version: "0.1.1" }, config),
    /旧版 v1.*v2 清单.*安全拒绝/,
    "legacy manifests must produce an actionable error instead of leaking validator internals"
  );
  assert.throws(
    () => parseAppUpdateManifest({ schemaVersion: 2, productId: "meta-code" }, config),
    /清单格式无效.*字段/,
    "malformed current manifests must report bounded field names"
  );
  await assert.rejects(async () => parseAppUpdateManifest({ ...manifest, productId: "other" }, config), /产品不匹配/);
  await assert.rejects(async () => parseAppUpdateManifest({ ...manifest, releaseNotes: "tampered" }, config), /签名验证失败/);
  const { signature: _signature, ...unsigned } = manifest;
  assert.ok(crypto.verify(null, canonicalManifestPayload(unsigned), crypto.createPublicKey({ key: Buffer.from(config.manifestSigning.trustedKeys[manifest.signature.keyId], "base64"), format: "der", type: "spki" }), Buffer.from(manifest.signature.value, "base64")));
  console.log("release manifest: ok");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
