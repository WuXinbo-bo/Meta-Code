import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { taskDeletionPolicy } from "../server/sessionManagement/deletionPolicy.ts";
import { WorkflowRepository } from "../server/workflows/repository.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-task-deletion-"));
const dataRoot = path.join(temporaryRoot, "data");
const workspaceRoot = path.join(temporaryRoot, "workspace");
const apiToken = "task-deletion-test-token-0123456789";
const timestamp = new Date().toISOString();
await fsp.mkdir(dataRoot, { recursive: true });
await fsp.mkdir(workspaceRoot, { recursive: true });

assert.equal(taskDeletionPolicy("session", "completed").requiresTermination, false);
assert.equal(taskDeletionPolicy("session", "paused").action, "terminate-and-delete");
assert.equal(taskDeletionPolicy("session", "idle", true).requiresTermination, true);
assert.equal(taskDeletionPolicy("workflow", "awaiting_approval").requiresTermination, false);
for (const status of ["planning", "queued", "running", "integrating", "paused"]) {
  assert.equal(taskDeletionPolicy("workflow", status).requiresTermination, true, `${status} workflow must terminate before deletion`);
}

await fsp.writeFile(path.join(dataRoot, "state.json"), JSON.stringify({
  settings: {},
  workspaces: [{ id: "workspace-delete", name: "Deletion workspace", root: workspaceRoot, createdAt: timestamp }],
  sessions: [
    { id: "session-idle", title: "Idle task", scopeKind: "workspace", workspaceId: "workspace-delete", engine: "codex", codexThreadId: null, engineSessionId: null, status: "idle", revision: 1, messages: [], pendingInputs: [], usage: {}, createdAt: timestamp, updatedAt: timestamp },
    { id: "session-paused", title: "Paused task", scopeKind: "workspace", workspaceId: "workspace-delete", engine: "codex", codexThreadId: null, engineSessionId: null, status: "paused", revision: 1, messages: [], pendingInputs: [], usage: {}, createdAt: timestamp, updatedAt: timestamp }
  ],
  delegatedTasks: [],
  mcpServers: [],
  skillFolders: [],
  skillOrganizations: [],
  delegationProtocolVersion: 2
}));

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startBackend(port) {
  const output = [];
  const child = spawn(process.execPath, [path.join(projectRoot, "dist-server", "index.js")], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), METACODE_HOME: dataRoot, WORKSPACE_ROOT: temporaryRoot, METACODE_API_TOKEN: apiToken },
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  return { child, output };
}

async function waitForHealth(instance, port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null) throw new Error(`backend exited early (${instance.child.exitCode})\n${instance.output.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`backend did not become ready\n${instance.output.join("")}`);
}

async function request(port, pathname, options = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", "X-MetaCode-Api-Token": apiToken, ...options.headers }
  });
}

async function navigation(port) {
  const response = await request(port, "/api/navigation");
  assert.equal(response.status, 200);
  return response.json();
}

const port = await reservePort();
const backend = startBackend(port);
try {
  await waitForHealth(backend, port);
  let snapshot = await navigation(port);
  const idle = snapshot.sessions.find((item) => item.id === "session-idle");
  const paused = snapshot.sessions.find((item) => item.id === "session-paused");
  assert.equal(idle?.deletionPolicy?.action, "delete");
  assert.equal(paused?.deletionPolicy?.action, "terminate-and-delete");

  const pausedConflict = await request(port, "/api/sessions/session-paused", { method: "DELETE" });
  assert.equal(pausedConflict.status, 409);
  assert.equal((await pausedConflict.json()).code, "TASK_TERMINATION_REQUIRED");
  assert.equal((await request(port, "/api/sessions/session-paused?terminate=1", { method: "DELETE" })).status, 200);
  assert.equal((await request(port, "/api/sessions/session-idle", { method: "DELETE" })).status, 200);
  snapshot = await navigation(port);
  assert.equal(snapshot.sessions.some((item) => item.id === "session-paused" || item.id === "session-idle"), false);
  const trash = await (await request(port, "/api/session-management/trash")).json();
  assert.equal(trash.items.length, 2);

  const bootstrap = await (await request(port, "/api/bootstrap")).json();
  const database = new DatabaseSync(path.join(dataRoot, "workbench-state.db"));
  const workflows = new WorkflowRepository(database);
  const draftWorkflow = workflows.create({ id: "workflow-draft", ownerUserId: bootstrap.user.id, workspaceId: "workspace-delete", workDirectory: path.join(workspaceRoot, ".tasks", "draft"), prompt: "Draft workflow", plannerEngine: "codex" });
  const pausedWorkflow = workflows.create({ id: "workflow-paused", ownerUserId: bootstrap.user.id, workspaceId: "workspace-delete", workDirectory: path.join(workspaceRoot, ".tasks", "paused"), prompt: "Paused workflow", plannerEngine: "codex" });
  workflows.updateRun(pausedWorkflow.id, "paused");
  database.close();

  snapshot = await navigation(port);
  assert.equal(snapshot.workflows.find((item) => item.id === draftWorkflow.id)?.deletionPolicy?.action, "delete");
  assert.equal(snapshot.workflows.find((item) => item.id === pausedWorkflow.id)?.deletionPolicy?.action, "terminate-and-delete");
  const workflowConflict = await request(port, `/api/workflows/${pausedWorkflow.id}`, { method: "DELETE" });
  assert.equal(workflowConflict.status, 409);
  assert.equal((await workflowConflict.json()).code, "TASK_TERMINATION_REQUIRED");
  assert.equal((await request(port, `/api/workflows/${pausedWorkflow.id}?terminate=1`, { method: "DELETE" })).status, 204);
  assert.equal((await request(port, `/api/workflows/${draftWorkflow.id}`, { method: "DELETE" })).status, 204);
  snapshot = await navigation(port);
  assert.equal(snapshot.workflows.some((item) => item.id === pausedWorkflow.id || item.id === draftWorkflow.id), false);

  console.log("task deletion policy, termination gate, trash persistence, and navigation reconciliation passed");
} finally {
  if (backend.child.exitCode === null) backend.child.kill("SIGTERM");
  await new Promise((resolve) => backend.child.exitCode !== null ? resolve() : backend.child.once("exit", resolve));
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
