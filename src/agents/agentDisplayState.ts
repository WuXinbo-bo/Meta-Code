export type AgentDisplayStatus = "running" | "completed" | "failed" | "waiting" | "interrupted" | "unknown";

export type AgentDisplaySnapshot = {
  status?: string;
  revision?: number;
  updatedAt?: string;
};

const TERMINAL_STATUSES = new Set<AgentDisplayStatus>(["completed", "failed", "interrupted"]);
const KNOWN_STATUSES = new Set<AgentDisplayStatus>(["running", "completed", "failed", "waiting", "interrupted", "unknown"]);

export function normalizeAgentDisplayStatus(value: unknown): AgentDisplayStatus {
  const status = String(value || "").trim().toLowerCase();
  return KNOWN_STATUSES.has(status as AgentDisplayStatus) ? status as AgentDisplayStatus : "unknown";
}

function snapshotRevision(snapshot: AgentDisplaySnapshot) {
  return Number.isFinite(snapshot.revision) ? Number(snapshot.revision) : 0;
}

function snapshotTime(snapshot: AgentDisplaySnapshot) {
  const time = Date.parse(snapshot.updatedAt || "");
  return Number.isFinite(time) ? time : 0;
}

/**
 * Selects the freshest detail/summary snapshot without allowing an older
 * running response to replace a newer terminal state. Equal snapshots prefer
 * the terminal state, then the detail snapshot because it normally contains
 * the complete log payload.
 */
export function selectAgentDisplaySnapshot<T extends AgentDisplaySnapshot>(detail: T | null | undefined, summary: T | null | undefined): T | null {
  if (!detail) return summary || null;
  if (!summary) return detail;
  const detailRevision = snapshotRevision(detail);
  const summaryRevision = snapshotRevision(summary);
  if (detailRevision !== summaryRevision) return detailRevision > summaryRevision ? detail : summary;
  const detailTime = snapshotTime(detail);
  const summaryTime = snapshotTime(summary);
  if (detailTime !== summaryTime) return detailTime > summaryTime ? detail : summary;
  const detailStatus = normalizeAgentDisplayStatus(detail.status);
  const summaryStatus = normalizeAgentDisplayStatus(summary.status);
  const detailTerminal = TERMINAL_STATUSES.has(detailStatus);
  const summaryTerminal = TERMINAL_STATUSES.has(summaryStatus);
  if (detailTerminal !== summaryTerminal) return detailTerminal ? detail : summary;
  return detail;
}

export function isTerminalAgentDisplayStatus(value: unknown) {
  return TERMINAL_STATUSES.has(normalizeAgentDisplayStatus(value));
}
