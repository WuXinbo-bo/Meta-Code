#!/usr/bin/env node
import path from "node:path";
import { defaultWorkbenchDataDir } from "../server/appPaths.ts";
import { completeBackupGroups, restoreWorkbenchBackup } from "../server/dataRecovery.ts";

function argsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") result.help = true;
    else if (value.startsWith("--")) result[value.slice(2)] = argv[index + 1] || "";
    if (value.startsWith("--")) index += 1;
  }
  return result;
}

async function workbenchRunning() {
  try {
    const response = await fetch("http://127.0.0.1:4338/api/health", { signal: AbortSignal.timeout(800) });
    const health = await response.json();
    return response.ok && health?.productId === "meta-code";
  } catch { return false; }
}

const args = argsFrom(process.argv.slice(2));
if (args.help) {
  console.log("用法：npm run data:restore -- [--stamp <备份时间戳>] [--data-dir <目录>]\n恢复前必须完全退出 Meta Code。省略 --stamp 时使用最新完整备份组。");
  process.exitCode = 0;
} else if (await workbenchRunning()) {
  console.error("Meta Code 仍在运行。请先完全退出工作台，再执行数据恢复。");
  process.exitCode = 2;
} else {
  try {
    const dataDir = path.resolve(args["data-dir"] || process.env.METACODE_HOME || process.env.WORKBENCH_DATA_DIR || defaultWorkbenchDataDir());
    const groups = completeBackupGroups(path.join(dataDir, "backups"));
    if (!groups.length) throw new Error("没有完整的数据库备份组");
    const result = restoreWorkbenchBackup({ dataDir, stamp: args.stamp || undefined });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
