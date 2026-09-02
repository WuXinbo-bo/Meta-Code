import fs from "node:fs/promises";
import path from "node:path";

/**
 * Compatibility loader for the copied admin release API.
 * The active workbench uses skills/<name>/SKILL.md directly and does not
 * require encryption. Legacy release endpoints may still call this loader,
 * so they receive a plain text SKILL.md when the target is readable.
 */
export type ProtectedSkillRuntime = { root: string; instructions: string; cleanup: () => void };

export async function loadProtectedSkill(_root: string, skillPath: string): Promise<ProtectedSkillRuntime> {
  const resolved = path.resolve(skillPath);
  const instructions = await fs.readFile(resolved, "utf8");
  return { root: path.dirname(resolved), instructions, cleanup: () => undefined };
}
