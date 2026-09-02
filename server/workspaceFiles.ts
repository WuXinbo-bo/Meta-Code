import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { assertPathInsideRoot } from "./pathBoundary.js";

type MoveRecord = { from: string; to: string };
export type WorkspaceFileSearchResult = { name: string; path: string; type: "file"; size: number; modifiedAt: string };

const MOVE_RETRY_DELAYS_MS = [120, 320, 800];
const SEARCH_IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".runtime", "dist", "build"]);
export const DEFAULT_WORKSPACE_SEARCH_VISIT_BUDGET = 30_000;

function pathKey(value: string) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function relativeDisplay(root: string, value: string) {
  return path.relative(root, value).replace(/\\/g, "/");
}

function resolveWorkspaceEntry(root: string, relativePath: string, allowRoot = false) {
  const workspaceRoot = path.resolve(root);
  const target = path.resolve(workspaceRoot, String(relativePath || "."));
  return assertPathInsideRoot(workspaceRoot, target, { allowRoot });
}

function containsPath(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function collapseNestedSources(sources: string[]) {
  const sorted = [...sources].sort((a, b) => a.length - b.length);
  return sorted.filter((source, index) => !sorted.slice(0, index).some((parent) => containsPath(parent, source)));
}

function isTransientMoveError(error: unknown) {
  return ["EPERM", "EBUSY", "EACCES"].includes(String((error as NodeJS.ErrnoException)?.code || ""));
}

export async function searchWorkspaceFiles(root: string, input: string, options: { limit?: number; visitBudget?: number; maxDepth?: number } = {}) {
  const workspaceRoot = path.resolve(root);
  const query = input.trim().toLocaleLowerCase();
  if (!query) return { results: [] as WorkspaceFileSearchResult[], truncated: false };
  const limit = Math.min(500, Math.max(1, options.limit || 120));
  const visitBudget = Math.min(50_000, Math.max(limit, options.visitBudget || DEFAULT_WORKSPACE_SEARCH_VISIT_BUDGET));
  const maxDepth = Math.min(64, Math.max(1, options.maxDepth || 32));
  const directories: Array<{ absolute: string; depth: number }> = [{ absolute: workspaceRoot, depth: 0 }];
  const results: WorkspaceFileSearchResult[] = [];
  let visited = 0;
  let truncated = false;

  while (directories.length && visited < visitBudget && results.length <= limit) {
    const current = directories.shift()!;
    let entries: import("node:fs").Dirent[];
    try { entries = await fsp.readdir(current.absolute, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (visited++ >= visitBudget) { truncated = true; break; }
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth && !SEARCH_IGNORED_DIRECTORIES.has(entry.name)) directories.push({ absolute, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = relativeDisplay(workspaceRoot, absolute);
      if (!entry.name.toLocaleLowerCase().includes(query) && !relative.toLocaleLowerCase().includes(query)) continue;
      try {
        const stat = await fsp.stat(absolute);
        results.push({ name: entry.name, path: relative, type: "file", size: stat.size, modifiedAt: stat.mtime.toISOString() });
      } catch { /* The file may disappear while the workspace is being updated. */ }
      if (results.length > limit) { truncated = true; break; }
    }
  }
  if (directories.length || visited >= visitBudget) truncated = true;
  results.sort((left, right) => {
    const leftName = left.name.toLocaleLowerCase();
    const rightName = right.name.toLocaleLowerCase();
    return Number(!leftName.startsWith(query)) - Number(!rightName.startsWith(query))
      || left.path.length - right.path.length
      || left.path.localeCompare(right.path);
  });
  return { results: results.slice(0, limit), truncated };
}

async function renameWithRetry(source: string, destination: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(source, destination);
      return;
    } catch (error) {
      if (!isTransientMoveError(error) || attempt >= MOVE_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, MOVE_RETRY_DELAYS_MS[attempt]));
    }
  }
}

export async function moveWorkspaceEntries(root: string, relativePaths: string[], targetDirectory = "") {
  const workspaceRoot = path.resolve(root);
  const target = resolveWorkspaceEntry(workspaceRoot, targetDirectory, true);
  const targetStat = await fsp.lstat(target);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error("移动目标必须是工作区内的真实文件夹");

  const uniqueSources = [...new Map(relativePaths.map((value) => {
    const source = resolveWorkspaceEntry(workspaceRoot, String(value || ""));
    return [pathKey(source), source] as const;
  })).values()];
  if (!uniqueSources.length) throw new Error("请选择要移动的文件或文件夹");
  const sources = collapseNestedSources(uniqueSources);
  const planned: Array<{ source: string; destination: string }> = [];
  const destinationKeys = new Set<string>();

  for (const source of sources) {
    const stat = await fsp.lstat(source);
    if (stat.isSymbolicLink()) throw new Error(`不能移动符号链接：${relativeDisplay(workspaceRoot, source)}`);
    if (stat.isDirectory() && (pathKey(source) === pathKey(target) || containsPath(source, target))) {
      throw new Error(`不能把文件夹移动到自身或其子目录：${relativeDisplay(workspaceRoot, source)}`);
    }
    const destination = path.join(target, path.basename(source));
    if (pathKey(source) === pathKey(destination)) continue;
    const destinationKey = pathKey(destination);
    if (destinationKeys.has(destinationKey)) throw new Error(`多个项目会产生同名目标：${path.basename(source)}`);
    destinationKeys.add(destinationKey);
    if (fs.existsSync(destination)) throw new Error(`目标位置已存在同名项目：${relativeDisplay(workspaceRoot, destination)}`);
    planned.push({ source, destination });
  }

  const completed: Array<{ source: string; destination: string }> = [];
  try {
    for (const item of planned) {
      await renameWithRetry(item.source, item.destination);
      completed.push(item);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const item of completed.reverse()) {
      try { await renameWithRetry(item.destination, item.source); }
      catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); }
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackErrors.length ? `${message}；部分回滚失败：${rollbackErrors.join("；")}` : message);
  }

  const moved: MoveRecord[] = planned.map((item) => ({
    from: relativeDisplay(workspaceRoot, item.source),
    to: relativeDisplay(workspaceRoot, item.destination)
  }));
  return { moved, skipped: sources.length - planned.length };
}

export async function deleteWorkspaceEntries(root: string, relativePaths: string[]) {
  const workspaceRoot = path.resolve(root);
  const uniqueSources = [...new Map(relativePaths.map((value) => {
    const source = resolveWorkspaceEntry(workspaceRoot, String(value || ""));
    return [pathKey(source), source] as const;
  })).values()];
  if (!uniqueSources.length) throw new Error("请选择要删除的文件或文件夹");
  const sources = collapseNestedSources(uniqueSources);

  for (const source of sources) {
    const stat = await fsp.lstat(source);
    if (stat.isSymbolicLink()) throw new Error(`不能通过工作台删除符号链接：${relativeDisplay(workspaceRoot, source)}`);
  }

  const deleted: string[] = [];
  try {
    for (const source of sources) {
      await fsp.rm(source, { recursive: true, force: false, maxRetries: 3, retryDelay: 200 });
      deleted.push(relativeDisplay(workspaceRoot, source));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(deleted.length ? `${message}；已有 ${deleted.length} 个项目被删除` : message);
  }
  return { deleted, skipped: uniqueSources.length - sources.length };
}
