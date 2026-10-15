import assert from "node:assert/strict";
import process from "node:process";
import { BUILTIN_AGENT_DESCRIPTORS } from "../server/agents/catalog.ts";
import {
  createAgentCapabilitySnapshot,
  mergeAgentCapabilities,
  probeAgentCapabilities
} from "../server/agents/capabilityProbe.ts";
import { AgentAdapterRegistry } from "../server/agents/registry.ts";

const codex = BUILTIN_AGENT_DESCRIPTORS.find((descriptor) => descriptor.id === "codex");
assert.ok(codex, "the built-in Codex descriptor must be present");

const managedFixture = {
  ...codex,
  id: "fixture-capability",
  runtimeId: "fixture-capability",
  displayName: "Capability Fixture",
  nativeCapabilities: { sessions: { fork: true }, tools: { web: true } },
  workbenchCapabilities: { sessions: { fork: false }, tools: { web: false } },
  versionRequirements: { minAdapterSdkVersion: 1, runtimeId: "fixture-capability" },
  restrictions: [{ capability: "sessions.fork", reason: "托管模式需要审计", scope: "managed" }]
};

const native = createAgentCapabilitySnapshot(managedFixture, { mode: "native" });
assert.equal(native.mode, "native");
assert.equal(native.requestedMode, "native");
assert.equal(native.effectiveCapabilities.sessions.fork, true);
assert.equal(native.effectiveCapabilities.tools.web, true);
assert.equal(native.transportCapabilities.kind, "native");

const managed = createAgentCapabilitySnapshot(managedFixture, { mode: "managed" });
assert.equal(managed.mode, "managed");
assert.equal(managed.effectiveCapabilities.sessions.fork, false);
assert.equal(managed.effectiveCapabilities.tools.web, false);
assert.equal(managed.restrictions[0]?.scope, "managed");

const degraded = createAgentCapabilitySnapshot(managedFixture, {
  mode: "native",
  runtimeProbe: {
    status: "unavailable",
    available: false,
    error: "fixture runtime is missing"
  }
});
assert.equal(degraded.mode, "degraded");
assert.match(degraded.degradedReasons.join(" "), /fixture runtime is missing/);
assert.ok(degraded.restrictions.some((item) => item.scope === "runtime"));
assert.equal(degraded.effectiveCapabilities.sessions.create, false);

const negotiated = createAgentCapabilitySnapshot(managedFixture, {
  mode: "native",
  transportCapabilities: {
    kind: "acp",
    enhanced: false,
    standard: "acp-v1",
    capabilities: { tools: { web: false } }
  }
});
assert.equal(negotiated.mode, "native");
assert.equal(negotiated.effectiveCapabilities.tools.web, false);
assert.ok(negotiated.restrictions.some((item) => item.capability === "tools.web" && item.scope === "transport"));

const versionLimited = createAgentCapabilitySnapshot({
  ...managedFixture,
  versionRequirements: { minRuntimeVersion: "9.0.0" }
}, { runtimeProbe: { available: true, status: "ready", version: "1.0.0" } });
assert.equal(versionLimited.mode, "degraded");
assert.ok(versionLimited.restrictions.some((item) => item.scope === "version"));

const merged = mergeAgentCapabilities({ sessions: { create: true } }, { sessions: { fork: true } });
assert.equal(merged.sessions.create, true);
assert.equal(merged.sessions.fork, true);
assert.deepEqual(merged.configuration.reasoningEffortValues, []);

const probed = await probeAgentCapabilities(managedFixture, {
  runtimeProbe: { command: process.execPath, args: ["--version"] }
});
assert.equal(probed.runtimeProbe.status, "ready");
assert.equal(probed.runtimeProbe.available, true);
assert.ok(probed.runtimeProbe.version);

const registry = new AgentAdapterRegistry([managedFixture]);
assert.equal(registry.supports("fixture-capability", ["session-fork"]), true);
registry.setCapabilitySnapshot(managed);
assert.equal(registry.supports("fixture-capability", ["session-fork"]), false);
assert.throws(() => registry.requireCapabilities("fixture-capability", ["session-fork"]), /未启用/);
const refreshed = await registry.probeCapabilities("fixture-capability", { runtimeProbe: { available: false, status: "unavailable" } });
assert.equal(refreshed.mode, "degraded");
assert.equal(registry.supports("fixture-capability", ["delegation-worker"]), false);
assert.equal(registry.capabilitySnapshot("fixture-capability").mode, "degraded");

console.log("Agent capability surfaces, runtime probe, modes, transport restrictions, and registry snapshots passed");
