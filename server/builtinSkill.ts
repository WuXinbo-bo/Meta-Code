import fs from "node:fs/promises";
import path from "node:path";

export type BuiltinSkill = {
  root: string;
  instructions: string;
  cleanup: () => void;
};

export async function loadBuiltinSkill(root: string, skillPath?: string): Promise<BuiltinSkill> {
  const resolved = path.resolve(skillPath || path.join(root, "skills", "claude-codex-workflow", "SKILL.md"));
  return { root: path.dirname(resolved), instructions: await fs.readFile(resolved, "utf8"), cleanup: () => undefined };
}
