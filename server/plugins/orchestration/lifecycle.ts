import fs from "node:fs";
import type { PluginLifecycle } from "../host.js";
import type { WorkflowRepository } from "./repository.js";
import type { WorkflowStateFiles } from "./stateFiles.js";
import { workflowLog } from "./logs.js";
import { migratePlannerTransactions } from "./legacyMigration.js";

export function orchestrationLifecycle(ports: {
  repository: WorkflowRepository;
  stateFiles: WorkflowStateFiles;
  legacyTransactions: string;
  transactions: string;
  isEnabled: () => boolean;
  isBusy: () => boolean;
  activeNodeKeys: () => Set<string>;
  queueTick: (id: string, ownerId: string) => void;
  disposeScheduler: () => void;
}): PluginLifecycle {
  const { repository, stateFiles } = ports;
  let reconciliationFailed = false;
  let checkedAt: string | undefined;
  return {
    activate() {
      const workflows = repository.listAll();
      migratePlannerTransactions(ports.legacyTransactions, ports.transactions, workflows.map((run) => run.id));
      for (const workflow of workflows) {
        if (!workflow.workDirectory || !fs.existsSync(workflow.workDirectory)) continue;
        const maintenance = stateFiles.maintenance(workflow);
        repository.migrateCheckpointDirectories(workflow.id, (directory) => stateFiles.checkpointDirectory(workflow, directory));
        if (maintenance?.status === "planning" && workflow.status !== "planning") {
          const recovered = repository.finishMaintenanceWithoutPlan(workflow.id, workflow.ownerUserId, workflowLog("error", "规划维护已中断", "工作台重启时维护事务尚未提交，原计划保持不变"));
          stateFiles.failMaintenance(recovered, "工作台重启导致本轮维护中断，请沿用原计划重新提交修改意见");
          stateFiles.syncResults(recovered);
        } else stateFiles.sync(workflow);
      }
      const recovered = repository.recoverAfterRestart();
      for (const item of recovered) {
        const run = repository.get(item.id, item.ownerUserId)!;
        stateFiles.sync(run);
        stateFiles.appendEvent(run, { type: "workflow.recovered_after_restart" });
      }
      reconciliationFailed = false;
      checkedAt = new Date().toISOString();
      // Enabling is persisted by the host before any execution is admitted.
      const pending = setImmediate(() => {
        if (ports.isEnabled()) for (const run of recovered) ports.queueTick(run.id, run.ownerUserId);
      });
      const timer = setInterval(() => {
        if (!ports.isEnabled()) return;
        try {
          for (const item of repository.recoverExpiredLeases(ports.activeNodeKeys())) {
            const run = repository.get(item.id, item.ownerUserId)!;
            stateFiles.sync(run);
            stateFiles.appendEvent(run, { type: "workflow.lease_recovered" });
            ports.queueTick(run.id, run.ownerUserId);
          }
          reconciliationFailed = false;
          checkedAt = new Date().toISOString();
        } catch (error) { reconciliationFailed = true; checkedAt = new Date().toISOString(); console.error("Workflow lease reconciliation failed", error); }
      }, 15_000);
      timer.unref();
      return () => { clearImmediate(pending); clearInterval(timer); ports.disposeScheduler(); };
    },
    beforeDisable() {
      if (ports.isBusy() || repository.listAll().some((run) => ["planning", "queued", "running", "integrating"].includes(run.status))) throw new Error("编排任务仍在运行，请先暂停或完成任务后停用插件");
    },
    healthCheck() {
      return { health: reconciliationFailed ? "degraded" : "healthy", message: reconciliationFailed ? "编排租约恢复检查暂未成功，将自动重试。已有任务和日志仍保留。" : "编排恢复与租约检查正常。", checkedAt, busy: ports.isBusy() };
    }
  };
}
