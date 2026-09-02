import assert from "node:assert/strict";
import { BUILTIN_AGENT_DESCRIPTORS } from "../server/agents/catalog.ts";
import { AgentAdapterRegistry } from "../server/agents/registry.ts";
import { canonicalActivity } from "../server/activity/normalize.ts";
import { normalizeWorkflowPlan, validateWorkflowPlan } from "../server/workflows/plan.ts";
import { CLI_REGISTRY } from "../server/runtime/registry.ts";

const custom = {
  id: "fixture-cli",
  adapterId: "fixture-json-stream",
  runtimeId: "fixture-cli",
  displayName: "Fixture CLI",
  shortName: "Fixture",
  description: "Contract test provider",
  displayOrder: 90,
  branding: { icon: "fixture", accent: "#333333" },
  capabilities: {
    sessions: { create: false, resume: false, fork: false },
    execution: { stream: true, cancel: true, steer: false },
    workspace: { read: true, write: false },
    tools: { shell: false, web: false, mcp: false },
    delegation: { worker: true, nativeSubagents: false },
    workflow: { planner: false, worker: false },
    configuration: { models: false, reasoningEffort: false, reasoningEffortValues: [], permissionProfile: false }
  },
  skillProjection: { strategy: "prompt", invocationPrefix: "" }
};

const registry = new AgentAdapterRegistry(BUILTIN_AGENT_DESCRIPTORS);
for (const descriptor of BUILTIN_AGENT_DESCRIPTORS) {
  assert.equal(CLI_REGISTRY[descriptor.runtimeId]?.providerId, descriptor.id);
  assert.equal(CLI_REGISTRY[descriptor.runtimeId]?.adapterId, descriptor.adapterId);
}
registry.registerAdapter({
  descriptor: custom,
  execute: async (request) => ({ providerId: request.providerId, prompt: request.prompt })
});

assert.deepEqual(registry.list().map((item) => item.id), ["claude", "codex", "fixture-cli"]);
assert.equal(registry.supports("fixture-cli", ["execution.stream", "workspace.read"]), true);
assert.equal(registry.supports("fixture-cli", ["workspace.write"]), false);
assert.equal(registry.supports("codex", ["workspace-write", "terminal", "network"]), true);
assert.deepEqual(registry.requireCapabilities("codex", ["workspace-write", "terminal", "network"]), ["workspace.write", "tools.shell", "tools.web"]);
assert.deepEqual(registry.requireCapabilities("claude", ["WORKSPACE_WRITE", "Terminal", "Network"]), ["workspace.write", "tools.shell", "tools.web"]);
assert.deepEqual(await registry.execute({ schemaVersion: 3, providerId: "fixture-cli", prompt: "hello" }), { providerId: "fixture-cli", prompt: "hello" });
await assert.rejects(() => registry.execute({ schemaVersion: 3, providerId: "fixture-cli", capabilityRequirements: ["workspace.write"] }), /未启用：workspace\.write/);
await assert.rejects(() => registry.execute({ schemaVersion: 3, providerId: "fixture-cli", capabilityRequirements: ["filesystem.magic"] }), /未知能力：filesystem\.magic/);
await assert.rejects(() => registry.execute({ schemaVersion: 3, providerId: "not-registered" }), /未注册/);

const v1Manifest = normalizeManifestForFixture({
  ...custom,
  id: "fixture-v1",
  adapterId: "fixture-v1-json-stream",
  capabilities: {
    ...custom.capabilities,
    sessions: { create: true, resume: false, fork: false },
    workflow: { planner: true, worker: true },
    configuration: { ...custom.capabilities.configuration, models: true }
  },
  configurationSchema: { modelSource: "adapter", reasoning: { type: "none" } }
});
const mainRunner = async () => "main";
const plannerRunner = async () => "plan";
const workerRunner = async () => "worker";
const modelAdapter = {
  listModels: async () => ({ models: [{ id: "fixture-1", displayName: "Fixture 1" }], source: "adapter", fetchedAt: new Date(0).toISOString() }),
  getSelection: () => ({ model: "fixture-1" }),
  updateSelection: async (selection) => selection
};
registry.registerV1Adapter({
  sdkVersion: 1,
  manifest: v1Manifest,
  delegation: { execute: async (request) => ({ providerId: request.providerId }) },
  mainSession: mainRunner,
  workflow: { planner: plannerRunner, worker: workerRunner },
  models: modelAdapter
});
assert.equal(registry.mainRunner("fixture-v1"), mainRunner);
assert.equal(registry.workflowPlannerRunner("fixture-v1"), plannerRunner);
assert.equal(registry.workflowWorkerRunner("fixture-v1"), workerRunner);
assert.equal(registry.modelAdapter("fixture-v1"), modelAdapter);
assert.deepEqual(registry.registeredCapabilities("fixture-v1"), {
  mainSession: true, delegation: true, workflowPlanner: true, workflowWorker: true, models: true
});
assert.deepEqual(await registry.execute({ schemaVersion: 3, providerId: "fixture-v1" }), { providerId: "fixture-v1" });

const activity = canonicalActivity({
  id: "fixture-event",
  rawType: "fixture.delta",
  provider: "fixture-cli",
  actor: { kind: "delegated", id: "worker-1" },
  semanticType: "unknown",
  phase: "running",
  title: "Fixture event",
  summary: "Forward compatible"
});
assert.equal(activity.provider, "fixture-cli");
assert.equal(activity.semanticType, "unknown");

const plan = normalizeWorkflowPlan({
  planSchemaVersion: 3,
  title: "Provider contract",
  summary: "Provider contract",
  assumptions: [], questions: [], risks: [],
  finalDelivery: { required: false, directory: "deliverables", primary: null, format: "", additional: [], producerNodeId: null, reason: "contract test" },
  audit: { status: "passed", checks: [], changes: [] },
  nodes: [{
    id: "read-node", title: "Read", objective: "Read input", nonGoals: [], constraints: [], dependsOn: [],
    provider: "fixture-cli", providerReason: "Read capability", skills: [], mcpServers: [], mcpRequired: false,
    workspaceAccess: "read", writeScope: [], requiredArtifacts: [], deliverables: [], acceptance: ["read"],
    verificationCommands: [], failurePolicy: "review", required: true
  }]
});
assert.equal(plan.nodes[0].provider, "fixture-cli");
const validation = validateWorkflowPlan(plan, new Set(), new Set(), {
  providers: { "fixture-cli": { displayName: "Fixture", available: true, workspaceRead: true, workspaceWrite: false } },
  defaults: { read: "fixture-cli", write: "fixture-cli" }
});
assert.equal(validation.some((error) => error.includes("未注册的 Provider")), false);

console.log("agent adapter registry contract passed");

function normalizeManifestForFixture(descriptor) {
  return {
    ...descriptor,
    sdkVersion: 1,
    configurationSchema: descriptor.configurationSchema || { modelSource: "none", reasoning: { type: "none" } }
  };
}
