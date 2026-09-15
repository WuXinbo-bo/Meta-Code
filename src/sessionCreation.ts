export type PendingSessionCreation = {
  requestId: string;
  scopeKey: string;
  sessionId: string | null;
  phase: "requesting" | "admitting" | "syncing";
};

export function bindPendingSessionCreation(
  pending: PendingSessionCreation,
  sessionId: string,
  phase: PendingSessionCreation["phase"] = "admitting"
): PendingSessionCreation {
  return { ...pending, sessionId, phase };
}

export function upsertCreatedSession<T extends { id: string }>(sessions: readonly T[], created: T): T[] {
  return [created, ...sessions.filter((session) => session.id !== created.id)];
}

export function preservePendingCreatedSession<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
  pending: PendingSessionCreation | null
): T[] {
  const sessionId = pending?.sessionId;
  if (!sessionId || incoming.some((session) => session.id === sessionId)) return [...incoming];
  const admitted = current.find((session) => session.id === sessionId);
  return admitted ? upsertCreatedSession(incoming, admitted) : [...incoming];
}

export function reconcilePendingSessionCreation<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
  pending: PendingSessionCreation | null
) {
  const confirmed = pendingCreationConfirmed(pending, incoming);
  return {
    sessions: preservePendingCreatedSession(current, incoming, pending),
    pending: confirmed ? null : pending,
    confirmed
  };
}

export function sessionResourceIsKnown(
  sessionId: string,
  knownSessionIds: ReadonlySet<string>,
  pending: PendingSessionCreation | null
) {
  return knownSessionIds.has(sessionId) || pending?.sessionId === sessionId;
}

export function pendingCreationConfirmed(
  pending: PendingSessionCreation | null,
  sessions: readonly { id: string }[]
) {
  return Boolean(pending?.sessionId && sessions.some((session) => session.id === pending.sessionId));
}
