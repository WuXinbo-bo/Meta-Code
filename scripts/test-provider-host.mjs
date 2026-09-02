import assert from "node:assert/strict";
import { ProviderHostRegistry } from "../server/providers/host.ts";

const capabilities = {
  sessions: { create: true, resume: true, fork: false },
  execution: { stream: true, cancel: true, steer: false },
  workspace: { read: true, write: true },
  tools: { shell: true, web: false, mcp: true },
  delegation: { worker: false, nativeSubagents: false },
  workflow: { planner: false, worker: false },
  configuration: { models: false, reasoningEffort: false, reasoningEffortValues: [], permissionProfile: true }
};

const manifest = (id, adapterId) => ({
  sdkVersion: 1,
  id,
  adapterId,
  runtimeId: id,
  displayName: id,
  shortName: id,
  description: "fixture",
  displayOrder: 1,
  capabilities,
  branding: { icon: id, accent: "#111111" },
  skillProjection: { strategy: "prompt", invocationPrefix: "" },
  configurationSchema: { modelSource: "none", reasoning: { type: "none" } }
});

const host = new ProviderHostRegistry();
const nativeRunner = async () => "native";
const acpRunner = async () => "acp";
host.registerNativeProvider({ manifest: manifest("native-fixture", "native-fixture"), mainSession: nativeRunner });
const acpManifest = manifest("acp-fixture", "acp-v1");
acpManifest.capabilities = { ...capabilities, delegation: { worker: true, nativeSubagents: false } };
host.registerAcpProvider({
  manifest: acpManifest,
  mainSession: acpRunner,
  delegation: { execute: async (request) => ({ taskId: request.taskId, providerId: request.providerId }) },
  launch: { command: "fixture-agent", args: ["--acp"], env: { FIXTURE_SECRET: "hidden" }, registryId: "fixture", version: "1.0.0" }
});

assert.equal(host.mainRunner("native-fixture"), nativeRunner);
assert.equal(host.mainRunner("acp-fixture"), acpRunner);
assert.deepEqual(await host.execute({ schemaVersion: 3, providerId: "acp-fixture", taskId: "worker-1" }), { taskId: "worker-1", providerId: "acp-fixture" });
assert.equal(host.registeredCapabilities("acp-fixture").delegation, true);
assert.deepEqual(host.providerSnapshot("native-fixture"), { providerId: "native-fixture", transport: "native", enhanced: true });
assert.deepEqual(host.providerSnapshot("acp-fixture"), {
  providerId: "acp-fixture",
  transport: "acp",
  enhanced: false,
  acp: { launch: { command: "fixture-agent", args: ["--acp"], registryId: "fixture", version: "1.0.0" } }
});
assert.equal(JSON.stringify(host.providerSnapshots()).includes("FIXTURE_SECRET"), false);
host.updateAcpHandshake("acp-fixture", {
  protocolVersion: 1,
  agentInfo: { name: "Fixture", version: "1.0.0" },
  agentCapabilities: { sessionCapabilities: { resume: {} } }
});
assert.equal(host.providerSnapshot("acp-fixture").acp.protocolVersion, 1);
assert.ok(host.providerSnapshot("acp-fixture").acp.capabilities.sessionCapabilities.resume);

console.log("provider host native/ACP transport boundary passed");
