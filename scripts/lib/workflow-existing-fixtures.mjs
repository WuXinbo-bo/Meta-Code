import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const existingWorkflowProjects = [
  { key: "ledger", folder: "01-ledger-cli", plannerEngine: "codex",
    readScope: ["src/analyze.mjs", "src/cli.mjs", "README.md"],
    goal: "检查现有账单 CSV 工具的公开接口、stdin/file 命令行行为、日期过滤和特殊类别边界。补充至少一个此前测试未覆盖且有价值的回归测试；使用已有 node:test，不新增依赖。保留所有现有功能，真实缺陷如有发现应修复并说明。" },
  { key: "issue", folder: "02-issue-api", plannerEngine: "claude",
    readScope: ["src/router.mjs", "src/store.mjs", "src/validation.mjs", "API.md"],
    goal: "检查现有事项 HTTP API 的错误请求处理、并发持久化与关闭/重建行为，补充至少一个此前测试未覆盖的公共接口回归测试。使用真实 HTTP 和隔离临时数据；保留公共 API，不新增依赖。真实缺陷如有发现应修复并说明。" },
  { key: "research", folder: "03-research-board", plannerEngine: "codex",
    readScope: ["src/domain/index.mjs", "src/storage/index.mjs", "src/http/routes.mjs", "API.md"],
    goal: "检查现有研究工作板领域、存储、HTTP/SSE 和浏览器功能的衔接，补充至少一个此前测试未覆盖的公共合同回归测试。保留现有公开接口和 UI，不新增依赖。真实缺陷如有发现应修复并说明。" }
];

// Copy source fixtures only. Prior run output, authentication files, dependency
// trees and Agent instructions are never projected into a model's trial root.
const ignoredDirectories = new Set([".git", ".metacode", ".claude", ".agents", ".codex", ".cache", "node_modules", "data", "reports", "verification", "audit", "credentials", "profiles"]);
const ignoredFile = (name) => name === ".DS_Store" || name === "AGENTS.md" || name === "CLAUDE.md"
  || /^\.env(?:\.|$)/i.test(name) || /^(?:secrets?|credentials?)(?:[._-]|$)/i.test(name);

export async function sourceManifest(root, { sourceOnly = true } = {}) {
  const result = [];
  const visit = async (directory) => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (sourceOnly && (ignoredFile(entry.name) || (entry.isDirectory() && ignoredDirectories.has(entry.name)))) continue;
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename).split(path.sep).join("/");
      assert.ok(!entry.isSymbolicLink(), `Existing fixture contains a source symlink: ${relative}`);
      if (entry.isDirectory()) { result.push({ path: `${relative}/`, type: "directory" }); await visit(filename); }
      else if (entry.isFile()) result.push({ path: relative, type: "file", sha256: crypto.createHash("sha256").update(await fs.readFile(filename)).digest("hex") });
      else throw new Error(`Unsupported existing fixture entry: ${relative}`);
    }
  };
  await visit(root);
  return result;
}

export async function copyExistingWorkflowProject(sourceBase, targetBase, key) {
  const project = existingWorkflowProjects.find((item) => item.key === key || item.folder === key);
  assert.ok(project, `Unknown existing project: ${key}`);
  const source = await fs.realpath(path.join(sourceBase, project.folder));
  let ancestor = path.resolve(targetBase);
  const unresolved = [];
  while (true) {
    try { ancestor = await fs.realpath(ancestor); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      unresolved.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const target = path.join(ancestor, ...unresolved, project.folder);
  const relation = path.relative(source, target);
  assert.ok(relation && (relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)), "A trial copy cannot be created inside the original project");
  const originalManifest = await sourceManifest(source);
  for (const required of ["package.json", "PROJECT_REQUIREMENTS.md"]) assert.ok(originalManifest.some((entry) => entry.path === required && entry.type === "file"), `${project.folder} is missing ${required}`);
  await fs.mkdir(targetBase, { recursive: true, mode: 0o700 });
  // A duplicate trial must never overwrite prior evidence. Callers should use
  // a fresh harness root for every run, while this guard also catches accidental
  // repeated destination keys within one process.
  await fs.mkdir(target, { mode: 0o700 });
  for (const entry of originalManifest) {
    const destination = path.join(target, entry.path);
    if (entry.type === "directory") await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    else { await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); await fs.copyFile(path.join(source, entry.path), destination); }
  }
  assert.deepEqual(await sourceManifest(target, { sourceOnly: false }), originalManifest, "Trial copy must preserve the source fixture bytes");
  return { project, source, root: target, originalManifest };
}

export function observedNodeConcurrency(nodes) {
  const events = nodes.flatMap((node) => {
    const start = Date.parse(node.startedAt || "");
    const end = Date.parse(node.finishedAt || "");
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? [{ at: start, change: 1 }, { at: end, change: -1 }] : [];
  }).sort((left, right) => left.at - right.at || left.change - right.change);
  let active = 0;
  let peak = 0;
  for (const event of events) { active += event.change; peak = Math.max(peak, active); }
  return { peak, observedIntervals: events.length / 2, method: "stored-node-startedAt-finishedAt-overlap" };
}

export function assertNoWorkflowDirectories(manifest, initialManifest = []) {
  const directories = (entry) => {
    const parts = entry.path.replace(/\/$/, "").split("/");
    const count = entry.type === "directory" ? parts.length : parts.length - 1;
    return parts.slice(0, count).map((_, index) => parts.slice(0, index + 1).join("/"));
  };
  const existing = new Set(initialManifest.flatMap(directories));
  const added = manifest.flatMap(directories).filter((directory) => !existing.has(directory));
  assert.ok(!added.some((directory) => /^(?:\.metacode|nodes|artifacts|deliverables|workflow-.+)$/.test(directory.split("/").at(-1))), "A business fixture must not acquire orchestration task/protocol directories");
}
