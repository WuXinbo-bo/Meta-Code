import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "output", "cli-install-validation");
await fsp.mkdir(output, { recursive: true });
const sandbox = await fsp.mkdtemp(path.join(output, "desktop-"));
const appRoot = path.join(sandbox, "app");
const dataRoot = path.join(sandbox, "data");
const profile = path.join(sandbox, "profile");
await fsp.mkdir(profile, { recursive: true });
for (const item of ["dist-server", "dist", "public", "server-assets", "skills", "release.config.json", "package.json"]) {
  await fsp.cp(path.join(root, item), path.join(appRoot, item), { recursive: true });
}
if (process.argv.includes("--bundled")) {
  await fsp.cp(path.join(output, "toolchains", "node"), path.join(appRoot, "toolchains", "node"), { recursive: true });
}
const server = net.createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:npm_|node_|metacode_|workbench_|path$|programfiles|appdata$|localappdata$|userprofile$|home$)/i.test(key)));
Object.assign(env, {
  PATH: path.join(process.env.SystemRoot, "System32"),
  ProgramFiles: profile, LOCALAPPDATA: path.join(profile, "local"), APPDATA: path.join(profile, "roaming"), USERPROFILE: profile, HOME: profile,
  ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", PORT: String(port), METACODE_HOME: dataRoot,
  METACODE_DESKTOP: "1", WORKBENCH_PACKAGED: "1", METACODE_API_TOKEN: "clean-desktop-installation-test-token", WORKSPACE_ROOT: profile
});
const backend = spawn(path.join(root, "node_modules", "electron", "dist", "electron.exe"), [path.join(appRoot, "dist-server", "index.js")], {
  cwd: appRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
backend.stdout.on("data", (data) => { logs = (logs + data).slice(-40_000); });
backend.stderr.on("data", (data) => { logs = (logs + data).slice(-40_000); });
const token = env.METACODE_API_TOKEN;
async function request(route, method = "GET", body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: { "X-MetaCode-Api-Token": token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000)
  });
  const payload = await response.json();
  assert.ok(response.ok, `${route}: ${JSON.stringify(payload)}`);
  return payload;
}
async function waitInstallation(id) {
  const deadline = Date.now() + 15 * 60_000;
  let lastPhase = "";
  while (Date.now() < deadline) {
    const { progress } = await request(`/api/runtime/${id}/install-status`);
    if (progress?.phase !== lastPhase) { lastPhase = progress?.phase; console.log(`[${id}] ${progress?.message || "waiting"}`); }
    if (progress && !progress.active) {
      assert.equal(progress.phase, "activated", progress.message);
      const status = await request(`/api/runtime/${id}/status`);
      assert.equal(status.available, true);
      assert.equal(status.selectionMode, "managed");
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${id} installation did not finish`);
}
try {
  const deadline = Date.now() + 45_000;
  while (true) {
    try { await request("/api/health"); break; }
    catch (error) {
      if (backend.exitCode !== null || Date.now() > deadline) throw new Error(`${error}\n${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  console.log(`CLEAN_DESKTOP_URL http://127.0.0.1:${port}`);
  for (const id of ["claude", "codex"]) {
    const status = await request(`/api/runtime/${id}/status`);
    assert.equal(status.available, false, "fresh profile must not reuse developer CLI");
    assert.equal(status.installation.supported, true);
    assert.equal(status.npmAvailable, process.argv.includes("--bundled"));
  }
  const market = await request("/api/agent-market");
  for (const id of ["claude", "codex"]) {
    const item = market.items.find((item) => item.id === id);
    assert.equal(item.installed, false);
    assert.equal(item.installable, true);
  }
  const installed = {};
  for (const id of ["claude", "codex"]) {
    const accepted = await request(`/api/agent-market/${id}/install`, "POST", {});
    assert.equal(accepted.accepted, true);
    installed[id] = await waitInstallation(id);
  }
  // Verify real damage is detected and same-version repair restores the executable.
  const cli = installed.codex.path;
  await fsp.rename(cli, `${cli}.test-damaged`);
  const broken = await request("/api/runtime/codex/status");
  assert.equal(broken.available, false);
  assert.equal(broken.managed.healthy, false);
  await request("/api/runtime/codex/install", "POST", { repair: true });
  const repaired = await waitInstallation("codex");
  assert.equal(repaired.managed.activeVersion, installed.codex.managed.activeVersion);
  assert.equal(repaired.managed.healthy, true);
  const finalMarket = await request("/api/agent-market");
  for (const id of ["claude", "codex"]) {
    assert.equal(finalMarket.items.find((item) => item.id === id).installed, true);
    assert.equal(finalMarket.controls[id].connection.status, "attention", "installing a CLI must not certify an unconfigured account");
  }
  const result = { environment: "Electron, empty profile, no system Node/npm/CLI on PATH", bundled: process.argv.includes("--bundled"), versions: Object.fromEntries(Object.entries(installed).map(([id, status]) => [id, status.version])), sameVersionRepair: true };
  await fsp.writeFile(path.join(output, `clean-desktop-${result.bundled ? "bundled" : "bootstrap"}-result.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (process.argv.includes("--inspect")) {
    console.log("Browser inspection window: 180 seconds");
    await new Promise((resolve) => setTimeout(resolve, 180_000));
  }
} finally {
  if (backend.exitCode === null) { backend.kill(); await once(backend, "exit"); }
  await fsp.writeFile(path.join(output, "clean-desktop-backend.log"), logs);
  await fsp.rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
