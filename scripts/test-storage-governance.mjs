import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planStorageMaintenance, runStorageMaintenance } from "../server/storageGovernance.ts";

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-storage-governance-"));
const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1_000);
const write = async (relative, content = "data", oldEntry = true) => {
  const target = path.join(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
  if (oldEntry) await fsp.utimes(target, old, old);
  return target;
};
const directory = async (relative, oldEntry = true) => {
  const target = path.join(root, relative);
  await fsp.mkdir(target, { recursive: true });
  await write(path.join(relative, "payload.txt"), "payload", oldEntry);
  if (oldEntry) await fsp.utimes(target, old, old);
  return target;
};

try {
  const runtimeRoot = path.join(root, "runtimes", "codex");
  await write("runtimes/codex/current.json", JSON.stringify({ version: "3.0.0" }), false);
  const activeVersion = await directory("runtimes/codex/versions/3.0.0");
  const rollbackVersion = await directory("runtimes/codex/versions/2.0.0");
  const boundVersion = await directory("runtimes/codex/versions/1.0.0");
  const obsoleteVersion = await directory("runtimes/codex/versions/0.9.0");
  const oldCache = await write("runtimes/codex/cache/old.tgz");
  const recentCache = await write("runtimes/codex/cache/recent.tgz", "recent", false);
  const currentArtifact = await write("artifacts/activity/current.json", JSON.stringify({ sessionId: "current-session" }));
  const orphanArtifact = await write("artifacts/activity/orphan.json", JSON.stringify({ sessionId: "removed-session" }));
  const currentRecovery = await write("sessions/recovery/local/current.json", JSON.stringify({ session: { id: "current-session" } }));
  const orphanRecovery = await write("sessions/recovery/local/orphan.json", JSON.stringify({ session: { id: "removed-session" } }));
  const activeWorkflow = await directory("workflow-node-runtime/active-node");
  const oldWorkflow = await directory("workflow-node-runtime/old-node");
  const token = await write("security/api-token", "private-token", true);
  for (let index = 0; index < 4; index += 1) await directory(`backups/personal-2025-0${index + 1}`);
  for (let index = 0; index < 6; index += 1) {
    const stamp = `2025-0${index + 1}`;
    await write(`backups/workbench-state-${stamp}.db`);
    await write(`backups/auth-${stamp}.db`);
  }

  const input = {
    dataDir: root,
    protectedSessionIds: ["current-session"],
    protectedRuntimePaths: [path.join(boundVersion, "bin", "codex.exe")],
    protectedWorkflowRuntimeNames: ["active-node"]
  };
  const report = await planStorageMaintenance(input);
  const removals = new Set(report.actions.map((action) => action.path));
  assert.ok(removals.has(obsoleteVersion), "obsolete managed version should be pruned");
  assert.ok(!removals.has(activeVersion), "active managed version must survive");
  assert.ok(!removals.has(rollbackVersion), "one rollback version must survive");
  assert.ok(!removals.has(boundVersion), "runtime referenced by an active task must survive");
  assert.ok(removals.has(oldCache));
  assert.ok(!removals.has(recentCache));
  assert.ok(!removals.has(currentArtifact));
  assert.ok(removals.has(orphanArtifact));
  assert.ok(!removals.has(currentRecovery));
  assert.ok(removals.has(orphanRecovery));
  assert.ok(!removals.has(activeWorkflow));
  assert.ok(removals.has(oldWorkflow));
  assert.ok(!removals.has(token), "ephemeral API token is never part of destructive maintenance");
  assert.equal(report.inventory["personal-backup"].items, 4);
  assert.equal(report.actions.filter((action) => action.category === "personal-backup").length, 1, "latest three personal snapshots must survive regardless of age");
  assert.equal(report.inventory["database-backup"].items, 6, "database retention is counted in complete state/auth groups");
  assert.equal(report.actions.filter((action) => action.category === "database-backup").length, 10, "old complete database groups are removed together while one group is always retained");

  const executed = await runStorageMaintenance(input);
  assert.equal(executed.deletedItems, report.actions.length);
  assert.equal(fs.existsSync(obsoleteVersion), false);
  assert.equal(fs.existsSync(activeVersion), true);
  assert.equal(fs.existsSync(boundVersion), true);
  assert.equal(fs.existsSync(token), true);
  assert.equal(path.dirname(runtimeRoot), path.join(root, "runtimes"));
  console.log("storage inventory, retention budgets, runtime protection, dry-run, and bounded cleanup passed");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
