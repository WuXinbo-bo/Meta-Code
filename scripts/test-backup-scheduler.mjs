import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackupBusyError, BackupScheduler } from "../server/persistence/backupScheduler.ts";
import { DEFAULT_BACKUP_POLICY, loadBackupPolicy, saveBackupPolicy } from "../server/persistence/backupPolicy.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "meta-code-backup-scheduler-"));
const healthFile = path.join(root, "backup-health.json");
let now = Date.parse("2026-09-03T00:00:00.000Z");
let outcome = "busy";
const timers = [];
const failures = [];

const scheduler = new BackupScheduler({
  healthFile,
  now: () => now,
  intervalMs: 100,
  staleAfterMs: 120,
  startupDelayMs: 10,
  retryDelaysMs: [5, 15],
  getLatestBackupAt: async () => null,
  runBackup: async () => {
    if (outcome === "busy") throw new BackupBusyError("running task");
    if (outcome === "failed") throw new Error("disk unavailable");
    return { createdAt: new Date(now).toISOString() };
  },
  onFailure: (_error, status) => failures.push(status),
  setTimer: (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  },
  clearTimer: () => undefined
});

await scheduler.start();
assert.equal(scheduler.snapshot().status, "pending");
assert.equal(scheduler.snapshot().stale, true);
assert.equal(timers.at(-1).delay, 10, "a missing backup must be attempted shortly after startup");

await assert.rejects(scheduler.runNow(), /running task/);
assert.equal(scheduler.snapshot().status, "busy");
assert.equal(timers.at(-1).delay, 5, "a busy workbench must use the first bounded retry delay");

now += 5;
outcome = "failed";
await assert.rejects(scheduler.runNow(), /disk unavailable/);
assert.equal(scheduler.snapshot().status, "failed");
assert.equal(timers.at(-1).delay, 15, "a repeated failure must back off without waiting a full day");

now += 15;
outcome = "success";
await scheduler.runNow();
assert.equal(scheduler.snapshot().status, "healthy");
assert.equal(scheduler.snapshot().stale, false);
assert.equal(scheduler.snapshot().lastError, null);
assert.equal(timers.at(-1).delay, 100, "a successful backup schedules the next daily interval from success");
assert.deepEqual(failures, ["busy", "failed"]);
assert.equal(JSON.parse(fs.readFileSync(healthFile, "utf8")).status, "healthy", "health survives a process restart");

const restarted = new BackupScheduler({
  healthFile,
  now: () => now + 20,
  intervalMs: 100,
  staleAfterMs: 120,
  getLatestBackupAt: async () => new Date(now + 10).toISOString(),
  runBackup: async () => ({ ok: true }),
  setTimer: (callback, delay) => ({ callback, delay, unref() {} }),
  clearTimer: () => undefined
});
await restarted.start();
assert.equal(restarted.snapshot().lastSuccessAt, new Date(now + 10).toISOString(), "the newest valid snapshot wins over stale persisted health");
assert.equal(restarted.snapshot().status, "healthy");

await restarted.setAutomaticEnabled(false);
assert.equal(restarted.snapshot().status, "disabled");
assert.equal(restarted.snapshot().nextAttemptAt, null, "disabled automatic backups must not retain a scheduled attempt");
await restarted.runNow("manual");
assert.equal(restarted.snapshot().status, "disabled", "manual backups remain available while automatic backups are disabled");
assert.equal(restarted.snapshot().lastTrigger, "manual");

await restarted.setAutomaticEnabled(true);
assert.equal(restarted.snapshot().automaticEnabled, true);
assert.ok(restarted.snapshot().nextAttemptAt, "re-enabling automatic backups must restore the schedule");

const policyFile = path.join(root, "backup-policy.json");
assert.deepEqual(loadBackupPolicy(policyFile), DEFAULT_BACKUP_POLICY);
await saveBackupPolicy(policyFile, { ...DEFAULT_BACKUP_POLICY, automaticEnabled: false });
assert.equal(loadBackupPolicy(policyFile).automaticEnabled, false, "the automatic backup preference must survive restart");

scheduler.stop();
restarted.stop();
fs.rmSync(root, { recursive: true, force: true });
console.log("backup startup calibration, enablement, bounded retry, persistence and manual execution passed");
