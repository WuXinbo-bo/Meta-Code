import fsp from "node:fs/promises";
import path from "node:path";

export type BackupTrigger = "manual" | "automatic";
export type BackupHealthStatus = "disabled" | "pending" | "running" | "healthy" | "busy" | "failed";

export type BackupHealth = {
  schemaVersion: 1;
  status: BackupHealthStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  stale: boolean;
  automaticEnabled: boolean;
  currentTrigger: BackupTrigger | null;
  lastTrigger: BackupTrigger | null;
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
  runBackup: (trigger: BackupTrigger) => Promise<Result>;
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
  automaticEnabled?: boolean;
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
  private automaticEnabled: boolean;
  private health: BackupHealth = {
    schemaVersion: 1,
    status: "pending",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextAttemptAt: null,
    lastError: null,
    stale: true,
    automaticEnabled: true,
    currentTrigger: null,
    lastTrigger: null
  };

  constructor(private readonly options: BackupSchedulerOptions<Result>) {
    this.intervalMs = options.intervalMs ?? DAY;
    this.staleAfterMs = options.staleAfterMs ?? 26 * 60 * 60 * 1_000;
    this.startupDelayMs = options.startupDelayMs ?? 30_000;
    this.retryDelaysMs = options.retryDelaysMs?.length ? options.retryDelaysMs : [5, 15, 30, 60].map((minutes) => minutes * 60_000);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.automaticEnabled = options.automaticEnabled !== false;
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
      status: this.automaticEnabled ? stale ? "pending" : "healthy" : "disabled",
      lastAttemptAt: persisted?.lastAttemptAt || null,
      lastSuccessAt,
      nextAttemptAt: this.automaticEnabled ? new Date(nextTime).toISOString() : null,
      lastError: stale ? persisted?.lastError || null : null,
      stale,
      automaticEnabled: this.automaticEnabled,
      currentTrigger: null,
      lastTrigger: persisted?.lastTrigger || null
    };
    await this.persist();
    if (this.automaticEnabled) this.scheduleAt(nextTime);
    return this.snapshot();
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  snapshot(): BackupHealth {
    return { ...this.health };
  }

  async setAutomaticEnabled(enabled: boolean) {
    if (!this.initialization) await this.start();
    else await this.initialization;
    this.automaticEnabled = enabled;
    this.stop();
    if (!enabled) {
      this.health = { ...this.health, status: "disabled", nextAttemptAt: null, automaticEnabled: false };
      await this.persist();
      return this.snapshot();
    }
    const latestBackupAt = await this.options.getLatestBackupAt();
    const lastSuccessAt = laterTimestamp(this.health.lastSuccessAt, latestBackupAt);
    const lastSuccessTime = parseTimestamp(lastSuccessAt);
    const now = this.now();
    const stale = lastSuccessTime === null || now - lastSuccessTime >= this.staleAfterMs;
    const nextTime = stale ? now + this.startupDelayMs : Math.max(now + 1_000, lastSuccessTime + this.intervalMs);
    this.health = {
      ...this.health,
      status: stale ? "pending" : "healthy",
      lastSuccessAt,
      nextAttemptAt: new Date(nextTime).toISOString(),
      lastError: stale ? this.health.lastError : null,
      stale,
      automaticEnabled: true
    };
    await this.persist();
    this.scheduleAt(nextTime);
    return this.snapshot();
  }

  async runNow(trigger: BackupTrigger = "manual") {
    if (!this.initialization) await this.start();
    else await this.initialization;
    if (this.inFlight) return this.inFlight;
    this.stop();
    const promise = this.execute(trigger);
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      this.inFlight = null;
    }
  }

  private async execute(trigger: BackupTrigger) {
    const attemptAt = this.now();
    this.health = {
      ...this.health,
      status: "running",
      lastAttemptAt: new Date(attemptAt).toISOString(),
      nextAttemptAt: null,
      lastError: null,
      stale: this.isStale(attemptAt),
      automaticEnabled: this.automaticEnabled,
      currentTrigger: trigger
    };
    await this.persist();
    try {
      const result = await this.options.runBackup(trigger);
      const successAt = this.now();
      this.retryIndex = 0;
      this.health = {
        schemaVersion: 1,
        status: this.automaticEnabled ? "healthy" : "disabled",
        lastAttemptAt: new Date(attemptAt).toISOString(),
        lastSuccessAt: new Date(successAt).toISOString(),
        nextAttemptAt: this.automaticEnabled ? new Date(successAt + this.intervalMs).toISOString() : null,
        lastError: null,
        stale: false,
        automaticEnabled: this.automaticEnabled,
        currentTrigger: null,
        lastTrigger: trigger
      };
      await this.persist();
      if (this.automaticEnabled) this.scheduleAt(successAt + this.intervalMs);
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
        nextAttemptAt: this.automaticEnabled ? new Date(retryAt).toISOString() : null,
        lastError: error instanceof Error ? error.message : String(error),
        stale: this.isStale(this.now()),
        automaticEnabled: this.automaticEnabled,
        currentTrigger: null,
        lastTrigger: trigger
      };
      await this.persist();
      if (this.automaticEnabled) this.scheduleAt(retryAt);
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
    if (!this.automaticEnabled) return;
    const timer = this.setTimer(() => {
      void this.runNow("automatic").catch(() => undefined);
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
        stale: value.stale !== false,
        automaticEnabled: value.automaticEnabled !== false,
        currentTrigger: null,
        lastTrigger: value.lastTrigger === "manual" || value.lastTrigger === "automatic" ? value.lastTrigger : null
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
