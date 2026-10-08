type ScopeInventory = {
  workspaces: Array<{ id: string; root: string }>;
  sessions: Array<{ id: string; workspaceId: string; executionRoot?: string }>;
  workflows: Array<{ id: string; workspaceId: string; executionRoot?: string; workDirectory?: string }>;
};

export function fileScopeRoot(scopeId: string, inventory: ScopeInventory | null | undefined): string {
  if (!inventory || !scopeId) return "";
  const workflow = inventory.workflows.find((item) => item.id === scopeId);
  if (workflow) return workflow.executionRoot || workflow.workDirectory || inventory.workspaces.find((item) => item.id === workflow.workspaceId)?.root || "";
  const session = inventory.sessions.find((item) => item.id === scopeId);
  if (session) return session.executionRoot || inventory.workspaces.find((item) => item.id === session.workspaceId)?.root || "";
  return inventory.workspaces.find((item) => item.id === scopeId)?.root || "";
}
