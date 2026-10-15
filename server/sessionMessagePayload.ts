/** Keep routing and display identity when a message payload exceeds the
 * transcript preview budget. Detailed logs remain available from Agent APIs. */
export function summarizeMessagePayload(payload: Record<string, unknown>) {
  const summary: Record<string, unknown> = { truncated: true };
  for (const field of ["type", "name", "tool", "action", "server", "tool_use_id", "toolUseId", "agent_id", "agentId", "status", "state", "provider", "providerId", "engine", "identityKey", "nickname", "agent_type", "agentType", "mode", "updatedAt", "parentThreadId", "parent_task_id", "path", "cwd", "task"]) {
    const value = payload[field];
    if (typeof value === "string") summary[field] = value.slice(0, field === "task" || field === "cwd" ? 2_000 : 384);
  }
  for (const field of ["exit_code", "revision", "logCount"]) {
    const value = payload[field];
    if (typeof value === "number" && Number.isFinite(value)) summary[field] = value;
  }
  for (const field of ["identityAliases", "ids", "receiver_thread_ids"]) {
    const value = payload[field];
    if (Array.isArray(value)) summary[field] = value.filter((item): item is string => typeof item === "string").slice(0, 8).map((item) => item.slice(0, 128));
  }
  if (payload.identity && typeof payload.identity === "object" && !Array.isArray(payload.identity)) {
    const source = payload.identity as Record<string, unknown>;
    const identity: Record<string, unknown> = {};
    for (const field of ["key", "agentId", "providerId", "sourceKind", "parentSessionId"]) {
      if (typeof source[field] === "string") identity[field] = source[field].slice(0, 512);
    }
    if (source.identityVersion === 1) identity.identityVersion = 1;
    summary.identity = identity;
  }
  if (Array.isArray(payload.logs) && summary.logCount === undefined) summary.logCount = payload.logs.length;
  return summary;
}
