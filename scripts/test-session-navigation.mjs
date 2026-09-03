import assert from "node:assert/strict";
import { isSessionPayload, matchesSessionNavigation } from "../src/sessionNavigation.ts";

const complete = { id: "task-1", scopeKind: "workspace", workspaceId: "workspace-1", messages: [], pendingInputs: [] };
assert.equal(isSessionPayload(complete), true);
assert.equal(isSessionPayload({ ...complete, scopeKind: "standalone", workspaceId: "" }), true);
assert.equal(isSessionPayload(null), false, "a null response must never enter the session cache");
assert.equal(isSessionPayload({ ...complete, id: "" }), false);
assert.equal(isSessionPayload({ ...complete, messages: null }), false);
assert.equal(isSessionPayload({ ...complete, pendingInputs: {} }), false);
assert.equal(isSessionPayload({ ...complete, scopeKind: "unknown" }), false);

const pending = { phase: "loading", sessionId: "task-1", generation: 4, selectionGeneration: 7 };
assert.equal(matchesSessionNavigation(pending, { sessionId: "task-1", generation: 4, selectionGeneration: 7 }), true);
assert.equal(matchesSessionNavigation({ ...pending, phase: "idle" }, { sessionId: "task-1", generation: 4, selectionGeneration: 7 }), false);
assert.equal(matchesSessionNavigation({ ...pending, generation: 3 }, { sessionId: "task-1", generation: 4, selectionGeneration: 7 }), false, "late navigation responses must be ignored");
assert.equal(matchesSessionNavigation({ ...pending, sessionId: "task-2" }, { sessionId: "task-1", generation: 4, selectionGeneration: 7 }), false);

console.log("session payload admission and navigation identity validation passed");
