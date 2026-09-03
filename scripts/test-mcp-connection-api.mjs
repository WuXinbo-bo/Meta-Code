import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-mcp-api-"));
const dataRoot = path.join(temporaryRoot, "data");
const workspaceRoot = path.join(temporaryRoot, "workspace");
const fixturePath = path.join(projectRoot, "scripts", "fixtures", "mcp-stdio-server.mjs");
const apiToken = "mcp-connection-test-token-0123456789";
await fsp.mkdir(workspaceRoot, { recursive: true });

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const selected = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(selected));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;
const output = [];
const backend = spawn(process.execPath, [path.join(projectRoot, "dist-server", "index.js")], {
  cwd: projectRoot,
  env: { ...process.env, PORT: String(port), METACODE_HOME: dataRoot, WORKSPACE_ROOT: temporaryRoot, METACODE_API_TOKEN: apiToken },
  windowsHide: true,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"]
});
backend.stdout.on("data", (chunk) => output.push(chunk.toString()));
backend.stderr.on("data", (chunk) => output.push(chunk.toString()));

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (backend.exitCode !== null) throw new Error(`isolated backend exited early (${backend.exitCode})\n${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The isolated backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`isolated backend did not become ready\n${output.join("")}`);
}

async function json(pathname, expectedStatus = 200, options) {
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { "X-MetaCode-Api-Token": apiToken, ...(options?.headers || {}) } });
  const body = await response.json().catch(() => null);
  assert.equal(response.status, expectedStatus, `${pathname}: ${JSON.stringify(body)}`);
  return body;
}

const request = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

try {
  await waitForHealth();
  const workspace = await json("/api/workspaces", 201, request("POST", { root: workspaceRoot, name: "MCP recovery" }));
  const created = await json("/api/mcp", 201, request("POST", {
    name: "test-mcp",
    transport: "stdio",
    command: process.execPath,
    args: [fixturePath],
    workspaceIds: [workspace.id]
  }));
  const testPath = `/api/mcp/${encodeURIComponent(created.server.id)}/test`;
  const connected = await json(testPath, 200, request("POST", { workspaceId: workspace.id }));
  assert.equal(connected.status, "connected");
  assert.equal(connected.server, "metacode-test-mcp 1.0.0");
  assert.deepEqual(connected.tools.map((tool) => tool.name), ["ping"]);

  await json(`/api/mcp/${encodeURIComponent(created.server.id)}`, 200, request("PATCH", {
    command: process.execPath,
    args: ["-e", "process.exit(12)"]
  }));
  const disconnected = await json(testPath, 400, request("POST", { workspaceId: workspace.id }));
  assert.match(disconnected.error, /closed|connection|transport|exited|MCP/i);

  await json(`/api/mcp/${encodeURIComponent(created.server.id)}`, 200, request("PATCH", {
    command: process.execPath,
    args: [fixturePath]
  }));
  const recovered = await json(testPath, 200, request("POST", { workspaceId: workspace.id }));
  assert.equal(recovered.status, "connected");
  assert.deepEqual(recovered.tools.map((tool) => tool.name), ["ping"]);

  console.log("Real stdio MCP connection, disconnect cleanup, and reconnect passed");
} finally {
  if (backend.exitCode === null) backend.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => backend.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 10_000))
  ]);
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
