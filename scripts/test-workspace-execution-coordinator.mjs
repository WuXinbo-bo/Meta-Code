import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitRoot, runGit } from "../server/git/service.ts";
import { WorkflowTargetService } from "../server/plugins/orchestration/targets.ts";
import { WorkspaceExecutionCoordinator } from "../server/runtime/workspaceExecutionCoordinator.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-execution-coordinator-"));
const root = path.join(temporary, "project");
await fs.mkdir(root);
const request = (ownerId, access = "write", target = root) => ({ root: target, ownerId, access, label: ownerId });

try {
  const coordinator = new WorkspaceExecutionCoordinator();
  const main = coordinator.tryAcquire(request("session:main"));
  assert.ok(main);
  assert.equal(coordinator.tryAcquire(request("workflow:other")), null);
  assert.equal(coordinator.tryAcquire(request("workflow:other", "read", path.join(root, "src"))), null);
  const unrelated = coordinator.tryAcquire(request("workflow:separate", "write", path.join(temporary, "project-other")));
  assert.ok(unrelated, "Sibling directories must not conflict merely because their path prefix matches");
  unrelated.release();

  const order = [];
  const pending = coordinator.acquire(request("workflow:pending")).then((lease) => { order.push("workflow"); return lease; });
  const delegated = coordinator.tryAcquire(request("session:main", "write", path.join(root, "src")));
  assert.ok(delegated, "A delegated operation must join its active parent even when another writer is waiting");
  main.release();
  await Promise.resolve();
  assert.deepEqual(order, [], "A parent release must not unlock its active delegated operation");
  delegated.release();
  const workflow = await pending;
  assert.deepEqual(order, ["workflow"]);
  assert.equal(coordinator.tryAcquire(request("reader", "read")), null);
  workflow.release();
  workflow.release();
  assert.equal(coordinator.snapshot().active.length, 0);

  const readerA = coordinator.tryAcquire(request("reader:a", "read"));
  const readerB = coordinator.tryAcquire(request("reader:b", "read"));
  assert.ok(readerA && readerB);
  const writerPromise = coordinator.acquire(request("writer"));
  assert.equal(coordinator.tryAcquire(request("reader:c", "read")), null, "Queued writers must not be starved by incoming readers");
  const canceled = new AbortController();
  const canceledPromise = coordinator.acquire(request("canceled"), { signal: canceled.signal });
  canceled.abort(new Error("test canceled"));
  await assert.rejects(canceledPromise, /test canceled/);
  readerA.release();
  readerB.release();
  const writer = await writerPromise;
  writer.release();
  assert.equal(coordinator.snapshot().waiting.length, 0);

  const alias = path.join(temporary, "alias");
  await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  const aliasLease = coordinator.tryAcquire(request("alias-owner", "write", alias));
  assert.ok(aliasLease);
  assert.equal(coordinator.tryAcquire(request("real-owner")), null, "Symlink aliases must share project ownership");
  aliasLease.release();

  const repositoryRoot = path.join(temporary, "monorepo");
  const workspaceA = path.join(repositoryRoot, "packages", "a");
  const workspaceB = path.join(repositoryRoot, "packages", "b");
  await fs.mkdir(workspaceA, { recursive: true });
  await fs.mkdir(workspaceB, { recursive: true });
  await fs.writeFile(path.join(workspaceA, "result.txt"), "original-a");
  await fs.writeFile(path.join(workspaceB, "result.txt"), "original-b");
  await runGit(repositoryRoot, ["init"]);
  await runGit(repositoryRoot, ["add", "."]);
  await runGit(repositoryRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "Initial monorepo"]);
  const targets = new WorkflowTargetService(path.join(temporary, "plugin-runtime"));
  const target = await targets.prepare({ runId: "sibling-integration", ownerUserId: "owner", workspaceId: "workspace-a", workspaceRoot: workspaceA, executionTarget: "worktree" });
  targets.confirmPrepared("sibling-integration", "owner");
  await fs.writeFile(path.join(target.executionRoot, "result.txt"), "integrated-a");
  const comparison = await targets.compare("sibling-integration", "owner");
  assert.equal(comparison.status, "ready");
  const headBefore = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).trim();
  const siblingTask = coordinator.tryAcquire(request("session:sibling", "write", workspaceB));
  assert.ok(siblingTask);
  const narrowLock = coordinator.tryAcquire(request("integration:narrow", "write", workspaceA));
  assert.ok(narrowLock, "Different subdirectories normally permit independent business execution");
  narrowLock.release();
  const integrationRoot = await gitRoot(workspaceA);
  assert.equal(integrationRoot, await fs.realpath(repositoryRoot));
  assert.equal(coordinator.tryAcquire(request("integration:repository", "write", integrationRoot)), null, "Git integration must block while a sibling workspace is writing");
  assert.equal((await runGit(repositoryRoot, ["rev-parse", "HEAD"])).trim(), headBefore);
  siblingTask.release();
  const integrationLease = coordinator.tryAcquire(request("integration:repository", "write", integrationRoot));
  assert.ok(integrationLease);
  assert.equal(coordinator.tryAcquire(request("session:sibling", "write", workspaceB)), null, "A repository integration must prevent new sibling writes");
  assert.equal(coordinator.tryAcquire(request("session:sibling", "read", workspaceB)), null, "Sibling readers must not observe a changing HEAD/index during integration");
  try {
    const integrated = await targets.integrate("sibling-integration", "owner", { expectedRevision: comparison.binding.revision, previewDigest: comparison.previewDigest, snapshotChanges: true });
    assert.equal(integrated.status, "integrated");
    assert.notEqual((await runGit(repositoryRoot, ["rev-parse", "HEAD"])).trim(), headBefore, "Real integration updates repository state across the selected workspace boundary");
    assert.equal(await fs.readFile(path.join(workspaceA, "result.txt"), "utf8"), "integrated-a");
    assert.equal(await fs.readFile(path.join(workspaceB, "result.txt"), "utf8"), "original-b");
  } finally { integrationLease.release(); }
  const resumedSibling = coordinator.tryAcquire(request("session:sibling", "write", workspaceB));
  assert.ok(resumedSibling, "Sibling work must become available after Git integration releases the repository lock");
  resumedSibling.release();
  const serverSource = await fs.readFile(new URL("../server/index.ts", import.meta.url), "utf8");
  assert.match(serverSource, /withWorkspaceWriteLock:[\s\S]*?const repositoryRoot = await gitRoot\(workspace\.root\);[\s\S]*?tryAcquire\(\{ root: repositoryRoot/, "The real integration port must acquire the same repository-level lock exercised here");
  console.log("Workspace execution coordination checks passed");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
