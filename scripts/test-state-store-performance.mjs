import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { WorkbenchStateStore } from "../dist-server/stateStore.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-state-performance-"));
const now = new Date().toISOString();
const messages = Array.from({ length: 10_000 }, (_, index) => ({
  id: `message-${index}`,
  role: index % 3 === 0 ? "event" : "assistant",
  text: `${index}:`.padEnd(1_024, "x"),
  createdAt: now,
  payload: { index, phase: "completed" }
}));
const state = {
  settings: {}, workspaces: [], delegatedTasks: [], mcpServers: [], skillFolders: [], skillOrganizations: [], capabilityProfiles: [], providerConnections: [],
  sessions: [{ id: "large-session", revision: 1, updatedAt: now, messages }]
};

const store = new WorkbenchStateStore(root);
store.save(state);
store.checkpoint();
const metadataBytes = Number(store.db.prepare("SELECT LENGTH(json) AS value FROM sessions WHERE id = 'large-session'").get().value);
assert.ok(metadataBytes < 10_000, `session metadata unexpectedly contains message bodies: ${metadataBytes}`);
assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS value FROM session_messages").get().value), 10_000);

state.sessions[0].revision += 1;
state.sessions[0].updatedAt = new Date(Date.parse(now) + 1_000).toISOString();
state.sessions[0].messages[5_000] = { ...state.sessions[0].messages[5_000], text: "updated" };
const updateStarted = performance.now();
store.save(state);
const updateMs = performance.now() - updateStarted;
const walFile = path.join(root, "workbench-state.db-wal");
const walBytes = fs.existsSync(walFile) ? fs.statSync(walFile).size : 0;
assert.ok(updateMs < 2_000, `single-message update took ${updateMs.toFixed(1)}ms`);
assert.ok(walBytes < 1_000_000, `single-message update wrote ${walBytes} WAL bytes`);
store.close();

const reloadStarted = performance.now();
const reloadedStore = new WorkbenchStateStore(root);
const reloaded = reloadedStore.load();
const reloadMs = performance.now() - reloadStarted;
assert.equal(reloaded.sessions[0].messages.length, 10_000);
assert.equal(reloaded.sessions[0].messages[5_000].text, "updated");
assert.ok(reloadMs < 3_000, `10k-message reload took ${reloadMs.toFixed(1)}ms`);
reloadedStore.close();
fs.rmSync(root, { recursive: true, force: true });

console.log(`10k-message state benchmark passed: update=${updateMs.toFixed(1)}ms reload=${reloadMs.toFixed(1)}ms wal=${walBytes}`);
