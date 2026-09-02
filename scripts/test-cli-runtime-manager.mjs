import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliRuntimeManager, runtimeUpdateDecision } from "../server/runtime/manager.ts";
import { resolveClaudeCommand } from "../server/engines/claude/runtime.ts";
import { CLI_REGISTRY } from "../server/runtime/registry.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "metacode-cli-manager-"));
const runtimes = path.join(root, "runtimes");
const manager = new CliRuntimeManager(root, runtimes);

assert.deepEqual(runtimeUpdateDecision("managed", "", "2.0.0"), { state: "not-installed", action: "install" });
assert.deepEqual(runtimeUpdateDecision("managed", "1.0.0", "2.0.0"), { state: "available", action: "update" });
assert.deepEqual(runtimeUpdateDecision("managed", "2.0.0", "2.0.0"), { state: "latest", action: "none" });
assert.deepEqual(runtimeUpdateDecision("managed", "3.0.0", "2.0.0"), { state: "newer-local", action: "none" });
assert.deepEqual(runtimeUpdateDecision("system", "1.0.0", "2.0.0"), { state: "external", action: "install-managed" });

const systemManager = new CliRuntimeManager(root, path.join(root, "system-runtimes"));
systemManager.definition = () => ({
  id: "codex", label: "Test CLI", command: "test", distribution: { kind: "npm", packageName: "test", defaultVersion: "latest" },
  executableCandidates: () => [], bundledRoots: () => [], systemCandidates: async () => [process.execPath],
  probe: async (candidate) => candidate === process.execPath ? process.version : ""
});
systemManager.configure({ selections: { codex: { mode: "system", systemPath: process.execPath } } });
assert.equal((await systemManager.detect("codex")).source, "system");
systemManager.configure({ selections: { codex: { mode: "system", systemPath: path.join(root, "missing-cli") } } });
assert.equal((await systemManager.detect("codex")).available, false, "an explicitly selected missing system path must not silently switch candidates");
assert.equal((await systemManager.discoverSystem("codex")).available, true, "a fresh discovery must ignore a stale explicit system path");

CLI_REGISTRY["test-tool"] = {
  id: "test-tool", label: "Test Tool CLI", command: "test-tool", distribution: { kind: "npm", packageName: "test-tool", defaultVersion: "latest" },
  executableCandidates: () => [], bundledRoots: () => [], systemCandidates: async () => [process.execPath],
  probe: async (candidate) => candidate === process.execPath ? process.version : ""
};
const extensibleManager = new CliRuntimeManager(root, path.join(root, "extensible-runtimes"));
extensibleManager.configure({ selections: { "test-tool": { mode: "system" } } });
assert.ok(extensibleManager.ids().includes("test-tool"));
assert.equal(extensibleManager.catalog().find((item) => item.id === "test-tool")?.label, "Test Tool CLI");
assert.equal((await extensibleManager.detect("test-tool")).source, "system");
delete CLI_REGISTRY["test-tool"];

manager.configure({ selections: { codex: { mode: "custom", customPath: process.execPath } } });
const customSelection = await manager.detect("codex");
assert.equal(customSelection.available, true);
assert.equal(customSelection.source, "configured");
assert.equal(customSelection.selectionMode, "custom");
assert.ok(customSelection.candidates.some((candidate) => candidate.source === "configured"));

manager.configure({ selections: { codex: { mode: "managed" } } });
const missingManagedSelection = await manager.detect("codex");
assert.equal(missingManagedSelection.available, false);
assert.equal(missingManagedSelection.selectionMode, "managed");

manager.configure({});

for (const version of ["1.0.0", "2.0.0"]) fs.mkdirSync(path.join(runtimes, "codex", "versions", version), { recursive: true });
await manager.activate("codex", "2.0.0");
assert.equal(manager.activeVersion("codex"), "2.0.0");
assert.deepEqual(manager.installedVersions("codex"), ["2.0.0", "1.0.0"]);
await manager.rollback("codex");
assert.equal(manager.activeVersion("codex"), "1.0.0");
manager.configure({ selections: { codex: { mode: "custom", customPath: process.execPath } } });
const diagnostics = await manager.diagnostics("codex", process.execPath);
assert.equal(diagnostics.status.available, true);
assert.deepEqual(diagnostics.installedVersions, ["2.0.0", "1.0.0"]);

manager.registerDefinition({
  id: "failing-tool",
  label: "Failing Tool CLI",
  command: "failing-tool",
  distribution: { kind: "direct", version: "2.0.0", platforms: {} },
  executableCandidates: () => [],
  bundledRoots: () => [],
  systemCandidates: async () => [],
  probe: async () => ""
});
const failingRoot = manager.runtimeRoot("failing-tool");
fs.mkdirSync(path.join(failingRoot, "versions", "1.0.0"), { recursive: true });
await manager.activate("failing-tool", "1.0.0");
manager.configure({ selections: { "failing-tool": { mode: "managed" } } });
await assert.rejects(manager.install("failing-tool", "2.0.0"), /不支持当前平台/);
assert.equal(manager.activeVersion("failing-tool"), "1.0.0", "a failed update must preserve the active version");
assert.equal(manager.progress("failing-tool")?.phase, "failed");
assert.equal(fs.readdirSync(failingRoot).some((entry) => entry.startsWith(".staging-")), false, "failed staging directories must be removed");
delete CLI_REGISTRY["failing-tool"];

const claudeWrapper = path.join(root, "claude.cmd");
const nativeClaude = path.join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
fs.mkdirSync(path.dirname(nativeClaude), { recursive: true });
fs.writeFileSync(claudeWrapper, "@echo off\n");
fs.writeFileSync(nativeClaude, "native placeholder\n");
assert.deepEqual(resolveClaudeCommand(claudeWrapper), { executable: nativeClaude, args: [] });

if (process.platform === "win32") {
  const installRoot = path.join(root, "claude-install");
  const platformClaude = path.join(installRoot, "node_modules", "@anthropic-ai", `claude-code-${process.platform}-${process.arch}`, "claude.exe");
  fs.mkdirSync(path.dirname(platformClaude), { recursive: true });
  fs.writeFileSync(platformClaude, "native claude");
  await manager.definition("claude").finalizeInstallation?.(installRoot);
  assert.equal(fs.readFileSync(path.join(installRoot, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), "utf8"), "native claude");
}

fs.rmSync(root, { recursive: true, force: true });
console.log("CLI runtime registry, activation, rollback, and diagnostics tests passed");
