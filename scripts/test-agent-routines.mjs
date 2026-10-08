import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RoutineScheduler, loadRoutines } from "../server/agents/routines.ts";

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-routines-"));
const file = path.join(root, "routines", "scheduled.json");
const calls = [];
let release;
const gate = new Promise((resolve) => { release = resolve; });
const runner = async (routine) => {
  calls.push(routine.id);
  if (routine.id === "duplicate") await gate;
  if (routine.id === "failure") throw new Error("runner fixture failed");
  return { ok: true, id: routine.id };
};

const scheduler = new RoutineScheduler({ file, run: runner });
const interval = scheduler.create({ id: "interval", name: "Interval", providerId: "codex", prompt: "run", intervalMs: 60_000 });
assert.equal(interval.enabled, true);
assert.equal(interval.intervalMs, 60_000);
assert.ok(interval.nextRunAt);
assert.equal(loadRoutines(file).length, 1);
const owned = scheduler.create({ id: "owned", name: "Owned", providerId: "codex", prompt: "owner", ownerUserId: "user-a", enabled: false });
assert.equal(scheduler.list("user-a").length, 1);
assert.equal(scheduler.get(owned.id, "user-b"), null);

const paused = scheduler.pause("interval");
assert.equal(paused.enabled, false);
assert.equal(paused.lastStatus, "paused");
const resumed = scheduler.resume("interval");
assert.equal(resumed.enabled, true);
assert.equal(resumed.lastStatus, "idle");
const updated = scheduler.update("interval", { name: "Updated", workspaceId: "workspace-1" });
assert.equal(updated.name, "Updated");
assert.equal(updated.workspaceId, "workspace-1");

const oneShot = scheduler.create({ id: "one-shot", name: "One shot", providerId: "claude", prompt: "once", nextRunAt: new Date(Date.now() - 1_000), enabled: true });
assert.equal(oneShot.intervalMs, null);
scheduler.start();
await new Promise((resolve) => setTimeout(resolve, 25));
assert.deepEqual(calls, ["one-shot"]);
assert.equal(scheduler.get("one-shot")?.enabled, false);
assert.equal(scheduler.get("one-shot")?.lastStatus, "succeeded");
scheduler.stop();

const duplicate = scheduler.create({ id: "duplicate", name: "Duplicate", providerId: "codex", prompt: "dedupe", enabled: false });
const first = scheduler.runNow(duplicate.id);
const second = scheduler.runNow(duplicate.id);
assert.equal(first, second, "concurrent manual runs should be deduplicated");
release();
await first;
assert.equal(scheduler.get(duplicate.id)?.lastStatus, "paused", "manual run preserves paused state");

const failure = scheduler.create({ id: "failure", name: "Failure", providerId: "claude", prompt: "fail", enabled: false });
await assert.rejects(() => scheduler.runNow(failure.id), /runner fixture failed/);
assert.equal(scheduler.get(failure.id)?.lastStatus, "paused");
assert.match(scheduler.get(failure.id)?.lastError || "", /runner fixture failed/);
scheduler.resume(failure.id);
assert.ok(scheduler.get(failure.id)?.nextRunAt, "resuming a completed one-shot should create a retry date");
scheduler.pause(failure.id);

// Simulate an unclean process exit and verify startup recovery marks the old
// running attempt as interrupted instead of silently presenting it as active.
const persisted = JSON.parse(await fsp.readFile(file, "utf8"));
persisted.routines.find((item) => item.id === "interval").lastStatus = "running";
persisted.routines.push({
  schemaVersion: 1,
  id: "recover-due",
  name: "Recover due",
  providerId: "codex",
  prompt: "recover",
  intervalMs: null,
  nextRunAt: new Date(Date.now() - 1_000).toISOString(),
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastRunAt: null,
  lastStatus: "running",
  lastError: null,
  runCount: 0
});
await fsp.writeFile(file, `${JSON.stringify(persisted)}\n`);
const recovered = new RoutineScheduler({ file, run: runner });
assert.equal(recovered.get("interval")?.lastStatus, "interrupted");
assert.match(recovered.get("interval")?.lastError || "", /重启/);
recovered.start();
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(recovered.get("recover-due")?.enabled, false);
assert.equal(recovered.get("recover-due")?.lastStatus, "succeeded");
recovered.stop();

assert.throws(() => recovered.create({ name: "bad", providerId: "codex", prompt: "x", intervalMs: 0 }), /intervalMs/);
assert.throws(() => recovered.create({ name: "bad", providerId: "codex", prompt: "x", nextRunAt: "invalid" }), /有效的时间/);
assert.equal(recovered.delete("missing"), false);
assert.equal(recovered.delete("failure"), true);
await fsp.rm(root, { recursive: true, force: true });
console.log("Agent routines persistence, recovery and scheduling tests passed");
