import assert from "node:assert/strict";
import { BUILTIN_AGENT_DESCRIPTORS } from "../server/agents/catalog.ts";
import {
  AGENT_ADAPTER_SDK_VERSION,
  assertAgentAdapterV1,
  normalizeAgentProviderManifest,
  normalizeReasoningControl
} from "../server/agents/types.ts";

for (const manifest of BUILTIN_AGENT_DESCRIPTORS) {
  assert.equal(manifest.sdkVersion, AGENT_ADAPTER_SDK_VERSION);
  assert.equal(normalizeAgentProviderManifest(manifest).id, manifest.id);
  assert.ok(manifest.configurationSchema.reasoning.type !== "none");
}

const numeric = normalizeReasoningControl({ type: "number", minimum: 1, maximum: 128, step: 8, unit: "tokens" });
assert.deepEqual(numeric, { type: "number", minimum: 1, maximum: 128, step: 8, unit: "tokens" });

const gemini = normalizeAgentProviderManifest({
  id: "gemini",
  adapterId: "gemini-json-stream",
  runtimeId: "gemini",
  displayName: "Gemini CLI",
  shortName: "Gemini",
  description: "Fixture provider",
  displayOrder: 30,
  branding: { icon: "gemini", accent: "#1a73e8" },
  capabilities: {
    sessions: { create: false, resume: false, fork: false },
    execution: { stream: true, cancel: true, steer: false },
    workspace: { read: true, write: true },
    tools: { shell: true, web: true, mcp: false },
    delegation: { worker: true, nativeSubagents: false },
    workflow: { planner: false, worker: false },
    configuration: { models: true, reasoningEffort: true, reasoningEffortValues: [] , permissionProfile: true }
  },
  configurationSchema: {
    modelSource: "adapter",
    reasoning: { type: "number", minimum: 0, maximum: 32768, step: 1024, unit: "tokens" }
  },
  skillProjection: { strategy: "prompt", invocationPrefix: "" }
});
assert.equal(gemini.configurationSchema.reasoning.type, "number");

assert.throws(() => assertAgentAdapterV1({
  sdkVersion: 1,
  manifest: gemini
}), /缺少绑定/);

const valid = assertAgentAdapterV1({
  sdkVersion: 1,
  manifest: gemini,
  delegation: { execute: async () => ({ ok: true }) },
  models: {
    listModels: async () => ({ models: [], source: "adapter", fetchedAt: new Date(0).toISOString() }),
    getSelection: () => ({ model: "gemini-test", reasoningValue: 1024 }),
    updateSelection: async (selection) => selection
  }
});
assert.equal(valid.id, "gemini");

console.log("Agent Adapter SDK V1 manifest and capability contracts passed");
