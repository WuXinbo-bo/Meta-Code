import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { TaskContextStore, latestTaskHandoffForRoot, renderTaskHandoff, taskRootsEqual } from "../server/tasks/context.ts";
import { prepareWorkflowTaskContext } from "../server/tasks/executionContext.ts";
import { publishTaskWorkflowResult } from "../server/tasks/workflowResult.ts";
import { registerTaskContextRoutes } from "../server/tasks/routes.ts";
import { registerOrchestrationRoutes } from "../server/plugins/orchestration/controller.ts";
import { WorkflowRepository } from "../server/plugins/orchestration/repository.ts";
import { WorkflowStateFiles } from "../server/plugins/orchestration/stateFiles.ts";
import { WorkflowTargetService } from "../server/plugins/orchestration/targets.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-task-context-api-"));
const db = new DatabaseSync(path.join(temporary, "state.sqlite"));
db.exec("PRAGMA foreign_keys=ON");
const store = new TaskContextStore(db);
const secret = `sk-${"synthetic".repeat(4)}`;
const sessions = new Map();
const workflows = new Map();
const repository = new WorkflowRepository(db);
const runtime = path.join(temporary, "runtime");
const targets = new WorkflowTargetService(runtime);
const workspaces = new Map([["workspace", { id: "workspace", ownerUserId: "owner", root: temporary, name: "API test" }]]);
const session = (id, engine, ownerUserId = "owner", workspaceId = "workspace") => ({ id, ownerUserId, workspaceId, engine, title: "Task", revision: 2, status: "idle", updatedAt: new Date().toISOString(), messages: [{ id: "first", role: "user", text: `Original goal ${secret}` }], archivedAt: null });
const workflow = (id, target = "workspace", root = temporary) => ({ id, ownerUserId: "owner", workspaceId: "workspace", title: "Task", plannerEngine: "claude", originalPrompt: "User workflow goal", revision: 1, activePlanVersion: 1, status: "completed", executionTarget: target, executionRoot: root, workDirectory: root, finalResult: null, nodes: [] });
sessions.set("session", session("session", "codex"));
sessions.set("other-owner", session("other-owner", "claude", "other-owner"));
workflows.set("workflow", workflow("workflow"));
workflows.set("unlinked", workflow("unlinked"));
const context = store.ensure({ kind: "session", id: "session", executionRoot: temporary }, "owner", "workspace", "Task");
store.link(context.id, { kind: "workflow", id: "workflow", executionRoot: temporary }, "owner", "workspace");
let creations = 0;
let publications = 0;
let releaseCreation;
let failCreation = false;
let captured;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUser = { id: req.headers["x-owner"] || "owner" }; next(); });
const sessionById = (id, owner) => { const item = sessions.get(id); return item?.ownerUserId === owner ? item : undefined; };
const workflowById = (id, owner) => { const item = workflows.get(id); return item?.ownerUserId === owner ? item : repository.get(id, owner); };
const workspaceById = (id, owner) => { const item = workspaces.get(id); return item?.ownerUserId === owner ? item : undefined; };
const executionRootForSession = (item) => store.forExecution({ kind: "session", id: item.id }, item.ownerUserId)?.executions.find((execution) => execution.kind === "session" && execution.id === item.id)?.executionRoot || workspaces.get(item.workspaceId)?.root;
const publishWorkflowResult = (item) => {
  publications += 1;
  publishTaskWorkflowResult(item, { store, sessionById, executionRootForSession,
    appendMessage: (conversation, message) => { conversation.messages.push({ id: `result-${conversation.messages.length}`, createdAt: new Date().toISOString(), ...message }); conversation.revision += 1; }, onPublished: () => {} });
};
registerTaskContextRoutes(app, {
  store,
  sessionById, workflowById, executionRootForSession, publishWorkflowResult,
  createConversation: async (input) => {
    creations += 1; captured = input;
    if (failCreation) throw new Error("Synthetic persistence failure");
    const item = session(`created-${creations}`, input.engine, input.ownerUserId, input.workspaceId);
    sessions.set(item.id, item);
    store.link(input.taskContextId, { kind: "session", id: item.id, executionRoot: input.executionRoot || temporary }, input.ownerUserId, input.workspaceId);
    if (releaseCreation) await new Promise((resolve) => { releaseCreation.resolve = resolve; });
    return item;
  }
});
let workflowCreations = 0;
registerOrchestrationRoutes(app, {
  acquireRequest: () => () => {}, workspaceTreeIndex: { invalidate: () => {} }, workflowRepository: repository, workspaceById,
  agentAdapterRegistry: { descriptor: () => ({ capabilities: { workflow: { planner: true } } }), workflowPlannerRunner: () => ({}) },
  providerReadiness: async () => ({ ready: true, issues: [] }), uid: () => `continued-${++workflowCreations}`,
  workflowStateFiles: new WorkflowStateFiles(path.join(runtime, "runs")), workflowEvent: () => {},
  workflowTargetService: targets, workflowRuntimeActive: () => false, activeWorkflowPlanners: new Map(), activeWorkflowNodes: new Map(), workflowNodeIntents: new Map(), activeWorkflowIntegrations: new Map(), activeWorkflowPlannerRuns: new Map(),
  waitForWorkflowRuntimeRelease: async () => {}, openInSystemFileManager: async () => {}, assertExistingDirectory: (value) => value,
  workflowResultPath: () => ({ absolute: temporary, relative: "." }), runtimeBindingForProvider: async () => ({}),
  workspaceAgentConfig: () => ({ skillPolicies: {} }), managedSkillManager: { listPublic: () => [] }, mcpServersForWorkspace: () => [],
  currentWorkflowProviderCapabilities: async () => ({}), WORKFLOW_PLANNER_TRANSACTION_DIR: path.join(runtime, "transactions"),
  workflowPlannerRequestKey: () => "fixture", requestWorkflowPlan: async () => { throw new Error("Not used by creation test"); }, plannerSkillContext: () => "",
  workflowPlannerFailureMessage: (error) => String(error), retryableWorkflowPlannerFailure: () => false,
  assertWorkflowExecutionReady: async () => {}, queueWorkflowTick: () => {},
  prepareTaskContext: (input) => prepareWorkflowTaskContext(input, { store, workspaceById, sessionById, executionRootForSession, workflowById, targets }),
  onWorkflowCreated: (item, taskContextId) => taskContextId ? store.link(taskContextId, { kind: "workflow", id: item.id, executionRoot: item.executionRoot }, item.ownerUserId, item.workspaceId) : store.ensure({ kind: "workflow", id: item.id, executionRoot: item.executionRoot }, item.ownerUserId, item.workspaceId, item.title),
  onWorkflowDeleted: (id, owner) => store.unlink({ kind: "workflow", id }, owner)
});
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const request = async (route, body, method = "POST", owner = "owner") => {
  const response = await fetch(`${url}${route}`, { method, headers: { "content-type": "application/json", "x-owner": owner }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};
const waitFor = async (check) => { const deadline = Date.now() + 3_000; while (!check()) { if (Date.now() > deadline) throw new Error("Request did not start"); await new Promise((resolve) => setTimeout(resolve, 10)); } };
try {
  assert.equal((await request(`/api/task-contexts/${context.id}`, undefined, "GET", "other-owner")).status, 404);
  assert.equal((await request("/api/task-contexts/lookup?sessionId=other-owner", undefined, "GET")).status, 404);
  assert.equal((await request("/api/task-contexts/lookup?sessionId=session&workflowId=workflow", undefined, "GET")).status, 400);
  const lookedUp = await request("/api/task-contexts/lookup?sessionId=session", undefined, "GET");
  assert.equal(lookedUp.body.id, context.id);
  assert.equal((await request(`/api/task-contexts/${context.id}/handoff`, { sessionId: "other-owner" })).status, 404);
  const handedOff = await request(`/api/task-contexts/${context.id}/handoff`, { sessionId: "session" });
  assert.equal(handedOff.status, 200);
  const history = await request(`/api/task-contexts/${context.id}/history?sessionId=session`, undefined, "GET");
  assert.equal(history.status, 200);
  assert.equal(history.body.entries.length, 1);
  assert.equal(history.body.entries[0].text, "Original goal [REDACTED]");
  assert.equal((await request(`/api/task-contexts/${context.id}/history?sessionId=session`, undefined, "GET", "other-owner")).status, 404);
  assert.equal((await request(`/api/task-contexts/${context.id}/history`, undefined, "GET")).status, 400);
  assert.equal((await request(`/api/task-contexts/${context.id}/history?sessionId=unlinked`, undefined, "GET")).status, 404);
  const exactHistory = await request(`/api/task-contexts/${context.id}/history?sessionId=session&referenceId=${history.body.entries[0].referenceId}`, undefined, "GET");
  assert.equal(exactHistory.body.entries[0].text, history.body.entries[0].text);

  assert.equal(JSON.stringify(handedOff.body).includes(secret), false);
  assert.equal(handedOff.body.handoffs[0].goal, "Original goal [REDACTED]");
  assert.equal((await request(`/api/task-contexts/${context.id}/conversation`, { workflowId: "unlinked" })).status, 409);
  assert.equal((await request(`/api/task-contexts/${context.id}/conversation`, { workflowId: "workflow", engine: "invalid provider" })).status, 409);
  assert.equal(creations, 0);
  const reused = await request(`/api/task-contexts/${context.id}/conversation`, { workflowId: "workflow", engine: "CODEX" });
  assert.equal(reused.status, 200);
  assert.equal(reused.body.id, "session");
  assert.equal(creations, 0);

  releaseCreation = {};
  const first = request(`/api/task-contexts/${context.id}/conversation`, { workflowId: "workflow", engine: "CLAUDE" });
  await waitFor(() => releaseCreation.resolve);
  let duplicateSettled = false;
  const duplicate = request(`/api/task-contexts/${context.id}/conversation`, { workflowId: "workflow", engine: "claude" }).then((reply) => { duplicateSettled = true; return reply; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(duplicateSettled, false, "duplicates must wait for durable creation, even when a session is already in memory");
  assert.equal(creations, 1);
  releaseCreation.resolve();
  const replies = await Promise.all([first, duplicate]);
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 201]);
  assert.equal(replies[0].body.id, replies[1].body.id);
  assert.equal(captured.executionRoot, temporary);
  assert.match(captured.handoff, /User workflow goal/);
  assert.deepEqual(captured.handoffSource, { kind: "workflow", id: "workflow", executionRoot: temporary, sourceRevision: workflows.get("workflow").revision }, "a newly created conversation retains the trusted workflow handoff provenance");
  releaseCreation = null;
  assert.equal((await request(`/api/task-contexts/${context.id}/conversation`, { workflowId: "workflow", engine: "claude" })).body.id, replies[0].body.id);
  assert.equal(creations, 1);

  const branchRoot = path.join(temporary, "branch");
  await fs.mkdir(branchRoot);
  workflows.set("branch", workflow("branch", "worktree", branchRoot));
  store.link(context.id, { kind: "workflow", id: "branch", executionRoot: branchRoot }, "owner", "workspace");
  const branchConversation = await request(`/api/task-contexts/${context.id}/conversation`, { workflowId: "branch", engine: "claude" });
  assert.equal(branchConversation.status, 201);
  assert.notEqual(branchConversation.body.id, replies[0].body.id);
  assert.equal(captured.executionRoot, branchRoot);
  assert.deepEqual(captured.handoffSource, { kind: "workflow", id: "branch", executionRoot: branchRoot, sourceRevision: workflows.get("branch").revision }, "branch conversation handoffs retain their source root and workflow revision");
  assert.equal(creations, 2);
  sessions.get(branchConversation.body.id).archivedAt = new Date().toISOString();
  assert.equal((await request(`/api/task-contexts/${context.id}/conversation`, { workflowId: "branch", engine: "claude" })).status, 201);
  assert.equal(creations, 3);

  failCreation = true;
  assert.equal((await request(`/api/task-contexts/${context.id}/conversation`, { workflowId: "workflow", engine: "gemini" })).status, 409);
  failCreation = false;
  assert.equal((await request(`/api/task-contexts/${context.id}/conversation`, { workflowId: "workflow", engine: "gemini" })).status, 201, "a failed request must release its in-flight key");
  assert.equal(creations, 5);
  assert.ok(publications >= 6);

  const result = (marker) => ({ outcome: "completed", humanSummary: marker, outputs: [{ path: `${marker}.txt` }], decisions: [], unresolved: [] });
  workflows.get("workflow").revision += 1;
  workflows.get("workflow").finalResult = result("main-only-marker");
  publishWorkflowResult(workflows.get("workflow"));
  const mainResults = sessions.get("session").messages.length;
  workflows.get("branch").revision += 1;
  workflows.get("branch").finalResult = result("branch-only-marker");
  publishWorkflowResult(workflows.get("branch"));
  assert.equal(sessions.get("session").messages.length, mainResults, "branch completion must not inject branch files into an original-root conversation");
  const stored = store.get(context.id, "owner");
  assert.equal(stored.handoffs.at(-1).source.id, "branch", "fixture must contain a newer handoff from another root");
  assert.match(renderTaskHandoff(latestTaskHandoffForRoot(stored, temporary)), /main-only-marker/);
  assert.doesNotMatch(renderTaskHandoff(latestTaskHandoffForRoot(stored, temporary)), /branch-only-marker/);
  sessions.get("session").updatedAt = "2099-01-01T00:00:00.000Z";
  const implicitConversation = await request(`/api/task-contexts/${context.id}/conversation`, { engine: "qwen" });
  assert.equal(implicitConversation.status, 201);
  assert.equal(captured.executionRoot, temporary, "without a workflow ID, conversation creation follows the latest active session root");
  assert.deepEqual(captured.handoffSource, { kind: "session", id: "session", executionRoot: temporary, sourceRevision: sessions.get("session").revision }, "implicit session handoffs cannot be mislabeled as the latest workflow from another root");
  assert.match(captured.handoff, /main-only-marker/);
  assert.doesNotMatch(captured.handoff, /branch-only-marker/);
  assert.equal((await request(`/api/task-contexts/${context.id}/conversation`, { sessionId: "unlinked", engine: "qwen" })).status, 409);
  assert.equal((await request(`/api/task-contexts/${context.id}/conversation`, { sessionId: "session", workflowId: "workflow" })).status, 409);

  const project = path.join(temporary, "project");
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, "existing.txt"), "Existing business project\n");
  const git = (...args) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main"); git("config", "user.name", "Task context fixture"); git("config", "user.email", "fixture@example.invalid"); git("add", "existing.txt"); git("commit", "-m", "Fixture baseline");
  workspaces.set("continuity", { id: "continuity", ownerUserId: "owner", root: project, name: "Continuous project" });
  const mainSession = session("continuous-main", "codex", "owner", "continuity");
  sessions.set(mainSession.id, mainSession);
  const continuousContext = store.ensure({ kind: "session", id: mainSession.id, executionRoot: project }, "owner", "continuity", "Continuous project");
  const initialFiles = await fs.readdir(project);
  for (const executionTarget of ["workspace", "isolated", "worktree"]) {
    const id = `source-${executionTarget}`;
    const target = await targets.prepare({ runId: id, ownerUserId: "owner", workspaceId: "continuity", workspaceRoot: project, executionTarget });
    targets.confirmPrepared(id, "owner");
    const source = repository.create({ id, ownerUserId: "owner", workspaceId: "continuity", ...target, prompt: `Maintain ${executionTarget} target`, plannerEngine: "codex" });
    store.link(continuousContext.id, { kind: "workflow", id, executionRoot: target.executionRoot }, "owner", "continuity");
    const conversation = await request(`/api/task-contexts/${continuousContext.id}/conversation`, { workflowId: id, engine: "codex" });
    assert.ok([200, 201].includes(conversation.status));
    const filesBefore = await fs.readdir(target.executionRoot);
    const directoriesBefore = await fs.readdir(path.join(runtime, "targets")).catch(() => []);
    const body = { workspaceId: "continuity", taskContextId: continuousContext.id, hostSessionId: conversation.body.id, prompt: "Continue in this task", plannerEngine: "codex" };
    const continued = await request("/api/workflows", body);
    assert.equal(continued.status, 201, JSON.stringify(continued.body));
    assert.equal(continued.body.executionRoot, await fs.realpath(target.executionRoot));
    assert.equal(continued.body.executionTarget, executionTarget);
    assert.equal(continued.body.worktreeId, target.worktreeId);
    assert.equal(continued.body.originalPrompt, body.prompt, "task handoff must not overwrite the durable user goal");
    const repeated = await request("/api/workflows", body);
    assert.equal(repeated.status, 201, JSON.stringify(repeated.body));
    assert.notEqual(repeated.body.id, continued.body.id);
    assert.equal(repeated.body.executionRoot, continued.body.executionRoot, "same-root orchestration states stay independent without another business directory");
    assert.deepEqual(await fs.readdir(target.executionRoot), filesBefore);
    assert.deepEqual(await fs.readdir(path.join(runtime, "targets")).catch(() => []), directoriesBefore, "mode switches must not allocate additional isolated or Worktree roots");
    const handoff = latestTaskHandoffForRoot(store.get(continuousContext.id, "owner"), target.executionRoot);
    assert.equal(handoff.source.kind, "session");
    assert.ok(taskRootsEqual(handoff.source.executionRoot, target.executionRoot));
    assert.match(renderTaskHandoff(handoff), /执行目录/);
    if (executionTarget !== "workspace") {
      assert.equal((await request("/api/workflows", { ...body, executionTarget: "workspace" })).status, 400, "a client must explicitly create a new target rather than silently switching back to the original project");
      assert.equal((await request("/api/workflows", { ...body, executionRoot: project })).status, 400, "client paths cannot override a trusted host session root");
    }
    if (executionTarget === "worktree") {
      const bindingFile = path.join(runtime, "worktree-bindings", `${target.worktreeId}.json`);
      const saved = await fs.readFile(bindingFile, "utf8");
      const originalBinding = JSON.parse(saved);
      await fs.writeFile(bindingFile, JSON.stringify({ ...originalBinding, ownerUserId: "other-owner" }));
      assert.equal((await request("/api/workflows", body)).status, 400, "a source session cannot inherit another owner's Worktree binding");
      await fs.writeFile(bindingFile, saved);
      try {
        const alias = path.join(temporary, "worktree-alias");
        await fs.symlink(target.executionRoot, alias, process.platform === "win32" ? "junction" : "dir");
        const aliasRequest = await request("/api/workflows", { ...body, executionRoot: alias });
        assert.equal(aliasRequest.status, 201, JSON.stringify(aliasRequest.body));
        assert.equal(aliasRequest.body.executionRoot, await fs.realpath(target.executionRoot), "aliases of the trusted business root keep one execution identity");
      } catch (error) { if (error.code !== "EPERM") throw error; }
    }
    repository.setPlanning(continued.body.id, "owner", continued.body.revision);
    assert.equal((await request(`/api/workflows/${continued.body.id}/metadata`, { archived: true }, "PUT")).status, 400, "active planning cannot disappear into the archive");
  }
  assert.deepEqual(await fs.readdir(project), initialFiles, "chat/orchestration cycles must not pollute the original project with task directories");
  const disappeared = workflow("disappeared", "isolated", path.join(temporary, "missing-root"));
  workflows.set(disappeared.id, disappeared);
  store.link(context.id, { kind: "workflow", id: disappeared.id, executionRoot: disappeared.executionRoot }, "owner", "workspace");
  const creationsBeforeMissing = creations;
  assert.equal((await request(`/api/task-contexts/${context.id}/conversation`, { workflowId: disappeared.id, engine: "codex" })).status, 409);
  assert.equal(creations, creationsBeforeMissing, "deleted business roots must fail before creating an unusable conversation");
  assert.equal((await request("/api/workflows", { workspaceId: "continuity", hostSessionId: "other-owner", prompt: "Unauthorized", plannerEngine: "codex" })).status, 400);
  console.log("task context API: Express/SQLite owner checks, redacted root provenance, concurrent dedup, root-filtered publication and prompts, source-free root selection, archive/failure recovery, real workspace/isolated/Git Worktree mode continuity without new directories passed");
} finally { await new Promise((resolve) => server.close(resolve)); db.close(); await fs.rm(temporary, { recursive: true, force: true }); }
