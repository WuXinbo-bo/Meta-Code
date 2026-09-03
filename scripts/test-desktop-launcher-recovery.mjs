import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataHome = await fsp.mkdtemp(path.join(os.tmpdir(), "meta-code-desktop-recovery-"));
const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");

try {
  const result = spawnSync(electron, [path.join(root, "desktop", "main.cjs")], {
    cwd: root,
    windowsHide: true,
    timeout: 30_000,
    encoding: "utf8",
    env: {
      ...process.env,
      METACODE_HOME: dataHome,
      METACODE_DESKTOP_HEADLESS: "1",
      METACODE_DESKTOP_TEST_CRASH_BACKEND_MS: "1200",
      METACODE_DESKTOP_TEST_EXIT_MS: "8000"
    }
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const log = await fsp.readFile(path.join(dataHome, "logs", "desktop-backend.log"), "utf8");
  assert.match(log, /backend exited: code=.*signal=/, "the launcher must observe the forced backend crash");
  assert.ok((log.match(/Meta Code backend: http:\/\/127\.0\.0\.1:/g) || []).length >= 2, "the launcher must start a healthy replacement backend");
  console.log("desktop launcher recovered a forced backend crash on a fresh local port");
} finally {
  await fsp.rm(dataHome, { recursive: true, force: true });
}
