import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import path from "node:path";
import { createOrchestrationScheduler } from "../server/plugins/orchestration/scheduler.ts";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// Execute the repository's actual function bodies without booting the HTTP
// server, native CLIs, user database or network. TypeScript's AST determines
// function boundaries; the compiler erases only their TypeScript annotations.
function executableFunction(source, fileName, name, ports) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let declaration;
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    else ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(declaration, `missing function ${name}`);
  const { outputText } = ts.transpileModule(declaration.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  return vm.runInNewContext(`${outputText}\n${name};`, { AbortController, Error, console, setTimeout, ...ports }, { filename: `${fileName}:${name}` });
}

const indexSource = await readFile(new URL("../server/index.ts", import.meta.url), "utf8");
const runtimeSource = await readFile(new URL("../server/plugins/orchestration/runtime.ts", import.meta.url), "utf8");
const emptyUsage = () => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });

for (const [name, provider] of [["runCodexBridgeTask", "codex"], ["runClaudeBridgeTask", "claude"], ["runAcpBridgeTask", "fixture-acp"]]) {
  for (const failure of ["initial-save", "persistent-save", "initial-upsert"]) {
    const unrelated = { parentTaskId: "other", providerId: provider, controller: new AbortController() };
    const active = new Map([["unrelated", unrelated]]);
    const updates = [];
    let saves = 0;
    let runs = 0;
    let closes = 0;
    let upserts = 0;
    const initialError = new Error(`${provider} ${failure} fixture`);
    const upsert = (_parent, agent) => {
      upserts++;
      if (failure === "initial-upsert" && upserts === 1) throw initialError;
      updates.push({ status: agent.status, logs: agent.logs.map(log => ({ ...log })) });
    };
    const runner = executableFunction(indexSource, "server/index.ts", name, {
      state: { sessions: [{ id: "parent", ownerUserId: "local", engineSessionId: "thread" }], delegatedTasks: [], settings: {} },
      activeDelegationTasks: active,
      isWorkbenchDelegationEnabled: () => true,
      executionWorkspaceForSession: () => ({ id: "workspace", root: process.cwd() }),
      assertExecutionCwd: (_workspace, cwd) => cwd,
      emptyUsage,
      uid: prefix => `${prefix}-fixture`,
      timeoutReason: () => undefined,
      trimAgentLogs: () => {},
      upsertCodexBridgeMessage: upsert,
      upsertClaudeBridgeMessage: upsert,
      upsertAcpBridgeMessage: upsert,
      saveState: async () => {
        saves++;
        assert.ok(active.has("worker"), "execution slot must exist while initial state is persisted");
        if (failure === "persistent-save" || (failure === "initial-save" && saves === 1)) throw initialError;
      },
      buildCodex: () => { runs++; throw new Error("unexpected Codex start"); },
      getClaudeRuntime: async () => { runs++; throw new Error("unexpected Claude start"); },
      providerConnectionFor: () => undefined,
      providerConnectionConfigValues: () => ({}),
      recordOf: value => value && typeof value === "object" ? value : undefined
    });
    const request = { parentTaskId: "parent", taskId: "worker", prompt: "isolated fault fixture" };
    const acp = { run: async () => { runs++; }, close: async sessionId => { closes++; assert.equal(sessionId, "delegated:worker"); if (failure === "persistent-save") throw new Error("close also failed"); } };
    const execute = () => name === "runAcpBridgeTask"
      ? runner({ id: provider, shortName: "Fixture", displayName: "Fixture ACP" }, acp, request)
      : runner(request);
    await assert.rejects(execute(), error => error === initialError);
    assert.equal(runs, 0, `${provider}: an initial persistence failure must not launch a CLI`);
    assert.equal(active.size, 1, `${provider}: execution slot leaked after ${failure}`);
    assert.equal(active.get("unrelated"), unrelated, `${provider}: cleanup affected an unrelated execution`);
    assert.equal(updates.at(-1)?.status, "failed", `${provider}: failure remains inspectable`);
    if (name === "runAcpBridgeTask") assert.equal(closes, 1, "ACP runtime cleanup must run even before a provider session starts");
  }
}
console.log("Native and ACP bridge initial upsert/save failures release slots, preserve unrelated executions and avoid CLI starts");

function integrationHarness({ discovery = async () => ({}), fault = "" } = {}) {
  const active = new Map();
  const workflow = { id: "integration", ownerUserId: "local", workspaceId: "workspace", plannerEngine: "codex", workDirectory: process.cwd(), status: "running", revision: 1, nodes: [] };
  const counters = { discovery: 0, begin: 0, sync: 0, event: 0, invalidated: 0, executed: 0 };
  const initialError = new Error(`integration ${fault} fixture`);
  const repository = {
    get: () => workflow,
    beginIntegration: () => { counters.begin++; if (fault === "begin") throw initialError; workflow.status = "integrating"; return { changed: false }; },
    appendIntegrationLog: () => {},
    finishIntegration: (_id, status) => { workflow.status = status; }
  };
  const execute = executableFunction(runtimeSource, "server/plugins/orchestration/runtime.ts", "integrateWorkflow", {
    workflowRepository: repository,
    workspaceById: () => ({ id: "workspace", root: process.cwd() }),
    workflowExecutionRoot: workflow => workflow.executionRoot || workflow.workDirectory,
    workspaceExecutionCoordinator: { acquire: async () => ({ release: () => {} }) },
    activeWorkflowIntegrations: active,
    runtimeBindingForProvider: async () => { counters.discovery++; if (fault === "discovery") throw initialError; return discovery(); },
    workflowStateFiles: {
      sync: () => { counters.sync++; if (fault === "persistent-sync" || (fault === "initial-sync" && counters.sync === 1)) throw initialError; },
      appendEvent: () => { counters.event++; if (fault === "initial-event" && counters.event === 1) throw initialError; }
    },
    workflowLog: (kind, title, text) => ({ kind, title, text }),
    workflowFailureResult: message => ({ unresolved: [message], changedFiles: [], checks: [], warnings: [], outputs: [] }),
    persistWorkflowFinalResult: (_workflow, _workspace, result) => result,
    workflowEvent: () => {},
    workflowFailureCategory: () => "permanent",
    workflowIntegratorPrompt: () => "fixture",
    runWorkflowTextAgent: async () => { counters.executed++; throw initialError; },
    workspaceTreeIndex: { invalidate: () => { counters.invalidated++; } },
    path
  });
  return { active, workflow, counters, execute, initialError };
}
for (const fault of ["discovery", "begin", "initial-sync", "persistent-sync", "initial-event"]) {
  const h = integrationHarness({ fault });
  const pending = h.execute("integration", "local");
  assert.equal(h.active.size, 1, `${fault}: integration must reserve before its first await`);
  if (fault === "persistent-sync") await assert.rejects(pending, error => error === h.initialError);
  else await pending;
  assert.equal(h.active.size, 0, `${fault}: initialization failure leaked integration capacity`);
  assert.equal(h.counters.invalidated, 1, `${fault}: finalization did not invalidate the workspace cache`);
  assert.equal(h.counters.executed, 0, `${fault}: initialization failure started a provider`);
  assert.equal(h.workflow.status, "needs_review", `${fault}: failed integration was not recoverable`);
}
for (const status of ["paused", "canceled"]) {
  const gate = deferred();
  const h = integrationHarness({ discovery: () => gate.promise });
  const pending = h.execute("integration", "local");
  assert.equal(h.active.size, 1, "runtime discovery must count as active integration capacity");
  await h.execute("integration", "local");
  assert.equal(h.counters.discovery, 1, "duplicate integration must not start a second discovery or overwrite the controller");
  h.workflow.status = status;
  h.active.get("integration").abort(new Error(`user ${status}`));
  gate.resolve({});
  await pending;
  assert.equal(h.counters.begin, 0, `${status}: aborted runtime discovery still began integration`);
  assert.equal(h.counters.executed, 0, `${status}: aborted runtime discovery started a provider`);
  assert.equal(h.workflow.status, status, `${status}: an abort overwrote the user's control state`);
  assert.equal(h.active.size, 0, `${status}: aborted discovery leaked integration capacity`);
}
console.log("Integration reserves synchronously, deduplicates discovery, releases initialization failures and respects pause/cancel while awaiting runtime");

function schedulerHarness({ fallback = false, startupFault = "", persistentStartupFault = false, startupErrorText = "" } = {}) {
  let enabled = true;
  let startupFaultEnabled = true;
  let reservedDelegations = 19;
  const gate = deferred();
  const execution = deferred();
  const activeNodes = new Map();
  const activeIntegrations = new Map();
  const activeDelegations = new Map();
  if (fallback) for (let index = 0; index < 19; index++) activeDelegations.set(`delegated-${index}`, { parentTaskId: "other", providerId: "codex", controller: new AbortController() });
  const ticks = new Set();
  const node = { id: "node", recordId: "record", status: "pending", provider: "codex", failurePolicy: "retry_then_review", workspaceAccess: "read", writeScope: [], dependsOn: [], requiredArtifacts: [], required: true, skills: [], logs: [], planVersion: 1, attempt: 0 };
  const workflow = { id: "workflow", workspaceId: "workspace", ownerUserId: "local", workDirectory: process.cwd(), status: "running", nodes: [node], maxConcurrentAgents: 5, revision: 1 };
  const counters = { discovery: 0, claims: 0, executions: 0, integration: 0, startupFaults: 0, projectionAcquisitions: 0, projectionReleases: 0 };
  const attempts = [];
  const failOnce = boundary => {
    if (startupFaultEnabled && startupFault === boundary && (persistentStartupFault || counters.startupFaults === 0)) {
      counters.startupFaults++;
      throw new Error(startupErrorText || `scheduler ${boundary} setup fixture`);
    }
  };
  const repository = {
    get: () => workflow,
    updateRun: (_id, status) => { workflow.status = status; },
    updateNode: () => {},
    claimNodeAttempt: (_nodeId, _runnerId, checkpointRoot) => { counters.claims++; node.status = "running"; node.attempt++; const attempt = { id: `attempt-${node.attempt}`, attempt: node.attempt, status: "running", checkpointDirectory: path.join(checkpointRoot, `attempt-${node.attempt}`) }; attempts.push(attempt); return attempt; },
    checkpointNodeAttempt: (id, update) => { const attempt = attempts.find(item => item.id === id); if (attempt) Object.assign(attempt, update); },
    invalidateCompletedDependents: () => {}
  };
  const scheduler = createOrchestrationScheduler({
    workflowTicks: ticks,
    workspaceById: () => ({ id: "workspace", root: process.cwd() }),
    syncWorkflowProtocolFiles: () => { failOnce("sync"); return workflow; },
    appendWorkflowProtocolEvent: () => { failOnce("event"); },
    workflowEvent: () => {},
    activeWorkflowNodes: activeNodes,
    activeWorkflowIntegrations: activeIntegrations,
    activeDelegationTasks: activeDelegations,
    ...(fallback ? {} : { getDelegationActiveCount: () => reservedDelegations }),
    integrateWorkflow: async () => { counters.integration++; },
    currentWorkflowProviderCapabilities: async () => ({}),
    runtimeBindingForProvider: async () => { counters.discovery++; return gate.promise; },
    WORKFLOW_RUNNER_ID: "isolated-test",
    workflowNodeIntents: new Map(),
    skillProjectionManager: { acquireTemporarySkills: () => { failOnce("projection"); counters.projectionAcquisitions++; return () => { counters.projectionReleases++; }; } },
    workspaceTreeIndex: { invalidate: () => { failOnce("invalidate"); } },
    executeWorkflowNode: async () => { counters.executions++; return execution.promise; },
    workflowResultDigest: () => "fixture-digest",
    workflowRepository: repository,
    workflowStateFiles: { directoryFor: () => process.cwd() },
    isEnabled: () => enabled
  });
  return { scheduler, workflow, node, counters, attempts, gate, execution, ticks, activeNodes, activeIntegrations,
    setReservedDelegations: count => { reservedDelegations = count; },
    clearStartupFault: () => { startupFaultEnabled = false; },
    disable: () => { enabled = false; scheduler.dispose(); } };
}
for (const fallback of [false, true]) {
  const h = schedulerHarness({ fallback });
  try {
    h.scheduler.queueWorkflowTick("workflow", "local");
    await waitFor(() => h.counters.discovery === 1, "scheduler did not reach asynchronous runtime discovery");
    if (fallback) h.activeIntegrations.set("other-integration", new AbortController());
    else h.setReservedDelegations(20);
    h.gate.resolve({});
    await waitFor(() => !h.ticks.has("workflow"), "blocked scheduler tick did not finish");
    assert.equal(h.counters.claims, 0, "runtime discovery resumed after the global budget filled but still claimed a node");
    assert.equal(h.counters.executions, 0, "scheduler started a twenty-first execution");
    assert.equal(h.activeNodes.size, 0, "blocked scheduling leaked an active node");
    assert.equal(h.node.status, "pending", "blocked scheduling changed a waiting node's durable state");
    if (fallback) h.activeIntegrations.clear();
    else h.setReservedDelegations(19);
    h.scheduler.queueWorkflowTick("workflow", "local");
    await waitFor(() => h.counters.executions === 1, "a waiting node did not start after global capacity became available");
    assert.equal(h.counters.claims, 1);
    assert.equal(h.activeNodes.size, 1);
    h.disable();
    h.execution.resolve({ humanSummary: "isolated scheduler fixture completed", outcome: "completed", changedFiles: [], checks: [], warnings: [], unresolved: [], outputs: [] });
    await waitFor(() => h.activeNodes.size === 0, "successful resumed node did not release its execution slot");
    assert.equal(h.node.status, "completed");
  } finally { h.disable(); }
}
console.log("Scheduler rechecks global 20-slot capacity after awaited runtime discovery, counts internal delegation reservations and resumes safely after release");

// Watch actual heartbeat handles while running the real scheduler. A leaked
// 30-second lease timer can keep renewing a node which never started its Agent.
for (const startupFault of ["sync", "event", "projection", "invalidate"]) {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const heartbeats = new Set();
  globalThis.setInterval = (...args) => { const timer = originalSetInterval(...args); heartbeats.add(timer); return timer; };
  globalThis.clearInterval = timer => { heartbeats.delete(timer); return originalClearInterval(timer); };
  const h = schedulerHarness({ startupFault });
  try {
    h.gate.resolve({});
    h.scheduler.queueWorkflowTick("workflow", "local");
    await waitFor(() => h.counters.startupFaults === 1 && h.workflow.status === "needs_review" && !h.ticks.has("workflow"), `${startupFault}: permanent initialization fault did not finish in review`);
    assert.equal(h.counters.claims, 1, `${startupFault}: fixture did not claim an actual node attempt`);
    assert.equal(h.counters.executions, 0, `${startupFault}: initialization fault still started a provider`);
    assert.equal(h.activeNodes.size, 0, `${startupFault}: initialization fault leaked active node capacity`);
    assert.equal(heartbeats.size, 0, `${startupFault}: initialization fault leaked a lease heartbeat`);
    assert.equal(h.counters.projectionReleases, h.counters.projectionAcquisitions, `${startupFault}: initialization fault leaked temporary skill ownership`);
    assert.equal(h.node.status, "failed", `${startupFault}: permanent setup failure was not finalized`);
    assert.equal(h.attempts[0].status, "failed", `${startupFault}: durable attempt remains running without an execution`);
    assert.equal(h.attempts[0].leaseExpiresAt, null, `${startupFault}: abandoned startup still holds a live lease`);
    // Explicit user retry restores eligibility after the cause is addressed.
    h.node.status = "pending";
    h.workflow.status = "running";
    h.scheduler.queueWorkflowTick("workflow", "local");
    await waitFor(() => h.counters.executions === 1, `${startupFault}: explicitly retried startup could not be rescheduled`);
    assert.equal(h.counters.claims, 2);
    assert.equal(h.activeNodes.size, 1);
    assert.equal(heartbeats.size, 1, `${startupFault}: resumed execution did not start exactly one heartbeat`);
    h.disable();
    h.execution.resolve({ humanSummary: "resumed setup fixture", outcome: "completed", changedFiles: [], checks: [], warnings: [], unresolved: [], outputs: [] });
    await waitFor(() => h.activeNodes.size === 0, `${startupFault}: resumed execution did not release capacity`);
    assert.equal(heartbeats.size, 0, `${startupFault}: completed resumption leaked its heartbeat`);
    assert.equal(h.counters.projectionReleases, h.counters.projectionAcquisitions, `${startupFault}: completed resumption leaked temporary skill ownership`);
    assert.equal(h.attempts[1].status, "completed");
    assert.equal(h.node.status, "completed");
  } finally {
    h.disable();
    for (const timer of heartbeats) originalClearInterval(timer);
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}
console.log("Scheduler post-claim sync/event/projection/cache initialization faults release capacity and heartbeats, finish in review and allow explicit retry");

for (const startupFault of ["sync", "projection"]) {
  for (const transient of [false, true]) {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const originalConsoleError = console.error;
    const heartbeats = new Set();
    const handledErrors = [];
    const unhandledErrors = [];
    const onUnhandled = error => unhandledErrors.push(error);
    globalThis.setInterval = (...args) => { const timer = originalSetInterval(...args); heartbeats.add(timer); return timer; };
    globalThis.clearInterval = timer => { heartbeats.delete(timer); return originalClearInterval(timer); };
    console.error = (...args) => { handledErrors.push(args); };
    process.on("unhandledRejection", onUnhandled);
    const h = schedulerHarness({ startupFault, persistentStartupFault: true, startupErrorText: transient ? "ECONNRESET setup fault fixture" : "" });
    try {
      h.gate.resolve({});
      h.scheduler.queueWorkflowTick("workflow", "local");
      await waitFor(() => h.workflow.status === "needs_review" && !h.ticks.has("workflow"), `${startupFault}: recurring setup error did not stop in review`, 12_000);
      const expectedClaims = transient ? 3 : 1;
      assert.equal(h.counters.claims, expectedClaims, `${startupFault}: recurring setup failure exceeded its finite retry policy`);
      assert.equal(h.counters.executions, 0, `${startupFault}: setup failure accidentally started a provider`);
      assert.ok(h.attempts.every(attempt => attempt.status === "failed" && attempt.leaseExpiresAt === null), `${startupFault}: a failed attempt retains an active lease`);
      assert.equal(h.activeNodes.size, 0);
      assert.equal(heartbeats.size, 0);
      assert.equal(h.counters.projectionReleases, h.counters.projectionAcquisitions);
      const logsAtReview = h.node.logs.length;
      await new Promise(resolve => setTimeout(resolve, 1_100));
      assert.equal(h.counters.claims, expectedClaims, `${startupFault}: review still polls and claims new attempts`);
      assert.equal(h.node.logs.length, logsAtReview, `${startupFault}: stopped failure keeps growing task logs`);
      assert.equal(heartbeats.size, 0);
      assert.equal(unhandledErrors.length, 0, `${startupFault}: persistence failure became an unhandled rejection`);
      if (startupFault === "sync") assert.ok(handledErrors.length > 0, "persistent sync fixture did not exercise the reporting failure boundary");
      h.clearStartupFault();
      h.node.status = "pending";
      h.workflow.status = "running";
      h.scheduler.queueWorkflowTick("workflow", "local");
      await waitFor(() => h.counters.executions === 1, `${startupFault}: manual retry did not recover after correcting the recurring fault`);
      h.disable();
      h.execution.resolve({ humanSummary: "corrected recurring setup fault", outcome: "completed", changedFiles: [], checks: [], warnings: [], unresolved: [], outputs: [] });
      await waitFor(() => h.activeNodes.size === 0, `${startupFault}: corrected execution did not release capacity`);
      assert.equal(h.node.status, "completed");
      assert.equal(heartbeats.size, 0);
    } finally {
      h.disable();
      for (const timer of heartbeats) originalClearInterval(timer);
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      console.error = originalConsoleError;
      process.off("unhandledRejection", onUnhandled);
    }
  }
}
console.log("Persistent sync/projection setup failures obey finite permanent/transient retries, stop log/attempt growth in review and recover after explicit correction");
