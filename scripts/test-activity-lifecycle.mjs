import assert from "node:assert/strict";
import { settleSupersededReasoning } from "../server/activity/lifecycle.ts";

function reasoning(id = "thinking-1") {
  return {
    id,
    sourceId: id,
    eventType: "assistant.thinking",
    eventPhase: "updated",
    activityCategory: "reasoning",
    activityPhase: "running",
    kind: "reasoning",
    category: "reasoning",
    phase: "running",
    activity: {
      schemaVersion: 1,
      id,
      sourceId: id,
      rawType: "assistant.thinking",
      provider: "claude",
      actor: { kind: "main" },
      semanticType: "reasoning",
      phase: "running",
      occurredAt: "2026-09-04T00:00:00.000Z",
      title: "分析与推理",
      summary: "thinking"
    }
  };
}

for (const next of ["assistant-1", "tool-1", "turn-completed", "error-1"]) {
  const entries = [reasoning()];
  assert.equal(settleSupersededReasoning(entries, next), 1);
  assert.equal(entries[0].activityPhase, "completed");
  assert.equal(entries[0].phase, "completed");
  assert.equal(entries[0].eventPhase, "completed");
  assert.equal(entries[0].activity.phase, "completed");
}

const streaming = [reasoning()];
assert.equal(settleSupersededReasoning(streaming, "thinking-1"), 0);
assert.equal(streaming[0].activityPhase, "running");

const nextReasoning = [reasoning("thinking-1")];
assert.equal(settleSupersededReasoning(nextReasoning, "thinking-2"), 1);
assert.equal(nextReasoning[0].activityPhase, "completed");

const legacy = [{ id: "legacy", kind: "reasoning", title: "分析中" }];
assert.equal(settleSupersededReasoning(legacy), 1);
assert.equal(legacy[0].phase, "completed");

const completed = [reasoning()];
completed[0].activityPhase = "completed";
completed[0].phase = "completed";
completed[0].activity.phase = "completed";
assert.equal(settleSupersededReasoning(completed), 0);

console.log("Provider-neutral reasoning lifecycle settlement OK");
