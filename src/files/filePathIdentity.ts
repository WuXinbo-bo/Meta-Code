export function normalizeWorkspaceFilePath(path: string) {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

export function workspaceFilePathIdentity(path: string) {
  return normalizeWorkspaceFilePath(path).replace(/\/$/, "").toLowerCase();
}

export function workspaceFilePathEquals(left: string | undefined, right: string | undefined) {
  if (!left || !right) return false;
  return workspaceFilePathIdentity(left) === workspaceFilePathIdentity(right);
}

export function workspaceFilePathAtOrBelow(path: string, root: string) {
  const pathIdentity = workspaceFilePathIdentity(path);
  const rootIdentity = workspaceFilePathIdentity(root);
  return pathIdentity === rootIdentity || pathIdentity.startsWith(`${rootIdentity}/`);
}
