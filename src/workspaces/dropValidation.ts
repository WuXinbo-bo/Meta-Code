export type WorkspaceDropCandidate = {
  itemCount: number;
  isDirectory: boolean;
  path: string;
};

export function validateWorkspaceDrop(candidate: WorkspaceDropCandidate) {
  if (candidate.itemCount !== 1) return { ok: false as const, error: "一次只能拖入一个文件夹" };
  if (!candidate.isDirectory) return { ok: false as const, error: "请拖入文件夹，而不是单个文件" };
  const path = candidate.path.trim();
  if (!path) return { ok: false as const, error: "浏览器无法读取本机目录路径，请使用桌面版或点击浏览" };
  return { ok: true as const, path };
}

export function workspaceNameFromPath(value: string) {
  return value.trim().replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || "";
}
