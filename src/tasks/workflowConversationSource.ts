export type ConversationHandoff = {
  source: { kind: "session"; id: string; executionRoot?: string };
  sourceRevision: number;
  goal: string;
  latestUserRequest?: { text: string };
  decisions: string[];
  files: string[];
  unresolved: string[];
  attachments: Array<{ name: string }>;
  createdAt: string;
};

export type WorkflowTaskContext = {
  executions?: Array<{ kind: string; id: string; executionRoot?: string }>;
  handoffs?: Array<Omit<ConversationHandoff, "source"> & { source: { kind: string; id: string; executionRoot?: string } }>;
};

function rootsEqual(left?: string, right?: string) {
  if (!left || !right) return false;
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const a = normalize(left); const b = normalize(right);
  const windowsPath = (value: string) => /^[a-z]:(?:\/|$)/i.test(value) || value.startsWith("//");
  return a === b || windowsPath(a) && windowsPath(b) && a.toLowerCase() === b.toLowerCase();
}

/** A source badge describes the conversation snapshot available at creation. */
export function workflowConversationSource(context: WorkflowTaskContext | null | undefined, workflow: { createdAt?: string; executionRoot?: string; workDirectory?: string }): ConversationHandoff | null {
  const createdAt = Date.parse(workflow.createdAt || "");
  const executionRoot = workflow.executionRoot || workflow.workDirectory;
  if (!Number.isFinite(createdAt) || !executionRoot) return null;
  return (context?.handoffs || []).filter((handoff): handoff is ConversationHandoff => {
    const capturedAt = Date.parse(handoff.createdAt || "");
    if (handoff.source.kind !== "session" || !Number.isFinite(capturedAt) || capturedAt > createdAt) return false;
    // Legacy snapshots may use the host's trusted execution link for the root.
    const source = context?.executions?.find((execution) => execution.kind === "session" && execution.id === handoff.source.id);
    return Boolean(source) && rootsEqual(source?.executionRoot, executionRoot)
      && (!handoff.source.executionRoot || rootsEqual(handoff.source.executionRoot, executionRoot));
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] || null;
}
