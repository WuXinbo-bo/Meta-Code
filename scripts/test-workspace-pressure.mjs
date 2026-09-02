import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { WorkspaceTreeIndex } from "../server/workspaceTreeIndex.ts";
import { searchWorkspaceFiles } from "../server/workspaceFiles.ts";

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "Meta Code 中文 workspace "));
const directoryCount = 200;
const filesPerDirectory = 100;

try {
  for (let directoryIndex = 0; directoryIndex < directoryCount; directoryIndex += 1) {
    const directory = path.join(root, `模块 ${String(directoryIndex).padStart(3, "0")}`);
    await fsp.mkdir(directory);
    const writes = [];
    for (let fileIndex = 0; fileIndex < filesPerDirectory; fileIndex += 1) {
      const needle = directoryIndex === directoryCount - 1 && fileIndex === filesPerDirectory - 1;
      const name = needle ? "唯一 needle 结果.md" : `文件 ${String(fileIndex).padStart(3, "0")}.txt`;
      writes.push(fsp.writeFile(path.join(directory, name), needle ? "target" : "fixture"));
    }
    await Promise.all(writes);
  }

  const longDirectory = path.join(root, "超长路径", ...Array.from({ length: 16 }, (_, index) => `层级-${index}-${"长".repeat(8)}`));
  await fsp.mkdir(longDirectory, { recursive: true });
  const longFile = path.join(longDirectory, "最终 文件.txt");
  await fsp.writeFile(longFile, "long path");
  assert.ok(longFile.length > 260, `fixture must exercise a path longer than 260 characters, got ${longFile.length}`);

  const readOnlyFile = path.join(root, "只读 文件.txt");
  await fsp.writeFile(readOnlyFile, "read only");
  await fsp.chmod(readOnlyFile, 0o444);

  const index = new WorkspaceTreeIndex({ initialDepth: 1, entryLimit: 500, ttlMs: 30_000 });
  const indexStartedAt = performance.now();
  const tree = await index.read(root);
  const indexDurationMs = performance.now() - indexStartedAt;
  assert.equal(tree.filter((entry) => entry.type === "directory").length, directoryCount + 1);
  assert.ok(tree.some((entry) => entry.name === "只读 文件.txt"));
  assert.ok(indexDurationMs < 5_000, `initial large-workspace index took ${indexDurationMs.toFixed(1)} ms`);

  const cachedStartedAt = performance.now();
  await index.read(root);
  const cachedDurationMs = performance.now() - cachedStartedAt;
  assert.ok(cachedDurationMs < Math.max(100, indexDurationMs / 5), `cached index took ${cachedDurationMs.toFixed(1)} ms`);

  const searchStartedAt = performance.now();
  const search = await searchWorkspaceFiles(root, "needle");
  const searchDurationMs = performance.now() - searchStartedAt;
  assert.deepEqual(search.results.map((item) => item.path), ["模块 199/唯一 needle 结果.md"]);
  assert.equal(search.truncated, false);
  assert.ok(searchDurationMs < 10_000, `20k-file search took ${searchDurationMs.toFixed(1)} ms`);
  assert.equal(await fsp.readFile(longFile, "utf8"), "long path");
  assert.equal(await fsp.readFile(readOnlyFile, "utf8"), "read only");

  console.log(JSON.stringify({ files: directoryCount * filesPerDirectory + 2, indexDurationMs: Number(indexDurationMs.toFixed(1)), cachedDurationMs: Number(cachedDurationMs.toFixed(1)), searchDurationMs: Number(searchDurationMs.toFixed(1)) }));
} finally {
  await fsp.chmod(path.join(root, "只读 文件.txt"), 0o666).catch(() => undefined);
  await fsp.rm(root, { recursive: true, force: true });
}
