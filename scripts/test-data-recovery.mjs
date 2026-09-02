import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { completeBackupGroups, restoreWorkbenchBackup } from "../server/dataRecovery.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "metacode-recovery-"));
const backups = path.join(root, "backups");
fs.mkdirSync(backups);

function database(file, value) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE marker (value TEXT NOT NULL)");
  db.prepare("INSERT INTO marker VALUES (?)").run(value);
  db.close();
}
function marker(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT value FROM marker").get().value; }
  finally { db.close(); }
}

database(path.join(root, "workbench-state.db"), "live-state");
database(path.join(root, "auth.db"), "live-auth");
database(path.join(backups, "workbench-state-2026-08-31.db"), "backup-state");
database(path.join(backups, "auth-2026-08-31.db"), "backup-auth");
database(path.join(backups, "workbench-state-incomplete.db"), "incomplete");

assert.deepEqual(completeBackupGroups(backups).map((group) => group.stamp), ["2026-08-31"]);
const result = restoreWorkbenchBackup({ dataDir: root, stamp: "2026-08-31" });
assert.equal(marker(path.join(root, "workbench-state.db")), "backup-state");
assert.equal(marker(path.join(root, "auth.db")), "backup-auth");
assert.equal(marker(path.join(result.recoveryDir, "state.db")), "live-state");
assert.equal(marker(path.join(result.recoveryDir, "auth.db")), "live-auth");

fs.writeFileSync(path.join(backups, "auth-corrupt.db"), "not sqlite");
fs.copyFileSync(path.join(backups, "workbench-state-2026-08-31.db"), path.join(backups, "workbench-state-corrupt.db"));
assert.throws(() => restoreWorkbenchBackup({ dataDir: root, stamp: "corrupt" }), /SQLite|database|数据库/);
assert.equal(marker(path.join(root, "workbench-state.db")), "backup-state");
assert.equal(marker(path.join(root, "auth.db")), "backup-auth");

fs.rmSync(root, { recursive: true, force: true });
console.log("database backup validation, atomic restore, and rollback preservation passed");
