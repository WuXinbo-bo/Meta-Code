import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { GitBranch, GitCommit, GitFileStatus, GitRemote, GitSnapshot } from "./types.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 15_000;
const MAX_OUTPUT = 8 * 1024 * 1024;

async function runGit(root: string, args: string[], timeout = GIT_TIMEOUT) {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8", timeout, windowsHide: true, maxBuffer: MAX_OUTPUT });
    return String(result.stdout || "");
  } catch (error) {
    const cause = error as NodeJS.ErrnoException & { stderr?: string; code?: string | number };
    const detail = String(cause.stderr || cause.message || error).trim();
    throw new Error(detail || "Git 命令执行失败");
  }
}

function safePathspecs(paths: string[]) {
  const normalized = [...new Set(paths.map((item) => String(item || "").replace(/\\/g, "/").trim()).filter(Boolean))];
  if (!normalized.length) throw new Error("请选择至少一个文件");
  for (const item of normalized) if (item.startsWith("/") || /^[A-Za-z]:\//.test(item) || item === ".." || item.startsWith("../") || item.includes("\0")) throw new Error("文件路径不在当前 Git 工作区内");
  return normalized;
}

export async function gitRoot(input: string) {
  const root = path.resolve(input);
  const result = (await runGit(root, ["rev-parse", "--show-toplevel"], 5_000)).trim();
  return path.resolve(result);
}

function parseNumstat(root: string, staged: boolean) {
  return runGit(root, ["diff", ...(staged ? ["--cached"] : []), "--numstat", "--no-renames"]).then((output) => {
    const map = new Map<string, { additions: number | null; deletions: number | null }>();
    for (const line of output.split(/\r?\n/)) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      map.set(parts.slice(2).join("\t"), { additions: /^\d+$/.test(parts[0]) ? Number(parts[0]) : null, deletions: /^\d+$/.test(parts[1]) ? Number(parts[1]) : null });
    }
    return map;
  });
}

function parseStatus(root: string, output: string, stagedStats: Map<string, { additions: number | null; deletions: number | null }>, unstagedStats: Map<string, { additions: number | null; deletions: number | null }>) {
  const files: GitFileStatus[] = [];
  const records = output.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith("# branch.head ")) continue;
    if (record.startsWith("# branch.upstream ") || record.startsWith("# branch.ab ")) continue;
    if (!record.startsWith("1 ") && !record.startsWith("2 ") && !record.startsWith("u ") && !record.startsWith("? ") && !record.startsWith("! ")) continue;
    if (record.startsWith("? ")) { const relative = record.slice(2); files.push({ path: relative, status: "untracked", staged: false, unstaged: true, additions: null, deletions: null }); continue; }
    if (record.startsWith("! ")) { files.push({ path: record.slice(2), status: "ignored", staged: false, unstaged: false, additions: null, deletions: null }); continue; }
    const kind = record[0];
    const fields = record.slice(2).split(" ");
    const xy = fields[0] || "..";
    const pathValue = fields.slice(kind === "2" ? 8 : 7).join(" ");
    const originalPath = kind === "2" ? records[++index] || undefined : undefined;
    const conflicted = kind === "u";
    const staged = conflicted || xy[0] !== ".";
    const unstaged = conflicted || xy[1] !== ".";
    const code = conflicted ? "conflicted" : xy.includes("R") ? "renamed" : xy.includes("C") ? "copied" : xy.includes("A") ? "added" : xy.includes("D") ? "deleted" : "modified";
    files.push({ path: pathValue, originalPath, status: code, staged, unstaged, additions: stagedStats.get(pathValue)?.additions ?? unstagedStats.get(pathValue)?.additions ?? null, deletions: stagedStats.get(pathValue)?.deletions ?? unstagedStats.get(pathValue)?.deletions ?? null });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readGitSnapshot(workspaceRoot: string): Promise<GitSnapshot> {
  const root = await gitRoot(workspaceRoot);
  const [statusOutput, stagedStats, unstagedStats] = await Promise.all([
    runGit(root, ["status", "--porcelain=v2", "--branch", "-z"]),
    parseNumstat(root, true),
    parseNumstat(root, false)
  ]);
  const branch = statusOutput.split("\0").find((item) => item.startsWith("# branch.head "))?.slice("# branch.head ".length) || "HEAD";
  const upstream = statusOutput.split("\0").find((item) => item.startsWith("# branch.upstream "))?.slice("# branch.upstream ".length);
  const counts = statusOutput.split("\0").find((item) => item.startsWith("# branch.ab "))?.match(/\+(\d+) -(\d+)/);
  const head = (await runGit(root, ["rev-parse", "HEAD"])).trim();
  return { isRepository: true, root, branch, head, upstream, ahead: Number(counts?.[1] || 0), behind: Number(counts?.[2] || 0), detached: branch === "(detached)", conflicted: statusOutput.split("\0").some((item) => item.startsWith("u ")), files: parseStatus(root, statusOutput, stagedStats, unstagedStats), refreshedAt: new Date().toISOString() };
}

export async function readBranches(workspaceRoot: string): Promise<GitBranch[]> {
  const root = await gitRoot(workspaceRoot);
  const output = await runGit(root, ["for-each-ref", "--format=%(refname)\t%(HEAD)\t%(objectname)\t%(upstream:short)\t%(upstream:track)\t%(subject)", "refs/heads", "refs/remotes"]);
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [fullName, head, sha, upstream, track, subject] = line.split("\t");
    const remote = fullName.startsWith("refs/remotes/");
    const name = fullName.replace(/^refs\/(heads|remotes)\//, "");
    return { name, fullName, remote, current: head === "*", upstream: upstream || undefined, ahead: Number(track.match(/ahead (\d+)/)?.[1] || 0), behind: Number(track.match(/behind (\d+)/)?.[1] || 0), subject, sha };
  });
}

export async function readRemotes(workspaceRoot: string): Promise<GitRemote[]> {
  const root = await gitRoot(workspaceRoot);
  const output = await runGit(root, ["remote", "-v"]);
  const remotes = new Map<string, GitRemote>();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([^\s]+)\s+(.+?)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, kind] = match;
    const current = remotes.get(name) || { name, fetchUrl: "" };
    if (kind === "fetch") current.fetchUrl = url;
    else current.pushUrl = url;
    remotes.set(name, current);
  }
  return [...remotes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchRemote(workspaceRoot: string, remoteName = "") {
  const root = await gitRoot(workspaceRoot);
  const remotes = await readRemotes(root);
  const name = remoteName.trim() || remotes[0]?.name;
  if (!name || !remotes.some((remote) => remote.name === name)) throw new Error("未找到可用的 Git 远程仓库");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error("远程仓库名称无效");
  await runGit(root, ["fetch", "--prune", "--no-tags", name], 60_000);
}

export async function readCommits(workspaceRoot: string, limit = 200): Promise<GitCommit[]> {
  const root = await gitRoot(workspaceRoot);
  const safeLimit = Math.min(1000, Math.max(1, Math.floor(limit)));
  const output = await runGit(root, ["log", "--all", "--date-order", `-${safeLimit}`, "--pretty=format:%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D%x1e"]);
  return output.split("\x1e").filter(Boolean).map((record) => { const [sha, parents, author, authoredAt, subject, refs] = record.split("\x1f"); return { sha, shortSha: sha.slice(0, 8), parents: parents ? parents.split(" ") : [], author, authoredAt, subject, refs: refs ? refs.split(", ").filter(Boolean) : [] }; });
}

export async function readCommitDiff(workspaceRoot: string, sha: string) {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error("提交哈希格式无效");
  const root = await gitRoot(workspaceRoot);
  return runGit(root, ["show", "--format=fuller", "--find-renames", "--no-ext-diff", "--patch", sha], 30_000);
}

export async function readWorkspaceDiff(workspaceRoot: string, staged = false) {
  const root = await gitRoot(workspaceRoot);
  return runGit(root, ["diff", ...(staged ? ["--cached"] : []), "--find-renames", "--no-ext-diff", "--patch"], 30_000);
}

export async function stageFiles(workspaceRoot: string, paths: string[]) {
  const root = await gitRoot(workspaceRoot);
  await runGit(root, ["add", "--", ...safePathspecs(paths)]);
}

export async function unstageFiles(workspaceRoot: string, paths: string[]) {
  const root = await gitRoot(workspaceRoot);
  await runGit(root, ["restore", "--staged", "--", ...safePathspecs(paths)]);
}

export async function commitFiles(workspaceRoot: string, message: string) {
  const root = await gitRoot(workspaceRoot);
  const subject = message.trim();
  if (!subject) throw new Error("提交说明不能为空");
  if (subject.length > 2000) throw new Error("提交说明过长");
  await runGit(root, ["commit", "-m", subject], 30_000);
}

export async function createBranch(workspaceRoot: string, name: string) {
  const root = await gitRoot(workspaceRoot);
  const branch = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,89}$/.test(branch) || branch.endsWith("/") || branch.includes("..")) throw new Error("分支名称无效");
  await runGit(root, ["switch", "-c", branch], 15_000);
}

export async function checkoutBranch(workspaceRoot: string, name: string) {
  const root = await gitRoot(workspaceRoot);
  const branch = name.trim();
  if (!branch || branch.includes("\0") || branch.startsWith("-") || branch.includes("..")) throw new Error("分支名称无效");
  await runGit(root, ["switch", branch], 15_000);
}
