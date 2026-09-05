import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishRuntimeInstallation, CliRuntimeManager } from "../server/runtime/manager.ts";
import { AgentMarketStore } from "../server/providers/market.ts";
import { nodeToolchainEnvironment } from "../server/runtime/nodeEnvironment.ts";
import { runtimeInstallationAction } from "../src/runtimeInstallation.ts";
import { createProviderControlSnapshot } from "../server/providers/controlPlane.ts";
import { BUILTIN_AGENT_DESCRIPTORS } from "../server/agents/catalog.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-installation-"));
try {
  const store = new AgentMarketStore(root, { list: async () => { throw new Error("offline"); } });
  const catalog = await store.catalog([
    { id: "codex", name: "Codex", version: "", description: "native", installed: false },
    { id: "claude", name: "Claude", version: "", description: "native", installed: false }
  ]);
  assert.equal(catalog.items.length, 2);
  assert.ok(catalog.registryWarning);
  assert.ok(catalog.items.every((item) => !item.installed && item.installable));
  const preparable = runtimeInstallationAction({ available: false, npmAvailable: false, installation: { supported: true, environment: "preparable", requiresNpm: true } });
  assert.equal(preparable.supported, true);
  assert.ok(preparable.environmentMessage);
  assert.equal(runtimeInstallationAction({ available: false, npmAvailable: false, installation: { supported: true, environment: "ready", requiresNpm: false } }).supported, true);
  assert.equal(runtimeInstallationAction({ available: false, managed: { installed: true, healthy: false } }).repair, true);

  const target = path.join(root, "versions", "1.0.0");
  const staging = path.join(root, "staging");
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(staging);
  await fs.writeFile(path.join(target, "cli"), "old");
  await fs.writeFile(path.join(staging, "cli"), "replacement");
  await assert.rejects(publishRuntimeInstallation(staging, target, true, async () => {
    assert.equal(await fs.readFile(path.join(target, "cli"), "utf8"), "replacement");
    throw new Error("certification failed");
  }), /certification failed/);
  assert.equal(await fs.readFile(path.join(target, "cli"), "utf8"), "old");
  await fs.mkdir(staging);
  await fs.writeFile(path.join(staging, "cli"), "repaired");
  await publishRuntimeInstallation(staging, target, true, async () => true);
  assert.equal(await fs.readFile(path.join(target, "cli"), "utf8"), "repaired");
  assert.deepEqual(await fs.readdir(path.dirname(target)), ["1.0.0"]);

  const manager = new CliRuntimeManager(root, path.join(root, "runtimes"));
  const brokenRoot = path.join(manager.runtimeRoot("codex"), "versions", "1.0.0");
  await fs.mkdir(brokenRoot, { recursive: true });
  await manager.activate("codex", "1.0.0");
  manager.configure({ selections: { codex: { mode: "managed" } } });
  const status = await manager.detect("codex");
  assert.equal(status.available, false);
  assert.equal(status.managed.healthy, false);
  assert.equal(status.managed.installed, true);
  const descriptor = BUILTIN_AGENT_DESCRIPTORS.find((item) => item.id === "codex");
  assert.ok(descriptor);
  const missingControl = createProviderControlSnapshot({ descriptor, runtime: { ...status, managed: { ...status.managed, installed: false } } });
  assert.equal(missingControl.lifecycle.installed, false);
  const installedControl = createProviderControlSnapshot({ descriptor, runtime: { ...status, available: true } });
  assert.equal(installedControl.connection.status, "attention");
  const env = nodeToolchainEnvironment(path.join(root, "node.exe"), { Path: "old-path", ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(env.Path, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.ok(env.PATH.startsWith(root + path.delimiter));
  console.log("Clean market states, dependency-aware actions, same-version repair and rollback passed");
} finally { await fs.rm(root, { recursive: true, force: true }); }
