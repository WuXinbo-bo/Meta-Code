import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gitRoot, runGit } from "../../git/service.js";
import { bindWorktree, cleanupWorktree, createWorktree, preflightMerge } from "../../git/worktreeManager.js";

export type WorkflowExecutionTarget = "workspace" | "isolated" | "worktree";
export type PreparedWorkflowTarget = {
  executionTarget: WorkflowExecutionTarget;
  executionRoot: string;
  workspaceRoot: string;
  worktreeId: string | null;
  workDirectory: string;
};
export type WorkflowWorktreeBinding = {
  schemaVersion: 1;
  id: string;
  runId: string;
  ownerUserId: string;
  workspaceId: string;
  workspaceRoot: string;
  repositoryRoot: string;
  worktreeRoot: string;
  executionRoot: string;
  branch: string | null;
  baseCommit: string;
  createdByPlugin: boolean;
  revision: number;
  createdAt: string;
  integratedAt: string | null;
  integratedCommit: string | null;
  integratedSourceDigest?: string;
};
export type WorkflowWorktreeComparison = {
  binding: WorkflowWorktreeBinding;
  previewDigest: string;
  sourceHead: string;
  sourceDigest: string;
  targetHead: string;
  sourceDirty: boolean;
  targetDirty: boolean;
  changedFiles: string[];
  untrackedFiles: string[];
  committedDiff: string;
  workingDiff: string;
  status: "ready" | "already_up_to_date" | "conflicts" | "blocked";
  message?: string;
  conflicts: string[];
};
export type PrepareWorkflowTargetInput = {
  runId: string;
  ownerUserId: string;
  workspaceId: string;
  workspaceRoot: string;
  executionTarget?: WorkflowExecutionTarget;
  executionRoot?: string;
  worktreeRef?: string;
  worktreeBranch?: string;
};

const execFileAsync = promisify(execFile);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/;
const SHA = /^[0-9a-f]{40,64}$/i;
function safeId(id: string) { if (!ID.test(id)) throw new Error("任务运行 ID 无效"); return id; }
function samePath(left: string, right: string) { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
function contained(root: string, candidate: string) { const relative = path.relative(root, candidate); return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); }
function digest(input: unknown) { return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
async function fileDigest(file: string) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export class WorkflowTargetService {
  private readonly runtimeDirectory: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly prepared = new Map<string, { ownerUserId: string; target: PreparedWorkflowTarget; created: boolean; worktreeRoot?: string }>();
  constructor(runtimeDirectory: string) { this.runtimeDirectory = path.resolve(runtimeDirectory); }
  async preferredBranchTarget(workspaceRoot: string): Promise<"worktree" | "isolated"> {
    try { await gitRoot(workspaceRoot); return "worktree"; } catch { return "isolated"; }
  }
  private bindingFile(id: string) { return path.join(this.runtimeDirectory, "worktree-bindings", `${safeId(id)}.json`); }
  private async writeBinding(binding: WorkflowWorktreeBinding) {
    const file = this.bindingFile(binding.id);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, { flag: "wx", mode: 0o600 }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async get(id: string, ownerUserId: string): Promise<WorkflowWorktreeBinding | null> {
    let value: WorkflowWorktreeBinding;
    try { value = JSON.parse(await fs.readFile(this.bindingFile(id), "utf8")) as WorkflowWorktreeBinding; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (value.schemaVersion !== 1 || value.id !== id || !SHA.test(value.baseCommit)) throw new Error("Worktree 任务绑定格式无效");
    return value.ownerUserId === ownerUserId ? value : null;
  }
  async prepare(input: PrepareWorkflowTargetInput): Promise<PreparedWorkflowTarget> {
    safeId(input.runId);
    const workspaceRoot = await fs.realpath(input.workspaceRoot);
    if (!(await fs.stat(workspaceRoot)).isDirectory()) throw new Error("工作区目录不可用");
    const executionTarget = input.executionTarget || "workspace";
    if (!["workspace", "isolated", "worktree"].includes(executionTarget)) throw new Error("执行目标无效");
    if (executionTarget === "workspace") {
      if (input.executionRoot && !samePath(await fs.realpath(input.executionRoot), workspaceRoot)) throw new Error("当前工作区模式不能指定其他执行目录");
      return { executionTarget, workspaceRoot, executionRoot: workspaceRoot, workDirectory: workspaceRoot, worktreeId: null };
    }
    await fs.mkdir(path.join(this.runtimeDirectory, "targets"), { recursive: true, mode: 0o700 });
    const runtimeDirectory = await fs.realpath(path.join(this.runtimeDirectory, "targets"));
    const managedRoot = path.join(runtimeDirectory, input.runId);
    if (contained(workspaceRoot, managedRoot)) throw new Error("编排隔离目录必须位于项目工作区之外");
    if (executionTarget === "isolated") {
      if (input.executionRoot && !samePath(path.resolve(input.executionRoot), managedRoot)) throw new Error("隔离任务目录只能由编排插件管理");
      await fs.mkdir(managedRoot, { mode: 0o700 });
      const target = { executionTarget, workspaceRoot, executionRoot: managedRoot, workDirectory: managedRoot, worktreeId: null };
      this.prepared.set(input.runId, { ownerUserId: input.ownerUserId, target, created: true });
      return target;
    }
    const repositoryRoot = await gitRoot(workspaceRoot);
    const root = input.executionRoot ? await fs.realpath(input.executionRoot) : managedRoot;
    if (contained(repositoryRoot, root)) throw new Error("方案 Worktree 必须位于原项目之外");
    const existing = await this.get(input.runId, input.ownerUserId);
    if (existing || await fs.access(this.bindingFile(input.runId)).then(() => true, () => false)) throw new Error("该任务已经绑定 Worktree");
    const result = input.executionRoot
      ? await bindWorktree(repositoryRoot, root)
      : await createWorktree({ workspaceRoot: repositoryRoot, worktreePath: root, branch: input.worktreeBranch || `metacode/${input.runId}`, ref: input.worktreeRef });
    if (!result.worktree || result.worktree.isPrimary || result.worktree.locked || result.worktree.status === "missing") throw new Error("Worktree 无法绑定为编排方案");
    const worktreeRoot = await fs.realpath(result.worktree.path);
    const scope = path.relative(repositoryRoot, workspaceRoot);
    let executionRoot: string;
    try {
      executionRoot = await fs.realpath(path.join(worktreeRoot, scope));
      if (!contained(worktreeRoot, executionRoot)) throw new Error("工作区在方案 Worktree 中不存在或越界");
    } catch (error) {
      if (result.status === "created") await cleanupWorktree(repositoryRoot, worktreeRoot);
      throw error;
    }
    const target = { executionTarget, workspaceRoot, executionRoot, workDirectory: executionRoot, worktreeId: input.runId };
    this.prepared.set(input.runId, { ownerUserId: input.ownerUserId, target, created: result.status === "created", worktreeRoot });
    try {
      await this.writeBinding({
        schemaVersion: 1, id: input.runId, runId: input.runId, ownerUserId: input.ownerUserId, workspaceId: input.workspaceId,
        workspaceRoot, repositoryRoot, worktreeRoot, executionRoot, branch: result.worktree.branch || null, baseCommit: result.worktree.head,
        createdByPlugin: result.status === "created", revision: 1, createdAt: new Date().toISOString(), integratedAt: null, integratedCommit: null
      });
    } catch (error) { await this.rollbackPrepared(input.runId, input.ownerUserId); throw error; }
    return target;
  }
  confirmPrepared(runId: string, ownerUserId: string) {
    const prepared = this.prepared.get(runId);
    if (prepared?.ownerUserId === ownerUserId) this.prepared.delete(runId);
  }
  async rollbackPrepared(runId: string, ownerUserId: string) {
    const prepared = this.prepared.get(runId);
    if (!prepared || prepared.ownerUserId !== ownerUserId) return;
    if (prepared.created) {
      if (prepared.target.executionTarget === "worktree") {
        const cleanup = await cleanupWorktree(prepared.target.workspaceRoot, prepared.worktreeRoot || prepared.target.executionRoot);
        if (cleanup.status === "blocked") throw new Error("创建失败的 Worktree 已产生修改，已保留目录供恢复");
      } else {
        const entries = await fs.readdir(prepared.target.executionRoot);
        if (entries.length) throw new Error("创建失败的隔离目录已有内容，已保留目录供恢复");
        await fs.rmdir(prepared.target.executionRoot);
      }
    }
    await fs.rm(this.bindingFile(runId), { force: true });
    this.prepared.delete(runId);
  }
  private async requireBinding(id: string, ownerUserId: string) {
    const binding = await this.get(id, ownerUserId);
    if (!binding) throw new Error("任务没有可用的 Worktree 绑定");
    const record = await bindWorktree(binding.repositoryRoot, binding.worktreeRoot);
    if (!record.worktree || record.worktree.isPrimary || record.worktree.locked || !samePath(await fs.realpath(binding.workspaceRoot), binding.workspaceRoot)) throw new Error("Worktree 绑定已失效或被锁定");
    return binding;
  }
  private async sourceState(binding: WorkflowWorktreeBinding) {
    const root = binding.worktreeRoot;
    const sourceHead = (await runGit(root, ["rev-parse", "HEAD"])).trim();
    const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const workingDiff = await runGit(root, ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv"]);
    const untrackedFiles = (await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const untracked = [];
    for (const file of untrackedFiles) {
      const absolute = path.resolve(root, file);
      if (!contained(root, absolute)) throw new Error("Worktree 出现越界文件");
      const stat = await fs.lstat(absolute);
      const hash = stat.isSymbolicLink() ? digest(await fs.readlink(absolute)) : await fileDigest(absolute);
      untracked.push({ path: file, hash });
    }
    return { sourceHead, status, workingDiff, untrackedFiles, digest: digest({ sourceHead, status, workingDiff, untracked }) };
  }
  async compare(id: string, ownerUserId: string): Promise<WorkflowWorktreeComparison> {
    const binding = await this.requireBinding(id, ownerUserId);
    const source = await this.sourceState(binding);
    const targetHead = (await runGit(binding.repositoryRoot, ["rev-parse", "HEAD"])).trim();
    const targetStatus = await runGit(binding.repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const mergeBase = (await runGit(binding.repositoryRoot, ["merge-base", targetHead, source.sourceHead])).trim();
    const committedDiff = await runGit(binding.worktreeRoot, ["diff", mergeBase, source.sourceHead, "--no-ext-diff", "--no-textconv", "--patch"]);
    const changedFiles = [...new Set([
      ...(await runGit(binding.worktreeRoot, ["diff", mergeBase, source.sourceHead, "--name-only", "-z"])).split("\0"),
      ...(await runGit(binding.worktreeRoot, ["diff", "HEAD", "--name-only", "-z"])).split("\0"), ...source.untrackedFiles
    ].filter(Boolean))];
    const preflight = await preflightMerge({ workspaceRoot: binding.repositoryRoot, source: source.sourceHead, target: targetHead });
    const scope = path.relative(binding.repositoryRoot, binding.workspaceRoot).replaceAll("\\", "/");
    const outsideScope = scope ? changedFiles.some((file) => file !== scope && !file.startsWith(`${scope}/`)) : false;
    const alreadyIntegrated = binding.integratedSourceDigest === source.digest && binding.integratedCommit
      && await runGit(binding.repositoryRoot, ["merge-base", "--is-ancestor", binding.integratedCommit, targetHead]).then(() => true, () => false);
    const status = targetStatus || outsideScope ? "blocked" : alreadyIntegrated ? "already_up_to_date" : preflight.status === "already_up_to_date" && source.status ? "ready" : preflight.status;
    return {
      binding, sourceHead: source.sourceHead, sourceDigest: source.digest, targetHead, previewDigest: digest({ id, revision: binding.revision, source: source.digest, targetHead, targetStatus }),
      sourceDirty: Boolean(source.status), targetDirty: Boolean(targetStatus), changedFiles, untrackedFiles: source.untrackedFiles,
      committedDiff, workingDiff: source.workingDiff, status, conflicts: preflight.conflicts,
      ...(outsideScope ? { message: "方案修改超出了所选工作区目录，不能直接整合" } : targetStatus ? { message: "原工作区有未提交修改，请先处理后再整合方案" } : preflight.message ? { message: preflight.message } : {})
    };
  }
  private async snapshot(binding: WorkflowWorktreeBinding, sourceHead: string) {
    // Build an immutable commit through a temporary index; the source worktree
    // keeps its user's staging state, branch and uncommitted files intact.
    const temporaryIndex = path.join(this.runtimeDirectory, `snapshot-${crypto.randomUUID()}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    const git = async (args: string[]) => String((await execFileAsync("git", ["-C", binding.worktreeRoot, ...args], { encoding: "utf8", env, windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout).trim();
    try {
      // The source index also identifies deliberately tracked ignored files
      // (git add -f). Seeding from HEAD silently drops those new deliverables.
      // Copy it rather than writing to the user's index, then materialize any
      // split-index entries before updating our standalone temporary index.
      const sourceIndexPath = (await runGit(binding.worktreeRoot, ["rev-parse", "--git-path", "index"])).trim();
      try { await fs.copyFile(path.resolve(binding.worktreeRoot, sourceIndexPath), temporaryIndex); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") await git(["read-tree", sourceHead]); else throw error; }
      if (await git(["ls-files", "--unmerged", "-z"])) throw new Error("方案暂存区存在未解决的合并冲突，请先处理后再整合");
      await git(["update-index", "--no-split-index"]);
      const scope = path.relative(binding.repositoryRoot, binding.workspaceRoot).replaceAll("\\", "/") || ".";
      // An out-of-scope staged version can differ from HEAD even when the
      // working file has been restored. It must not enter a scoped snapshot.
      if (scope !== ".") await git(["reset", "--quiet", sourceHead, "--", ".", `:(exclude,literal)${scope}`]);
      await git(["add", "-A", "--", scope]);
      const tree = await git(["write-tree"]);
      return await git(["-c", "user.name=Meta Code", "-c", "user.email=metacode@localhost", "commit-tree", tree, "-p", sourceHead, "-m", `Integrate Meta Code task ${binding.runId}`]);
    } finally { await fs.rm(temporaryIndex, { force: true }); await fs.rm(`${temporaryIndex}.lock`, { force: true }); }
  }
  async integrate(id: string, ownerUserId: string, input: { expectedRevision: number; previewDigest: string; snapshotChanges?: boolean }) {
    const binding = await this.requireBinding(id, ownerUserId);
    const lockKey = binding.repositoryRoot;
    if (this.locks.has(lockKey)) throw new Error("当前工作区正在整合另一个方案");
    const operation = this.integrateUnlocked(id, ownerUserId, input);
    this.locks.set(lockKey, operation);
    try { return await operation; } finally { if (this.locks.get(lockKey) === operation) this.locks.delete(lockKey); }
  }
  private async integrateUnlocked(id: string, ownerUserId: string, input: { expectedRevision: number; previewDigest: string; snapshotChanges?: boolean }) {
    const preview = await this.compare(id, ownerUserId);
    if (preview.binding.revision !== input.expectedRevision || preview.previewDigest !== input.previewDigest) throw new Error("方案或工作区已变化，请刷新对比后重新确认");
    if (preview.status === "blocked" || preview.status === "conflicts") throw new Error(preview.message || "方案存在冲突，无法直接整合");
    if (preview.status === "already_up_to_date") return { status: "already_up_to_date", binding: preview.binding, sourceCommit: preview.binding.integratedCommit || preview.sourceHead, integratedCommit: preview.targetHead, changedFiles: [] };
    if (preview.sourceDirty && input.snapshotChanges !== true) throw new Error("方案存在未提交修改，请确认将这些修改一并整合");
    const sourceCommit = preview.sourceDirty ? await this.snapshot(preview.binding, preview.sourceHead) : preview.sourceHead;
    const rechecked = await this.compare(id, ownerUserId);
    if (rechecked.previewDigest !== preview.previewDigest) throw new Error("生成整合快照期间文件已变化，请重新确认");
    const preflight = await preflightMerge({ workspaceRoot: preview.binding.repositoryRoot, source: sourceCommit, target: preview.targetHead });
    if (!["ready", "already_up_to_date"].includes(preflight.status)) throw new Error(preflight.message || "方案与当前项目存在文件冲突");
    if ((await runGit(preview.binding.repositoryRoot, ["rev-parse", "HEAD"])).trim() !== preview.targetHead || (await runGit(preview.binding.repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))) throw new Error("原工作区已变化，整合已停止");
    if (preflight.status !== "already_up_to_date") await runGit(preview.binding.repositoryRoot, ["-c", "user.name=Meta Code", "-c", "user.email=metacode@localhost", "-c", "core.hooksPath=", "merge", "--no-edit", "--no-verify", "--no-gpg-sign", "--no-overwrite-ignore", sourceCommit], 60_000);
    const integratedCommit = (await runGit(preview.binding.repositoryRoot, ["rev-parse", "HEAD"])).trim();
    const updated = { ...preview.binding, revision: preview.binding.revision + 1, integratedAt: new Date().toISOString(), integratedCommit, integratedSourceDigest: preview.sourceDigest };
    await this.writeBinding(updated);
    return { status: preflight.status === "already_up_to_date" ? "already_up_to_date" : "integrated", binding: updated, sourceCommit, integratedCommit, changedFiles: preview.changedFiles };
  }
}
