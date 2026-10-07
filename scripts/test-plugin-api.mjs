import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-plugin-api-"));
const dataRoot = path.join(temporaryRoot, "data");
const workspaceRoot = path.join(temporaryRoot, "workspace");
const apiToken = "file-preview-test-token-0123456789";
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
let child;
function start() {
child = spawn(process.execPath, [path.join(projectRoot, "dist-server", "index.js")], {
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

}
start();

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated backend exited early (${child.exitCode})\n${output.join("")}`);
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


const post = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const toggle = (id, enabled, status = 200) => json(`/api/plugins/${id}`, status, { ...post({ enabled }), method: "PATCH" });
async function stop() {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try { await exited; } finally { clearTimeout(timer); }
}
try {
  await waitForHealth();
  const plugins = await json("/api/plugins");
  assert.deepEqual(plugins.items.map((p) => p.id).sort(), ["collaboration", "orchestration"]);
  assert.ok(plugins.items.every((p) => p.enabled && !p.runtimeDirectory && !p.dataDirectory));
  await toggle("unknown", false, 400);
  await toggle("collaboration", "false", 400);
  await toggle("collaboration", false);
  assert.equal((await json("/api/plugins")).items.find((p) => p.id === "orchestration").enabled, true);
  await toggle("orchestration", false);
  await json("/api/workflows", 409, post({}));
  await json("/api/workflows/missing/approve", 409, post({ revision: 1 }));
  assert.deepEqual(await json("/api/workflows"), []);
  await json("/api/workflows/missing", 404);
  await json("/api/workflows/missing/pause", 404, post({}));
  await json("/api/admin/skill-releases/old/activate", 410, post({}));
  await stop(); start(); await waitForHealth();
  assert.ok((await json("/api/plugins")).items.every((p) => !p.enabled), "toggles survive backend restart");
  await toggle("orchestration", true);
  assert.equal((await json("/api/plugins")).items.find((p) => p.id === "collaboration").enabled, false);
  const workspace = await json("/api/workspaces", 201, post({ root: workspaceRoot, name: "Plugin fixture" }));
  const imported = await json("/api/session-management/import", 201, post({ schemaVersion: 1, kind: "metacode-session", session: { title: "Native history remains available", engine: "codex", workspaceId: workspace.id, messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "done" }] } }));
  assert.equal(imported.session.engine, "codex");
  const uploaded = await json(`/api/sessions/${imported.session.id}/attachments`, 201, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Attachment-Name": encodeURIComponent("notes.md"), "X-Attachment-Type": "text/markdown" }, body: "# Plugin attachment\n" });
  assert.match(uploaded.relativePath, /^@attachments\//);
  const preview = (workspaceId, reference, status = 200) => json(`/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(reference)}`, status);
  assert.match((await preview(workspace.id, uploaded.relativePath)).content, /Plugin attachment/);
  assert.match((await preview(workspace.id, uploaded.relativePath.replaceAll("/", "\\"))).content, /Plugin attachment/);
  const otherRoot = path.join(temporaryRoot, "other"); await fsp.mkdir(otherRoot);
  const other = await json("/api/workspaces", 201, post({ root: otherRoot, name: "Other scope" }));
  await preview(other.id, uploaded.relativePath, 400);
  await preview(workspace.id, uploaded.relativePath.replace(imported.session.id, "task-missing"), 400);
  const branch = await json(`/api/sessions/${imported.session.id}/branch`, 201, post({ messageId: imported.session.messages[1].id }));
  assert.equal(branch.parentSessionId, imported.session.id);
  await toggle("collaboration", true);
  for (const folder of [".claude-codex", ".agents", ".claude", ".workflow"]) {
    await assert.rejects(fsp.access(path.join(workspaceRoot, folder)), { code: "ENOENT" });
  }
  console.log("plugin HTTP lifecycle, restart persistence, native history and managed attachment preview passed");
} finally {
  await stop();
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
