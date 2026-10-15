import assert from "node:assert/strict";

const { normalizeAgentDisplayStatus, selectAgentDisplaySnapshot } = await import("../src/agents/agentDisplayState.ts");

const snapshot = (status, revision, updatedAt = "2026-10-06T00:00:00.000Z") => ({ status, revision, updatedAt });

assert.equal(normalizeAgentDisplayStatus("completed"), "completed");
assert.equal(normalizeAgentDisplayStatus("unexpected"), "unknown");
assert.deepEqual(selectAgentDisplaySnapshot(snapshot("running", 1), snapshot("completed", 2)), snapshot("completed", 2), "newer terminal summary wins over stale detail");
assert.deepEqual(selectAgentDisplaySnapshot(snapshot("running", 3), snapshot("completed", 3)), snapshot("completed", 3), "terminal state wins when snapshots have equal freshness");
assert.deepEqual(selectAgentDisplaySnapshot(snapshot("completed", 4), snapshot("running", 3)), snapshot("completed", 4), "newer detail wins over older summary");
assert.deepEqual(selectAgentDisplaySnapshot(snapshot("running", 5), snapshot("running", 5)), snapshot("running", 5), "detail remains preferred when both snapshots are current");
assert.equal(selectAgentDisplaySnapshot(null, snapshot("completed", 2))?.status, "completed");

console.log("Agent display state freshness and terminal precedence passed");
