export function workspaceRelativePath(source: string | undefined, workspaceRoot?: string, markdownPath?: string) {
  if (!source || !workspaceRoot || /^(?:https?:|mailto:|tel:|#|data:|\/\/)/i.test(source)) return null;
  let cleanSource = source.split(/[?#]/, 1)[0].replace(/^file:\/{2,3}/i, "/").replaceAll("\\", "/");
  try {
    cleanSource = decodeURIComponent(cleanSource);
  } catch {
    // Keep literal percent characters unchanged.
  }
  if (/^\/[a-zA-Z]:\//.test(cleanSource)) cleanSource = cleanSource.slice(1);
  const normalizedRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  const windowsAbsolute = /^[a-zA-Z]:\//.test(cleanSource);
  const absolute = windowsAbsolute || cleanSource.startsWith("/");
  let relative = cleanSource;
  if (absolute) {
    const comparableSource = windowsAbsolute ? cleanSource.toLowerCase() : cleanSource;
    const comparableRoot = windowsAbsolute ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootPrefix = comparableRoot === "/" ? "/" : `${comparableRoot}/`;
    if (comparableSource !== comparableRoot && !comparableSource.startsWith(rootPrefix)) return null;
    relative = cleanSource.slice(normalizedRoot === "/" ? 1 : normalizedRoot.length).replace(/^\//, "");
  }
  const baseParts = absolute || !markdownPath
    ? []
    : markdownPath.replaceAll("\\", "/").split("/").slice(0, -1);
  let escapedRoot = false;
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!baseParts.length) escapedRoot = true;
      else baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return escapedRoot ? null : baseParts.join("\\");
}
