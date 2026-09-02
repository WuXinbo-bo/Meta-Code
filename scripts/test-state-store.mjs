import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { WorkbenchStateStore } from "../dist-server/stateStore.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-state-"));
const now = new Date().toISOString();
const initial = {
  settings: { model: "test-model" },
  workspaces: [{ id: "workspace-1", ownerUserId: "user-1", name: "Test" }],
  sessions: [{ id: "session-1", ownerUserId: "user-1", workspaceId: "workspace-1", revision: 1, updatedAt: now, messages: [] }],
  delegatedTasks: [{ id: "agent-1", parentSessionId: "session-1", updatedAt: now, status: "running", idempotencyKey: "idem-1", requestFingerprint: "fingerprint-1", deadlineAt: "2026-08-08T02:00:00.000Z" }],
  mcpServers: [{ id: "mcp-1", ownerUserId: "user-1", name: "test" }],
  skillFolders: [{ id: "skill-folder-1", ownerUserId: "user-1", name: "Writing", position: 0 }],
  skillOrganizations: [{ id: "skill-org-1", ownerUserId: "user-1", skillName: "writer", folderId: "skill-folder-1", position: 0 }],
  delegationProtocolVersion: 2
};

let store = new WorkbenchStateStore(root);
assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
const first = store.save(initial);
assert.deepEqual(first.sessionIds, ["session-1"]);
assert.deepEqual(first.delegatedParentSessionIds, ["session-1"]);
assert.deepEqual(store.save(initial).sessionIds, []);

const changed = structuredClone(initial);
changed.sessions[0].revision = 2;
changed.sessions[0].messages.push({ id: "message-1", text: "x".repeat(250_000) });
const delta = store.save(changed);
assert.deepEqual(delta.sessionIds, ["session-1"]);
assert.deepEqual(delta.workspaceIds, []);
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?").get("session-1").count, 1);
assert.ok(store.db.prepare("SELECT LENGTH(json) AS length FROM sessions WHERE id = ?").get("session-1").length < 2_000, "session metadata must not duplicate message bodies");
assert.equal(store.db.prepare("SELECT LENGTH(json) AS length FROM session_messages WHERE session_id = ? AND id = ?").get("session-1", "message-1").length > 250_000, true);
const unchangedLargeSession = {
  ...changed.sessions[0],
  toJSON() { throw new Error("unchanged session should not be serialized"); }
};
assert.deepEqual(store.save({ ...changed, sessions: [unchangedLargeSession] }).sessionIds, []);
const updated = structuredClone(changed);
updated.sessions[0].revision = 3;
updated.sessions[0].updatedAt = new Date(Date.parse(now) + 1_000).toISOString();
updated.sessions[0].messages[0].text = "y".repeat(250_000);
assert.deepEqual(store.save(updated).sessionIds, ["session-1"]);
assert.match(store.db.prepare("SELECT json FROM session_messages WHERE session_id = ? AND id = ?").get("session-1", "message-1").json, /yyyy/);
store.checkpoint();
store.close();

store = new WorkbenchStateStore(root);
const loaded = store.load();
assert.equal(loaded.sessions[0].revision, 3);
assert.equal(loaded.sessions[0].messages[0].text.length, 250_000);
assert.equal(loaded.delegatedTasks[0].idempotencyKey, "idem-1");
assert.equal(loaded.skillFolders[0].name, "Writing");
assert.equal(loaded.skillOrganizations[0].folderId, "skill-folder-1");
const removed = structuredClone(changed);
removed.delegatedTasks = [];
const removal = store.save(removed);
assert.deepEqual(removal.deletedDelegatedTaskIds, ["agent-1"]);
assert.deepEqual(removal.delegatedParentSessionIds, ["session-1"]);
store.close();

const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-state-legacy-"));
const legacyFile = path.join(legacyRoot, "workbench-state.db");
const legacyDb = new DatabaseSync(legacyFile);
legacyDb.exec(`
  CREATE TABLE settings (id INTEGER PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, position INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL);
`);
legacyDb.prepare("INSERT INTO settings (id, json) VALUES (1, ?)").run(JSON.stringify({ model: "legacy" }));
legacyDb.prepare("INSERT INTO sessions (id, position, revision, updated_at, json) VALUES (?, 0, 1, ?, ?)").run("legacy-session", now, JSON.stringify({ id: "legacy-session", revision: 1, updatedAt: now, messages: [{ id: "legacy-message", text: "preserved" }] }));
legacyDb.close();
const legacyStore = new WorkbenchStateStore(legacyRoot);
const migrated = legacyStore.load();
assert.equal(migrated.sessions[0].messages[0].text, "preserved");
assert.equal(JSON.parse(legacyStore.db.prepare("SELECT json FROM sessions WHERE id = ?").get("legacy-session").json).messages, undefined);
assert.equal(legacyStore.db.prepare("SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?").get("legacy-session").count, 1);
legacyStore.close();
fs.rmSync(legacyRoot, { recursive: true, force: true });

const faultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-state-faults-"));
const faultStore = new WorkbenchStateStore(faultRoot);
const faultState = {
  ...structuredClone(initial),
  workspaces: [],
  sessions: [],
  delegatedTasks: [],
  mcpServers: [],
  skillFolders: [],
  skillOrganizations: [],
  capabilityProfiles: [],
  providerConnections: []
};
faultStore.save(faultState);

const lockerSource = [
  "const { DatabaseSync } = require('node:sqlite');",
  "const db = new DatabaseSync(process.argv[1]);",
  "db.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');",
  "console.log('locked');",
  "setTimeout(() => { db.exec('COMMIT'); db.close(); }, 350);"
].join("");
const locker = spawn(process.execPath, ["-e", lockerSource, faultStore.file], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("database locker did not start")), 5_000);
  locker.once("error", reject);
  locker.stdout.once("data", () => { clearTimeout(timeout); resolve(); });
});
const lockStartedAt = Date.now();
faultStore.save({ ...faultState, settings: { model: "after-lock" } });
assert.ok(Date.now() - lockStartedAt >= 250, "writer should wait for a short external database lock");
await new Promise((resolve) => locker.once("exit", resolve));
assert.equal(faultStore.load().settings.model, "after-lock");

const pageCount = Number(faultStore.db.prepare("PRAGMA page_count").get().page_count);
faultStore.db.exec(`PRAGMA max_page_count = ${pageCount}`);
const fullState = { ...faultState, settings: { model: "x".repeat(2 * 1024 * 1024) } };
assert.throws(() => faultStore.save(fullState), /database or disk is full|SQLITE_FULL/i);
assert.equal(faultStore.load().settings.model, "after-lock", "failed disk-full transactions must preserve committed state");
faultStore.db.exec("PRAGMA max_page_count = 1073741823");
faultStore.save({ ...faultState, settings: { model: "after-disk-recovery" } });
assert.equal(faultStore.load().settings.model, "after-disk-recovery");
faultStore.close();
fs.rmSync(faultRoot, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
console.log("state store migration, lock wait, disk-full rollback, and recovery tests passed");
