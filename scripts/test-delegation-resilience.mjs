import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createDelegationBroker } from "../server/plugins/collaboration/broker.ts";
import { createDelegationExecution } from "../server/plugins/collaboration/execution.ts";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function waitFor(check, message) {
  const deadline = Date.now() + 5_000;
  while (!check()) { if (Date.now() >= deadline) throw Error(message); await new Promise((done) => setTimeout(done, 10)); }
}
const usage = () => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
function task(id, parentSessionId = "parent") {
  return { id, parentSessionId, provider: "codex", status: "queued", nickname: id, task: "fixture", cwd: process.cwd(), mode: "implementation", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), usage: usage() };
}
function harness({ parents = ["parent"], externalCount = () => 0, binding = async () => ({}), execute, save = async () => {} } = {}) {
  const state = { sessions: parents.map((id) => ({ id, status: "running" })), delegatedTasks: [] };
  const active = new Map();
  const completions = new Map();
  const calls = [];
  let maximum = 0;
  const coordinator = createDelegationExecution({
    getState: () => state, isWorkbenchDelegationEnabled: () => true, activeDelegationTasks: active, getExternalActiveCount: externalCount,
    runtimeBindingForProvider: binding, saveState: () => save(state), upsertDelegatedTask: (item) => state.delegatedTasks.push(item), appendMessage() {},
    agentAdapterRegistry: { execute: async (request) => {
      const item = state.delegatedTasks.find((item) => item.id === request.taskId);
      item.status = "running"; active.set(item.id, { parentTaskId: item.parentSessionId });
      maximum = Math.max(maximum, active.size); calls.push(item.id);
      try {
        if (execute) await execute(item, request);
        else { const completion = deferred(); completions.set(item.id, completion); await completion.promise; }
        item.status = "completed";
      } finally { active.delete(item.id); }
    } }
  });
  const submit = (item) => { state.delegatedTasks.push(item); return coordinator.launch(item); };
  const finish = (id) => completions.get(id)?.resolve();
  return { state, active, calls, coordinator, submit, completions, finish, maximum: () => maximum };
}

// Dependency closures may reference subsystem maps declared later in bootstrap.
// Construction and empty activation must not eagerly read those dependencies.
{
  let dependenciesReady = false;
  let reads = 0;
  const h = harness({ externalCount: () => { assert.equal(dependenciesReady, true); reads++; return 0; }, execute: async () => {} });
  h.coordinator.start(); assert.equal(reads, 0);
  dependenciesReady = true; await h.submit(task("late-dependencies"));
  assert.ok(reads > 0); await h.coordinator.stop();
}
console.log("delegation lazy cross-subsystem dependency closure passed");

// Runtime discovery must reserve a slot before its first await, and duplicate
// launches of the same persisted task cannot create a second worker.
{
  const binding = deferred();
  const h = harness({ binding: () => binding.promise, execute: async () => {} });
  const first = task("binding-0");
  const promises = [h.submit(first), ...Array.from({ length: 5 }, (_, index) => h.submit(task(`binding-${index + 1}`)))];
  assert.equal(h.coordinator.launch(first), promises[0]);
  assert.equal(h.coordinator.activeCount(), 5);
  assert.equal(h.calls.length, 0);
  binding.resolve({}); await Promise.all(promises);
  assert.equal(h.calls.length, 6); assert.ok(h.maximum() <= 5);
  await h.coordinator.stop();
}
console.log("delegation runtime-binding reservations and duplicate launch guard passed");

// Queue saturation is waiting, never a failed worker or a sixth actual start.
{
  const h = harness();
  const promises = Array.from({ length: 7 }, (_, index) => h.submit(task(`parent-${index}`)));
  await waitFor(() => h.calls.length === 5, "first five workers did not start");
  assert.equal(h.state.delegatedTasks.filter((item) => item.status === "queued").length, 2);
  assert.equal(h.coordinator.activeCount(), 5, "active map and internal leases count each task once");
  h.finish("parent-0"); await waitFor(() => h.calls.length === 6, "waiting worker did not start after release");
  h.finish("parent-1"); await waitFor(() => h.calls.length === 7, "second waiting worker did not start after release");
  for (const id of h.completions.keys()) h.finish(id);
  await Promise.all(promises); assert.equal(h.maximum(), 5); await h.coordinator.stop();
}
console.log("delegation queued capacity and per-parent execution budget passed");

// A different subsystem can consume the global budget. A queued worker wakes
// when that external subsystem releases capacity, without another delegation.
{
  let external = 19;
  const h = harness({ externalCount: () => external });
  const promises = Array.from({ length: 3 }, (_, index) => h.submit(task(`external-${index}`)));
  await waitFor(() => h.calls.length === 1, "global budget did not start one worker");
  assert.equal(h.coordinator.activeCount(), 1); external = 17;
  await waitFor(() => h.calls.length === 3, "external capacity release did not wake queued work");
  for (const id of h.completions.keys()) h.finish(id);
  await Promise.all(promises); await h.coordinator.stop();
}
{
  const h = harness({ parents: ["p0", "p1", "p2", "p3", "p4"] });
  const promises = Array.from({ length: 25 }, (_, index) => h.submit(task(`global-${index}`, `p${Math.floor(index / 5)}`)));
  await waitFor(() => h.calls.length === 20, "global first 20 workers did not start");
  assert.equal(h.coordinator.activeCount(), 20);
  for (const id of [...h.completions.keys()]) h.finish(id);
  await waitFor(() => h.calls.length === 25, "global waiting workers did not drain");
  for (const id of h.completions.keys()) h.finish(id);
  await Promise.all(promises); assert.equal(h.maximum(), 20); await h.coordinator.stop();
}
console.log("delegation global execution budget and external capacity wake passed");

// Simulate a provider persisting its failed status before throwing. A newly
// admitted replacement uses the free admission slot while the retry waits.
{
  const providerFailure = deferred();
  const failureRegistered = deferred();
  const retrySaved = deferred();
  let failedOnce = false;
  let h;
  h = harness({
    execute: async (item) => {
      if (item.id === "fails" && !failedOnce) {
        failedOnce = true; item.status = "failed"; await providerFailure.promise; throw Error("fetch failed");
      }
      const completion = deferred(); h.completions.set(item.id, completion); await completion.promise;
    },
    save: async (state) => { if (state.delegatedTasks.some((item) => item.retryOf === "fails") && !retrySaved.done) { failureRegistered.resolve(); await retrySaved.promise; } }
  });
  const originals = [h.submit(task("fails")), ...Array.from({ length: 4 }, (_, index) => h.submit(task(`busy-${index}`)))];
  await waitFor(() => failedOnce && h.calls.length === 5, "failed provider fixture did not start");
  const replacement = h.submit(task("replacement"));
  providerFailure.resolve(); await failureRegistered.promise;
  assert.equal(h.state.delegatedTasks.filter((item) => ["queued", "running"].includes(item.status)).length, 6);
  assert.ok(h.state.delegatedTasks.some((item) => item.retryOf === "fails" && item.status === "queued"), "parent barrier must see the retry before persistence completes");
  assert.ok(h.coordinator.activeCount() <= 5);
  retrySaved.done = true; retrySaved.resolve();
  await waitFor(() => h.calls.includes("replacement"), "replacement failed to start");
  await new Promise((done) => setTimeout(done, 1_100));
  assert.equal(h.calls.length, 6, "retry cannot start as a sixth worker");
  h.finish("replacement");
  await waitFor(() => h.calls.some((id) => id.startsWith("fails:retry-1-")), "retry did not start when budget freed");
  assert.equal(h.maximum(), 5);
  for (const id of h.completions.keys()) h.finish(id);
  await Promise.all([...originals, replacement]);
  await waitFor(() => h.coordinator.activeCount() === 0, "retry did not release its execution lease");
  assert.equal(h.state.delegatedTasks.find((item) => item.retryOf === "fails").status, "completed"); await h.coordinator.stop();
}
console.log("delegation retry/admission race and parent barrier continuity passed");

// Stop persists waiting work as interrupted and does not replay it after start.
{
  const binding = deferred();
  const h = harness({ binding: () => binding.promise, execute: async () => {} });
  const promises = Array.from({ length: 6 }, (_, index) => h.submit(task(`stop-${index}`)));
  await h.coordinator.stop();
  assert.ok(h.state.delegatedTasks.every((item) => item.status === "interrupted"));
  h.coordinator.start(); binding.resolve({}); await Promise.all(promises);
  assert.equal(h.calls.length, 0);
  await h.coordinator.stop();
  const afterStop = task("after-stop"); await h.submit(afterStop);
  assert.equal(afterStop.status, "interrupted");
}
{
  const h = harness();
  const promises = Array.from({ length: 6 }, (_, index) => h.submit(task(`parent-stop-${index}`)));
  await waitFor(() => h.calls.length === 5, "stop-parent fixture did not start");
  h.state.sessions[0].status = "stopped";
  await waitFor(() => h.state.delegatedTasks[5].status === "interrupted", "queued task did not notice stopped parent");
  assert.equal(h.calls.length, 5); for (const id of h.completions.keys()) h.finish(id);
  await Promise.all(promises); await h.coordinator.stop();
}
console.log("delegation stop/start generation, queue persistence and parent cancellation passed");

// A completed write cannot be replayed because cleanup later throws.
{
  const h = harness({ execute: async (item) => { item.status = "completed"; throw Error("fetch failed after completion"); } });
  await h.submit(task("already-completed"));
  assert.equal(h.state.delegatedTasks.length, 1); assert.equal(h.calls.length, 1); await h.coordinator.stop();
}
console.log("delegation completed-side-effect retry guard passed");

{
  const h = harness({ execute: async () => { throw Error("rate limit exceeded"); } });
  await h.submit(task("exhaustion"));
  await waitFor(() => h.state.delegatedTasks.length === 3 && h.state.delegatedTasks.every((item) => item.status === "failed") && h.coordinator.activeCount() === 0, "retry exhaustion did not settle");
  assert.equal(h.calls.length, 3); assert.equal(h.state.delegatedTasks.at(-1).retryCount, 2);
  await h.coordinator.stop();
}
{
  let failedSave = false;
  const h = harness({ execute: async () => { throw Error("fetch failed"); }, save: async (state) => {
    if (state.delegatedTasks.length > 1 && !failedSave) { failedSave = true; throw Error("disk full"); }
  } });
  await assert.rejects(h.submit(task("retry-save-fails")), /disk full/);
  assert.equal(h.state.delegatedTasks.at(-1).status, "interrupted", "a non-durable retry must not remain waiting or execute");
  assert.equal(h.calls.length, 1); await h.coordinator.stop();
}
console.log("delegation finite retry exhaustion and retry persistence failure passed");

function brokerHarness(existing = []) {
  const state = { sessions: [{ id: "parent", status: "running" }], delegatedTasks: existing };
  const broker = createDelegationBroker({
    getState: () => state, isWorkbenchDelegationEnabled: () => true, executionWorkspaceForSession: () => ({ root: process.cwd() }), assertExecutionCwd: () => process.cwd(), activeDelegationTasks: new Map(),
    agentAdapterRegistry: { requireDescriptor: (id) => ({ adapterId: id, shortName: id, capabilities: { delegation: { worker: true } } }), requireCapabilities: (_id, requirements) => requirements || [] },
    upsertDelegatedTask: (item) => state.delegatedTasks.push(item), saveState: async () => {}, launchDelegatedExecution() {}
  }); return { state, broker };
}
{
  const h = brokerHarness();
  const request = { parentTaskId: "parent", prompt: "implement fixture", idempotencyKey: "v2", capabilityRequirements: ["terminal", "workspace-write"], adapterOptions: { configValues: { policy: "write", model: "fixture" } } };
  await h.broker.queue(request, "codex");
  assert.match(h.state.delegatedTasks[0].requestFingerprint, /^v2:/);
  assert.equal((await h.broker.queue({ ...request, capabilityRequirements: ["workspace-write", "terminal", "terminal"], adapterOptions: { configValues: { model: "fixture", policy: "write" } } }, "codex")).deduplicated, true);
  await assert.rejects(h.broker.queue({ ...request, capabilityRequirements: ["terminal"] }, "codex"), /幂等/);
  await assert.rejects(h.broker.queue({ ...request, adapterOptions: { configValues: { model: "other", policy: "write" } } }, "codex"), /幂等/);
}
for (const hasFingerprint of [true, false]) {
  const existing = { ...task("legacy"), task: "legacy request", mode: "implementation", idempotencyKey: "legacy", capabilityRequirements: ["terminal"], adapterOptions: { configValues: { model: "fixture" } } };
  if (hasFingerprint) existing.requestFingerprint = crypto.createHash("sha256").update(JSON.stringify({ provider: "codex", parentTaskId: "parent", cwd: process.cwd(), prompt: existing.task, acceptance: [], mode: "implementation" })).digest("hex");
  const h = brokerHarness([existing]);
  const input = { parentTaskId: "parent", prompt: existing.task, idempotencyKey: "legacy", capabilityRequirements: ["terminal"], adapterOptions: { configValues: { model: "fixture" } } };
  assert.equal((await h.broker.queue(input, "codex")).deduplicated, true);
  await assert.rejects(h.broker.queue({ ...input, prompt: "different request" }, "codex"), /幂等/);
  await assert.rejects(h.broker.queue({ ...input, capabilityRequirements: ["workspace-write"] }, "codex"), /幂等/);
}
console.log("delegation v2 effective-contract fingerprints and legacy receipt compatibility passed");

{
  const h = brokerHarness();
  const replies = await Promise.allSettled(Array.from({ length: 9 }, (_, index) => h.broker.queue({ parentTaskId: "parent", taskId: `admit-${index}`, prompt: `independent-${index}` }, "codex")));
  assert.equal(replies.filter((reply) => reply.status === "fulfilled").length, 5);
  assert.equal(h.state.delegatedTasks.length, 5);
  assert.ok(replies.filter((reply) => reply.status === "rejected").every((reply) => /并发上限/.test(reply.reason.message)));
}
console.log("delegation serialized normal admission saturation passed");
