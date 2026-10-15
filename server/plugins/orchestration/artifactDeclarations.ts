import path from "node:path";

export type WorkflowArtifactDeclaration =
  | { kind: "text"; text: string }
  | { kind: "path"; path: string }
  | { kind: "described"; path: string; description: string }
  | { kind: "ambiguous"; text: string };

const extensionAtEnd = /\.[\p{L}\p{N}_-]{1,20}$/u;
const extensionlessFile = /^(?:README|LICENSE|LICENCE|NOTICE|Makefile|Dockerfile|Gemfile|Procfile)(?:$|\.)/i;
const looksLikePath = (value: string) => /[\\/]/.test(value) || extensionAtEnd.test(value) || extensionlessFile.test(value);
const pathReferences = /(?:^|[\s`"'([,;])(?:[^\s`"'()[\],;]+[\\/][^\s`"'()[\],;]+|[^\s`"'()[\],;]+\.[\p{L}\p{N}_-]{1,20})(?=$|[\s`"')\],;])/gu;

/** A path is not a prose description. Only a clear, leading, single-path legacy
 * declaration can be recovered; uncertain declarations must be replanned. */
export function parseWorkflowArtifactDeclaration(value: string): WorkflowArtifactDeclaration {
  const text = value.trim();
  const quoted = text.match(/^`([^`]+)`(?:\s*(.*))?$/u);
  if (quoted && looksLikePath(quoted[1])) {
    if (!quoted[2]) return { kind: "path", path: normalizeWorkflowArtifactPath(quoted[1]) };
    if (pathReferences.test(quoted[2])) { pathReferences.lastIndex = 0; return { kind: "ambiguous", text }; }
    pathReferences.lastIndex = 0;
    return { kind: "described", path: normalizeWorkflowArtifactPath(quoted[1]), description: quoted[2] };
  }
  // An explicit separator distinguishes prose from filenames containing spaces.
  const described = text.match(/^(.+?\.[\p{L}\p{N}_-]{1,20})(?:\s+(?:with|containing|including|updated|corrected|implementing|providing)\b\s*|\s*[:：]\s+|\s+[—–-]\s+|\s*[（(])(.+)$/iu);
  if (described && looksLikePath(described[1])) {
    const hasAnotherPath = pathReferences.test(described[2]); pathReferences.lastIndex = 0;
    if (hasAnotherPath) return { kind: "ambiguous", text };
    return { kind: "described", path: normalizeWorkflowArtifactPath(described[1]), description: described[2] };
  }
  // A complete filename may contain spaces or Unicode; never split on whitespace.
  if (looksLikePath(text)) {
    const references = [...text.matchAll(pathReferences)];
    const listSeparator = /\s+(?:and|or|plus|和|以及)\s+|[,;，；、]/iu.test(text);
    if ((references.length > 1 && listSeparator) || (!extensionAtEnd.test(text) && /\.[\p{L}\p{N}_-]{1,20}\s+\S/u.test(text))) return { kind: "ambiguous", text };
    return { kind: "path", path: normalizeWorkflowArtifactPath(text) };
  }
  return { kind: "text", text };
}

export function normalizeWorkflowArtifactPath(value: string) {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.replace(/\/+$/, "") || normalized;
}

/** Preserve the historical case-insensitive identity, without suffix matching. */
export function workflowArtifactPathKey(value: string, executionRoot?: string) {
  let normalized = normalizeWorkflowArtifactPath(value);
  if (executionRoot && (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized))) {
    const root = normalizeWorkflowArtifactPath(executionRoot).replace(/\/+$/, "");
    if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) normalized = normalized.slice(root.length + 1);
  }
  return normalized.toLowerCase();
}

/** Old dependency contracts allowed an unqualified basename. Retain that only
 * when it identifies one unique path; explicitly qualified paths stay exact. */
export function workflowRequiredArtifactMatches(required: string, available: string[]) {
  const target = workflowArtifactPathKey(required);
  const candidates = [...new Set(available.map((value) => {
    const declaration = parseWorkflowArtifactDeclaration(value);
    return declaration.kind === "path" || declaration.kind === "described" ? workflowArtifactPathKey(declaration.path) : null;
  }).filter((value): value is string => Boolean(value)))];
  if (target.includes("/")) return candidates.includes(target);
  const matches = candidates.filter((candidate) => candidate === target || candidate.endsWith(`/${target}`));
  return matches.length === 1;
}
