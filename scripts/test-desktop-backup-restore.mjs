import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataHome = await fsp.mkdtemp(path.join(os.tmpdir(), "meta-code-desktop-restore-"));
const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const sentinel = path.join(dataHome, "providers", "desktop-restore-sentinel.txt");

try {
  await fsp.mkdir(path.dirname(sentinel), { recursive: true });
  await fsp.writeFile(sentinel, "value-in-backup", "utf8");
  const result = spawnSync(electron, [path.join(root, "desktop", "main.cjs")], {
    cwd: root,
    windowsHide: true,
    timeout: 90_000,
    encoding: "utf8",
    env: {
      ...process.env,
      METACODE_HOME: dataHome,
      METACODE_DESKTOP_HEADLESS: "1",
      METACODE_DESKTOP_TEST_RESTORE: "1"
    }
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /desktop backup restore and coordinated backend restart passed/);
  assert.equal(await fsp.readFile(sentinel, "utf8"), "value-in-backup");
  const backupEntries = await fsp.readdir(path.join(dataHome, "backups"));
  assert.equal(backupEntries.filter((entry) => entry.startsWith("personal-")).length, 1);
  assert.equal(backupEntries.some((entry) => entry.startsWith("pre-restore-")), false);
  console.log("real Electron backup restore lifecycle passed");
} finally {
  await fsp.rm(dataHome, { recursive: true, force: true });
}
