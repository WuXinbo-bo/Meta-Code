import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManagedSkillManager } from "../dist-server/managedSkillManager.js";

const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-skill-test-"));
const source = path.join(runtime, "source", "test-skill");
await fs.mkdir(path.join(source, "references"), { recursive: true });
await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: Test Skill\ndescription: import test\n---\n", "utf8");
await fs.writeFile(path.join(source, "references", "guide.md"), "guide", "utf8");

try {
  const manager = new ManagedSkillManager(path.join(runtime, "managed-runtime"));
  const results = await Promise.allSettled([manager.importFolder(source), manager.importFolder(source)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.match(String(rejected?.reason?.message || rejected?.reason), /同名 Skill 已存在/);
  assert.equal((await manager.tree("test-skill")).length, 2);
  const renamed = await manager.renameDisplayName("test-skill", "我的摘要 Skill");
  assert.equal(renamed.title, "我的摘要 Skill");
  assert.equal(manager.listPublic()[0].name, "test-skill");
  assert.equal(manager.listPublic()[0].title, "我的摘要 Skill");
  assert.equal((await fs.readdir(manager.root)).some((name) => name.startsWith(".upload-")), false);
  console.log("Managed Skill import locking and cleanup OK");
} finally {
  await fs.rm(runtime, { recursive: true, force: true });
}
