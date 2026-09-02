import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceSkillProjectionManager } from "../dist-server/skillProjection.js";

const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-skill-projection-"));
const managed = path.join(runtime, "managed");
const workspace = path.join(runtime, "workspace");

async function createSkill(root, name, body = name) {
  const target = path.join(root, name);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "SKILL.md"), `---\nname: ${name}\n---\n${body}\n`, "utf8");
}

try {
  await fs.mkdir(path.join(workspace, ".git", "info"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".git", "info", "exclude"), "# user rule\n*.local\n", "utf8");
  await createSkill(managed, "base-skill");
  await createSkill(managed, "manual-skill");
  await createSkill(managed, "conflict-skill", "managed");
  await createSkill(path.join(workspace, ".agents", "skills"), "conflict-skill", "user-owned");

  const manager = new WorkspaceSkillProjectionManager(managed);
  manager.setBaseSkills("workspace-1", workspace, ["base-skill", "conflict-skill"]);
  assert.equal(manager.isAvailable(workspace, "codex", "base-skill"), true);
  assert.equal(manager.isAvailable(workspace, "claude", "base-skill"), true);
  assert.equal(manager.isAvailable(workspace, "codex", "conflict-skill"), false);
  assert.equal(manager.isAvailable(workspace, "claude", "conflict-skill"), true);
  const activeExclude = await fs.readFile(path.join(workspace, ".git", "info", "exclude"), "utf8");
  assert.match(activeExclude, /# user rule/);
  assert.match(activeExclude, /\.agents\/skills\/base-skill/);
  assert.doesNotMatch(activeExclude, /\.agents\/skills\/conflict-skill/);

  const releaseOne = manager.acquireTemporarySkills("workspace-1", workspace, ["manual-skill"]);
  const releaseTwo = manager.acquireTemporarySkills("workspace-1", workspace, ["manual-skill"]);
  assert.equal(manager.isAvailable(workspace, "codex", "manual-skill"), true);
  assert.equal(manager.isAvailable(workspace, "claude", "manual-skill"), true);
  releaseOne();
  assert.equal(manager.isAvailable(workspace, "codex", "manual-skill"), true);
  releaseTwo();
  assert.equal(manager.isAvailable(workspace, "codex", "manual-skill"), false);
  assert.equal(manager.isAvailable(workspace, "claude", "manual-skill"), false);

  const workflowDirectory = path.join(workspace, "workflow-runs", "nested-task");
  await fs.mkdir(workflowDirectory, { recursive: true });
  const releaseWorkflow = manager.acquireTemporarySkills("workspace-1:workflow:run-1", workflowDirectory, ["manual-skill"]);
  assert.equal(manager.isAvailable(workflowDirectory, "codex", "manual-skill"), true);
  assert.equal(manager.isAvailable(workflowDirectory, "claude", "manual-skill"), true);
  assert.equal(manager.isAvailable(workspace, "codex", "manual-skill"), false);
  releaseWorkflow();
  assert.equal(manager.isAvailable(workflowDirectory, "codex", "manual-skill"), false);
  assert.equal(manager.isAvailable(workflowDirectory, "claude", "manual-skill"), false);

  manager.setBaseSkills("workspace-1", workspace, []);
  assert.equal(manager.isAvailable(workspace, "codex", "base-skill"), false);
  assert.equal(manager.isAvailable(workspace, "claude", "base-skill"), false);
  assert.equal(await fs.readFile(path.join(workspace, ".agents", "skills", "conflict-skill", "SKILL.md"), "utf8").then((value) => value.includes("user-owned")), true);
  const clearedExclude = await fs.readFile(path.join(workspace, ".git", "info", "exclude"), "utf8");
  assert.match(clearedExclude, /# user rule/);
  assert.doesNotMatch(clearedExclude, /Claude-Codex Workbench Skill Projections/);

  const restarted = new WorkspaceSkillProjectionManager(managed);
  restarted.setBaseSkills("workspace-1", workspace, []);
  assert.equal(manager.isAvailable(workspace, "claude", "conflict-skill"), false);
  console.log("Workspace native Skill projection lifecycle OK");
} finally {
  await fs.rm(runtime, { recursive: true, force: true });
}
