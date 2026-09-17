/** A stale snapshot is reusable only while the selected runtime is unchanged. */
export class RuntimeDetectionCache<T> {
  private generation = 0;
  private snapshot: T | null = null;
  private checkedAt = 0;
  private pending: Promise<T> | null = null;

  constructor(
    private readonly probe: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly onBackgroundError: (error: unknown) => void,
    private readonly now: () => number = Date.now
  ) {}

  peek() { return this.snapshot; }

  invalidate() {
    this.generation += 1;
    this.snapshot = null;
    this.checkedAt = 0;
    this.pending = null;
  }

  async get(force = false, allowStale = false): Promise<T> {
    if (!force && this.snapshot !== null) {
      if (this.now() - this.checkedAt < this.ttlMs) return this.snapshot;
      if (allowStale) {
        void this.refresh().catch(this.onBackgroundError);
        return this.snapshot;
      }
    }
    return this.refresh();
  }

  private refresh(): Promise<T> {
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = Promise.resolve().then(this.probe).then(
      (status) => {
        if (generation !== this.generation) return this.get();
        this.snapshot = status;
        this.checkedAt = this.now();
        return status;
      },
      (error: unknown) => {
        if (generation !== this.generation) return this.get();
        throw error;
      }
    ).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }
}
