import fs from "node:fs/promises";
import path from "node:path";
import { gitRoot, runGit } from "./service.js";

/**
 * The lifecycle service deliberately has no UI or orchestration dependency.
 * Callers can use the structured status values to decide whether an operation
 * should be shown as ready, blocked, or failed without parsing Git output.
 */
export type WorktreeLifecycleStatus =
  | "listed"
  | "created"
  | "already_exists"
  | "bound"
  | "restored"
  | "removed"
  | "already_absent"
  | "blocked";

export type WorktreeRecordStatus = "ready" | "detached" | "locked" | "prunable" | "missing";

export type WorktreeRecord = {
  /** Absolute path reported by Git, normalized for the host platform. */
  path: string;
  /** The repository root from which this record was read. */
  repositoryRoot: string;
  head: string;
  /** Short branch name when the worktree is attached to a branch. */
  branch?: string;
  /** Full `refs/...` value reported by Git. */
  branchRef?: string;
  detached: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  pruneReason?: string;
  /** The first entry is the repository's primary worktree. */
  isPrimary: boolean;
  exists: boolean;
  status: WorktreeRecordStatus;
};

export type WorktreeListResult = {
  status: "listed";
  repositoryRoot: string;
  worktrees: WorktreeRecord[];
  refreshedAt: string;
};

export type WorktreeOperationResult = {
  status: WorktreeLifecycleStatus;
  repositoryRoot: string;
  worktree?: WorktreeRecord;
  path?: string;
  reason?: "dirty" | "locked" | "path_occupied";
  dirtyFiles?: string[];
  message?: string;
};

export type CreateWorktreeOptions = {
  /** Any path inside a Git worktree is accepted; non-Git paths fail clearly. */
  workspaceRoot: string;
  /** Absolute path, or a relative path contained by `workspaceRoot`. */
  worktreePath: string;
  /** Create a new branch at `ref` (or HEAD when omitted). */
  branch?: string;
  /** Existing commit, branch, or tag to check out. */
  ref?: string;
  /** Create a detached worktree instead of attaching a branch. */
  detach?: boolean;
  /** Pass `--force` to Git for an otherwise valid existing branch. */
  force?: boolean;
};

export type MergePreflightOptions = {
  workspaceRoot: string;
  source: string;
  /** Defaults to the current branch, or HEAD when detached. */
  target?: string;
  /** Run status and merge-tree from a particular worktree. */
  worktreePath?: string;
  /** Allow a dirty target worktree to be assessed. Defaults to false. */
  allowDirty?: boolean;
};

export type MergePreflightResult = {
  status: "ready" | "already_up_to_date" | "conflicts" | "blocked";
  repositoryRoot: string;
  source: string;
  target: string;
  sourceCommit: string;
  targetCommit: string;
  changedFiles: string[];
  conflicts: string[];
  targetDirty: boolean;
  dirtyFiles: string[];
  reason?: "target_dirty" | "merge_conflict";
  message?: string;
};

export type WorktreeErrorCode =
  | "INVALID_PATH"
  | "NOT_GIT_REPOSITORY"
  | "PATH_OCCUPIED"
  | "CREATE_FAILED"
  | "WORKTREE_NOT_FOUND"
  | "PRIMARY_WORKTREE"
  | "INVALID_REF"
  | "RESTORE_FAILED"
  | "CLEANUP_FAILED"
  | "MERGE_PREFLIGHT_FAILED";

/** An actionable error that can be safely surfaced by an API boundary. */
export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: WorktreeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
    this.details = details;
  }
}

function fail(code: WorktreeErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new WorktreeError(code, message, details);
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function pathHasTraversal(raw: string): boolean {
  return raw.split(/[\\/]+/).some((part) => part === ".." || part.includes("\0"));
}

function normalizeWorktreePath(workspaceRoot: string, input: string): string {
  const raw = String(input || "").trim();
  if (!raw || raw.includes("\0") || /[\u0000-\u001f\u007f]/.test(raw)) {
    fail("INVALID_PATH", "Worktree 路径为空或包含非法控制字符");
  }
  // Relative paths are intentionally constrained to the repository root. An
  // absolute sibling path is supported because it is the common worktree
  // layout, while cleanup still requires an exact Git-managed record.
  if (!path.isAbsolute(raw) && pathHasTraversal(raw)) {
    fail("INVALID_PATH", "相对 Worktree 路径不能越过当前工作区边界");
  }
  const candidate = path.resolve(path.isAbsolute(raw) ? raw : path.join(workspaceRoot, raw));
  if (samePath(candidate, workspaceRoot) || samePath(candidate, path.join(workspaceRoot, ".git"))) {
    fail("INVALID_PATH", "Worktree 路径不能是主工作区或其 .git 目录");
  }
  return candidate;
}

function validateGitToken(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const token = String(value).trim();
  if (!token || token.length > 1024 || token.startsWith("-") || /[\u0000-\u0020\u007f]/.test(token)) {
    fail("INVALID_REF", `${label} 无效`, { label });
  }
  return token;
}

function validateBranch(value: string | undefined): string | undefined {
  const branch = validateGitToken(value, "分支名");
  if (!branch) return undefined;
  if (branch.includes("..") || branch.includes("@{") || branch.endsWith("/") || branch.endsWith(".")) {
    fail("INVALID_REF", "分支名无效", { branch });
  }
  return branch;
}

async function repositoryRoot(input: string): Promise<string> {
  try {
    return await gitRoot(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorktreeError("NOT_GIT_REPOSITORY", "指定路径不是可用的 Git 工作区", { input, cause: message });
  }
}

async function pathExists(input: string): Promise<boolean> {
  try {
    await fs.access(input);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(input: string): Promise<boolean> {
  try {
    return (await fs.stat(input)).isDirectory();
  } catch {
    return false;
  }
}

function parseWorktreeRecords(repositoryRoot: string, output: string): Array<Omit<WorktreeRecord, "exists" | "status">> {
  const records: Array<Omit<WorktreeRecord, "exists" | "status">> = [];
  const blocks = output.split(/\r?\n\r?\n/).map((item) => item.trim()).filter(Boolean);
  for (const [index, block] of blocks.entries()) {
    const lines = block.split(/\r?\n/);
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    if (!worktreeLine) continue;
    const worktreePath = path.resolve(worktreeLine.slice("worktree ".length));
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length).trim() || "";
    const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length).trim();
    const lockedLine = lines.find((line) => line.startsWith("locked"));
    const prunableLine = lines.find((line) => line.startsWith("prunable"));
    const detached = lines.some((line) => line === "detached");
    records.push({
      path: worktreePath,
      repositoryRoot,
      head,
      branch: branchRef?.replace(/^refs\/heads\//, ""),
      branchRef,
      detached,
      locked: Boolean(lockedLine),
      lockReason: lockedLine ? lockedLine.slice("locked".length).trim() || undefined : undefined,
      prunable: Boolean(prunableLine),
      pruneReason: prunableLine ? prunableLine.slice("prunable".length).trim() || undefined : undefined,
      isPrimary: index === 0
    });
  }
  return records;
}

function recordStatus(record: Omit<WorktreeRecord, "exists" | "status">, exists: boolean): WorktreeRecordStatus {
  if (record.locked) return "locked";
  if (record.prunable) return "prunable";
  if (!exists) return "missing";
  if (record.detached) return "detached";
  return "ready";
}

async function materializeRecords(repositoryRootValue: string, output: string): Promise<WorktreeRecord[]> {
  const parsed = parseWorktreeRecords(repositoryRootValue, output);
  return Promise.all(parsed.map(async (record) => {
    const exists = await isDirectory(record.path);
    return { ...record, exists, status: recordStatus(record, exists) };
  }));
}

async function readWorktreeRecords(repositoryRootValue: string): Promise<WorktreeRecord[]> {
  const output = await runGit(repositoryRootValue, ["worktree", "list", "--porcelain"]);
  return materializeRecords(repositoryRootValue, output);
}

async function canonicalExistingPath(value: string): Promise<string> {
  try {
    // macOS commonly exposes /var as a symlink to /private/var. Git reports
    // the real path while user input often contains the symlinked spelling.
    return comparablePath(await fs.realpath(value));
  } catch {
    return comparablePath(value);
  }
}

async function findRecord(records: WorktreeRecord[], requestedPath: string): Promise<WorktreeRecord | undefined> {
  const target = await canonicalExistingPath(requestedPath);
  for (const record of records) {
    if (target === await canonicalExistingPath(record.path)) return record;
  }
  return undefined;
}

/** List primary and linked worktrees, including stale/locked records. */
export async function listWorktrees(workspaceRoot: string): Promise<WorktreeListResult> {
  const root = await repositoryRoot(workspaceRoot);
  return { status: "listed", repositoryRoot: root, worktrees: await readWorktreeRecords(root), refreshedAt: new Date().toISOString() };
}

/** Create a linked worktree with shell-safe Git arguments. */
export async function createWorktree(options: CreateWorktreeOptions): Promise<WorktreeOperationResult> {
  const root = await repositoryRoot(options.workspaceRoot);
  const worktreePath = normalizeWorktreePath(root, options.worktreePath);
  const branch = validateBranch(options.branch);
  const ref = validateGitToken(options.ref, "起始引用");
  if (branch && options.detach) fail("INVALID_REF", "分支 Worktree 不能同时使用 detached 模式");
  const records = await readWorktreeRecords(root);
  const existing = await findRecord(records, worktreePath);
  if (existing) return { status: "already_exists", repositoryRoot: root, worktree: existing, path: existing.path };
  if (await pathExists(worktreePath)) {
    fail("PATH_OCCUPIED", "目标路径已存在且不是由当前 Git 工作区管理", { path: worktreePath });
  }
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  const args = ["worktree", "add"];
  if (options.force) args.push("--force");
  if (branch) args.push("-b", branch);
  if (options.detach) args.push("--detach");
  args.push(worktreePath);
  if (ref) args.push(ref);
  try {
    await runGit(root, args, 60_000);
  } catch (error) {
    throw new WorktreeError("CREATE_FAILED", error instanceof Error ? error.message : String(error), { path: worktreePath });
  }
  const created = await findRecord(await readWorktreeRecords(root), worktreePath);
  if (!created) fail("PATH_OCCUPIED", "Git 未返回新建的 Worktree 记录", { path: worktreePath });
  return { status: "created", repositoryRoot: root, worktree: created, path: created.path };
}

/** Validate and bind an existing Git worktree to a task. */
export async function bindWorktree(workspaceRoot: string, worktreePath: string): Promise<WorktreeOperationResult> {
  const root = await repositoryRoot(workspaceRoot);
  const candidate = normalizeWorktreePath(root, worktreePath);
  const record = await findRecord(await readWorktreeRecords(root), candidate);
  if (!record) fail("WORKTREE_NOT_FOUND", "目标路径不是当前 Git 工作区登记的 Worktree", { path: candidate });
  return { status: "bound", repositoryRoot: root, worktree: record, path: record.path };
}

/** Repair Git administrative metadata after a worktree was moved or restored. */
export async function restoreWorktree(workspaceRoot: string, worktreePath: string): Promise<WorktreeOperationResult> {
  const root = await repositoryRoot(workspaceRoot);
  const candidate = normalizeWorktreePath(root, worktreePath);
  try {
    await runGit(root, ["worktree", "repair", candidate], 30_000);
  } catch (error) {
    throw new WorktreeError("RESTORE_FAILED", error instanceof Error ? error.message : String(error), { path: candidate });
  }
  const record = await findRecord(await readWorktreeRecords(root), candidate);
  if (!record) fail("RESTORE_FAILED", "修复后未找到 Worktree 记录", { path: candidate });
  return { status: "restored", repositoryRoot: root, worktree: record, path: record.path };
}

/**
 * Check mergeability without touching the index or working tree. This uses
 * merge-tree, so a conflict report is deterministic and safe to show before
 * a workflow asks Git to perform the real merge.
 */
export async function preflightMerge(options: MergePreflightOptions): Promise<MergePreflightResult> {
  const repository = await repositoryRoot(options.workspaceRoot);
  const executionRoot = options.worktreePath ? await repositoryRoot(options.worktreePath) : repository;
  const source = validateGitToken(options.source, "源引用")!;
  const target = validateGitToken(options.target, "目标引用") || (await runGit(executionRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "HEAD")).trim() || "HEAD";
  const sourceCommit = (await runGit(executionRoot, ["rev-parse", "--verify", `${source}^{commit}`])).trim();
  const targetCommit = (await runGit(executionRoot, ["rev-parse", "--verify", `${target}^{commit}`])).trim();
  const statusOutput = await runGit(executionRoot, ["status", "--porcelain=v1"]);
  const dirtyFiles = statusOutput.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim());
  const targetDirty = dirtyFiles.length > 0;
  const changedOutput = await runGit(executionRoot, ["diff", "--name-only", "--no-renames", `${target}...${source}`]);
  const changedFiles = changedOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let alreadyUpToDate = false;
  try {
    await runGit(executionRoot, ["merge-base", "--is-ancestor", source, target]);
    alreadyUpToDate = true;
  } catch {
    // Exit code 1 means the source is not an ancestor. References were already
    // verified above, so this does not hide an invalid ref error.
  }
  if (targetDirty && !options.allowDirty) {
    return { status: "blocked", repositoryRoot: repository, source, target, sourceCommit, targetCommit, changedFiles, conflicts: [], targetDirty, dirtyFiles, reason: "target_dirty", message: "目标 Worktree 存在未提交修改" };
  }
  if (alreadyUpToDate) {
    return { status: "already_up_to_date", repositoryRoot: repository, source, target, sourceCommit, targetCommit, changedFiles, conflicts: [], targetDirty, dirtyFiles };
  }
  try {
    await runGit(executionRoot, ["merge-tree", "--write-tree", target, source], 30_000);
    return { status: "ready", repositoryRoot: repository, source, target, sourceCommit, targetCommit, changedFiles, conflicts: [], targetDirty, dirtyFiles };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    // The write-tree form writes conflict diagnostics to stdout, while the
    // shared runGit helper intentionally keeps failed command messages short.
    // The read-only form exposes the conflict paths without touching the
    // index, so use it only after the write-tree preflight reports a conflict.
    const output = await runGit(executionRoot, ["merge-tree", target, source], 30_000).catch(() => failure);
    const conflicts = [...output.matchAll(/Merge conflict in (.+)$/gm)].map((match) => match[1].trim());
    return { status: "conflicts", repositoryRoot: repository, source, target, sourceCommit, targetCommit, changedFiles, conflicts, targetDirty, dirtyFiles, reason: "merge_conflict", message: output || failure };
  }
}

/** Remove a linked worktree, refusing dirty or locked trees unless forced. */
export async function cleanupWorktree(workspaceRoot: string, worktreePath: string, force = false): Promise<WorktreeOperationResult> {
  const root = await repositoryRoot(workspaceRoot);
  const candidate = normalizeWorktreePath(root, worktreePath);
  const record = await findRecord(await readWorktreeRecords(root), candidate);
  if (!record) {
    if (!(await pathExists(candidate))) return { status: "already_absent", repositoryRoot: root, path: candidate };
    fail("WORKTREE_NOT_FOUND", "拒绝删除未由当前 Git 工作区登记的路径", { path: candidate });
  }
  if (record.isPrimary) fail("PRIMARY_WORKTREE", "不能删除主工作区", { path: candidate });
  if (record.locked && !force) return { status: "blocked", repositoryRoot: root, worktree: record, path: candidate, reason: "locked", message: record.lockReason || "Worktree 已锁定" };
  if (!record.exists) {
    if (!force) return { status: "blocked", repositoryRoot: root, worktree: record, path: candidate, reason: "path_occupied", message: "Worktree 目录已缺失，请确认后强制清理 Git 登记" };
    try {
      await runGit(root, ["worktree", "prune", "--expire", "now"], 30_000);
    } catch (error) {
      throw new WorktreeError("CLEANUP_FAILED", error instanceof Error ? error.message : String(error), { path: candidate });
    }
    const remainingAfterPrune = await findRecord(await readWorktreeRecords(root), candidate);
    if (remainingAfterPrune) fail("CLEANUP_FAILED", "清理缺失 Worktree 后仍保留 Git 登记", { path: candidate });
    return { status: "removed", repositoryRoot: root, path: candidate };
  }
  const dirtyFiles = record.exists ? (await runGit(candidate, ["status", "--porcelain=v1"]).catch(() => "")).split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()) : [];
  if (dirtyFiles.length && !force) return { status: "blocked", repositoryRoot: root, worktree: record, path: candidate, reason: "dirty", dirtyFiles, message: "Worktree 存在未提交修改" };
  try {
    await runGit(root, ["worktree", "remove", ...(force ? ["--force"] : []), candidate], 60_000);
  } catch (error) {
    throw new WorktreeError("CLEANUP_FAILED", error instanceof Error ? error.message : String(error), { path: candidate });
  }
  const remaining = await findRecord(await readWorktreeRecords(root), candidate);
  if (remaining) fail("CLEANUP_FAILED", "Git 删除后仍保留 Worktree 记录", { path: candidate });
  return { status: "removed", repositoryRoot: root, path: candidate };
}
