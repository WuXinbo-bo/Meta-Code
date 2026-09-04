import assert from "node:assert/strict";
import { normalizeProviderConnection, providerConnectionConfigValues, providerConnectionEnvironment, publicProviderConnection } from "../server/providers/connections.ts";
import { createProviderControlSnapshot, providerActiveEnvironment, providerConfiguration, providerManagedEnvironment } from "../server/providers/controlPlane.ts";

const profile = normalizeProviderConnection({
  providerId: "gemini", name: "Relay", authMode: "custom-endpoint", baseUrl: "https://relay.example/v1/",
  authMethodId: "gemini-api-key", apiKey: "legacy-secret", apiKeyEnv: "LEGACY_API_KEY", baseUrlEnv: "GEMINI_BASE_URL",
  env: { REGION: "test" }, secretEnv: { GEMINI_API_KEY: "secret-value" }, isDefault: true
}, "owner-1");
assert.equal(profile.baseUrl, "https://relay.example/v1");
assert.deepEqual(providerConnectionEnvironment(profile), { REGION: "test", GEMINI_API_KEY: "secret-value", GEMINI_BASE_URL: "https://relay.example/v1", LEGACY_API_KEY: "legacy-secret" });
assert.equal(publicProviderConnection(profile).apiKeyConfigured, true);
assert.deepEqual(publicProviderConnection(profile).secretEnvConfigured, ["GEMINI_API_KEY"]);
assert.equal("apiKey" in publicProviderConnection(profile), false);
assert.equal("secretEnv" in publicProviderConnection(profile), false);
assert.equal(profile.healthStatus, "unknown");
assert.deepEqual(profile.configOptions, []);
assert.deepEqual(profile.configValues, {});
assert.equal(profile.negotiatedCapabilities, null);
const control = providerConfiguration("gemini", [{ id: "gemini-api-key", name: "API key" }]);
assert.equal(control.authMethods[0].id, "gemini-api-key");
assert.ok(control.fields.some((field) => field.env === "GEMINI_API_KEY" && field.kind === "secret"));
const codexControl = providerConfiguration("codex");
assert.deepEqual(codexControl.authMethods.map((method) => method.id), ["workbench-account", "system-account", "openai-api-key", "openai-compatible"]);
assert.ok(codexControl.fields.some((field) => field.env === "OPENAI_API_KEY" && field.kind === "secret"));
const claudeControl = providerConfiguration("claude");
assert.deepEqual(claudeControl.authMethods.map((method) => method.id), ["workbench-account", "system-account", "anthropic-api-key", "anthropic-compatible"]);
assert.deepEqual(providerManagedEnvironment("gemini", "native-account", "C:/data/providers"), { GEMINI_CLI_HOME: "C:\\data\\providers\\gemini" });
assert.deepEqual(providerManagedEnvironment("gemini", "system-profile", "C:/data/providers"), {});
assert.deepEqual(providerActiveEnvironment("gemini", "gemini-api-key", { GEMINI_API_KEY: "key", GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "project", GOOGLE_GEMINI_BASE_URL: "https://gateway.example" }), { GEMINI_API_KEY: "key", GOOGLE_GEMINI_BASE_URL: "https://gateway.example" });
assert.deepEqual(providerActiveEnvironment("gemini", "vertex-ai", { GEMINI_API_KEY: "key", GOOGLE_API_KEY: "google", GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "project" }), { GOOGLE_API_KEY: "google", GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "project" });
assert.throws(() => normalizeProviderConnection({ providerId: "gemini", env: { PATH: "blocked" } }, "owner-1"), /环境变量/);
assert.throws(() => normalizeProviderConnection({ providerId: "gemini", baseUrl: "file:///secret" }, "owner-1"), /HTTP/);

const descriptor = {
  id: "gemini", adapterId: "acp-v1:gemini", runtimeId: "gemini", displayName: "Gemini CLI", shortName: "Gemini",
  description: "Gemini ACP", displayOrder: 100, branding: { icon: "https://example.com/gemini.png", accent: "#4285f4" },
  capabilities: {
    sessions: { create: true, resume: true, fork: false }, execution: { stream: true, cancel: true, steer: false },
    workspace: { read: true, write: true }, tools: { shell: true, web: false, mcp: true },
    delegation: { worker: false, nativeSubagents: false }, workflow: { planner: false, worker: false },
    configuration: { models: false, reasoningEffort: false, reasoningEffortValues: [], permissionProfile: true }
  },
  configurationSchema: { modelSource: "none", reasoning: { type: "none" } },
  skillProjection: { strategy: "prompt", invocationPrefix: "$" }
};
const runtime = { id: "gemini", available: true, source: "system", path: "gemini", version: "1", npmAvailable: true, networkRequired: false, message: "ready", selectionMode: "system", managed: { installed: false, activeVersion: "", installedVersions: [] } };
const acpOperations = { setDefault: true, testConnection: true, discoverModels: true, selectModel: true, authenticate: true, manageProfiles: true, dynamicSessionConfig: true };
const unverified = createProviderControlSnapshot({ descriptor, transport: { providerId: "gemini", transport: "acp", enhanced: false }, runtime, profiles: [profile], defaultProviderId: "gemini", operations: acpOperations });
assert.equal(unverified.connection.status, "attention");
assert.equal(unverified.lifecycle.stage, "needs-connection");
assert.equal(unverified.configuration.modelSource, "session");
assert.equal(unverified.configuration.scope, "profile");
assert.deepEqual(unverified.operations, { ...acpOperations, setDefault: false });
const verifiedProfile = { ...profile, healthStatus: "ready", healthCheckedAt: new Date(0).toISOString(), healthLatencyMs: 24, healthMessage: "连接已验证" };
const verified = createProviderControlSnapshot({ descriptor, transport: { providerId: "gemini", transport: "acp", enhanced: false }, runtime, profiles: [verifiedProfile], marketIcon: "https://cdn.example/gemini.svg", operations: acpOperations });
assert.equal(verified.connection.status, "ready");
assert.equal(verified.lifecycle.stage, "ready");
assert.equal(verified.operations.setDefault, true);
assert.equal(verified.identity.icon, "https://cdn.example/gemini.svg");
assert.equal(verified.connection.latencyMs, 24);
const workerOnly = createProviderControlSnapshot({
  descriptor,
  transport: { providerId: "codebuddy-code", transport: "acp", enhanced: false, acp: { launch: { command: "codebuddy" }, capabilities: { mainAgentSupport: false, loadSession: true } } },
  runtime,
  profiles: [verifiedProfile],
  operations: acpOperations
});
assert.equal(workerOnly.capabilities.sessions.create, false, "the runtime handshake must override a stale market manifest");
assert.equal(workerOnly.capabilities.sessions.resume, true);
assert.equal(workerOnly.operations.setDefault, false, "worker-only ACP agents must not be selectable as a main agent");
const renamed = normalizeProviderConnection({ providerId: "gemini", name: "Renamed" }, "owner-1", verifiedProfile);
assert.equal(renamed.healthStatus, "ready", "renaming a profile must preserve a valid connection check");
const changedCredentials = normalizeProviderConnection({ providerId: "gemini", baseUrl: "https://new-relay.example/v1" }, "owner-1", verifiedProfile);
assert.equal(changedCredentials.healthStatus, "unknown", "connection changes must invalidate the previous health check");
assert.equal(changedCredentials.healthCheckedAt, "");
const spoofedHealth = normalizeProviderConnection({ providerId: "gemini", healthStatus: "ready", healthMessage: "spoofed" }, "owner-1");
assert.equal(spoofedHealth.healthStatus, "unknown", "client input must not be able to forge a healthy connection");
const restoredHealth = normalizeProviderConnection({ ...verifiedProfile }, "owner-1", undefined, { trustPersistedHealth: true });
assert.equal(restoredHealth.healthStatus, "ready", "trusted persisted health must survive restart migration");
const negotiated = normalizeProviderConnection({
  providerId: "codebuddy-code",
  negotiatedCapabilities: { mainAgentSupport: false, loadSession: true },
  negotiatedRuntimeVersion: "2.142.0",
  negotiatedAt: new Date(0).toISOString()
}, "owner-1");
assert.equal(negotiated.negotiatedCapabilities.mainAgentSupport, false);
assert.equal(negotiated.negotiatedRuntimeVersion, "2.142.0");
const configurable = normalizeProviderConnection({ providerId: "gemini" }, "owner-1", {
  ...profile,
  configOptions: [{ type: "select", id: "model", name: "模型", category: "model", currentValue: "gemini-2.5", options: [{ value: "gemini-2.5", name: "Gemini 2.5" }, { value: "gemini-3", name: "Gemini 3" }] }],
  configValues: { model: "gemini-2.5" }
});
const configurableControl = createProviderControlSnapshot({ descriptor, transport: { providerId: "gemini", transport: "acp", enhanced: false }, runtime, profiles: [{ ...configurable, healthStatus: "ready" }], operations: acpOperations });
assert.deepEqual(configurableControl.configuration.sessionOptions, configurable.configOptions, "the default profile model catalog must be available before a task is created");
const selected = normalizeProviderConnection({ ...configurable, configValues: { model: "gemini-3", ignored: "unsafe" } }, "owner-1", configurable);
assert.deepEqual(selected.configValues, { model: "gemini-3" });
assert.deepEqual(
  providerConnectionConfigValues(selected),
  { model: "gemini-3" },
  "delegated ACP sessions must inherit the default provider profile"
);
assert.deepEqual(
  providerConnectionConfigValues(selected, { model: "gemini-2.5", mode: "plan", unsafe: 1 }),
  { model: "gemini-2.5", mode: "plan" },
  "per-delegation ACP values must override the profile while non-protocol values are ignored"
);
console.log("Provider connection validation, environment projection, and redaction tests passed");
