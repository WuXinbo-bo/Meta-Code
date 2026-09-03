import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AppUpdateService } from "../server/appUpdate/service.ts";
import { canonicalManifestPayload } from "../server/appUpdate/manifest.ts";

const signingKeys = crypto.generateKeyPairSync("ed25519");
const signingKeyId = "test-release-key";
const encodedPublicKey = signingKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64");

const temporaryRoots = [];
async function project(configure = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-code-update-"));
  temporaryRoots.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  await fs.writeFile(path.join(root, "release.config.json"), JSON.stringify({
    schemaVersion: 2,
    productId: "meta-code",
    productName: "Meta Code",
    dataSchemaVersion: 1,
    dataCompatibility: { readsFrom: { min: 1, max: 1 }, writesTo: 1, migratesFrom: { min: 1, max: 1 }, migrationProtocolVersion: 1, downgradePolicy: "blocked" },
    launcherProtocol: { min: 1, max: 1 },
    manifestSigning: { required: true, trustedKeys: { [signingKeyId]: encodedPublicKey } },
    githubRepository: "",
    manifestUrls: { stable: "", beta: "" },
    defaultChannel: "stable",
    defaultCheckIntervalHours: 6,
    ...configure
  }));
  return root;
}

function manifest(version, overrides = {}) {
  const unsigned = {
    schemaVersion: 2,
    productId: "meta-code",
    productName: "Meta Code",
    version,
    buildId: `${version}-build-a`,
    channel: "stable",
    publishedAt: "2026-08-31T00:00:00.000Z",
    releaseNotes: `Meta Code ${version}`,
    releaseUrl: "https://example.com/releases/latest",
    compatibility: {
      data: { readsFrom: { min: 1, max: 1 }, writesTo: 1, migratesFrom: { min: 1, max: 1 }, migrationProtocolVersion: 1, downgradePolicy: "blocked" },
      launcherProtocol: { min: 1, max: 1 }
    },
    assets: [{ platform: "win32", arch: "x64", url: "https://example.com/meta-code.zip", sha256: "a".repeat(64) }],
    ...overrides
  };
  return { ...unsigned, signature: { algorithm: "Ed25519", keyId: signingKeyId, value: crypto.sign(null, canonicalManifestPayload(unsigned), signingKeys.privateKey).toString("base64") } };
}

let currentManifest = manifest("0.2.0");
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(currentManifest));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const manifestUrl = `http://127.0.0.1:${address.port}/latest.json`;

try {
  const unconfiguredRoot = await project();
  const unconfigured = new AppUpdateService({ projectRoot: unconfiguredRoot, stateFile: path.join(unconfiguredRoot, "data", "state.json") });
  const unconfiguredStatus = await unconfigured.check(true);
  assert.equal(unconfiguredStatus.product.name, "Meta Code");
  assert.equal(unconfiguredStatus.product.currentVersion, "0.1.0");
  assert.equal(unconfiguredStatus.source.state, "unconfigured");
  assert.match(unconfiguredStatus.lastError, /尚未配置/);

  const configuredRoot = await project({ manifestUrls: { stable: manifestUrl, beta: manifestUrl } });
  const configured = new AppUpdateService({ projectRoot: configuredRoot, stateFile: path.join(configuredRoot, "data", "state.json") });
  let status = await configured.check(true);
  assert.equal(status.source.state, "manifest");
  assert.equal(status.release?.version, "0.2.0");
  assert.equal(status.updateAvailable, true);
  assert.equal(status.announcementVisible, true);
  assert.deepEqual(status.capabilities, { check: true, download: false, apply: false, launcher: false });

  status = await configured.skip("0.2.0", status.revision);
  assert.equal(status.announcementVisible, false);
  await assert.rejects(() => configured.updatePreferences({ autoCheck: false, expectedRevision: status.revision - 1 }), /其他窗口/);
  status = await configured.updatePreferences({ autoCheck: false, expectedRevision: status.revision });
  assert.equal(status.preferences.autoCheck, false);
  status = await configured.remind(24, status.revision);
  assert.equal(status.announcementVisible, false);

  currentManifest = manifest("0.1.0");
  const current = new AppUpdateService({ projectRoot: configuredRoot, stateFile: path.join(configuredRoot, "data", "current.json") });
  assert.equal((await current.check(true)).updateAvailable, false);

  const replacedBuildRoot = await project({ manifestUrls: { stable: manifestUrl, beta: manifestUrl } });
  await fs.writeFile(path.join(replacedBuildRoot, "build-info.json"), JSON.stringify({ schemaVersion: 1, version: "0.1.0", buildId: "0.1.0-original" }));
  currentManifest = manifest("0.1.0", { buildId: "0.1.0-rebuilt" });
  const replacedBuild = new AppUpdateService({ projectRoot: replacedBuildRoot, stateFile: path.join(replacedBuildRoot, "data", "same-version-build.json") });
  status = await replacedBuild.check(true);
  assert.equal(status.updateAvailable, true, "同一 SemVer 的资源修订必须通过 buildId 被识别");
  replacedBuild.close();

  currentManifest = manifest("0.3.0", { compatibility: { data: { readsFrom: { min: 2, max: 3 }, writesTo: 3, migratesFrom: { min: 2, max: 3 }, migrationProtocolVersion: 1, downgradePolicy: "blocked" }, launcherProtocol: { min: 1, max: 1 } } });
  const incompatible = new AppUpdateService({ projectRoot: configuredRoot, stateFile: path.join(configuredRoot, "data", "incompatible.json") });
  status = await incompatible.check(true);
  assert.equal(status.updateAvailable, true);
  assert.equal(status.release?.compatible, false);
  assert.match(status.release?.incompatibilityReason || "", /数据架构/);

  currentManifest = manifest("0.3.0", { compatibility: { data: { readsFrom: { min: 2, max: 2 }, writesTo: 2, migratesFrom: { min: 1, max: 2 }, migrationProtocolVersion: 2, downgradePolicy: "blocked" }, launcherProtocol: { min: 1, max: 1 } } });
  const migrationProtocol = new AppUpdateService({ projectRoot: configuredRoot, stateFile: path.join(configuredRoot, "data", "migration-protocol.json") });
  status = await migrationProtocol.check(true);
  assert.equal(status.release?.compatible, false);
  assert.match(status.release?.incompatibilityReason || "", /迁移协议/);
  migrationProtocol.close();

  currentManifest = manifest("0.3.0", { compatibility: { data: { readsFrom: { min: 1, max: 2 }, writesTo: 2, migratesFrom: { min: 1, max: 2 }, migrationProtocolVersion: 1, downgradePolicy: "blocked" }, launcherProtocol: { min: 1, max: 1 } } });
  const downgrade = new AppUpdateService({ projectRoot: configuredRoot, stateFile: path.join(configuredRoot, "data", "downgrade.json"), getDataSchemaVersion: () => 3 });
  status = await downgrade.check(true);
  assert.equal(status.release?.compatible, false);
  assert.match(status.release?.incompatibilityReason || "", /禁止降级/);
  downgrade.close();

  currentManifest = manifest("0.3.1", { compatibility: { data: { readsFrom: { min: 1, max: 2 }, writesTo: 2, migratesFrom: { min: 1, max: 2 }, migrationProtocolVersion: 1, downgradePolicy: "blocked" }, launcherProtocol: { min: 1, max: 1 } } });
  const actualSchema = new AppUpdateService({
    projectRoot: configuredRoot,
    stateFile: path.join(configuredRoot, "data", "actual-schema.json"),
    getDataSchemaVersion: () => 2
  });
  status = await actualSchema.check(true);
  assert.equal(status.release?.compatible, true, "compatibility must use the opened database schema instead of release.config.json");

  const staleStateFile = path.join(configuredRoot, "data", "stale-state.json");
  await fs.writeFile(staleStateFile, JSON.stringify({
    schemaVersion: 1,
    revision: 7,
    preferences: { autoCheck: true, channel: "stable", skippedVersion: "", remindAfter: null },
    lastCheckedAt: new Date().toISOString(),
    lastSuccessfulCheckAt: new Date().toISOString(),
    lastError: "",
    release: {
      version: "0.3.0", channel: "stable", publishedAt: new Date().toISOString(), releaseNotes: "old",
      releaseUrl: "https://example.com", source: "manifest", compatible: false, installable: false,
      incompatibilityReason: "需要数据架构 2-2，当前为 1", assets: []
    }
  }));
  const refreshed = new AppUpdateService({ projectRoot: configuredRoot, stateFile: staleStateFile, getDataSchemaVersion: () => 2 });
  assert.equal(refreshed.status().release?.compatible, true, "legacy derived compatibility must not survive an app restart");
  status = await refreshed.check(false);
  assert.equal(status.release?.version, "0.3.1", "a new app version must bypass the previous version's check cooldown");

  const timeout = new AppUpdateService({
    projectRoot: configuredRoot,
    stateFile: path.join(configuredRoot, "data", "timeout.json"),
    requestTimeoutMs: 25,
    retryDelaysMs: [0, 0, 0],
    fetch: (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
  });
  status = await timeout.check(true);
  assert.equal(status.source.state, "error");
  assert.match(status.lastError, /超时/);

  currentManifest = manifest("0.3.2");
  const cachedStateFile = path.join(configuredRoot, "data", "cached-failure.json");
  const cached = new AppUpdateService({ projectRoot: configuredRoot, stateFile: cachedStateFile });
  status = await cached.check(true);
  assert.equal(status.source.usingCachedRelease, false);
  cached.close();
  const cachedFailure = new AppUpdateService({
    projectRoot: configuredRoot,
    stateFile: cachedStateFile,
    retryDelaysMs: [0],
    fetch: async () => { throw new Error("network unavailable"); }
  });
  status = await cachedFailure.check(true);
  assert.equal(status.source.state, "error");
  assert.equal(status.source.usingCachedRelease, true);
  assert.equal(status.release?.version, "0.3.2", "检查失败时必须保留上次成功结果");
  assert.equal(status.source.lastSuccessfulState, "manifest");
  cachedFailure.close();

  const githubReleases = [
    {
      tag_name: "v0.4.0",
      draft: false,
      prerelease: false,
      published_at: "2026-09-01T00:00:00.000Z",
      body: "stable",
      html_url: "https://github.com/example/meta-code/releases/tag/v0.4.0"
    },
    {
      tag_name: "v0.5.0-beta.1",
      draft: false,
      prerelease: true,
      published_at: "2026-09-02T00:00:00.000Z",
      body: "beta",
      html_url: "https://github.com/example/meta-code/releases/tag/v0.5.0-beta.1"
    }
  ];
  const githubFetch = async () => new Response(JSON.stringify(githubReleases), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const githubRoot = await project({ githubRepository: "example/meta-code" });
  const stableGithub = new AppUpdateService({
    projectRoot: githubRoot,
    stateFile: path.join(githubRoot, "data", "github-stable.json"),
    fetch: githubFetch
  });
  status = await stableGithub.check(true);
  assert.equal(status.source.state, "github");
  assert.equal(status.release?.version, "0.4.0");
  assert.equal(status.release?.channel, "stable");

  const betaGithub = new AppUpdateService({
    projectRoot: githubRoot,
    stateFile: path.join(githubRoot, "data", "github-beta.json"),
    fetch: githubFetch
  });
  status = await betaGithub.updatePreferences({ channel: "beta", expectedRevision: betaGithub.status().revision });
  status = await betaGithub.check(true);
  assert.equal(status.source.state, "github");
  assert.equal(status.release?.version, "0.5.0-beta.1");
  assert.equal(status.release?.channel, "beta");

  const noBeta = new AppUpdateService({
    projectRoot: githubRoot,
    stateFile: path.join(githubRoot, "data", "github-no-beta.json"),
    fetch: async () => new Response(JSON.stringify(githubReleases.filter((release) => !release.prerelease)), { status: 200 })
  });
  await noBeta.updatePreferences({ channel: "beta", expectedRevision: noBeta.status().revision });
  status = await noBeta.check(true);
  assert.equal(status.source.state, "error");
  assert.match(status.lastError, /没有找到测试版发布记录/);
  stableGithub.close(); betaGithub.close(); noBeta.close();
  configured.close(); current.close(); incompatible.close(); actualSchema.close(); refreshed.close(); timeout.close(); unconfigured.close();
  console.log("app update service: ok");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await Promise.all(temporaryRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
}
