import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-backend-recovery-"));
const dataRoot = path.join(temporaryRoot, "data");
const workspaceRoot = path.join(temporaryRoot, "workspace");
const apiToken = "backend-recovery-test-token-0123456789";
await fsp.mkdir(workspaceRoot, { recursive: true });

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

function startBackend(port, home = dataRoot) {
  const output = [];
  const child = spawn(process.execPath, [path.join(projectRoot, "dist-server", "index.js")], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), METACODE_HOME: home, WORKSPACE_ROOT: temporaryRoot, METACODE_API_TOKEN: apiToken },
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
      // The backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`backend did not become ready\n${instance.output.join("")}`);
}

async function waitForExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise((resolve) => child.once("exit", (code) => resolve(code))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("backend did not exit")), timeoutMs))
  ]);
}

async function stopBackend(instance, signal = "SIGTERM") {
  if (instance.child.exitCode === null) instance.child.kill(signal);
  await waitForExit(instance.child);
}

let active = null;
try {
  const port = await reservePort();
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(port, "127.0.0.1", resolve);
  });
  const conflicted = startBackend(port);
  const conflictExitCode = await waitForExit(conflicted.child);
  const conflictOutput = conflicted.output.join("");
  assert.notEqual(conflictExitCode, 0, `port-conflicted backend exited successfully\n${conflictOutput}`);
  assert.match(conflictOutput, /EADDRINUSE|address already in use/i);
  await new Promise((resolve) => blocker.close(resolve));

  active = startBackend(port);
  await waitForHealth(active, port);
  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MetaCode-Api-Token": apiToken },
    body: JSON.stringify({ root: workspaceRoot, name: "Crash recovery workspace" })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();

  await stopBackend(active, "SIGKILL");
  active = startBackend(port);
  await waitForHealth(active, port);
  const bootstrapResponse = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { headers: { "X-MetaCode-Api-Token": apiToken } });
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  assert.ok(bootstrap.workspaces.some((workspace) => workspace.id === created.id && workspace.root === workspaceRoot));

  await stopBackend(active);
  active = null;
  const database = new DatabaseSync(path.join(dataRoot, "workbench-state.db"), { readOnly: true });
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();

  const legacyDataRoot = path.join(temporaryRoot, "legacy-data");
  const legacyTimestamp = new Date().toISOString();
  await fsp.mkdir(legacyDataRoot, { recursive: true });
  await fsp.writeFile(path.join(legacyDataRoot, "state.json"), JSON.stringify({
    settings: {},
    workspaces: [],
    sessions: [
      { id: "legacy-missing-messages", title: "Missing messages", workspaceId: "", codexThreadId: null, createdAt: legacyTimestamp, updatedAt: legacyTimestamp },
      { id: "legacy-invalid-messages", title: "Invalid messages", workspaceId: "", codexThreadId: null, createdAt: legacyTimestamp, updatedAt: legacyTimestamp, messages: "invalid" }
    ],
    delegatedTasks: [],
    mcpServers: [],
    skillFolders: [],
    skillOrganizations: [],
    delegationProtocolVersion: 2
  }));
  const legacyPort = await reservePort();
  active = startBackend(legacyPort, legacyDataRoot);
  await waitForHealth(active, legacyPort);
  for (const id of ["legacy-missing-messages", "legacy-invalid-messages"]) {
    const sessionResponse = await fetch(`http://127.0.0.1:${legacyPort}/api/sessions/${id}`, { headers: { "X-MetaCode-Api-Token": apiToken } });
    assert.equal(sessionResponse.status, 200, `${id} must survive startup migration`);
    const session = await sessionResponse.json();
    assert.deepEqual(session.messages, [], `${id} must normalize messages to an empty array`);
  }
  await stopBackend(active);
  active = null;
  console.log("Backend port conflict, abrupt termination, restart persistence, malformed legacy sessions, and database integrity passed");
} finally {
  if (active?.child.exitCode === null) active.child.kill("SIGTERM");
  if (active) await waitForExit(active.child).catch(() => undefined);
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
