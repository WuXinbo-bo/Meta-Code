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
fs.rmSync(root, { recursive: true, force: true });
console.log("plugin host lifecycle and persistence passed");
