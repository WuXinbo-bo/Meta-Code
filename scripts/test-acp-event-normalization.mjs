import assert from "node:assert/strict";
import { normalizedEventFromAcp } from "../server/providers/acp/events.ts";
import { canonicalActivityFromEngineEvent } from "../server/activity/fromEngineEvent.ts";

const fileEvent = normalizedEventFromAcp({
  sessionId: "session-1",
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "edit-1",
    title: "Update file",
    kind: "edit",
    status: "completed",
    content: [{ type: "diff", path: "C:/workspace/file.ts", oldText: "a", newText: "b" }]
  }
});
assert.ok(fileEvent);
assert.equal(fileEvent.category, "file");
assert.equal(fileEvent.rawType, "acp.tool_call");
assert.deepEqual(fileEvent.detail.changes[0], { path: "C:/workspace/file.ts", kind: "update", oldText: "a", newText: "b" });

const canonical = canonicalActivityFromEngineEvent(fileEvent, { provider: "fixture", actor: { kind: "main" }, scope: { sessionId: "session-1" } });
assert.equal(canonical.provider, "fixture");
assert.equal(canonical.semanticType, "file");
assert.equal(canonical.phase, "completed");

const unknown = normalizedEventFromAcp({ sessionId: "session-1", update: { sessionUpdate: "session_info_update", title: "Renamed" } });
assert.equal(unknown.type, "status");
assert.equal(unknown.text, "Renamed");

console.log("ACP session updates normalize into canonical activity events");
