import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * A locally persisted scheduled prompt.  The routine intentionally stores
 * only the request metadata; execution output belongs to the normal session
 * and activity stores and must not be copied into this file.
 */
export type RoutineStatus = "idle" | "paused" | "running" | "succeeded" | "failed" | "interrupted";

export type AgentRoutine = {
  schemaVersion: 1;
  id: string;
  name: string;
  providerId: string;
  prompt: string;
  /** Optional owner scope for HTTP/API callers; local installations may omit it. */
  ownerUserId?: string;
  workspaceId?: string;
  intervalMs: number | null;
  nextRunAt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastStatus: RoutineStatus;
  lastError: string | null;
  runCount: number;
};

export type CreateRoutineInput = {
  id?: string;
  name: string;
  providerId: string;
  prompt: string;
  ownerUserId?: string;
  workspaceId?: string;
  intervalMs?: number | null;
  nextRunAt?: string | number | Date | null;
  enabled?: boolean;
};

export type UpdateRoutineInput = Partial<Omit<CreateRoutineInput, "id">> & {
  /** Explicitly clear an existing interval or one-shot date. */
  intervalMs?: number | null;
  nextRunAt?: string | number | Date | null;
};

export type RoutineRunner = (routine: AgentRoutine) => Promise<unknown> | unknown;

type RoutineTimer = ReturnType<typeof setTimeout>;

export type RoutineSchedulerOptions = {
  /** Absolute JSON file path. It is created with mode 0600 on first write. */
  file: string;
  run: RoutineRunner;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => RoutineTimer;
  clearTimer?: (timer: RoutineTimer) => void;
};

type PersistedRoutines = { schemaVersion: 1; routines: AgentRoutine[] };

const SCHEMA_VERSION = 1 as const;
const MAX_TIMER_DELAY_MS = 2_147_000_000; // Node's practical setTimeout limit.

function nonEmpty(value: unknown, field: string) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${field} 不能为空`);
  return result;
}

function parseDate(value: string | number | Date | null | undefined, field: string) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error(`${field} 必须是有效的时间`);
  return new Date(parsed).toISOString();
}

function parseInterval(value: number | null | undefined) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value <= 0) throw new Error("intervalMs 必须是大于 0 的毫秒数");
  return Math.floor(value);
}

function normalizePersistedRoutine(input: Partial<AgentRoutine>): AgentRoutine | null {
  try {
    const id = nonEmpty(input.id, "routine.id");
    const name = nonEmpty(input.name, "routine.name");
    const providerId = nonEmpty(input.providerId, "routine.providerId");
    const prompt = nonEmpty(input.prompt, "routine.prompt");
    const createdAt = parseDate(input.createdAt, "createdAt") || new Date().toISOString();
    const updatedAt = parseDate(input.updatedAt, "updatedAt") || createdAt;
    const lastRunAt = parseDate(input.lastRunAt, "lastRunAt");
    const nextRunAt = parseDate(input.nextRunAt, "nextRunAt");
    const status: RoutineStatus = ["idle", "paused", "running", "succeeded", "failed", "interrupted"].includes(String(input.lastStatus))
      ? input.lastStatus as RoutineStatus
      : "idle";
    return {
      schemaVersion: SCHEMA_VERSION,
      id,
      name,
      providerId,
      prompt,
      ownerUserId: input.ownerUserId ? String(input.ownerUserId) : undefined,
      workspaceId: input.workspaceId ? String(input.workspaceId) : undefined,
      intervalMs: parseInterval(input.intervalMs),
      nextRunAt,
      enabled: input.enabled === true,
      createdAt,
      updatedAt,
      lastRunAt,
      lastStatus: status,
      lastError: input.lastError ? String(input.lastError).slice(0, 2_000) : null,
      runCount: Math.max(0, Math.floor(Number(input.runCount) || 0))
    };
  } catch {
    return null;
  }
}

function copyRoutine(routine: AgentRoutine): AgentRoutine {
  return { ...routine };
}

/**
 * A small, dependency-free scheduler for user routines.
 *
 * The scheduler is deliberately separate from HTTP/session code.  A host can
 * provide a runner that starts an ordinary Meta Code session, while this
 * module owns lifecycle, persistence, timer recovery and status transitions.
 */
export class RoutineScheduler {
  private readonly file: string;
  private readonly run: RoutineRunner;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<RoutineSchedulerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<RoutineSchedulerOptions["clearTimer"]>;
  private readonly routines = new Map<string, AgentRoutine>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private timer: RoutineTimer | null = null;
  private started = false;

  constructor(options: RoutineSchedulerOptions) {
    this.file = path.resolve(options.file);
    this.run = options.run;
    this.now = options.now || Date.now;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.load();
  }

  /** Load persisted state and recover routines interrupted by a prior exit. */
  private load() {
    let parsed: Partial<PersistedRoutines> | null = null;
    try { parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<PersistedRoutines>; } catch { /* first start or malformed file */ }
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.routines)) return;
    let recovered = false;
    for (const candidate of parsed.routines) {
      const routine = normalizePersistedRoutine(candidate);
      if (!routine) continue;
      if (routine.lastStatus === "running") {
        routine.lastStatus = "interrupted";
        routine.lastError = "工作台重启时任务被中断";
        routine.updatedAt = new Date(this.now()).toISOString();
        recovered = true;
      }
      this.routines.set(routine.id, routine);
    }
    // Persist the recovery marker immediately. A process that starts, reads
    // the file, and exits again must not leave a stale `running` state behind.
    if (recovered) this.persist();
  }

  /** Start timer recovery. Calling start repeatedly is safe. */
  start() {
    this.started = true;
    this.scheduleNext();
    return this.list();
  }

  stop() {
    this.started = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  list(ownerUserId?: string) {
    return [...this.routines.values()]
      .filter((routine) => ownerUserId === undefined || routine.ownerUserId === ownerUserId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(copyRoutine);
  }

  get(id: string, ownerUserId?: string) {
    const routine = this.routines.get(id);
    return routine && (ownerUserId === undefined || routine.ownerUserId === ownerUserId) ? copyRoutine(routine) : null;
  }

  create(input: CreateRoutineInput) {
    const now = new Date(this.now()).toISOString();
    const intervalMs = parseInterval(input.intervalMs);
    const nextRunAt = parseDate(input.nextRunAt, "nextRunAt") || (intervalMs ? new Date(this.now() + intervalMs).toISOString() : null);
    const routine: AgentRoutine = {
      schemaVersion: SCHEMA_VERSION,
      id: nonEmpty(input.id || `routine-${crypto.randomUUID()}`, "routine.id"),
      name: nonEmpty(input.name, "name"),
      providerId: nonEmpty(input.providerId, "providerId"),
      prompt: nonEmpty(input.prompt, "prompt"),
      ownerUserId: input.ownerUserId ? String(input.ownerUserId) : undefined,
      workspaceId: input.workspaceId ? String(input.workspaceId) : undefined,
      intervalMs,
      nextRunAt,
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastStatus: input.enabled === false ? "paused" : "idle",
      lastError: null,
      runCount: 0
    };
    if (this.routines.has(routine.id)) throw new Error(`例程已存在：${routine.id}`);
    this.routines.set(routine.id, routine);
    this.persist();
    this.scheduleNext();
    return copyRoutine(routine);
  }

  update(id: string, input: UpdateRoutineInput) {
    const routine = this.require(id);
    if (input.name !== undefined) routine.name = nonEmpty(input.name, "name");
    if (input.providerId !== undefined) routine.providerId = nonEmpty(input.providerId, "providerId");
    if (input.prompt !== undefined) routine.prompt = nonEmpty(input.prompt, "prompt");
    if (input.ownerUserId !== undefined) routine.ownerUserId = input.ownerUserId ? String(input.ownerUserId) : undefined;
    if (input.workspaceId !== undefined) routine.workspaceId = input.workspaceId ? String(input.workspaceId) : undefined;
    if (input.intervalMs !== undefined) routine.intervalMs = parseInterval(input.intervalMs);
    if (input.nextRunAt !== undefined) routine.nextRunAt = parseDate(input.nextRunAt, "nextRunAt");
    if (input.enabled !== undefined) {
      routine.enabled = Boolean(input.enabled);
      if (!routine.enabled) routine.lastStatus = "paused";
      else if (!routine.nextRunAt) routine.nextRunAt = new Date(this.now() + (routine.intervalMs || 0)).toISOString();
      else if (routine.enabled && routine.lastStatus === "paused") routine.lastStatus = "idle";
    }
    routine.updatedAt = new Date(this.now()).toISOString();
    this.persist();
    this.scheduleNext();
    return copyRoutine(routine);
  }

  pause(id: string) {
    return this.update(id, { enabled: false });
  }

  resume(id: string) {
    return this.update(id, { enabled: true });
  }

  delete(id: string) {
    if (!this.routines.delete(id)) return false;
    this.persist();
    this.scheduleNext();
    return true;
  }

  /** Run once immediately. A paused routine remains paused after manual run. */
  runNow(id: string) {
    const routine = this.require(id);
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    return this.execute(routine, false);
  }

  private require(id: string) {
    const routine = this.routines.get(id);
    if (!routine) throw new Error(`例程不存在：${id}`);
    return routine;
  }

  private execute(routine: AgentRoutine, scheduled: boolean) {
    const id = routine.id;
    const startedAt = new Date(this.now()).toISOString();
    const wasEnabled = routine.enabled;
    routine.lastStatus = "running";
    routine.lastError = null;
    routine.lastRunAt = startedAt;
    routine.updatedAt = startedAt;
    routine.runCount += 1;
    this.persist();
    const operation = Promise.resolve().then(() => this.run(copyRoutine(routine))).then(
      (result) => {
        const current = this.routines.get(id);
        if (current) {
          current.lastStatus = "succeeded";
          current.lastError = null;
          if (!scheduled && !wasEnabled) current.lastStatus = "paused";
          current.updatedAt = new Date(this.now()).toISOString();
          if (scheduled) {
            if (current.intervalMs) current.nextRunAt = new Date(this.now() + current.intervalMs).toISOString();
            else { current.enabled = false; current.nextRunAt = null; current.lastStatus = "succeeded"; }
          }
          this.persist();
          this.scheduleNext();
        }
        return result;
      },
      (error: unknown) => {
        const current = this.routines.get(id);
        if (current) {
          current.lastStatus = "failed";
          current.lastError = String(error instanceof Error ? error.message : error).slice(0, 2_000);
          current.updatedAt = new Date(this.now()).toISOString();
          if (scheduled) {
            if (current.intervalMs) current.nextRunAt = new Date(this.now() + current.intervalMs).toISOString();
            else { current.enabled = false; current.nextRunAt = null; }
          } else if (!wasEnabled) current.lastStatus = "paused";
          this.persist();
          this.scheduleNext();
        }
        throw error;
      }
    );
    this.inFlight.set(id, operation);
    void operation.finally(() => this.inFlight.delete(id)).catch(() => undefined);
    return operation;
  }

  private scheduleNext() {
    if (!this.started) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const now = this.now();
    let earliest: number | null = null;
    for (const routine of this.routines.values()) {
      if (!routine.enabled || !routine.nextRunAt || this.inFlight.has(routine.id)) continue;
      const due = Date.parse(routine.nextRunAt);
      if (!Number.isFinite(due)) continue;
      earliest = earliest === null ? due : Math.min(earliest, due);
    }
    if (earliest === null) return;
    const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, earliest - now));
    this.timer = this.setTimer(() => {
      this.timer = null;
      const currentNow = this.now();
      for (const routine of this.routines.values()) {
        if (!routine.enabled || !routine.nextRunAt || this.inFlight.has(routine.id)) continue;
        const due = Date.parse(routine.nextRunAt);
        if (Number.isFinite(due) && due <= currentNow) void this.execute(routine, true).catch(() => undefined);
      }
      this.scheduleNext();
    }, delay);
    const maybeUnref = this.timer as RoutineTimer & { unref?: () => void };
    maybeUnref.unref?.();
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const value: PersistedRoutines = { schemaVersion: SCHEMA_VERSION, routines: this.list() };
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

export function loadRoutines(file: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as Partial<PersistedRoutines>;
    if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.routines)) return [];
    return parsed.routines.map(normalizePersistedRoutine).filter((routine): routine is AgentRoutine => Boolean(routine));
  } catch {
    return [];
  }
}
