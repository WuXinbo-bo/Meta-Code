export interface WorkspaceResourceSnapshot<T> {
  value: T;
  /** Time at which the value entered the cache. */
  updatedAt: number;
  /** Non-negative age calculated at read time. */
  ageMs: number;
}

interface StoredResource<T> {
  value: T;
  updatedAt: number;
}

type Clock = () => number;

function validateCapacity(capacity: number) {
  if (!Number.isInteger(capacity) || capacity < 0) {
    throw new RangeError("WorkspaceResourceCache capacity must be a non-negative integer");
  }
  return capacity;
}

/** A small LRU cache with timestamp metadata for stale-while-revalidate reads. */
export class WorkspaceResourceCache<T> {
  private readonly entries = new Map<string, StoredResource<T>>();
  private maxEntries: number;

  constructor(capacity = 8, private readonly clock: Clock = Date.now) {
    this.maxEntries = validateCapacity(capacity);
  }

  get size() {
    return this.entries.size;
  }

  get capacity() {
    return this.maxEntries;
  }

  has(key: string) {
    return this.entries.has(key);
  }

  /** Reads and promotes the entry to most-recently-used. */
  get(key: string) {
    return this.getEntry(key)?.value;
  }

  /** Reads without changing LRU order, suitable for speculative/SWR checks. */
  peek(key: string) {
    return this.peekEntry(key)?.value;
  }

  /** Reads value and age metadata and promotes it to most-recently-used. */
  getEntry(key: string, now = this.clock()): WorkspaceResourceSnapshot<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return this.snapshot(entry, now);
  }

  /** Reads value and age metadata without changing LRU order. */
  peekEntry(key: string, now = this.clock()): WorkspaceResourceSnapshot<T> | undefined {
    const entry = this.entries.get(key);
    return entry ? this.snapshot(entry, now) : undefined;
  }

  getAge(key: string, now = this.clock()) {
    return this.peekEntry(key, now)?.ageMs;
  }

  isFresh(key: string, maxAgeMs: number, now = this.clock()) {
    const age = this.getAge(key, now);
    return age !== undefined && maxAgeMs >= 0 && age <= maxAgeMs;
  }

  set(key: string, value: T, updatedAt = this.clock()) {
    if (!Number.isFinite(updatedAt)) throw new RangeError("updatedAt must be a finite timestamp");
    this.entries.delete(key);
    this.entries.set(key, { value, updatedAt });
    this.evictOverflow();
  }

  setCapacity(capacity: number) {
    this.maxEntries = validateCapacity(capacity);
    this.evictOverflow();
  }

  delete(key: string) {
    return this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  private snapshot(entry: StoredResource<T>, now: number): WorkspaceResourceSnapshot<T> {
    return {
      value: entry.value,
      updatedAt: entry.updatedAt,
      ageMs: Math.max(0, now - entry.updatedAt)
    };
  }

  private evictOverflow() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
