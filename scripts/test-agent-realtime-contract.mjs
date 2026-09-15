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
assert.match(app, /\[sessionId, selectedAgentSummary\?\.id, sessionRunning\]/, "log timestamp changes must not abort the active detail request");
assert.match(server, /if \(!agentId\) syncNativeAgentMessages\(session, native\);\s*const merged = mergeAgentThreads\(native, managed, persisted\);/, "only summary reconciliation may project native agents into native messages");
assert.doesNotMatch(server, /syncNativeAgentMessages\(session, merged\)/);
assert.match(server, /agentId: agent\.id,[\s\S]{0,120}revision,[\s\S]{0,120}logCount:/, "agent events must carry an identity and monotonic version");

console.log("agent realtime ownership, routing, and rerun contracts OK");
