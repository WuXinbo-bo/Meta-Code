import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const environmentDependent = new Set([
  "test:ci",
  "test:workflow-codex-real",
  "test:workflow-claude-permissions",
  "test:claude-real",
  "test:desktop-launcher-recovery",
  "test:desktop-backup-restore"
]);
const tests = Object.entries(packageJson.scripts)
  .filter(([name]) => name.startsWith("test:") && !environmentDependent.has(name))
  .map(([name, command]) => ({
    name,
    command: String(command)
      .replace(/^npm run build &&\s*/, "")
      .replace(/^npm run typecheck &&\s*/, "")
  }));

function run(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: process.cwd(),
      env: { ...process.env, CI: "true" },
      shell: true,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`退出码 ${code ?? "unknown"}${signal ? `，信号 ${signal}` : ""}`));
    });
  });
}

for (const [index, test] of tests.entries()) {
  console.log(`\n[ci ${index + 1}/${tests.length}] ${test.name}`);
  try {
    await run(test.command);
  } catch (error) {
    throw new Error(`${test.name} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${tests.length} 项离线测试全部通过`);
