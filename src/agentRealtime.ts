export function agentChangeTargets(detail: Record<string, unknown>, sessionId: string, agentId: string) {
  if (String(detail.sessionId || "") !== sessionId) return false;
  const changedAgentId = String(detail.agentId || "");
  const changedAgents = Array.isArray(detail.agents) ? detail.agents : [];
  if (!changedAgentId && !changedAgents.length) return true;
  if (changedAgentId === agentId) return true;
  return changedAgents.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    return String((item as Record<string, unknown>).agentId || "") === agentId;
  });
}
