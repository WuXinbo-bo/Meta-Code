import fs from "node:fs";
import path from "node:path";

function comparable(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInside(root: string, target: string, allowRoot = true) {
  const relative = path.relative(comparable(root), comparable(target));
  return (allowRoot && relative === "") || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertPathInsideRoot(root: string, input: string, options: { allowRoot?: boolean; allowMissing?: boolean } = {}) {
  const lexicalRoot = path.resolve(root);
  const target = path.resolve(input);
  const allowRoot = options.allowRoot !== false;
  if (!isPathInside(lexicalRoot, target, allowRoot)) throw new Error("路径必须位于当前工作区内");

  const realRoot = fs.realpathSync.native(lexicalRoot);
  let existing = target;
  while (!fs.existsSync(existing)) {
    if (!options.allowMissing) throw Object.assign(new Error(`路径不存在：${target}`), { code: "ENOENT" });
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error("无法验证路径边界");
    existing = parent;
  }
  const realExisting = fs.realpathSync.native(existing);
  if (!isPathInside(realRoot, realExisting, allowRoot || existing !== target)) {
    throw new Error("路径通过符号链接或目录联接越过工作区边界");
  }
  return target;
}

