export type SessionPayloadShape = {
  id: string;
  scopeKind: "workspace" | "standalone";
  workspaceId: string;
  messages: unknown[];
  pendingInputs: unknown[];
};

export function isSessionPayload(value: unknown): value is SessionPayloadShape {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionPayloadShape>;
  return typeof candidate.id === "string"
    && candidate.id.length > 0
    && (candidate.scopeKind === "workspace" || candidate.scopeKind === "standalone")
    && typeof candidate.workspaceId === "string"
    && Array.isArray(candidate.messages)
    && Array.isArray(candidate.pendingInputs);
}

export type SessionNavigationIdentity = {
  sessionId: string;
  generation: number;
  selectionGeneration: number;
};

export function matchesSessionNavigation(value: unknown, expected: SessionNavigationIdentity) {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionNavigationIdentity> & { phase?: string };
  return candidate.phase === "loading"
    && candidate.sessionId === expected.sessionId
    && candidate.generation === expected.generation
    && candidate.selectionGeneration === expected.selectionGeneration;
}
