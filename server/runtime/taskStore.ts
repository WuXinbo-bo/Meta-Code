import fs from "node:fs";
import path from "node:path";
import type { CliRuntimeId, RuntimeInstallProgress } from "./types.js";

type StoredTasks = { schemaVersion: 1; tasks: Partial<Record<CliRuntimeId, RuntimeInstallProgress>> };

export class RuntimeTaskStore {
  private readonly file: string;
  private readonly tasks: Partial<Record<CliRuntimeId, RuntimeInstallProgress>>;

  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true });
    this.file = path.join(root, "install-tasks.json");
    let parsed: StoredTasks | null = null;
    try { parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredTasks; } catch { /* First run. */ }
    this.tasks = parsed?.schemaVersion === 1 && parsed.tasks ? parsed.tasks : {};
    let changed = false;
    for (const [id, task] of Object.entries(this.tasks)) {
      if (!task) continue;
      const operationId = task.operationId || `${id}:${task.startedAt}`;
      const sequence = Math.max(1, Number(task.sequence) || 1);
      if (!task.operationId || task.sequence !== sequence) changed = true;
      this.tasks[id] = task.active ? {
        ...task, operationId, sequence: sequence + 1, active: false, resumable: true, phase: "interrupted",
        message: "上次安装因工作台退出而中断，可以继续下载", updatedAt: new Date().toISOString()
      } : { ...task, operationId, sequence };
      if (task.active) changed = true;
    }
    if (changed) this.flush();
  }

  get(id: CliRuntimeId) {
    return this.tasks[id] || null;
  }

  set(progress: RuntimeInstallProgress) {
    this.tasks[progress.runtimeId] = progress;
    this.flush();
  }

  private flush() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, tasks: this.tasks }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}
