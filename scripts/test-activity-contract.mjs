import assert from "node:assert/strict";
import { canonicalActivity, normalizeCanonicalActivity } from "../server/activity/normalize.ts";
import { canonicalActivityFromEngineEvent } from "../server/activity/fromEngineEvent.ts";
import { codexActivityFromEvent, isCodexContextCompactionNotice } from "../server/engines/codex/events.ts";
import { normalizeAgentStreamLog } from "../src/components/activityModel.ts";
import { compactStoredActivityDetails } from "../server/activity/redaction.ts";

const activity = canonicalActivity({
  id: "command-1",
  rawType: "command_execution",
  provider: "codex",
  actor: { kind: "delegated", id: "agent-1", parentId: "session-1" },
  semanticType: "command",
  phase: "completed",
  title: "执行命令",
  summary: "npm test",
  detail: { command: "npm test", apiKey: "must-not-leak" }
});
assert.equal(activity.schemaVersion, 1);
assert.equal(activity.actor.kind, "delegated");
assert.equal(activity.detail.apiKey, "[已隐藏]");

const malformed = normalizeCanonicalActivity(null);
assert.equal(malformed.semanticType, "unknown");
assert.equal(malformed.provider, "unknown");
assert.equal(malformed.phase, "started");

const unknownTopLevel = codexActivityFromEvent({ type: "future.notification", id: "future-1", value: 42 });
assert.equal(unknownTopLevel.category, "unknown");
assert.notEqual(unknownTopLevel.phase, "failed");
assert.equal(unknownTopLevel.rawType, "future.notification");
assert.equal(unknownTopLevel.diagnostics?.[0]?.code, "unknown_codex_event");

const unknownItem = codexActivityFromEvent({ type: "item.completed", item: { id: "future-item", type: "new_sdk_item", status: "completed", value: 42 } });
assert.equal(unknownItem.category, "unknown");
assert.equal(unknownItem.phase, "completed");
assert.equal(unknownItem.diagnostics?.[0]?.code, "unknown_codex_item");

const compactionMessage = "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.";
assert.equal(isCodexContextCompactionNotice(compactionMessage), true);
const compactionNotice = codexActivityFromEvent({ type: "item.completed", item: { id: "compact-1", type: "error", message: compactionMessage } });
assert.equal(compactionNotice.rawType, "context_compaction");
assert.equal(compactionNotice.category, "status");
assert.equal(compactionNotice.phase, "completed");
assert.equal(compactionNotice.title, "上下文已整理");

assert.equal(isCodexContextCompactionNotice("Context compaction failed: server disconnected"), false);
const genuineError = codexActivityFromEvent({ type: "item.completed", item: { id: "error-1", type: "error", message: "sandbox initialization failed" } });
assert.equal(genuineError.rawType, "error");
assert.equal(genuineError.category, "error");
assert.equal(genuineError.phase, "failed");

const legacy = normalizeAgentStreamLog({ id: "legacy", kind: "tool", title: "Bash", text: "echo ok" });
assert.equal(legacy.id, "legacy");
assert.equal(legacy.schemaVersion, undefined);

const canonicalView = normalizeAgentStreamLog({
  id: activity.id,
  createdAt: activity.occurredAt,
  kind: "tool",
  title: activity.title,
  text: activity.summary,
  category: activity.semanticType,
  phase: activity.phase,
  ...activity
});
assert.equal(canonicalView.schemaVersion, 1);
assert.equal(canonicalView.rawType, "command_execution");
assert.equal(canonicalView.actor?.id, "agent-1");

const largeOutput = "x".repeat(80_000);
const duplicatedMessage = {
  activityDetail: { command: "npm test", output: largeOutput },
  activity: { detail: { command: "npm test", output: largeOutput }, artifactRefs: [{ id: "diff-1" }] }
};
const duplicatedBytes = JSON.stringify(duplicatedMessage).length;
assert.equal(compactStoredActivityDetails(duplicatedMessage), true);
assert.equal(duplicatedMessage.activityDetail, undefined);
assert.ok(duplicatedMessage.activity.detail.output.length < largeOutput.length);
assert.ok(JSON.stringify(duplicatedMessage).length < duplicatedBytes / 2);
assert.deepEqual(duplicatedMessage.activity.artifactRefs, [{ id: "diff-1" }]);

const legacyOnlyMessage = { activityDetail: { output: "legacy output" } };
assert.equal(compactStoredActivityDetails(legacyOnlyMessage), false);
assert.deepEqual(legacyOnlyMessage.activityDetail, { output: "legacy output" });

const unequalMessage = { activityDetail: { output: "legacy" }, activity: { detail: { output: "canonical" } } };
compactStoredActivityDetails(unequalMessage);
assert.deepEqual(unequalMessage.activityDetail, { output: "legacy" });

const nestedView = normalizeAgentStreamLog({
  id: "legacy-shell",
  createdAt: "2020-01-01T00:00:00.000Z",
  kind: "tool",
  title: "旧标题",
  text: "旧摘要",
  activity
});
assert.equal(nestedView.id, "command-1");
assert.equal(nestedView.title, "执行命令");
assert.equal(nestedView.category, "command");
assert.equal(nestedView.provider, "codex");

const commonEvent = { type: "tool.completed", rawType: "assistant.tool_result", sourceId: "tool-1", toolName: "Bash", text: "ok", detail: { input: { command: "npm test" }, output: "ok" } };
const actorKinds = ["main", "native", "delegated", "workflow"];
const acrossSurfaces = actorKinds.map((kind) => canonicalActivityFromEngineEvent(commonEvent, { provider: "claude", actor: { kind, id: `${kind}-1` } }));
assert.ok(acrossSurfaces.every((entry) => entry.semanticType === "command" && entry.phase === "completed" && entry.rawType === "assistant.tool_result"));

const malformedValues = [undefined, null, 0, true, "event", [], [null], { actor: [] }, { phase: "impossible" }, { semanticType: "future_type" }];
for (let index = 0; index < 500; index += 1) assert.doesNotThrow(() => normalizeCanonicalActivity(malformedValues[index % malformedValues.length]));
const largeLogSet = Array.from({ length: 10_000 }, (_, index) => ({ id: `log-${index}`, createdAt: new Date(index).toISOString(), kind: "tool", title: "Bash", text: `echo ${index}`, category: "command", phase: "completed" }));
const startedAt = performance.now();
const largeNormalized = largeLogSet.map(normalizeAgentStreamLog);
assert.equal(largeNormalized.length, 10_000);
assert.ok(performance.now() - startedAt < 2_000, "10k legacy activity records should normalize within the render safety budget");

console.log("Versioned activity contract and tolerant provider adapters OK");
