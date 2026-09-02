import type { Dirent, Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export type WorkspaceTreeNode = {
  name: string;
  path: string;
  type: "directory" | "file";
  size?: number;
  modifiedAt?: string;
  children?: WorkspaceTreeNode[];
  childrenLoaded?: boolean;
  hasChildren?: boolean;
};

export type WorkspaceTreeReadOptions = {
  relativePath?: string;
  maxDepth?: number;
  totalEntryBudget?: number;
  consistency?: "cache" | "fresh";
};

export type WorkspaceTreeIndexFileSystem = {
  readDirectory(directory: string): Promise<Dirent[]>;
  lstat(target: string): Promise<Stats>;
  realpath?(target: string): Promise<string>;
};

export type WorkspaceTreeIndexOptions = {
  ttlMs?: number;
  staleWhileRevalidateMs?: number;
  initialDepth?: number;
  entryLimit?: number;
  totalEntryBudget?: number;
  maxCachedDirectories?: number;
  ioConcurrency?: number;
  ignoredDirectories?: Iterable<string>;
  fileSystem?: WorkspaceTreeIndexFileSystem;
  now?: () => number;
};

export type WorkspaceTreeIndexStats = {
  reads: number;
  cacheHits: number;
  staleHits: number;
  misses: number;
  coalescedRequests: number;
  refreshes: number;
  refreshErrors: number;
  cachedDirectories: number;
  inFlightDirectories: number;
};

type ListedEntry = {
  name: string;
  type: "directory" | "file";
};

type DirectoryRecord = ListedEntry & {
  absolutePath: string;
  relativePath: string;
  size?: number;
  modifiedAt: string;
};

type DirectoryLocation = {
  workspaceRoot: string;
  rootKey: string;
  absolutePath: string;
  relativePath: string;
  relativeKey: string;
  cacheKey: string;
  ignored: boolean;
};

type DirectorySnapshot = DirectoryLocation & {
  entries: ListedEntry[];
  truncated: boolean;
  loadedAt: number;
  records?: DirectoryRecord[];
};

type MetadataRequest = {
  snapshot: DirectorySnapshot;
  promise: Promise<DirectoryRecord[]>;
};

const DEFAULT_IGNORED_DIRECTORIES = [".git", "node_modules", ".runtime", "dist", "build"];

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}

function pathKey(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function relativeKey(value: string) {
  const normalized = value.split(path.sep).filter(Boolean).join(path.sep);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function directoryNameKey(value: string) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isOutsidePath(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function containsPath(parent: string, child: string) {
  if (!parent) return true;
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

class EntryBudget {
  constructor(public remaining: number) {}

  take<T>(values: T[]) {
    if (this.remaining <= 0) return [];
    const selected = values.slice(0, this.remaining);
    this.remaining -= selected.length;
    return selected;
  }
}

type TreeBuildResult = {
  nodes: WorkspaceTreeNode[];
  /** Whether every immediate entry in this directory is represented. */
  complete: boolean;
};

/**
 * A bounded, watcher-free workspace directory index. Directory names are
 * cached independently, while file metadata is hydrated only for directories
 * that are actually rendered. Stale entries are returned immediately during
 * the SWR window and refreshed in the background.
 */
export class WorkspaceTreeIndex {
  private readonly ttlMs: number;
  private readonly staleWhileRevalidateMs: number;
  private readonly initialDepth: number;
  private readonly entryLimit: number;
  private readonly totalEntryBudget: number;
  private readonly maxCachedDirectories: number;
  private readonly ioConcurrency: number;
  private readonly ignoredDirectories: Set<string>;
  private readonly fileSystem: WorkspaceTreeIndexFileSystem;
  private readonly now: () => number;
  private readonly cache = new Map<string, DirectorySnapshot>();
  private readonly listingRequests = new Map<string, Promise<DirectorySnapshot>>();
  private readonly metadataRequests = new Map<string, MetadataRequest>();
  private readonly detachedRequests = new Set<Promise<unknown>>();
  private readonly canonicalRoots = new Map<string, Promise<string>>();
  private readonly rootGenerations = new Map<string, number>();
  private readonly counters = {
    reads: 0,
    cacheHits: 0,
    staleHits: 0,
    misses: 0,
    coalescedRequests: 0,
    refreshes: 0,
    refreshErrors: 0
  };

  constructor(options: WorkspaceTreeIndexOptions = {}) {
    this.ttlMs = boundedInteger(options.ttlMs, 5_000, 0, 10 * 60_000);
    this.staleWhileRevalidateMs = boundedInteger(options.staleWhileRevalidateMs, 30_000, 0, 60 * 60_000);
    this.initialDepth = boundedInteger(options.initialDepth, 2, 0, 16);
    this.entryLimit = boundedInteger(options.entryLimit, 100, 1, 2_000);
    this.totalEntryBudget = boundedInteger(options.totalEntryBudget, 2_000, 1, 100_000);
    this.maxCachedDirectories = boundedInteger(options.maxCachedDirectories, 2_000, 1, 50_000);
    this.ioConcurrency = boundedInteger(options.ioConcurrency, 16, 1, 128);
    this.ignoredDirectories = new Set([...options.ignoredDirectories || DEFAULT_IGNORED_DIRECTORIES].map(directoryNameKey));
    this.fileSystem = {
      readDirectory: options.fileSystem?.readDirectory || ((directory) => fsp.readdir(directory, { withFileTypes: true })),
      lstat: options.fileSystem?.lstat || ((target) => fsp.lstat(target)),
      realpath: options.fileSystem?.realpath || ((target) => fsp.realpath(target))
    };
    this.now = options.now || Date.now;
  }

  async read(workspaceRoot: string, options: WorkspaceTreeReadOptions = {}): Promise<WorkspaceTreeNode[]> {
    this.counters.reads += 1;
    const location = this.resolveLocation(workspaceRoot, options.relativePath || "");
    if (location.ignored) return [];
    const maxDepth = boundedInteger(
      options.maxDepth,
      location.relativePath ? 0 : this.initialDepth,
      0,
      16
    );
    const budget = new EntryBudget(boundedInteger(
      options.totalEntryBudget,
      this.totalEntryBudget,
      1,
      100_000
    ));
    return (await this.buildTree(location, 0, maxDepth, budget, options.consistency === "fresh")).nodes;
  }

  readDirectory(workspaceRoot: string, relativePath: string, options: Omit<WorkspaceTreeReadOptions, "relativePath" | "maxDepth"> = {}) {
    return this.read(workspaceRoot, { ...options, relativePath, maxDepth: 0 });
  }

  /** Invalidates the changed path, all of its descendants, and its ancestors. */
  invalidate(workspaceRoot: string, changedPath = "") {
    const location = this.resolveLocation(workspaceRoot, changedPath);
    this.rootGenerations.set(location.rootKey, this.generation(location.rootKey) + 1);
    const target = location.relativeKey;
    for (const [key, entry] of this.cache) {
      if (entry.rootKey !== location.rootKey) continue;
      if (!target || containsPath(target, entry.relativeKey) || containsPath(entry.relativeKey, target)) this.cache.delete(key);
    }
    for (const key of this.listingRequests.keys()) {
      const entry = this.locationFromCacheKey(key);
      if (entry?.rootKey === location.rootKey && (!target || containsPath(target, entry.relativeKey) || containsPath(entry.relativeKey, target))) {
        const request = this.listingRequests.get(key);
        if (request) this.detachRequest(request);
        this.listingRequests.delete(key);
      }
    }
    for (const [key, request] of this.metadataRequests) {
      const entry = request.snapshot;
      if (entry.rootKey === location.rootKey && (!target || containsPath(target, entry.relativeKey) || containsPath(entry.relativeKey, target))) {
        this.detachRequest(request.promise);
        this.metadataRequests.delete(key);
      }
    }
  }

  clear() {
    const roots = new Set([
      ...[...this.cache.values()].map((entry) => entry.rootKey),
      ...[...this.listingRequests.keys()].map((key) => this.locationFromCacheKey(key)?.rootKey).filter((key): key is string => Boolean(key)),
      ...[...this.metadataRequests.values()].map((request) => request.snapshot.rootKey)
    ]);
    for (const rootKey of roots) {
      this.rootGenerations.set(rootKey, this.generation(rootKey) + 1);
    }
    this.cache.clear();
    for (const request of this.listingRequests.values()) this.detachRequest(request);
    for (const request of this.metadataRequests.values()) this.detachRequest(request.promise);
    this.listingRequests.clear();
    this.metadataRequests.clear();
    this.canonicalRoots.clear();
  }

  stats(): WorkspaceTreeIndexStats {
    return {
      ...this.counters,
      cachedDirectories: this.cache.size,
      inFlightDirectories: new Set([...this.listingRequests.keys(), ...this.metadataRequests.keys()]).size + this.detachedRequests.size
    };
  }

  async whenIdle() {
    while (this.listingRequests.size || this.metadataRequests.size || this.detachedRequests.size) {
      await Promise.allSettled([
        ...this.listingRequests.values(),
        ...[...this.metadataRequests.values()].map((request) => request.promise),
        ...this.detachedRequests
      ]);
    }
  }

  private async buildTree(location: DirectoryLocation, depth: number, maxDepth: number, budget: EntryBudget, fresh: boolean): Promise<TreeBuildResult> {
    if (location.ignored) return { nodes: [], complete: true };
    if (budget.remaining <= 0) return { nodes: [], complete: false };
    const snapshot = await this.getListing(location, fresh);
    const allRecords = await this.getRecords(snapshot);
    const records = budget.take(allRecords);
    const complete = !snapshot.truncated && records.length === allRecords.length;
    const nodes: WorkspaceTreeNode[] = records.map((record) => ({
      name: record.name,
      path: record.relativePath,
      type: record.type,
      size: record.size,
      modifiedAt: record.modifiedAt
    }));

    // Allocate the shared render budget deterministically in visible order.
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.type !== "directory") continue;
      const childLocation = this.resolveLocation(location.workspaceRoot, record.relativePath);
      if (depth < maxDepth) {
        const child = await this.buildTree(childLocation, depth + 1, maxDepth, budget, fresh);
        if (child.nodes.length) nodes[index].children = child.nodes;
        nodes[index].childrenLoaded = child.complete;
        nodes[index].hasChildren = child.nodes.length > 0 || !child.complete;
        continue;
      }
      nodes[index].childrenLoaded = false;
      // Avoid an N+1 directory scan merely to decorate a collapsed row.
      nodes[index].hasChildren = true;
    }
    return { nodes, complete };
  }

  private async getListing(location: DirectoryLocation, fresh: boolean) {
    const cached = this.cache.get(location.cacheKey);
    if (!fresh && cached) {
      this.touch(cached);
      const age = Math.max(0, this.now() - cached.loadedAt);
      if (age <= this.ttlMs) {
        this.counters.cacheHits += 1;
        return cached;
      }
      if (age <= this.ttlMs + this.staleWhileRevalidateMs) {
        this.counters.staleHits += 1;
        void this.refreshListing(location).catch(() => undefined);
        return cached;
      }
    }
    this.counters.misses += 1;
    return this.refreshListing(location);
  }

  private refreshListing(location: DirectoryLocation) {
    const pending = this.listingRequests.get(location.cacheKey);
    if (pending) {
      this.counters.coalescedRequests += 1;
      return pending;
    }
    const generation = this.generation(location.rootKey);
    this.counters.refreshes += 1;
    let promise!: Promise<DirectorySnapshot>;
    promise = (async () => {
      try {
        await this.assertCanonicalContainment(location);
        const visibleEntries = (await this.fileSystem.readDirectory(location.absolutePath))
          .filter((entry) => !entry.isSymbolicLink())
          .filter((entry) => entry.isFile() || entry.isDirectory())
          .filter((entry) => !entry.isDirectory() || !this.ignoredDirectories.has(directoryNameKey(entry.name)))
          .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name));
        const entries = visibleEntries
          .slice(0, this.entryLimit)
          .map<ListedEntry>((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
        const snapshot: DirectorySnapshot = { ...location, entries, truncated: visibleEntries.length > entries.length, loadedAt: this.now() };
        if (generation === this.generation(location.rootKey)) {
          this.cache.set(location.cacheKey, snapshot);
          this.touch(snapshot);
          this.evictOverflow();
        }
        return snapshot;
      } catch (error) {
        this.counters.refreshErrors += 1;
        throw error;
      }
    })().finally(() => {
      if (this.listingRequests.get(location.cacheKey) === promise) this.listingRequests.delete(location.cacheKey);
    });
    this.listingRequests.set(location.cacheKey, promise);
    return promise;
  }

  private getRecords(snapshot: DirectorySnapshot) {
    if (snapshot.records) return Promise.resolve(snapshot.records);
    const pending = this.metadataRequests.get(snapshot.cacheKey);
    if (pending?.snapshot === snapshot) {
      this.counters.coalescedRequests += 1;
      return pending.promise;
    }
    let promise!: Promise<DirectoryRecord[]>;
    promise = mapWithConcurrency<ListedEntry, DirectoryRecord | null>(snapshot.entries, this.ioConcurrency, async (entry) => {
      const absolutePath = path.join(snapshot.absolutePath, entry.name);
      try {
        const stat = await this.fileSystem.lstat(absolutePath);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return null;
        const type = stat.isDirectory() ? "directory" as const : "file" as const;
        const record: DirectoryRecord = {
          name: entry.name,
          type,
          absolutePath,
          relativePath: path.relative(snapshot.workspaceRoot, absolutePath) || ".",
          modifiedAt: stat.mtime.toISOString()
        };
        if (type === "file") record.size = stat.size;
        return record;
      } catch {
        return null;
      }
    }).then((records) => records.filter((record): record is DirectoryRecord => record !== null)).then((records) => {
      if (this.cache.get(snapshot.cacheKey) === snapshot) snapshot.records = records;
      return records;
    }).finally(() => {
      if (this.metadataRequests.get(snapshot.cacheKey)?.promise === promise) this.metadataRequests.delete(snapshot.cacheKey);
    });
    this.metadataRequests.set(snapshot.cacheKey, { snapshot, promise });
    return promise;
  }

  private resolveLocation(workspaceRoot: string, requestedPath: string): DirectoryLocation {
    const root = path.resolve(workspaceRoot);
    const absolutePath = path.resolve(root, String(requestedPath || "."));
    const relativePath = path.relative(root, absolutePath);
    if (isOutsidePath(root, absolutePath)) throw new Error("目录路径必须位于当前工作区内");
    const rootKey = pathKey(root);
    const normalizedRelativeKey = relativeKey(relativePath);
    const ignored = relativePath.split(path.sep).filter(Boolean).some((segment) => this.ignoredDirectories.has(directoryNameKey(segment)));
    return {
      workspaceRoot: root,
      rootKey,
      absolutePath,
      relativePath,
      relativeKey: normalizedRelativeKey,
      cacheKey: JSON.stringify([rootKey, normalizedRelativeKey]),
      ignored
    };
  }

  private generation(rootKey: string) {
    return this.rootGenerations.get(rootKey) || 0;
  }

  private async assertCanonicalContainment(location: DirectoryLocation) {
    let canonicalRoot = this.canonicalRoots.get(location.rootKey);
    if (!canonicalRoot) {
      canonicalRoot = this.fileSystem.realpath!(location.workspaceRoot);
      this.canonicalRoots.set(location.rootKey, canonicalRoot);
      void canonicalRoot.catch(() => {
        if (this.canonicalRoots.get(location.rootKey) === canonicalRoot) this.canonicalRoots.delete(location.rootKey);
      });
    }
    const [root, target] = await Promise.all([canonicalRoot, this.fileSystem.realpath!(location.absolutePath)]);
    if (isOutsidePath(root, target)) throw new Error("目录路径必须位于当前工作区内");
  }

  private detachRequest(request: Promise<unknown>) {
    this.detachedRequests.add(request);
    void request.finally(() => this.detachedRequests.delete(request)).catch(() => undefined);
  }

  private touch(snapshot: DirectorySnapshot) {
    if (this.cache.get(snapshot.cacheKey) !== snapshot) return;
    this.cache.delete(snapshot.cacheKey);
    this.cache.set(snapshot.cacheKey, snapshot);
  }

  private evictOverflow() {
    while (this.cache.size > this.maxCachedDirectories) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private locationFromCacheKey(cacheKey: string) {
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    try {
      const [rootKey, relativeKey] = JSON.parse(cacheKey) as [string, string];
      return { rootKey, relativeKey };
    } catch {
      return null;
    }
  }
}
