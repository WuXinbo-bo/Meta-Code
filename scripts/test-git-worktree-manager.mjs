import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorktreeError, bindWorktree, cleanupWorktree, createWorktree, listWorktrees, preflightMerge, restoreWorktree } from "../server/git/worktreeManager.ts";

const run = promisify(execFile);
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-worktree-"));
const repository = path.join(temporaryRoot, "repo");
const linked = path.join(temporaryRoot, "linked");
const outside = path.join(temporaryRoot, "outside");

try {
  await fs.mkdir(repository);
  await run("git", ["-C", repository, "init", "-b", "main"]);
  await run("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", repository, "config", "user.name", "Meta Code Test"]);
  await fs.writeFile(path.join(repository, "README.md"), "initial\n");
  await run("git", ["-C", repository, "add", "README.md"]);
  await run("git", ["-C", repository, "commit", "-m", "initial"]);

  const initial = await listWorktrees(repository);
  assert.equal(initial.status, "listed");
  assert.equal(initial.worktrees.length, 1);
  assert.equal(initial.worktrees[0].isPrimary, true);
  assert.equal(initial.worktrees[0].branch, "main");

  const created = await createWorktree({ workspaceRoot: repository, worktreePath: linked, branch: "feature/worktree" });
  assert.equal(created.status, "created");
  assert.equal(created.worktree?.branch, "feature/worktree");
  assert.equal((await createWorktree({ workspaceRoot: repository, worktreePath: linked, branch: "other" })).status, "already_exists");
  assert.equal((await bindWorktree(repository, linked)).status, "bound");

  await fs.writeFile(path.join(linked, "feature.txt"), "feature\n");
  await run("git", ["-C", linked, "add", "feature.txt"]);
  await run("git", ["-C", linked, "commit", "-m", "feature"]);
  const ready = await preflightMerge({ workspaceRoot: repository, source: "feature/worktree", target: "main" });
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.changedFiles, ["feature.txt"]);

  await fs.writeFile(path.join(linked, "uncommitted.txt"), "dirty\n");
  const blocked = await preflightMerge({ workspaceRoot: repository, source: "feature/worktree", target: "main", worktreePath: linked });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "target_dirty");
  assert.ok(blocked.dirtyFiles.includes("uncommitted.txt"));
  assert.equal((await cleanupWorktree(repository, linked)).status, "blocked");
  assert.equal((await cleanupWorktree(repository, linked, true)).status, "removed");
  assert.equal((await cleanupWorktree(repository, linked)).status, "already_absent");

  // A relative traversal and an unmanaged existing path are both rejected.
  await assert.rejects(() => createWorktree({ workspaceRoot: repository, worktreePath: "../escape", branch: "escape" }), (error) => error instanceof WorktreeError && error.code === "INVALID_PATH");
  await fs.mkdir(outside);
  await assert.rejects(() => createWorktree({ workspaceRoot: repository, worktreePath: outside, branch: "occupied" }), (error) => error instanceof WorktreeError && error.code === "PATH_OCCUPIED");
  await assert.rejects(() => listWorktrees(outside), (error) => error instanceof WorktreeError && error.code === "NOT_GIT_REPOSITORY");

  // Repair is safe to call on a currently registered worktree.
  const recreated = await createWorktree({ workspaceRoot: repository, worktreePath: linked, branch: "feature/restore" });
  assert.equal((await restoreWorktree(repository, recreated.path)).status, "restored");
  assert.equal((await cleanupWorktree(repository, linked, true)).status, "removed");
  console.log("git worktree lifecycle, merge preflight, boundary checks, and cleanup passed");
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
