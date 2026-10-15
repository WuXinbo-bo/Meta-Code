import fs from "node:fs";
import path from "node:path";

/** Preserve retryable drafts from the pre-plugin data layout. Never overwrite
 * a newer plugin transaction, and retain the source as a recovery copy. */
export function migratePlannerTransactions(legacyDirectory: string, directory: string, workflowIds: string[]) {
  if (!fs.existsSync(legacyDirectory)) return;
  if (fs.lstatSync(legacyDirectory).isSymbolicLink()) throw new Error("旧规划事务目录不能是符号链接");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("规划事务目录不能是符号链接");
  for (const id of workflowIds) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("工作流 ID 无效");
    for (const mode of ["initial", "fresh", "refine"]) {
      const name = `${id}-${mode}.json`;
      const source = path.join(legacyDirectory, name);
      const target = path.join(directory, name);
      if (fs.existsSync(target) || !fs.existsSync(source)) continue;
      if (!fs.lstatSync(source).isFile()) continue;
      const content = fs.readFileSync(source);
      const value = JSON.parse(content.toString("utf8"));
      if (value?.schemaVersion !== 1 || value.workflowId !== id || value.mode !== mode || !value.id || !Array.isArray(value.operations)) throw new Error(`旧规划事务身份无效：${name}`);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
      if (!fs.readFileSync(target).equals(content)) throw new Error(`规划事务迁移校验失败：${name}`);
    }
  }
}
