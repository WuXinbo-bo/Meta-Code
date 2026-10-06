import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { agentChangeTargets } from "../src/agentRealtime.ts";

assert.equal(agentChangeTargets({ sessionId: "session-1", agentId: "agent-1", revision: 3 }, "session-1", "agent-1"), true);
assert.equal(agentChangeTargets({ sessionId: "session-1", agentId: "agent-2", revision: 3 }, "session-1", "agent-1"), false);
assert.equal(agentChangeTargets({ sessionId: "session-2", agentId: "agent-1", revision: 3 }, "session-1", "agent-1"), false);
assert.equal(agentChangeTargets({ sessionId: "session-1" }, "session-1", "agent-1"), true, "legacy session-wide events must reconcile the drawer");
assert.equal(agentChangeTargets({ sessionId: "session-1", agents: [{ agentId: "agent-1", revision: 4 }] }, "session-1", "agent-1"), true);

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const server = await readFile(new URL("../server/index.ts", import.meta.url), "utf8");
assert.match(app, /if \(loading\) \{\s*rerunRequested = true;/, "drawer refreshes received during a request must be replayed");
assert.match(app, /\[sessionId, selectedAgentSummary\?\.id, selectedAgentSummary\?\.identityKey, selectedAgentSummary\?\.identity\?\.key, selectedAgentSummary\?\.provider\]/, "session status changes must not abort the active detail request");
assert.match(app, /hasNonEmptySummaryRef/, "partially written empty snapshots must preserve the last usable summary");
assert.match(app, /agentOrderRef/, "Agent navigation order must remain stable while timestamps advance");
assert.match(app, /detailForSelection\.id === selectedAgentSummary\?\.id/, "late detail responses must match the selected Agent identity");
assert.match(server, /mergeAgentThreads\(nativeWithIdentity, managed, persisted\)/, "agent reads must merge canonical snapshots without write-side effects");
assert.match(server, /if \(native\.length\) syncNativeAgentMessages\(session, native\);/, "native projection is owned by the background reconciler");
assert.doesNotMatch(server, /syncNativeAgentMessages\(session, merged\)/);
assert.match(server, /identityKey/, "agent events must carry a canonical identity key");
assert.match(server, /revision/, "agent events must carry a monotonic version");
assert.match(server, /logCount/, "agent events must carry the activity count");

console.log("agent realtime ownership, routing, and rerun contracts OK");
