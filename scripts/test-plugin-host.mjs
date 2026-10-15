import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginHost } from "../server/plugins/host.ts";
import { collaborationPlugin } from "../server/plugins/collaboration.ts";
import { orchestrationPlugin } from "../server/plugins/orchestration.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "metacode-plugin-host-"));
const paths = {
  projectRoot: root,
  dataDir: path.join(root, "data"),
  legacyRuntimeDir: path.join(root, ".runtime"),
  logsDir: path.join(root, "data", "logs"),
  backupsDir: path.join(root, "data", "backups"),
  activityArtifactsDir: path.join(root, "data", "artifacts"),
  codexHome: path.join(root, "data", "codex"),
  claudeHome: path.join(root, "data", "claude"),
  runtimesDir: path.join(root, "data", "runtimes"),
  codexRuntimeDir: path.join(root, "data", "runtimes", "codex"),
  claudeRuntimeDir: path.join(root, "data", "runtimes", "claude"),
  mcpConfigDir: path.join(root, "data", "mcp"),
  managedSkillsDir: path.join(root, "data", "skills"),
  pluginsDir: path.join(root, "data", "plugins"),
  pluginRuntimeDir: path.join(root, "data", "runtime", "plugins"),
  standaloneSessionsDir: path.join(root, "data", "sessions"),
  workflowTransactionsDir: path.join(root, "data", "transactions"),
  appUpdateStateFile: path.join(root, "data", "updates", "state.json"),
  secretsFile: path.join(root, "data", "credentials", "secrets.dat")
};

const host = new PluginHost(paths, [collaborationPlugin, orchestrationPlugin]);
host.start();
assert.equal(host.list().length, 2);
assert.equal(host.isEnabled("collaboration"), true);
assert.equal(host.hasCapability("agent.delegation"), true);
assert.ok(fs.existsSync(path.join(paths.pluginsDir, "registry.json")));
assert.ok(fs.existsSync(host.context("orchestration").runtimeDirectory));

host.setEnabled("collaboration", false);
assert.equal(host.hasCapability("agent.delegation"), false);
const reloaded = new PluginHost(paths, [collaborationPlugin, orchestrationPlugin]);
reloaded.start();
assert.equal(reloaded.isEnabled("collaboration"), false);
assert.equal(reloaded.isEnabled("orchestration"), true);
reloaded.stop();
host.stop();

const isolated = (name) => ({ ...paths, pluginsDir: path.join(root, name, "plugins"), pluginRuntimeDir: path.join(root, name, "runtime") });
const manifest = (id, requires = { core: ">=1" }) => ({ ...collaborationPlugin.manifest, id, requires });
const order = [];
const dependent = new PluginHost(isolated("dependencies"), [
  { manifest: manifest("consumer", { producer: "^1.0.0" }), activate: () => { order.push("consumer"); return () => order.push("stop-consumer"); } },
  { manifest: manifest("producer"), activate: () => { order.push("producer"); return () => order.push("stop-producer"); } }
]);
dependent.start();
assert.deepEqual(order, ["producer", "consumer"]);
assert.throws(() => dependent.setEnabled("producer", false), /需要/);
assert.throws(() => dependent.bind("producer", {}), /已有运行实例/);
dependent.stop();
assert.deepEqual(order.slice(2), ["stop-consumer", "stop-producer"]);
const cyclic = new PluginHost(isolated("cycle"), [{ manifest: manifest("alpha", { bravo: "*" }) }, { manifest: manifest("bravo", { alpha: "*" }) }]);
assert.throws(() => cyclic.start(), /循环/);
assert.equal(cyclic.isEnabled("alpha"), false);
const lifecyclePaths = isolated("failure");
let fail = false;
let cleanups = 0;
const failure = new PluginHost(lifecyclePaths, [{ manifest: manifest("fixture"), activate: () => { if (fail) throw Error("activation failed"); return () => cleanups++; }, beforeDisable: () => { if (fail) throw Error("busy"); } }]);
failure.start();
fail = true;
assert.throws(() => failure.setEnabled("fixture", false), /busy/);
assert.equal(failure.isEnabled("fixture"), true);
fail = false;
const release = failure.acquire("fixture");
assert.throws(() => failure.setEnabled("fixture", false), /请求仍在处理/);
release(); release();
failure.setEnabled("fixture", false);
assert.equal(cleanups, 1);
assert.throws(() => failure.acquire("fixture"), /已停用/);
fail = true;
assert.throws(() => failure.setEnabled("fixture", true), /activation failed/);
assert.equal(failure.isEnabled("fixture"), false);
assert.equal(JSON.parse(fs.readFileSync(path.join(lifecyclePaths.pluginsDir, "registry.json"))).enabled.fixture, false);
fail = false;
const registryPath = path.join(lifecyclePaths.pluginsDir, "registry.json");
fs.renameSync(registryPath, registryPath + ".saved");
fs.mkdirSync(registryPath);
assert.throws(() => failure.setEnabled("fixture", true));
assert.equal(failure.isEnabled("fixture"), false);
assert.equal(cleanups, 2, "failed persistence disposes the newly activated runtime");
fs.rmdirSync(registryPath);
fs.renameSync(registryPath + ".saved", registryPath);
failure.stop();
let healthCalls = 0;
let healthFailure = false;
const diagnostics = new PluginHost(isolated("diagnostics"), [
  { manifest: manifest("legacy"), healthCheck: () => "healthy" },
  { manifest: manifest("reported"), healthCheck: () => {
    healthCalls++;
    if (healthFailure) throw Error("private fixture detail");
    return { health: "degraded", message: "Recovery pending", checkedAt: "2026-10-11T00:00:00Z", busy: true };
  } }
]);
diagnostics.start();
assert.equal(diagnostics.snapshot("legacy").health, "healthy", "legacy string health remains compatible");
const reported = diagnostics.snapshot("reported");
assert.equal(healthCalls, 1, "a snapshot evaluates custom health once");
assert.equal(reported.diagnostics.message, "Recovery pending");
assert.equal(reported.diagnostics.checkedAt, "2026-10-11T00:00:00Z");
assert.equal(reported.diagnostics.busy, true);
const admitted = diagnostics.acquire("legacy");
assert.equal(diagnostics.snapshot("legacy").diagnostics.activeRequests, 1);
assert.equal(diagnostics.snapshot("legacy").diagnostics.busy, true);
admitted();
assert.equal(diagnostics.snapshot("legacy").diagnostics.busy, false);
healthFailure = true;
assert.equal(diagnostics.snapshot("reported").health, "degraded");
assert.doesNotMatch(JSON.stringify(diagnostics.snapshot("reported")), /private fixture detail/, "exceptions must not leak through public diagnostics");
diagnostics.setEnabled("reported", false);
assert.equal(diagnostics.snapshot("reported").health, "disabled");
assert.equal(diagnostics.snapshot("reported").diagnostics.busy, false);
assert.ok(diagnostics.publicList().every((plugin) => !("runtimeDirectory" in plugin)));
diagnostics.stop();
fs.writeFileSync(registryPath, "not json");
assert.throws(() => new PluginHost(lifecyclePaths, [{ manifest: manifest("fixture") }]).start(), /配置损坏/);
assert.equal(fs.readFileSync(registryPath, "utf8"), "not json");
fs.rmSync(root, { recursive: true, force: true });
console.log("plugin host lifecycle and persistence passed");
