import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AppUpdateService } from "../server/appUpdate/service.ts";

const temporaryRoots = [];
async function project(configure = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-code-update-"));
  temporaryRoots.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  await fs.writeFile(path.join(root, "release.config.json"), JSON.stringify({
    schemaVersion: 1,
    productId: "meta-code",
    productName: "Meta Code",
    dataSchemaVersion: 1,
    launcherProtocolVersion: 1,
    githubRepository: "",
    manifestUrls: { stable: "", beta: "" },
    defaultChannel: "stable",
    defaultCheckIntervalHours: 6,
    ...configure
  }));
  return root;
}

function manifest(version, overrides = {}) {
  return {
    schemaVersion: 1,
    productId: "meta-code",
    productName: "Meta Code",
    version,
    channel: "stable",
    publishedAt: "2026-08-31T00:00:00.000Z",
    releaseNotes: `Meta Code ${version}`,
    releaseUrl: "https://example.com/releases/latest",
    compatibility: { minDataSchemaVersion: 1, maxDataSchemaVersion: 1, launcherProtocolVersion: 1 },
    assets: [{ platform: "win32", arch: "x64", url: "https://example.com/meta-code.zip", sha256: "a".repeat(64) }],
    ...overrides
  };
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

  currentManifest = manifest("0.3.0", { compatibility: { minDataSchemaVersion: 2, maxDataSchemaVersion: 3, launcherProtocolVersion: 1 } });
  const incompatible = new AppUpdateService({ projectRoot: configuredRoot, stateFile: path.join(configuredRoot, "data", "incompatible.json") });
  status = await incompatible.check(true);
  assert.equal(status.updateAvailable, true);
  assert.equal(status.release?.compatible, false);
  assert.match(status.release?.incompatibilityReason || "", /数据架构/);

  const timeout = new AppUpdateService({
    projectRoot: configuredRoot,
    stateFile: path.join(configuredRoot, "data", "timeout.json"),
    requestTimeoutMs: 25,
    fetch: (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
  });
  status = await timeout.check(true);
  assert.equal(status.source.state, "error");
  assert.match(status.lastError, /超时/);

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
  configured.close(); current.close(); incompatible.close(); timeout.close(); unconfigured.close();
  console.log("app update service: ok");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await Promise.all(temporaryRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
}
