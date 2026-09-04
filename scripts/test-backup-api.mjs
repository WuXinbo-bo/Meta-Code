import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-backup-api-"));
const dataRoot = path.join(temporaryRoot, "data");
const apiToken = "backup-api-test-token-0123456789";

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
const child = spawn(process.execPath, [path.join(projectRoot, "dist-server", "index.js")], {
  cwd: projectRoot,
  env: { ...process.env, PORT: String(port), METACODE_HOME: dataRoot, WORKSPACE_ROOT: temporaryRoot, METACODE_API_TOKEN: apiToken },
  windowsHide: true,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"]
});
child.stdout.on("data", (chunk) => output.push(chunk.toString()));
child.stderr.on("data", (chunk) => output.push(chunk.toString()));

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated backend exited early (${child.exitCode})\n${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`isolated backend did not become ready\n${output.join("")}`);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", "X-MetaCode-Api-Token": apiToken, ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => null);
  assert.equal(response.ok, true, `${pathname}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function stop() {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("isolated backend did not stop")), 15_000))
  ]);
}

try {
  await waitForHealth();
  const initial = await request("/api/data/backups");
  assert.equal(initial.policy.automaticEnabled, true);
  assert.equal(initial.policy.retentionCount, 2);

  const invalidPolicy = await fetch(`${baseUrl}/api/data/backup-policy`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-MetaCode-Api-Token": apiToken },
    body: JSON.stringify({ automaticEnabled: "false" })
  });
  assert.equal(invalidPolicy.status, 400, "the backup policy API must reject ambiguous non-boolean values");

  const disabled = await request("/api/data/backup-policy", { method: "PATCH", body: JSON.stringify({ automaticEnabled: false }) });
  assert.equal(disabled.policy.automaticEnabled, false);
  assert.equal(disabled.health.status, "disabled");

  let latest;
  for (let index = 0; index < 3; index += 1) {
    if (index) await new Promise((resolve) => setTimeout(resolve, 5));
    latest = await request("/api/data/backups", { method: "POST", body: "{}" });
  }
  assert.equal(latest.backups.length, 2, "the API must expose only the two newest certified recovery points");
  assert.ok(latest.backups.every((item) => item.compatibility === "ready" && item.verificationLevel === "restore-rehearsal"));

  const selected = latest.backups[0];
  const verified = await request(`/api/data/backups/${encodeURIComponent(selected.name)}/verify`, { method: "POST", body: "{}" });
  assert.equal(verified.verificationLevel, "restore-rehearsal");
  const preflight = await request(`/api/data/backups/${encodeURIComponent(selected.name)}/restore-preflight`, { method: "POST", body: "{}" });
  assert.equal(preflight.ready, false, "a browser-only server must not claim it can coordinate an in-process restore");
  assert.equal(preflight.checks.find((item) => item.id === "desktop").ok, false);

  const enabled = await request("/api/data/backup-policy", { method: "PATCH", body: JSON.stringify({ automaticEnabled: true }) });
  assert.equal(enabled.policy.automaticEnabled, true);
  assert.ok(enabled.health.nextAttemptAt);
  console.log("backup policy, certified two-point retention, verification, and restore preflight API passed");
} finally {
  await stop().catch(() => undefined);
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
