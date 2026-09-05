import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { completeBackupGroups, createPersonalDataBackup, finalizePersonalDataRestore, listPersonalDataBackups, restorePersonalDataBackup, rollbackPersonalDataRestore, restoreWorkbenchBackup, verifyPersonalDataBackup } from "../server/dataRecovery.ts";

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

const personalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "metacode-personal-recovery-"));
const personalDbs = ["workbench-state.db", "auth.db", "codex-link.db", "session-management.db"];
const handles = personalDbs.map((name) => {
  const file = path.join(personalRoot, name);
  database(file, `live-${name}`);
  return { name, db: new DatabaseSync(file) };
});
fs.mkdirSync(path.join(personalRoot, "credentials"), { recursive: true });
fs.writeFileSync(path.join(personalRoot, "credentials", "secrets.dat"), "encrypted-secret");
fs.mkdirSync(path.join(personalRoot, "profiles", "codex", "sessions"), { recursive: true });
fs.writeFileSync(path.join(personalRoot, "profiles", "codex", "sessions", "thread.jsonl"), "history");
fs.mkdirSync(path.join(personalRoot, "runtimes", "codex"), { recursive: true });
fs.writeFileSync(path.join(personalRoot, "runtimes", "codex", "large-runtime.bin"), "re-downloadable");
const originalRename = fsp.rename;
let publicationAttempts = 0;
fsp.rename = async (...args) => {
  if (process.platform === "win32" && String(args[0]).endsWith(".tmp") && publicationAttempts++ < 2) throw Object.assign(new Error("transient scanner lock"), { code: "EPERM" });
  return originalRename(...args);
};
const personal = await createPersonalDataBackup({
  dataDir: personalRoot,
  appVersion: "0.1.2-dev",
  dataSchemaVersion: 2,
  componentSchemas: { state: 2, auth: 1, codexLink: 1, sessionManagement: 1 },
  databases: handles,
  retain: 2,
  maxTotalBytes: 512 * 1024 * 1024
}).finally(() => { fsp.rename = originalRename; });
if (process.platform === "win32") assert.equal(publicationAttempts, 3, "backup publication must retry transient Windows locks");
for (const item of handles) item.db.close();
assert.equal(listPersonalDataBackups(path.join(personalRoot, "backups")).length, 1);
assert.equal(verifyPersonalDataBackup(path.join(personalRoot, "backups", personal.name)).appVersion, "0.1.2-dev");
assert.equal(listPersonalDataBackups(path.join(personalRoot, "backups"))[0].verification?.level, "restore-rehearsal", "published backups must already have a restore rehearsal receipt");
assert.equal(fs.existsSync(path.join(personalRoot, "backups", personal.name, "data", "runtimes")), false, "managed runtimes are recoverable downloads, not personal data");
for (const failureCode of process.platform === "win32" ? ["ENOSPC", "EPERM"] : ["ENOSPC"]) {
  let attempts = 0;
  fsp.rename = async () => { attempts += 1; throw Object.assign(new Error("persistent publication failure"), { code: failureCode }); };
  try {
    await assert.rejects(createPersonalDataBackup({ dataDir: personalRoot, appVersion: "test", dataSchemaVersion: 2, componentSchemas: {}, databases: [], retain: 1 }), /persistent publication failure/);
  } finally { fsp.rename = originalRename; }
  assert.equal(attempts, failureCode === "EPERM" ? 7 : 1, "only transient failures receive bounded retries");
  assert.deepEqual(listPersonalDataBackups(path.join(personalRoot, "backups")).map(item => item.name), [personal.name], "failed publication must retain the previous certified backup");
}
fs.writeFileSync(path.join(personalRoot, "credentials", "secrets.dat"), "changed");
database(path.join(personalRoot, "temporary.db"), "unrelated");
const originalRenameSync = fs.renameSync;
let restoreAttempts = 0;
fs.renameSync = (...args) => {
  if (process.platform === "win32" && restoreAttempts++ < 2) throw Object.assign(new Error("transient restore lock"), { code: "EACCES" });
  return originalRenameSync(...args);
};
let personalRestore;
try { personalRestore = restorePersonalDataBackup({ dataDir: personalRoot, name: personal.name }); }
finally { fs.renameSync = originalRenameSync; }
if (process.platform === "win32") assert.ok(restoreAttempts > 2, "restore moves must retry transient Windows locks");
assert.equal(fs.readFileSync(path.join(personalRoot, "credentials", "secrets.dat"), "utf8"), "encrypted-secret");
assert.equal(marker(path.join(personalRoot, "codex-link.db")), "live-codex-link.db");
assert.ok(personalRestore.restored.some((file) => file.endsWith("session-management.db")));
assert.equal(fs.existsSync(path.join(personalRoot, "temporary.db")), true, "restore must not replace unrelated local files");
rollbackPersonalDataRestore(personalRestore);
assert.equal(fs.readFileSync(path.join(personalRoot, "credentials", "secrets.dat"), "utf8"), "changed", "a failed post-restore restart must be able to roll back the complete restore transaction");
assert.equal(fs.existsSync(personalRestore.recoveryDir), false, "completed rollback safety data must be removed");

const finalizedRestore = restorePersonalDataBackup({ dataDir: personalRoot, name: personal.name });
finalizePersonalDataRestore(finalizedRestore);
assert.equal(fs.readFileSync(path.join(personalRoot, "credentials", "secrets.dat"), "utf8"), "encrypted-secret");
assert.equal(fs.existsSync(finalizedRestore.recoveryDir), false, "a successful restore must not leak hidden pre-restore copies");

const retentionHandles = personalDbs.map((name) => ({ name, db: new DatabaseSync(path.join(personalRoot, name)) }));
await new Promise((resolve) => setTimeout(resolve, 5));
await createPersonalDataBackup({ dataDir: personalRoot, appVersion: "0.1.2-dev", dataSchemaVersion: 2, componentSchemas: { state: 2 }, databases: retentionHandles, retain: 2 });
await new Promise((resolve) => setTimeout(resolve, 5));
const newest = await createPersonalDataBackup({ dataDir: personalRoot, appVersion: "0.1.2-dev", dataSchemaVersion: 2, componentSchemas: { state: 2 }, databases: retentionHandles, retain: 2, trigger: "automatic" });
for (const item of retentionHandles) item.db.close();
const retained = listPersonalDataBackups(path.join(personalRoot, "backups"));
assert.equal(retained.length, 2, "manual and automatic backups share one two-item recovery stack");
assert.equal(retained[0].name, newest.name);
assert.equal(retained[0].manifest.trigger, "automatic");
assert.equal(retained.some((item) => item.name === personal.name), false, "the oldest recovery point is removed only after a new certified point is published");

const unexpected = path.join(retained[0].directory, "data", "unexpected.txt");
fs.writeFileSync(unexpected, "tampered");
assert.throws(() => verifyPersonalDataBackup(retained[0].directory), /未登记文件/, "files added after certification must invalidate the recovery point");
fs.rmSync(unexpected);
fs.rmSync(personalRoot, { recursive: true, force: true });

fs.rmSync(root, { recursive: true, force: true });
console.log("legacy database and complete personal-data backup validation, restore, and rollback preservation passed");
