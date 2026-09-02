import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tracked = new Map<string, Set<ChildProcess>>();

export function registerProcessTree(ownerId: string, child: ChildProcess) {
  const processes = tracked.get(ownerId) || new Set<ChildProcess>();
  processes.add(child);
  tracked.set(ownerId, processes);
  child.once("close", () => unregisterProcessTree(ownerId, child));
}

export function unregisterProcessTree(ownerId: string, child: ChildProcess) {
  const processes = tracked.get(ownerId);
  processes?.delete(child);
  if (!processes?.size) tracked.delete(ownerId);
}

export function terminateProcessTree(child: ChildProcess, graceMs = 2_000) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => { try { child.kill(); } catch { /* Already exited. */ } });
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); }
  catch { try { child.kill("SIGTERM"); } catch { return; } }
  const timer = setTimeout(() => {
    if (child.exitCode !== null) return;
    try { process.kill(-child.pid!, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch { /* Already exited. */ } }
  }, graceMs);
  timer.unref();
}

export function terminateTrackedProcessTrees(ownerId?: string) {
  const groups = ownerId ? [[ownerId, tracked.get(ownerId) || new Set<ChildProcess>()] as const] : [...tracked.entries()];
  for (const [, processes] of groups) for (const child of processes) terminateProcessTree(child);
}

export async function terminateServerDescendants(parentPid = process.pid) {
  if (process.platform !== "win32") return;
  try {
    const command = `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", timeout: 8_000, windowsHide: true });
    const parsed = JSON.parse(stdout || "[]") as { ProcessId: number; ParentProcessId: number } | Array<{ ProcessId: number; ParentProcessId: number }>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const descendants = new Set<number>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (row.ProcessId === parentPid || descendants.has(row.ProcessId)) continue;
        if (row.ParentProcessId === parentPid || descendants.has(row.ParentProcessId)) {
          descendants.add(row.ProcessId);
          changed = true;
        }
      }
    }
    const roots = [...descendants].filter((pid) => !descendants.has(rows.find((row) => row.ProcessId === pid)?.ParentProcessId || 0));
    await Promise.allSettled(roots.map((pid) => execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 8_000, windowsHide: true })));
  } catch {
    // Shutdown cleanup is best effort; tracked processes were already terminated.
  }
}
