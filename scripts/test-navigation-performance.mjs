import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { WorkflowRepository } from "../server/workflows/repository.ts";

const db = new DatabaseSync(":memory:");
try {
  const repository = new WorkflowRepository(db);
  const ownerUserId = "navigation-performance-user";
  for (let index = 0; index < 80; index += 1) {
    const workflow = repository.create({
      ownerUserId,
      workspaceId: `workspace-${index % 4}`,
      prompt: `历史工作流 ${index}`,
      plannerEngine: index % 2 ? "codex" : "claude"
    });
    db.prepare("UPDATE workflow_runs SET planner_logs_json = ? WHERE id = ?")
      .run(JSON.stringify([{ id: `log-${index}`, text: "x".repeat(256 * 1024) }]), workflow.id);
  }

  const started = performance.now();
  const summaries = repository.listNavigation(ownerUserId);
  const durationMs = performance.now() - started;
  assert.equal(summaries.length, 80);
  assert.equal("plannerLogs" in summaries[0], false, "navigation summaries must not hydrate historical logs");
  assert.ok(durationMs < 250, `navigation summary query took ${durationMs.toFixed(1)}ms`);
} finally {
  db.close();
}

console.log("large workflow navigation summary performance passed");
