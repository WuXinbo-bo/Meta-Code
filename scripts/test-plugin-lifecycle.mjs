import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { PluginHost } from "../server/plugins/host.ts";
import { orchestrationPlugin } from "../server/plugins/orchestration.ts";
import { orchestrationLifecycle } from "../server/plugins/orchestration/lifecycle.ts";
import { migratePlannerTransactions } from "../server/plugins/orchestration/legacyMigration.ts";
import { createDelegationExecution } from "../server/plugins/collaboration/execution.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "metacode-plugin-lifecycle-"));
try {
  const legacy = path.join(root, "legacy");
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(legacy);
  const transaction = { schemaVersion: 1, id: "transaction-1", workflowId: "workflow-1", mode: "refine", operations: [{ id: "operation-1" }], status: "editing" };
  fs.writeFileSync(path.join(legacy, "workflow-1-refine.json"), JSON.stringify(transaction));
  fs.writeFileSync(path.join(legacy, "unknown.json"), "user content");
  migratePlannerTransactions(legacy, runtime, ["workflow-1"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, "workflow-1-refine.json"))), transaction);
  assert.equal(fs.existsSync(path.join(runtime, "unknown.json")), false);
  fs.writeFileSync(path.join(runtime, "workflow-1-refine.json"), "newer plugin state");
  migratePlannerTransactions(legacy, runtime, ["workflow-1"]);
  assert.equal(fs.readFileSync(path.join(runtime, "workflow-1-refine.json"), "utf8"), "newer plugin state");
  assert.ok(fs.existsSync(path.join(legacy, "workflow-1-refine.json")), "rollback copy remains");
  assert.throws(() => migratePlannerTransactions(legacy, runtime, ["../escape"]), /ID/);

  const paths = { pluginsDir: path.join(root, "plugins"), pluginRuntimeDir: path.join(root, "plugin-runtime") };
  const host = new PluginHost(paths, [orchestrationPlugin]);
  host.start(); host.setEnabled("orchestration", false);
  let recoveries = 0, disposals = 0, busy = false;
  const queued = [];
  const run = { id: "recovered", ownerUserId: "owner", workspaceId: "workspace", workDirectory: "", status: "paused" };
  host.bind("orchestration", orchestrationLifecycle({
    repository: { listAll: () => [run], recoverAfterRestart: () => { recoveries++; return [run]; }, get: () => run },
    stateFiles: { sync() {}, appendEvent() {} }, legacyTransactions: path.join(root, "absent"), transactions: runtime,
    isEnabled: () => host.isEnabled("orchestration"), isBusy: () => busy, activeNodeKeys: () => new Set(),
    queueTick: (id) => queued.push(id), disposeScheduler: () => disposals++
  }));
  assert.equal(recoveries, 0, "disabled plugins do not recover or schedule work");
  host.setEnabled("orchestration", true);
  await new Promise(setImmediate);
  assert.equal(recoveries, 1); assert.deepEqual(queued, ["recovered"]);
  busy = true; assert.throws(() => host.setEnabled("orchestration", false), /仍在运行/);
  busy = false; host.setEnabled("orchestration", false);
  host.setEnabled("orchestration", true); host.stop();
  await new Promise(setImmediate);
  assert.equal(disposals, 2);
  assert.equal(queued.length, 1, "stopping cancels recovery admission");

  mock.timers.enable({ apis: ["setInterval"] });
  let leaseFailure = true;
  const recoveryLifecycle = orchestrationLifecycle({
    repository: { listAll: () => [], recoverAfterRestart: () => [], recoverExpiredLeases: () => { if (leaseFailure) throw Error("fixture unavailable"); return []; } },
    stateFiles: {}, legacyTransactions: path.join(root, "absent"), transactions: runtime,
    isEnabled: () => true, isBusy: () => false, activeNodeKeys: () => new Set(), queueTick() {}, disposeScheduler() {}
  });
  const stopRecovery = recoveryLifecycle.activate({});
  const originalError = console.error;
  try {
    console.error = () => {};
    mock.timers.tick(15_000);
    assert.equal(recoveryLifecycle.healthCheck({}).health, "degraded", "failed reconciliation is visible");
    leaseFailure = false;
    mock.timers.tick(15_000);
    assert.equal(recoveryLifecycle.healthCheck({}).health, "healthy", "the next successful reconciliation restores health");
  } finally { console.error = originalError; stopRecovery(); mock.timers.reset(); }

  const parent = { id: "parent", status: "running" };
  const task = { id: "task", parentSessionId: "parent", provider: "codex", status: "queued", nickname: "fixture", task: "research", cwd: root, mode: "analysis" };
  const state = { sessions: [parent], delegatedTasks: [task] };
  let executions = 0;
  let coordinator;
  coordinator = createDelegationExecution({
    getState: () => state, isWorkbenchDelegationEnabled: () => true,
    runtimeBindingForProvider: async () => ({}),
    agentAdapterRegistry: { execute: async () => { executions++; throw Error("fetch failed"); } },
    upsertDelegatedTask: (item) => state.delegatedTasks.push(item), appendMessage() {},
    saveState: async () => { if (state.delegatedTasks.length > 1) coordinator.stop(); }
  });
  await coordinator.launch(task);
  assert.equal(executions, 1);
  assert.equal(state.delegatedTasks.at(-1).status, "interrupted", "stop while saving retry cannot leave queued work");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("plugin recovery, legacy planner migration and retry cancellation passed");
