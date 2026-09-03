import fsp from "node:fs/promises";
import path from "node:path";

export type BackupHealthStatus = "pending" | "running" | "healthy" | "busy" | "failed";

export type BackupHealth = {
  schemaVersion: 1;
  status: BackupHealthStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  stale: boolean;
};

type Timer = ReturnType<typeof setTimeout>;

export class BackupBusyError extends Error {
  readonly code = "BACKUP_BUSY";

  constructor(message: string) {
    super(message);
    this.name = "BackupBusyError";
  }
}

type BackupSchedulerOptions<Result> = {
  healthFile: string;
  runBackup: () => Promise<Result>;
  getLatestBackupAt: () => Promise<string | null>;
  onSuccess?: (result: Result) => Promise<void> | void;
  onFailure?: (error: unknown, status: "busy" | "failed") => Promise<void> | void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  intervalMs?: number;
  staleAfterMs?: number;
  startupDelayMs?: number;
  retryDelaysMs?: number[];
};

const DAY = 24 * 60 * 60 * 1_000;

function parseTimestamp(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function laterTimestamp(left: string | null, right: string | null) {
  const leftTime = parseTimestamp(left) ?? -1;
  const rightTime = parseTimestamp(right) ?? -1;
  return leftTime >= rightTime ? left : right;
}

export class BackupScheduler<Result> {
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly startupDelayMs: number;
  private readonly retryDelaysMs: number[];
  private readonly now: () => number;
  private readonly setTimer: NonNullable<BackupSchedulerOptions<Result>["setTimer"]>;
  private readonly clearTimer: NonNullable<BackupSchedulerOptions<Result>["clearTimer"]>;
  private timer: Timer | null = null;
  private inFlight: Promise<Result> | null = null;
  private retryIndex = 0;
  private initialization: Promise<BackupHealth> | null = null;
  private health: BackupHealth = {
    schemaVersion: 1,
    status: "pending",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextAttemptAt: null,
    lastError: null,
    stale: true
  };

  constructor(private readonly options: BackupSchedulerOptions<Result>) {
    this.intervalMs = options.intervalMs ?? DAY;
    this.staleAfterMs = options.staleAfterMs ?? 26 * 60 * 60 * 1_000;
    this.startupDelayMs = options.startupDelayMs ?? 30_000;
    this.retryDelaysMs = options.retryDelaysMs?.length ? options.retryDelaysMs : [5, 15, 30, 60].map((minutes) => minutes * 60_000);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  start() {
    if (!this.initialization) this.initialization = this.initialize();
    return this.initialization;
  }

  private async initialize() {
    const [persisted, latestBackupAt] = await Promise.all([this.readPersistedHealth(), this.options.getLatestBackupAt()]);
    const lastSuccessAt = laterTimestamp(persisted?.lastSuccessAt || null, latestBackupAt);
    const lastSuccessTime = parseTimestamp(lastSuccessAt);
    const now = this.now();
    const stale = lastSuccessTime === null || now - lastSuccessTime >= this.staleAfterMs;
    const nextTime = stale ? now + this.startupDelayMs : Math.max(now + 1_000, lastSuccessTime + this.intervalMs);
    this.health = {
      schemaVersion: 1,
      status: stale ? "pending" : "healthy",
      lastAttemptAt: persisted?.lastAttemptAt || null,
      lastSuccessAt,
      nextAttemptAt: new Date(nextTime).toISOString(),
      lastError: stale ? persisted?.lastError || null : null,
      stale
    };
    await this.persist();
    this.scheduleAt(nextTime);
    return this.snapshot();
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  snapshot(): BackupHealth {
    return { ...this.health };
  }

  async runNow() {
    if (!this.initialization) await this.start();
    else await this.initialization;
    if (this.inFlight) return this.inFlight;
    this.stop();
    const promise = this.execute();
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      this.inFlight = null;
    }
  }

  private async execute() {
    const attemptAt = this.now();
    this.health = {
      ...this.health,
      status: "running",
      lastAttemptAt: new Date(attemptAt).toISOString(),
      nextAttemptAt: null,
      lastError: null,
      stale: this.isStale(attemptAt)
    };
    await this.persist();
    try {
      const result = await this.options.runBackup();
      const successAt = this.now();
      this.retryIndex = 0;
      this.health = {
        schemaVersion: 1,
        status: "healthy",
        lastAttemptAt: new Date(attemptAt).toISOString(),
        lastSuccessAt: new Date(successAt).toISOString(),
        nextAttemptAt: new Date(successAt + this.intervalMs).toISOString(),
        lastError: null,
        stale: false
      };
      await this.persist();
      this.scheduleAt(successAt + this.intervalMs);
      await this.options.onSuccess?.(result);
      return result;
    } catch (error) {
      const status = error instanceof BackupBusyError ? "busy" : "failed";
      const retryDelay = this.retryDelaysMs[Math.min(this.retryIndex, this.retryDelaysMs.length - 1)];
      this.retryIndex += 1;
      const retryAt = this.now() + retryDelay;
      this.health = {
        ...this.health,
        status,
        nextAttemptAt: new Date(retryAt).toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
        stale: this.isStale(this.now())
      };
      await this.persist();
      this.scheduleAt(retryAt);
      await this.options.onFailure?.(error, status);
      throw error;
    }
  }

  private isStale(now: number) {
    const lastSuccessTime = parseTimestamp(this.health.lastSuccessAt);
    return lastSuccessTime === null || now - lastSuccessTime >= this.staleAfterMs;
  }

  private scheduleAt(timestamp: number) {
    this.stop();
    const timer = this.setTimer(() => {
      void this.runNow().catch(() => undefined);
    }, Math.max(0, timestamp - this.now()));
    timer.unref?.();
    this.timer = timer;
  }

  private async readPersistedHealth(): Promise<BackupHealth | null> {
    try {
      const value = JSON.parse(await fsp.readFile(this.options.healthFile, "utf8")) as Partial<BackupHealth>;
      if (value.schemaVersion !== 1) return null;
      return {
        schemaVersion: 1,
        status: value.status || "pending",
        lastAttemptAt: value.lastAttemptAt || null,
        lastSuccessAt: value.lastSuccessAt || null,
        nextAttemptAt: value.nextAttemptAt || null,
        lastError: value.lastError || null,
        stale: value.stale !== false
      };
    } catch {
      return null;
    }
  }

  private async persist() {
    await fsp.mkdir(path.dirname(this.options.healthFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.healthFile}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(this.health, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, this.options.healthFile);
  }
}
