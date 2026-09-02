import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { downloadArtifact } from "../server/runtime/downloader.ts";
import { DEFAULT_RUNTIME_CONFIGURATION, normalizeRuntimeConfiguration } from "../server/runtime/config.ts";
import { RuntimeTaskStore } from "../server/runtime/taskStore.ts";
import { resolveNpmArtifacts } from "../server/runtime/source.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "metacode-runtime-download-"));
const payload = crypto.randomBytes(2 * 1024 * 1024 + 173);
const integrity = `sha512-${crypto.createHash("sha512").update(payload).digest("base64")}`;
let firstRequest = true;
let resumedAt = 0;

const server = http.createServer((req, res) => {
  if (req.url === "/runtime.tgz") {
    res.statusCode = 302;
    res.setHeader("Location", "/download/runtime.tgz");
    res.end();
    return;
  }
  const range = /^bytes=(\d+)-$/.exec(String(req.headers.range || ""));
  const offset = range ? Number(range[1]) : 0;
  if (offset) resumedAt = offset;
  res.statusCode = offset ? 206 : 200;
  res.setHeader("Content-Length", payload.length - offset);
  if (offset) res.setHeader("Content-Range", `bytes ${offset}-${payload.length - 1}/${payload.length}`);
  if (firstRequest) {
    firstRequest = false;
    res.write(payload.subarray(0, 1024 * 1024));
    setImmediate(() => res.destroy());
    return;
  }
  res.end(payload.subarray(offset));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const artifact = { packageName: "test-runtime", installName: "test-runtime", version: "1.0.0", url: `http://127.0.0.1:${address.port}/runtime.tgz`, integrity };
const network = { ...DEFAULT_RUNTIME_CONFIGURATION.network, proxyMode: "off", inactivityTimeoutSeconds: 30 };

await assert.rejects(downloadArtifact(artifact, path.join(root, "cache"), network, () => undefined));
const downloaded = await downloadArtifact(artifact, path.join(root, "cache"), network, () => undefined);
assert.ok(resumedAt >= 1024 * 1024, "second request should resume from the partial file");
assert.deepEqual(fs.readFileSync(downloaded), payload);

const completePartialRoot = path.join(root, "complete-partial");
fs.mkdirSync(completePartialRoot, { recursive: true });
const cachedName = fs.readdirSync(path.join(root, "cache"))[0];
fs.copyFileSync(downloaded, path.join(completePartialRoot, `${cachedName}.part`));
const recoveredCompletePartial = await downloadArtifact(artifact, completePartialRoot, network, () => undefined);
assert.deepEqual(fs.readFileSync(recoveredCompletePartial), payload);

assert.throws(() => normalizeRuntimeConfiguration({ network: { proxyMode: "custom", proxyUrl: "" } }), /代理地址/);
const normalized = normalizeRuntimeConfiguration({ network: { inactivityTimeoutSeconds: 1 }, selections: { claude: { mode: "managed" } } });
assert.equal(normalized.network.inactivityTimeoutSeconds, 30);
assert.equal(normalized.selections.claude.mode, "managed");
assert.equal(normalizeRuntimeConfiguration({ selections: { codex: { mode: "auto" } } }).selections.codex.mode, "system");
assert.equal(normalizeRuntimeConfiguration({ selections: { "future-cli": { mode: "managed" } } }).selections["future-cli"].mode, "managed");

const tasksRoot = path.join(root, "tasks");
const store = new RuntimeTaskStore(tasksRoot);
const taskStartedAt = new Date().toISOString();
store.set({ runtimeId: "claude", operationId: `claude:${taskStartedAt}`, sequence: 4, phase: "downloading", message: "downloading", startedAt: taskStartedAt, updatedAt: new Date().toISOString(), active: true, resumable: true });
const restored = new RuntimeTaskStore(tasksRoot).get("claude");
assert.equal(restored?.phase, "interrupted");
assert.equal(restored?.resumable, true);
assert.equal(restored?.sequence, 5);

const registryState = { firstRoot: 0, firstPlatform: 0, secondRoot: 0, secondPlatform: 0 };
const registryServer = http.createServer((req, res) => {
  const host = `http://127.0.0.1:${registryServer.address().port}`;
  const route = decodeURIComponent(String(req.url || ""));
  res.setHeader("Content-Type", "application/json");
  if (route.startsWith("/fast/@vendor/tool/")) {
    registryState.firstRoot += 1;
    res.end(JSON.stringify({ version: "1.0.0", dist: { tarball: `${host}/fast/root.tgz`, integrity }, optionalDependencies: { "@vendor/tool-win32-x64": "1.0.0" } }));
  } else if (route.startsWith("/fast/@vendor/tool-win32-x64/")) {
    registryState.firstPlatform += 1;
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "missing" }));
  } else if (route.startsWith("/complete/@vendor/tool/")) {
    registryState.secondRoot += 1;
    setTimeout(() => res.end(JSON.stringify({ version: "1.0.0", dist: { tarball: `${host}/complete/root.tgz`, integrity }, optionalDependencies: { "@vendor/tool-win32-x64": "1.0.0" } })), 30);
  } else if (route.startsWith("/complete/@vendor/tool-win32-x64/")) {
    registryState.secondPlatform += 1;
    res.end(JSON.stringify({ version: "1.0.0", dist: { tarball: `${host}/complete/platform.tgz`, integrity } }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  }
});
await new Promise((resolve) => registryServer.listen(0, "127.0.0.1", resolve));
const registryAddress = registryServer.address();
assert.ok(registryAddress && typeof registryAddress === "object");
const registries = [`http://127.0.0.1:${registryAddress.port}/fast`, `http://127.0.0.1:${registryAddress.port}/complete`];
const resolved = await resolveNpmArtifacts("@vendor/tool", "1.0.0", network, registries);
assert.equal(resolved.selected, registries[1]);
assert.equal(resolved.artifacts.length, process.platform === "win32" && process.arch === "x64" ? 2 : 1);
if (process.platform === "win32" && process.arch === "x64") {
  assert.equal(registryState.firstPlatform, 1);
  assert.equal(registryState.secondPlatform, 1);
}

await new Promise((resolve) => server.close(resolve));
await new Promise((resolve) => registryServer.close(resolve));
fs.rmSync(root, { recursive: true, force: true });
console.log("Runtime configuration, persisted task recovery, integrity, and ranged resume tests passed");
