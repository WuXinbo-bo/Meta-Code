import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteWorkspaceEntries, moveWorkspaceEntries, searchWorkspaceFiles } from "../dist-server/workspaceFiles.js";

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-files-test-"));
try {
  await fsp.mkdir(path.join(root, "source-a"));
  await fsp.mkdir(path.join(root, "source-b"));
  await fsp.mkdir(path.join(root, "target"));
  await fsp.writeFile(path.join(root, "source-a", "a.txt"), "a");
  await fsp.writeFile(path.join(root, "source-b", "b.txt"), "b");
  const moved = await moveWorkspaceEntries(root, ["source-a/a.txt", "source-b/b.txt"], "target");
  assert.deepEqual(moved.moved.map((item) => item.to).sort(), ["target/a.txt", "target/b.txt"]);
  assert.equal(await fsp.readFile(path.join(root, "target", "a.txt"), "utf8"), "a");

  await fsp.mkdir(path.join(root, "nested", "child"), { recursive: true });
  await assert.rejects(moveWorkspaceEntries(root, ["nested"], "nested/child"), /自身或其子目录/);

  await fsp.mkdir(path.join(root, "bundle", "inner"), { recursive: true });
  await fsp.writeFile(path.join(root, "bundle", "inner", "item.txt"), "item");
  const collapsed = await moveWorkspaceEntries(root, ["bundle", "bundle/inner/item.txt"], "target");
  assert.equal(collapsed.moved.length, 1);
  assert.equal(await fsp.readFile(path.join(root, "target", "bundle", "inner", "item.txt"), "utf8"), "item");

  await fsp.mkdir(path.join(root, "conflict-source"));
  await fsp.writeFile(path.join(root, "conflict-source", "a.txt"), "other");
  await assert.rejects(moveWorkspaceEntries(root, ["conflict-source/a.txt"], "target"), /同名项目/);
  assert.equal(await fsp.readFile(path.join(root, "conflict-source", "a.txt"), "utf8"), "other");

  await fsp.mkdir(path.join(root, "delete-parent", "child"), { recursive: true });
  await fsp.writeFile(path.join(root, "delete-parent", "child", "remove.txt"), "remove");
  const deleted = await deleteWorkspaceEntries(root, ["delete-parent", "delete-parent/child/remove.txt"]);
  assert.deepEqual(deleted.deleted, ["delete-parent"]);
  await assert.rejects(fsp.stat(path.join(root, "delete-parent")), /ENOENT/);
  await assert.rejects(deleteWorkspaceEntries(root, ["../outside"]), /当前工作区/);

  await fsp.mkdir(path.join(root, "research", "nested"), { recursive: true });
  await fsp.writeFile(path.join(root, "research", "nested", "Market-Analysis.md"), "report");
  await fsp.mkdir(path.join(root, "node_modules", "hidden"), { recursive: true });
  await fsp.writeFile(path.join(root, "node_modules", "hidden", "Market-Dependency.md"), "ignored");
  const search = await searchWorkspaceFiles(root, "market");
  assert.deepEqual(search.results.map((item) => item.path), ["research/nested/Market-Analysis.md"]);
  assert.equal(search.truncated, false);
  console.log("Workspace file operation contracts OK");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
