import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertNoWorkflowDirectories,
  copyExistingWorkflowProject,
  observedNodeConcurrency,
  sourceManifest
} from "./lib/workflow-existing-fixtures.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-existing-fixtures-"));
const sourceBase = path.join(root, "source");
const project = path.join(sourceBase, "01-ledger-cli");
try {
  await fs.mkdir(path.join(project, "src"), { recursive: true });
  await fs.mkdir(path.join(project, "audit"));
  await fs.mkdir(path.join(project, ".metacode"));
  await fs.writeFile(path.join(project, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(path.join(project, "PROJECT_REQUIREMENTS.md"), "Public contract\n");
  await fs.writeFile(path.join(project, "src", "main.mjs"), "export const value = 1;\n");
  await fs.writeFile(path.join(project, "audit", "old.md"), "Prior run evidence\n");
  await fs.writeFile(path.join(project, ".metacode", "protocol.json"), "{}\n");
  await fs.writeFile(path.join(project, ".env"), "NON_SECRET_FIXTURE=value\n");
  await fs.writeFile(path.join(project, "AGENTS.md"), "Prior Agent instructions\n");
  const original = await sourceManifest(project);
  const targetBase = path.join(root, "trial");
  const fixture = await copyExistingWorkflowProject(sourceBase, targetBase, "ledger");
  const copied = await sourceManifest(fixture.root, { sourceOnly: false });
  assert.deepEqual(copied, original);
  assert.ok(!copied.some((entry) => /(?:audit|\.metacode|\.env|AGENTS)/.test(entry.path)), "Prior metadata and configuration must not enter the trial");
  assertNoWorkflowDirectories(copied);
  await assert.rejects(copyExistingWorkflowProject(sourceBase, targetBase, "ledger"), /EEXIST/, "A duplicate destination cannot overwrite evidence");
  await assert.rejects(copyExistingWorkflowProject(sourceBase, path.join(project, "nested"), "ledger"), /inside the original project/);
  await fs.writeFile(path.join(fixture.root, "src", "main.mjs"), "export const value = 2;\n");
  assert.deepEqual(await sourceManifest(project), original, "Trial changes must not affect the source fixture");
  await fs.mkdir(path.join(fixture.root, ".metacode"));
  assert.throws(() => assertNoWorkflowDirectories([{ path: ".metacode/", type: "directory" }]), /protocol directories/);
  assert.throws(() => assertNoWorkflowDirectories([{ path: "nested/workflow-run/output.js", type: "file" }]), /protocol directories/);
  const businessDirectories = ["nodes", "artifacts", "deliverables", "workflow-source"].map((directory) => ({ path: `${directory}/`, type: "directory" }));
  assertNoWorkflowDirectories([...businessDirectories, { path: "nodes/new-business-file.js", type: "file" }], businessDirectories);
  assert.throws(() => assertNoWorkflowDirectories([...businessDirectories, { path: "nodes/workflow-new/output.js", type: "file" }], businessDirectories), /protocol directories/, "Existing business directories do not hide new protocol subdirectories");
  assertNoWorkflowDirectories([{ path: "artifacts", type: "file" }]);
  assert.ok((await sourceManifest(fixture.root, { sourceOnly: false })).some((entry) => entry.path === ".metacode/"), "Final manifests must expose newly created hidden protocol directories");
  if (process.platform !== "win32") {
    await fs.symlink(path.join(project, "src", "main.mjs"), path.join(project, "source-link"));
    await assert.rejects(copyExistingWorkflowProject(sourceBase, path.join(root, "symlink-trial"), "ledger"), /source symlink/);
  }
  assert.deepEqual(observedNodeConcurrency([
    { startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:10Z" },
    { startedAt: "2026-01-01T00:00:01Z", finishedAt: "2026-01-01T00:00:09Z" },
    { startedAt: "2026-01-01T00:00:02Z", finishedAt: "2026-01-01T00:00:08Z" }
  ]), { peak: 3, observedIntervals: 3, method: "stored-node-startedAt-finishedAt-overlap" });
  assert.equal(observedNodeConcurrency([
    { startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z" },
    { startedAt: "2026-01-01T00:00:01Z", finishedAt: "2026-01-01T00:00:02Z" },
    { startedAt: "invalid", finishedAt: "invalid" }
  ]).peak, 1, "Touching intervals do not prove simultaneous execution");
  console.log("Existing workflow fixture copy isolation, metadata exclusion and concurrency evidence passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
