export function agentChangeTargets(detail: Record<string, unknown>, sessionId: string, agentId: string, identityKey = "") {
  if (String(detail.sessionId || "") !== sessionId) return false;
  const changedAgentId = String(detail.agentId || "");
  const changedIdentityKey = String(detail.identityKey || (detail.identity && typeof detail.identity === "object" && !Array.isArray(detail.identity) ? (detail.identity as Record<string, unknown>).key || "" : ""));
  const changedAgents = Array.isArray(detail.agents) ? detail.agents : [];
  if (!changedAgentId && !changedAgents.length) return true;
  if (changedAgentId === agentId || (!!identityKey && changedIdentityKey === identityKey)) return true;
  return changedAgents.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    const itemIdentity = record.identity && typeof record.identity === "object" && !Array.isArray(record.identity)
      ? String((record.identity as Record<string, unknown>).key || "") : "";
    return String(record.agentId || record.id || "") === agentId || (!!identityKey && String(record.identityKey || itemIdentity) === identityKey);
  });
}
