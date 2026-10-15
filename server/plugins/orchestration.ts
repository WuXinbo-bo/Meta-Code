import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PluginContext } from "./types.js";
import { WorkflowRepository } from "./orchestration/repository.js";
import { WorkflowStateFiles } from "./orchestration/stateFiles.js";
import type { MetaCodePlugin } from "./types.js";

export const ORCHESTRATION_PLUGIN_ID = "orchestration";

export const orchestrationPlugin: MetaCodePlugin = {
  manifest: {
    id: ORCHESTRATION_PLUGIN_ID,
    version: "1.0.0",
    apiVersion: 1,
    displayName: "任务编排",
    description: "提供计划、DAG 调度、节点执行、验收、维护和局部重跑能力。",
    capabilities: ["workflow.planning", "workflow.execution", "workflow.maintenance", "workflow.activity"],
    requires: { core: ">=1" }
  }
};

/** The orchestration plugin owns persistence; the host supplies its shared DB. */
export function createOrchestrationServices(context: PluginContext, db: DatabaseSync) {
  return {
    repository: new WorkflowRepository(db),
    stateFiles: new WorkflowStateFiles(path.join(context.runtimeDirectory, "runs"))
  };
}
