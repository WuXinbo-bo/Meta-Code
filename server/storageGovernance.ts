import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export type StorageCategory =
  | "personal-backup"
  | "database-backup"
  | "migration-backup"
  | "pre-restore"
  | "legacy-migration"
  | "runtime-version"
  | "runtime-cache"
  | "session-recovery"
  | "activity-artifact"
  | "workflow-runtime"
  | "diagnostic-log";

export type StorageMaintenanceAction = {
  category: StorageCategory;
  path: string;
  kind: "file" | "directory" | "symlink";
  bytes: number;
  reason: "age" | "count" | "capacity";
};

export type StorageMaintenanceReport = {
  schemaVersion: 1;
  dataDir: string;
  createdAt: string;
  dryRun: boolean;
  inventory: Record<StorageCategory, { items: number; bytes: number; protectedItems: number }>;
  actions: StorageMaintenanceAction[];
  reclaimableBytes: number;
  deletedItems: number;
  deletedBytes: number;
};

export type StorageMaintenanceInput = {
  dataDir: string;
  protectedSessionIds?: Iterable<string>;
  protectedRuntimePaths?: Iterable<string>;
  protectedWorkflowRuntimeNames?: Iterable<string>;
  now?: number;
};

type Entry = {
  path: string;
  kind: StorageMaintenanceAction["kind"];
  bytes: number;
  mtimeMs: number;
  protected: boolean;
};

const DAY = 24 * 60 * 60 * 1_000;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const CATEGORIES: StorageCategory[] = [
  "personal-backup", "database-backup", "migration-backup", "pre-restore", "legacy-migration",
  "runtime-version", "runtime-cache", "session-recovery", "activity-artifact", "workflow-runtime", "diagnostic-log"
];

function isInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function entrySize(target: string): Promise<number> {
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of await fsp.readdir(target, { withFileTypes: true })) total += await entrySize(path.join(target, entry.name));
  return total;
}

async function describe(target: string, protectedEntry = false): Promise<Entry | null> {
  try {
    const stat = await fsp.lstat(target);
    return {
      path: path.resolve(target),
      kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
      bytes: await entrySize(target),
      mtimeMs: stat.mtimeMs,
      protected: protectedEntry
    };
  } catch { return null; }
}

async function directEntries(root: string, accept: (name: string, directory: boolean) => boolean, protectedEntry?: (target: string, name: string) => boolean) {
  const result: Entry[] = [];
  for (const item of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!accept(item.name, item.isDirectory())) continue;
    const target = path.join(root, item.name);
    const value = await describe(target, protectedEntry?.(target, item.name) || false);
    if (value) result.push(value);
  }
  return result;
}

async function recursiveFiles(root: string, protectedEntry?: (target: string) => boolean) {
  const result: Entry[] = [];
  async function visit(directory: string) {
    for (const item of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(directory, item.name);
      if (item.isDirectory() && !item.isSymbolicLink()) await visit(target);
      else {
        const value = await describe(target, protectedEntry?.(target) || false);
        if (value) result.push(value);
      }
    }
  }
  await visit(root);
  return result;
}

function normalizePath(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathProtects(candidate: string, protectedPaths: ReadonlySet<string>) {
  const normalized = normalizePath(candidate);
  for (const protectedPath of protectedPaths) {
    if (protectedPath === normalized || protectedPath.startsWith(`${normalized}${path.sep}`)) return true;
  }
  return false;
}

function selectActions(category: StorageCategory, entries: Entry[], options: {
  now: number;
  maxAgeMs: number;
  keepCount: number;
  maxBytes: number;
  minimumKeep?: number;
}) {
  const ordered = [...entries].sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  const protectedItems = ordered.filter((entry) => entry.protected);
  const deletable = ordered.filter((entry) => !entry.protected);
  const keep = new Set(deletable.slice(0, Math.max(options.minimumKeep || 0, options.keepCount)).map((entry) => entry.path));
  let remainingBytes = ordered.reduce((total, entry) => total + entry.bytes, 0);
  const actions: StorageMaintenanceAction[] = [];
  for (const [index, entry] of deletable.entries()) {
    if (index < (options.minimumKeep || 0)) continue;
    const tooOld = options.maxAgeMs > 0 && entry.mtimeMs < options.now - options.maxAgeMs;
    const tooMany = index >= options.keepCount;
    const overCapacity = remainingBytes > options.maxBytes && !keep.has(entry.path);
    const reason = tooOld ? "age" : tooMany ? "count" : overCapacity ? "capacity" : null;
    if (!reason) continue;
    actions.push({ category, path: entry.path, kind: entry.kind, bytes: entry.bytes, reason });
    remainingBytes -= entry.bytes;
  }
  return {
    inventory: { items: ordered.length, bytes: ordered.reduce((total, entry) => total + entry.bytes, 0), protectedItems: protectedItems.length },
    actions
  };
}

async function sessionIdFromJson(file: string) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as { sessionId?: string; session?: { id?: string } };
    return String(parsed.sessionId || parsed.session?.id || "");
  } catch { return ""; }
}

export async function planStorageMaintenance(input: StorageMaintenanceInput): Promise<StorageMaintenanceReport> {
  const dataDir = path.resolve(input.dataDir);
  const now = input.now ?? Date.now();
  const protectedSessions = new Set(input.protectedSessionIds || []);
  const protectedRuntimePaths = new Set([...input.protectedRuntimePaths || []].map(normalizePath));
  const protectedWorkflowNames = new Set(input.protectedWorkflowRuntimeNames || []);
  const inventory = Object.fromEntries(CATEGORIES.map((category) => [category, { items: 0, bytes: 0, protectedItems: 0 }])) as StorageMaintenanceReport["inventory"];
  const actions: StorageMaintenanceAction[] = [];
  const add = (category: StorageCategory, entries: Entry[], policy: Parameters<typeof selectActions>[2]) => {
    const selected = selectActions(category, entries, policy);
    inventory[category] = selected.inventory;
    actions.push(...selected.actions);
  };
  const addDatabaseBackupGroups = (entries: Entry[]) => {
    const groups = new Map<string, Entry[]>();
    for (const entry of entries) {
      const match = /^(?:workbench-state|auth)-([\w.-]+)\.db$/.exec(path.basename(entry.path));
      if (!match) continue;
      const values = groups.get(match[1]) || [];
      values.push(entry);
      groups.set(match[1], values);
    }
    const complete = [...groups.values()].filter((values) => values.length === 2);
    const grouped = complete.map((values) => ({
      path: values[0].path,
      kind: "file" as const,
      bytes: values.reduce((total, entry) => total + entry.bytes, 0),
      mtimeMs: Math.max(...values.map((entry) => entry.mtimeMs)),
      protected: false
    }));
    const selected = selectActions("database-backup", grouped, { now, maxAgeMs: 90 * DAY, keepCount: 5, minimumKeep: 1, maxBytes: 4 * GIB });
    inventory["database-backup"] = { items: complete.length, bytes: grouped.reduce((total, entry) => total + entry.bytes, 0), protectedItems: 0 };
    for (const selectedGroup of selected.actions) {
      const members = complete.find((values) => values[0].path === selectedGroup.path) || [];
      for (const member of members) actions.push({ ...selectedGroup, path: member.path, kind: member.kind, bytes: member.bytes });
    }
  };

  const backups = path.join(dataDir, "backups");
  add("personal-backup", await directEntries(backups, (name, directory) => directory && name.startsWith("personal-")), { now, maxAgeMs: 90 * DAY, keepCount: 3, minimumKeep: 3, maxBytes: 8 * GIB });
  addDatabaseBackupGroups(await directEntries(backups, (name, directory) => !directory && /^(workbench-state|auth)-[\w.-]+\.db$/.test(name)));
  add("migration-backup", await directEntries(path.join(backups, "migrations"), (_name, directory) => !directory), { now, maxAgeMs: 365 * DAY, keepCount: 5, minimumKeep: 1, maxBytes: 4 * GIB });
  add("pre-restore", await directEntries(backups, (name, directory) => directory && name.startsWith("pre-restore-")), { now, maxAgeMs: 30 * DAY, keepCount: 3, minimumKeep: 1, maxBytes: 8 * GIB });
  add("legacy-migration", await directEntries(path.join(dataDir, "migration-backups"), (_name, directory) => directory), { now, maxAgeMs: 365 * DAY, keepCount: 2, minimumKeep: 1, maxBytes: 8 * GIB });

  const runtimesRoot = path.join(dataDir, "runtimes");
  const runtimeVersions: Entry[] = [];
  const runtimeCaches: Entry[] = [];
  for (const runtime of await fsp.readdir(runtimesRoot, { withFileTypes: true }).catch(() => [])) {
    if (!runtime.isDirectory()) continue;
    const runtimeRoot = path.join(runtimesRoot, runtime.name);
    let activeVersion = "";
    try { activeVersion = String(JSON.parse(await fsp.readFile(path.join(runtimeRoot, "current.json"), "utf8")).version || ""); } catch { /* No managed version is active. */ }
    runtimeVersions.push(...await directEntries(path.join(runtimeRoot, "versions"), (_name, directory) => directory, (target, name) => name === activeVersion || pathProtects(target, protectedRuntimePaths)));
    runtimeCaches.push(...await recursiveFiles(path.join(runtimeRoot, "cache")));
  }
  add("runtime-version", runtimeVersions, { now, maxAgeMs: 180 * DAY, keepCount: 1, minimumKeep: 1, maxBytes: 8 * GIB });
  add("runtime-cache", runtimeCaches, { now, maxAgeMs: 30 * DAY, keepCount: 500, maxBytes: 2 * GIB });

  const recoveryEntries = await recursiveFiles(path.join(dataDir, "sessions", "recovery"));
  for (const entry of recoveryEntries) entry.protected = protectedSessions.has(await sessionIdFromJson(entry.path));
  add("session-recovery", recoveryEntries, { now, maxAgeMs: 30 * DAY, keepCount: 500, maxBytes: 512 * MIB });

  const artifactEntries = await recursiveFiles(path.join(dataDir, "artifacts", "activity"));
  for (const entry of artifactEntries) entry.protected = protectedSessions.has(await sessionIdFromJson(entry.path));
  add("activity-artifact", artifactEntries, { now, maxAgeMs: 90 * DAY, keepCount: 1_000, maxBytes: 1 * GIB });
  add("workflow-runtime", await directEntries(path.join(dataDir, "workflow-node-runtime"), (_name, directory) => directory, (_target, name) => protectedWorkflowNames.has(name)), { now, maxAgeMs: 30 * DAY, keepCount: 100, maxBytes: 2 * GIB });
  add("diagnostic-log", await recursiveFiles(path.join(dataDir, "logs"), (target) => {
    try { return fs.statSync(target).mtimeMs >= now - DAY; } catch { return false; }
  }), { now, maxAgeMs: 14 * DAY, keepCount: 20, maxBytes: 256 * MIB });

  actions.sort((left, right) => left.category.localeCompare(right.category) || left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    dataDir,
    createdAt: new Date(now).toISOString(),
    dryRun: true,
    inventory,
    actions,
    reclaimableBytes: actions.reduce((total, action) => total + action.bytes, 0),
    deletedItems: 0,
    deletedBytes: 0
  };
}

export async function runStorageMaintenance(input: StorageMaintenanceInput) {
  const report = await planStorageMaintenance(input);
  let deletedItems = 0;
  let deletedBytes = 0;
  for (const action of report.actions) {
    if (!isInside(report.dataDir, action.path)) throw new Error(`存储清理路径越界：${action.path}`);
    try {
      await fsp.rm(action.path, { recursive: action.kind === "directory", force: true });
      deletedItems += 1;
      deletedBytes += action.bytes;
    } catch {
      // Active log files can be locked on Windows. They remain for the next pass.
    }
  }
  return { ...report, dryRun: false, deletedItems, deletedBytes };
}
