type LinkedWorkflow = { id: string; taskContextId?: string | null; executionRoot?: string; workDirectory?: string; updatedAt: string };

function workflowRoot(workflow: LinkedWorkflow) {
  return workflow.executionRoot || workflow.workDirectory || "";
}

function rootsEqual(left?: string, right?: string) {
  if (!left || !right) return false;
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  if (normalizedLeft === normalizedRight) return true;
  // Windows drive and UNC paths are case-insensitive; preserve case for
  // POSIX roots because project paths may intentionally differ by case.
  const windowsPath = (value: string) => /^[a-z]:(?:\/|$)/i.test(value) || value.startsWith("//");
  return windowsPath(normalizedLeft) && windowsPath(normalizedRight) && normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

export function linkedWorkflowId(session: { id: string; taskContextId?: string | null; executionRoot?: string }, workflows: LinkedWorkflow[], pendingLink?: { sessionId: string; workflowId: string } | null): string {
  if (pendingLink?.sessionId === session.id) {
    const pendingWorkflow = workflows.find((workflow) => workflow.id === pendingLink.workflowId);
    // A just-created workflow may not be in the inventory yet. Keep that
    // temporary link until reconciliation, but never cross-link a known root.
    if (!pendingWorkflow || rootsEqual(session.executionRoot, workflowRoot(pendingWorkflow))) return pendingLink.workflowId;
  }
  if (!session.taskContextId) return "";
  return workflows.filter((workflow) => workflow.taskContextId === session.taskContextId)
    .filter((workflow) => rootsEqual(session.executionRoot, workflowRoot(workflow)))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]?.id || "";
}

export function handoffWorkflowId(sourceId: string, session: { taskContextId?: string | null; executionRoot?: string }, workflows: LinkedWorkflow[]): string {
  const linked = workflows.filter((workflow) => workflow.taskContextId && workflow.taskContextId === session.taskContextId && rootsEqual(session.executionRoot, workflowRoot(workflow)));
  // Legacy messages have no source ID. Only infer their target when the task
  // has a single round; opening a newer round would misrepresent its history.
  return sourceId ? linked.find((workflow) => workflow.id === sourceId)?.id || "" : linked.length === 1 ? linked[0].id : "";
}
