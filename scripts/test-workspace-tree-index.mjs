import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceTreeIndex } from "../server/workspaceTreeIndex.ts";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const key = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-tree-index-"));
const outsideRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-tree-outside-"));
try {
  await fsp.mkdir(path.join(root, "alpha", "nested"), { recursive: true });
  await fsp.mkdir(path.join(root, "empty"));
  await fsp.writeFile(path.join(root, "root.txt"), "root");
  await fsp.writeFile(path.join(root, "alpha", "note.md"), "note");
  await fsp.writeFile(path.join(root, "alpha", "nested", "deep.txt"), "deep");
  for (const ignored of [".git", "node_modules", ".runtime", "dist", "build"]) {
    await fsp.mkdir(path.join(root, ignored, "hidden"), { recursive: true });
    await fsp.writeFile(path.join(root, ignored, "hidden", "secret.txt"), "ignored");
  }
  await fsp.mkdir(path.join(root, "alpha", "node_modules"));
  await fsp.writeFile(path.join(root, "alpha", "node_modules", "dependency.js"), "ignored");
  await fsp.mkdir(path.join(root, "..legal"));
  await fsp.writeFile(path.join(root, "..legal", "valid.txt"), "valid");
  await fsp.writeFile(path.join(outsideRoot, "outside-secret.txt"), "outside");
  await fsp.symlink(outsideRoot, path.join(root, "outside-link"), process.platform === "win32" ? "junction" : "dir");

  const index = new WorkspaceTreeIndex({ initialDepth: 1, ttlMs: 10_000 });
  const initial = await index.read(root);
  assert.deepEqual(initial.map((node) => node.name), ["..legal", "alpha", "empty", "root.txt"]);
  const alpha = initial.find((node) => node.name === "alpha");
  assert.equal(alpha?.type, "directory");
  assert.equal(alpha?.childrenLoaded, true);
  assert.equal(alpha?.hasChildren, true);
  assert.deepEqual(alpha?.children?.map((node) => node.name), ["nested", "note.md"]);
  const nested = alpha?.children?.find((node) => node.name === "nested");
  assert.equal(nested?.children, undefined);
  assert.equal(nested?.childrenLoaded, false);
  assert.equal(nested?.hasChildren, true);
  const rootFile = initial.find((node) => node.name === "root.txt");
  assert.equal(rootFile?.size, 4);
  assert.match(rootFile?.modifiedAt || "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(rootFile?.childrenLoaded, undefined);

  const lazy = await index.readDirectory(root, "alpha");
  assert.deepEqual(lazy.map((node) => node.name), ["nested", "note.md"]);
  assert.equal(lazy[0].childrenLoaded, false);
  assert.equal(lazy[0].hasChildren, true);
  assert.deepEqual(await index.readDirectory(root, "node_modules"), []);
  await assert.rejects(index.read(root, { relativePath: "../outside" }), /当前工作区/);
  assert.deepEqual((await index.readDirectory(root, "..legal")).map((node) => node.name), ["valid.txt"]);
  await assert.rejects(index.readDirectory(root, "outside-link"), /当前工作区/);

  await fsp.mkdir(path.join(root, "budget", "a"), { recursive: true });
  await fsp.mkdir(path.join(root, "budget", "b"), { recursive: true });
  await fsp.writeFile(path.join(root, "budget", "a", "one.txt"), "one");
  await fsp.writeFile(path.join(root, "budget", "b", "two.txt"), "two");
  const budgeted = await new WorkspaceTreeIndex({ initialDepth: 1 }).read(root, {
    relativePath: "budget",
    maxDepth: 1,
    totalEntryBudget: 3
  });
  assert.equal(budgeted[0]?.name, "a");
  assert.equal(budgeted[0]?.childrenLoaded, true);
  assert.equal(budgeted[1]?.name, "b");
  assert.equal(budgeted[1]?.children, undefined);
  assert.equal(budgeted[1]?.childrenLoaded, false, "budget exhaustion must remain lazily recoverable");
  assert.equal(budgeted[1]?.hasChildren, true, "an unvisited directory must not be reported as empty");

  const reads = new Map();
  const countedFileSystem = {
    async readDirectory(directory) {
      const directoryKey = key(directory);
      reads.set(directoryKey, (reads.get(directoryKey) || 0) + 1);
      await sleep(25);
      return fsp.readdir(directory, { withFileTypes: true });
    },
    lstat: (target) => fsp.lstat(target)
  };
  const concurrentIndex = new WorkspaceTreeIndex({ fileSystem: countedFileSystem, initialDepth: 0, ttlMs: 10_000 });
  const [first, second, third] = await Promise.all([
    concurrentIndex.readDirectory(root, "alpha"),
    concurrentIndex.readDirectory(root, "alpha"),
    concurrentIndex.readDirectory(root, "alpha")
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  assert.equal(reads.get(key(path.join(root, "alpha"))), 1, "concurrent directory reads must share one filesystem request");
  assert.equal(reads.get(key(path.join(root, "alpha", "nested"))), undefined, "collapsed directories must not trigger N+1 probes");
  assert.ok(concurrentIndex.stats().coalescedRequests >= 1);
  await concurrentIndex.readDirectory(root, "alpha");
  assert.equal(reads.get(key(path.join(root, "alpha"))), 1, "fresh cache must avoid another filesystem request");

  let clock = 0;
  const swrIndex = new WorkspaceTreeIndex({ ttlMs: 100, staleWhileRevalidateMs: 500, now: () => clock });
  const beforeRefresh = await swrIndex.read(root, { maxDepth: 0 });
  await fsp.writeFile(path.join(root, "later.txt"), "later");
  clock = 150;
  const stale = await swrIndex.read(root, { maxDepth: 0 });
  assert.equal(stale.some((node) => node.name === "later.txt"), false, "SWR reads return the cached value immediately");
  await swrIndex.whenIdle();
  const refreshed = await swrIndex.read(root, { maxDepth: 0 });
  assert.equal(refreshed.some((node) => node.name === "later.txt"), true, "the background refresh replaces stale entries");
  assert.ok(swrIndex.stats().staleHits > 0);
  assert.ok(beforeRefresh.length < refreshed.length);

  await swrIndex.readDirectory(root, "alpha");
  await fsp.writeFile(path.join(root, "alpha", "new.md"), "new");
  const stillCached = await swrIndex.readDirectory(root, "alpha");
  assert.equal(stillCached.some((node) => node.name === "new.md"), false);
  swrIndex.invalidate(root, "alpha/new.md");
  const invalidated = await swrIndex.readDirectory(root, "alpha");
  assert.equal(invalidated.some((node) => node.name === "new.md"), true, "invalidating a file also invalidates its parent directory");

  const limited = new WorkspaceTreeIndex({ entryLimit: 2, initialDepth: 0 });
  assert.equal((await limited.read(root)).length, 2, "per-directory entry limits stay bounded");

  console.log("Workspace tree index contracts OK");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outsideRoot, { recursive: true, force: true });
}
