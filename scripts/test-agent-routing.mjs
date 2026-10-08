import assert from "node:assert/strict";
import { crossProviderReviewPair, resolveAgentRoute } from "../server/agents/routing.ts";
import { TraceRecorder, traceDurationMs } from "../server/observability/traces.ts";

const descriptor = (id, overrides = {}) => ({
  id, displayName: id, shortName: id, adapterId: `${id}-adapter`, runtimeId: id, description: id, displayOrder: 1,
  branding: { icon: id, accent: "#000" }, skillProjection: { strategy: "none", invocationPrefix: "" },
  capabilities: {
    sessions: { create: true, resume: true, fork: id === "codex" }, execution: { stream: true, cancel: true, steer: true },
    workspace: { read: true, write: true }, tools: { shell: true, web: true, mcp: true },
    delegation: { worker: true, nativeSubagents: true }, workflow: { planner: true, worker: true },
    configuration: { models: true, reasoningEffort: true, reasoningEffortValues: [], permissionProfile: true }, ...overrides
  }
});
const descriptors = [descriptor("codex"), descriptor("claude")];
assert.equal(resolveAgentRoute("codex", descriptors).selectedProvider, "codex");
assert.equal(resolveAgentRoute("auto", descriptors, { preferredProviders: ["claude"] }).selectedProvider, "claude");
assert.deepEqual(crossProviderReviewPair("codex", descriptors), { primary: "codex", reviewer: "claude" });
assert.throws(() => resolveAgentRoute("auto", [descriptor("readonly", { workspace: { read: true, write: false } })], { requiredCapabilities: ["workspace.write"] }));

const traces = new TraceRecorder();
const span = traces.start("delegation", "unit test", { provider: "codex", attributes: { token: "secret", attempt: 1 } });
const finished = traces.finish(span.spanId, "ok");
assert.equal(finished?.attributes.token, undefined);
assert.equal(finished?.status, "ok");
assert.equal(traces.list(span.traceId).length, 1);
assert.ok(traceDurationMs(finished) >= 0);
console.log("agent routing, cross-provider review and trace redaction passed");
