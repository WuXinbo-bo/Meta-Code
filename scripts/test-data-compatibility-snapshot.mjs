import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCompatibilitySnapshot } from "./create-data-compatibility-snapshot.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "metacode-compatibility-"));
const source = path.join(root, "source");
const target = path.join(root, "compat", "0.1.0");
fs.mkdirSync(path.join(source, "skills", "example"), { recursive: true });
fs.writeFileSync(path.join(source, "skills", "example", "SKILL.md"), "test");
fs.writeFileSync(path.join(source, "auth-encryption.key"), "test-key");

const state = new DatabaseSync(path.join(source, "workbench-state.db"));
state.exec(`
  CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, position INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL);
  CREATE TABLE session_messages (session_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (session_id, id));
  PRAGMA user_version = 2;
`);
state.prepare("INSERT INTO sessions VALUES (?, 0, 1, '', ?)").run("session-1", JSON.stringify({ id: "session-1", title: "Test" }));
state.prepare("INSERT INTO session_messages VALUES (?, ?, 0, ?)").run("session-1", "message-1", JSON.stringify({ id: "message-1", text: "preserved" }));
state.close();

const auth = new DatabaseSync(path.join(source, "auth.db"));
auth.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('auth-preserved')");
auth.close();

const executable = path.join(root, "Meta Code.exe");
const result = createCompatibilitySnapshot({ sourceDir: source, targetDir: target, executable });
assert.equal(result.sessionCount, 1);
assert.equal(result.messageCount, 1);
assert.equal(fs.readFileSync(path.join(target, "skills", "example", "SKILL.md"), "utf8"), "test");
const compatible = new DatabaseSync(path.join(target, "workbench-state.db"), { readOnly: true });
assert.equal(compatible.prepare("PRAGMA user_version").get().user_version, 1);
assert.equal(compatible.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_messages'").get(), undefined);
assert.equal(JSON.parse(compatible.prepare("SELECT json FROM sessions WHERE id = ?").get("session-1").json).messages[0].text, "preserved");
compatible.close();
const metadata = JSON.parse(fs.readFileSync(path.join(target, "compatibility.json"), "utf8"));
assert.equal(metadata.targetAppVersion, "0.1.0");
assert.match(fs.readFileSync(result.launcher, "utf8"), new RegExp(target.replaceAll("\\", "\\\\")));
assert.doesNotMatch(fs.readFileSync(result.launcher, "utf8"), /\.staging-/);

fs.rmSync(root, { recursive: true, force: true });
console.log("0.1.0 compatibility snapshot reconstruction and isolation passed");
