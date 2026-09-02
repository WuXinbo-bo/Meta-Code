import path from "node:path";

export type SessionScopeKind = "workspace" | "standalone";

export function normalizeSessionScope(scopeKind: unknown, workspaceId: unknown) {
  return scopeKind === "standalone"
    ? { scopeKind: "standalone" as const, workspaceId: "" }
    : { scopeKind: "workspace" as const, workspaceId: String(workspaceId || "") };
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
}

export function standaloneSessionContainer(runtimeDirectory: string, session: { id: string; ownerUserId: string }) {
  return path.join(path.resolve(runtimeDirectory), "standalone", safeSegment(session.ownerUserId), safeSegment(session.id));
}

export function standaloneSessionRoot(runtimeDirectory: string, session: { id: string; ownerUserId: string }) {
  return path.join(standaloneSessionContainer(runtimeDirectory, session), "workspace");
}

