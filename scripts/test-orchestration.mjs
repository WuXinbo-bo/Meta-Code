import assert from "node:assert/strict";
import {
  agentStatusForParent,
  codexTerminalStatusFromMarkers,
  delegationAdmission,
  delegationIdempotency,
  mergeAgentRuntimeStatus,
  orchestrationCapabilities,
  recoverDelegatedTaskAfterRestart,
  recoverSessionAfterRestart,
  skillPolicyEnabled
} from "../dist-server/orchestration/contracts.js";
import { codexTurnFailure, consumeCodexTurnEvents, runCodexSessionTurn } from "../dist-server/engines/codex/events.js";

const now = "2026-08-08T00:00:00.000Z";

const crashedSession = recoverSessionAfterRestart({ status: "running", revision: 4 }, now);
assert.equal(crashedSession.shouldResume, true);
assert.equal(crashedSession.session.status, "interrupted");
assert.equal(crashedSession.session.stopReason, "crash");
assert.equal(crashedSession.session.revision, 5);
assert.equal(recoverSessionAfterRestart({ status: "completed", revision: 9 }, now).shouldResume, false);

const crashedTask = recoverDelegatedTaskAfterRestart({ status: "running" }, now);
assert.equal(crashedTask.changed, true);
assert.equal(crashedTask.task.status, "interrupted");
assert.equal(crashedTask.task.completedAt, now);
assert.equal(recoverDelegatedTaskAfterRestart({ status: "completed" }, now).changed, false);
console.log("restart recovery contracts OK");

assert.equal(agentStatusForParent("running", false), "interrupted");
assert.equal(agentStatusForParent("running", true), "running");
assert.equal(agentStatusForParent("completed", false), "completed");
assert.equal(mergeAgentRuntimeStatus("completed", "running"), "completed");
assert.equal(mergeAgentRuntimeStatus("failed", "running"), "failed");
assert.equal(mergeAgentRuntimeStatus("running", "completed"), "completed");
assert.equal(mergeAgentRuntimeStatus("interrupted", "running"), "running");
assert.equal(codexTerminalStatusFromMarkers(["turn.completed"]), "completed");
assert.equal(codexTerminalStatusFromMarkers(["error:1", "task_complete"]), "completed");
assert.equal(codexTerminalStatusFromMarkers(["turn.failed"]), "failed");
assert.equal(codexTerminalStatusFromMarkers(["error:1"]), undefined);
console.log("agent terminal status reconciliation contracts OK");

const terminalStream = {
  [Symbol.asyncIterator]() {
    let sent = false;
    return {
      next() {
        if (!sent) { sent = true; return Promise.resolve({ done: false, value: { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } } }); }
        return new Promise(() => undefined);
      },
      return() { return Promise.resolve({ done: true }); }
    };
  }
};
const terminalResult = await Promise.race([
  consumeCodexTurnEvents(terminalStream, () => undefined, { pollIntervalMs: 5 }),
  new Promise((_, reject) => setTimeout(() => reject(new Error("terminal stream did not close")), 250))
]);
assert.equal(terminalResult.completed, true);
assert.equal(terminalResult.forcedByDurableResult, false);
assert.equal(codexTurnFailure(terminalResult, terminalResult.lastError, "missing"), "");

let forcedTerminal = false;
const stalledStream = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined), return: () => Promise.resolve({ done: true }) }) };
const durableResult = await consumeCodexTurnEvents(stalledStream, () => undefined, {
  isDurableResultCommitted: () => true,
  durableResultGraceMs: 20,
  pollIntervalMs: 5,
  onTerminal: () => { forcedTerminal = true; }
});
assert.equal(durableResult.completed, true);
assert.equal(durableResult.forcedByDurableResult, true);
assert.equal(forcedTerminal, true);

const interruptedStream = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined), return: () => Promise.resolve({ done: true }) }) };
const interruptController = new AbortController();
setTimeout(() => interruptController.abort(new Error("guide interrupt")), 10);
await assert.rejects(
  Promise.race([
    consumeCodexTurnEvents(interruptedStream, () => undefined, { signal: interruptController.signal, pollIntervalMs: 5 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("aborted stream did not release")), 250))
  ]),
  /guide interrupt/
);
console.log("codex terminal stream takeover contracts OK");

const sessionEvents = [];
const persistedThreads = [];
const threadSelections = [];
const sessionTurn = await runCodexSessionTurn({
  createThread: (threadId) => {
    threadSelections.push(threadId || null);
    return {
      runStreamed: async () => ({
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "thread.started", thread_id: "thread-shared-1" };
            yield { type: "turn.started" };
            yield { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 3 } };
          }
        }
      })
    };
  },
  threadId: "thread-resume-source",
  prompt: "shared turn",
  signal: new AbortController().signal,
  missingCompletionMessage: "missing completion",
  onThreadId: (threadId) => persistedThreads.push(threadId),
  onEvent: (event) => sessionEvents.push(event.type)
});
assert.deepEqual(threadSelections, ["thread-resume-source"]);
assert.deepEqual(persistedThreads, ["thread-shared-1"]);
assert.deepEqual(sessionEvents, ["thread.started", "turn.started", "turn.completed"]);
assert.equal(sessionTurn.threadId, "thread-shared-1");
assert.equal(sessionTurn.completed, true);
assert.equal(sessionTurn.failure, "");
console.log("shared Codex session runner persistence and resume contracts OK");

assert.equal(skillPolicyEnabled("auto"), true);
assert.equal(skillPolicyEnabled("always"), true);
assert.equal(skillPolicyEnabled("manual"), false);
assert.equal(skillPolicyEnabled("manual", true), true);
assert.equal(skillPolicyEnabled("off", true), false);
console.log("skill policy contracts OK");

assert.deepEqual(delegationAdmission(4, 19, 5, 20), { accepted: true });
assert.deepEqual(delegationAdmission(5, 0, 5, 20), { accepted: false, reason: "parent-limit" });
assert.deepEqual(delegationAdmission(0, 20, 5, 20), { accepted: false, reason: "global-limit" });
console.log("delegation admission contracts OK");

assert.deepEqual(delegationIdempotency("same", "same"), { deduplicated: true });
assert.deepEqual(delegationIdempotency(undefined, "legacy"), { deduplicated: true });
assert.deepEqual(delegationIdempotency("old", "new"), { deduplicated: false, conflict: true });
console.log("delegation idempotency contracts OK");

for (const engine of ["claude", "codex"]) {
  const ordinary = orchestrationCapabilities(engine, false);
  assert.equal(ordinary.nativeAgents, true);
  assert.equal(ordinary.bridgeClaude, false);
  assert.equal(ordinary.bridgeCodex, false);
  const collaborative = orchestrationCapabilities(engine, true);
  assert.equal(collaborative.nativeAgents, false);
  assert.equal(collaborative.bridgeClaude, true);
  assert.equal(collaborative.bridgeCodex, true);
  assert.equal(collaborative.requiresAcceptanceBarrier, true);
}
console.log("four engine/delegation modes OK");
