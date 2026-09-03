import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type DataOwnerRecord = {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  role: "desktop" | "development" | "server";
  port: number;
  startedAt: string;
  heartbeatAt: string;
};

const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_STALE_MS = 20_000;

function processExists(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRecord(file: string): DataOwnerRecord | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<DataOwnerRecord>;
    if (value.schemaVersion !== 1 || typeof value.instanceId !== "string" || !Number.isInteger(value.pid)) return null;
    return value as DataOwnerRecord;
  } catch { return null; }
}

export function activeDataOwner(dataDir: string, now = Date.now()) {
  const file = path.join(path.resolve(dataDir), "owner.json");
  const owner = readRecord(file);
  if (!owner) return null;
  const heartbeat = Date.parse(owner.heartbeatAt);
  const recent = Number.isFinite(heartbeat) && now - heartbeat < HEARTBEAT_STALE_MS;
  return processExists(owner.pid) || recent ? owner : null;
}

export class WorkbenchDataOwnerLease {
  readonly file: string;
  readonly record: DataOwnerRecord;
  private timer: NodeJS.Timeout | null = null;
  private released = false;

  private constructor(file: string, record: DataOwnerRecord) {
    this.file = file;
    this.record = record;
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  static acquire(dataDir: string, input: { role: DataOwnerRecord["role"]; port: number }) {
    const directory = path.resolve(dataDir);
    const file = path.join(directory, "owner.json");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = activeDataOwner(directory);
      if (existing) {
        throw new Error(`数据目录已由另一个 Meta Code 后端占用（${existing.role}，PID ${existing.pid}，端口 ${existing.port}）。请先关闭该实例，或为开发版设置独立的 METACODE_HOME。`);
      }
      if (fs.existsSync(file)) {
        try { fs.rmSync(file, { force: true }); } catch { /* Exclusive creation below decides the race. */ }
      }
      const now = new Date().toISOString();
      const record: DataOwnerRecord = {
        schemaVersion: 1,
        instanceId: crypto.randomUUID(),
        pid: process.pid,
        role: input.role,
        port: input.port,
        startedAt: now,
        heartbeatAt: now
      };
      try {
        fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        return new WorkbenchDataOwnerLease(file, record);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 1) throw error;
      }
    }
    throw new Error("无法取得 Meta Code 数据目录所有权");
  }

  heartbeat() {
    if (this.released) return;
    const current = readRecord(this.file);
    if (current?.instanceId !== this.record.instanceId) {
      this.released = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    this.record.heartbeatAt = new Date().toISOString();
    try { fs.writeFileSync(this.file, `${JSON.stringify(this.record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); }
    catch { /* A failed heartbeat becomes stale and can be recovered on the next launch. */ }
  }

  release() {
    if (this.released) return;
    this.released = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const current = readRecord(this.file);
    if (current?.instanceId === this.record.instanceId) fs.rmSync(this.file, { force: true });
  }
}
