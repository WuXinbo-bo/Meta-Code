import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-session-creation-"));
const dataRoot = path.join(temporaryRoot, "data");
const workspaceRoot = path.join(temporaryRoot, "workspace");
const apiToken = "session-creation-test-token-0123456789";
await fsp.mkdir(dataRoot, { recursive: true });
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

function startBackend(port) {
  const output = [];
  const child = spawn(process.execPath, [path.join(projectRoot, "dist-server", "index.js")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      METACODE_HOME: dataRoot,
      WORKSPACE_ROOT: temporaryRoot,
      METACODE_API_TOKEN: apiToken
    },
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

async function waitForSseEvent(response, eventType) {
  assert.ok(response.body, "event stream must expose a response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`event stream ended before ${eventType}`);
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const type = block.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (type === eventType) return dataLine ? JSON.parse(dataLine.slice(6)) : {};
      boundary = buffer.indexOf("\n\n");
    }
  }
}

const port = await reservePort();
const backend = startBackend(port);
const eventController = new AbortController();
let createdEventPromise;
try {
  await waitForHealth(backend, port);
  const workspaceResponse = await request(port, "/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ root: workspaceRoot })
  });
  assert.equal(workspaceResponse.status, 201);
  const workspace = await workspaceResponse.json();

  const profileResponse = await request(port, "/api/agent-market/codex/profiles", {
    method: "POST",
    body: JSON.stringify({
      name: "Session creation test",
      authMode: "system-profile",
      authMethodId: "system-account",
      isDefault: true
    })
  });
  const profile = await profileResponse.json();
  assert.equal(profileResponse.status, 201, JSON.stringify(profile));
  const connectionResponse = await request(port, "/api/agent-market/codex/authenticate", {
    method: "POST",
    body: JSON.stringify({ profileId: profile.id })
  });
  const connection = await connectionResponse.json();
  assert.equal(connectionResponse.status, 200, JSON.stringify(connection));

  const invalidMutation = await request(port, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({ workspaceId: workspace.id, scopeKind: "workspace", engine: "codex", clientMutationId: "short" })
  });
  const invalidPayload = await invalidMutation.json();
  assert.equal(invalidMutation.status, 400, JSON.stringify(invalidPayload));

  const eventResponse = await request(port, "/api/events", { signal: eventController.signal });
  assert.equal(eventResponse.status, 200);
  createdEventPromise = waitForSseEvent(eventResponse, "sessions.changed").catch((error) => {
    if (eventController.signal.aborted) return null;
    throw error;
  });
  const mutationId = "session-create:test-idempotency";
  const createResponse = await request(port, "/api/sessions?messageLimit=100", {
    method: "POST",
    body: JSON.stringify({ workspaceId: workspace.id, scopeKind: "workspace", engine: "codex", clientMutationId: mutationId })
  });
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201, JSON.stringify(created));
  const createdEvent = await Promise.race([
    createdEventPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("sessions.changed event timed out")), 5_000))
  ]);
  assert.ok(createdEvent, "sessions.changed event must arrive before the timeout");
  assert.equal(createdEvent.sessionId, created.id);
  assert.equal(createdEvent.action, "created");

  const replayResponse = await request(port, "/api/sessions?messageLimit=100", {
    method: "POST",
    body: JSON.stringify({ workspaceId: workspace.id, scopeKind: "workspace", engine: "codex", clientMutationId: mutationId })
  });
  assert.equal(replayResponse.status, 200);
  const replayed = await replayResponse.json();
  assert.equal(replayed.id, created.id, "replaying one client mutation must return the original session");

  const navigationResponse = await request(port, "/api/navigation");
  assert.equal(navigationResponse.status, 200);
  const navigation = await navigationResponse.json();
  assert.equal(navigation.sessions.filter((session) => session.id === created.id).length, 1, "idempotent creation must persist one session");

  const concurrentMutationId = "session-create:test-concurrent-idempotency";
  const concurrentResponses = await Promise.all([1, 2].map(() => request(port, "/api/sessions?messageLimit=100", {
    method: "POST",
    body: JSON.stringify({ workspaceId: workspace.id, scopeKind: "workspace", engine: "codex", clientMutationId: concurrentMutationId })
  })));
  const concurrentSessions = await Promise.all(concurrentResponses.map((response) => response.json()));
  assert.deepEqual(concurrentResponses.map((response) => response.status).sort(), [200, 201]);
  assert.equal(concurrentSessions[0].id, concurrentSessions[1].id, "concurrent replay must resolve to one server session");
  const concurrentNavigation = await (await request(port, "/api/navigation")).json();
  assert.equal(concurrentNavigation.sessions.filter((session) => session.creationMutationId === concurrentMutationId).length, 1, "concurrent creation must persist one session");
  console.log("session creation idempotency and realtime inventory event passed");
} finally {
  eventController.abort();
  await createdEventPromise?.catch(() => undefined);
  if (backend.child.exitCode === null) backend.child.kill("SIGTERM");
  await new Promise((resolve) => backend.child.exitCode !== null ? resolve() : backend.child.once("exit", resolve));
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
