export type SessionHealthCode = "healthy" | "running" | "missing-workspace" | "missing-native-thread" | "orphaned-assets" | "inconsistent-index" | "recoverable" | "broken";

export type SessionCapability = "open" | "resume" | "rename" | "pin" | "unpin" | "archive" | "unarchive" | "delete" | "delete-native" | "repair" | "export" | "branch";
export type WorkspaceCapability = "pin" | "unpin" | "archive" | "unarchive" | "delete" | "rename" | "open-folder";

export type SessionInventoryItem = {
  id: string;
  resourceId: string;
  kind: "session" | "workflow";
  source: "workbench" | "codex-official" | "claude-native";
  provider: string;
  title: string;
  workspaceId: string | null;
  workspaceName: string | null;
  workspacePath: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  usageTokens: number;
  archivedAt: string | null;
  pinned: boolean;
  branchAnchorId: string | null;
  nativeThreadId: string | null;
  linked: boolean;
  health: SessionHealthCode;
  issues: Array<{ code: SessionHealthCode; severity: "info" | "warning" | "error"; message: string; repairable: boolean }>;
  capabilities: SessionCapability[];
};

export type SessionScopeSummary = {
  id: string;
  kind: "all" | "workspace" | "standalone" | "missing" | "native";
  workspaceId: string | null;
  name: string;
  path: string | null;
  sessionCount: number;
  workflowCount: number;
  runningCount: number;
  archivedCount: number;
  usageTokens: number;
  updatedAt: string | null;
  pinned: boolean;
  archivedAt: string | null;
  capabilities: WorkspaceCapability[];
};

export type SessionManagementPreferences = {
  quickCheckOnStartup: boolean;
  autoRepairSafeIssues: boolean;
  includeNativeSessions: boolean;
  trashRetentionDays: number;
  pageSize: number;
};

export type SessionManagementSummary = { total: number; healthy: number; attention: number; running: number; archived: number; trash: number };

export type SessionInventoryResponse = {
  items: SessionInventoryItem[];
  total: number;
  selectionTotal: number;
  page: number;
  pageSize: number;
  summary: SessionManagementSummary;
  preferences: SessionManagementPreferences;
  warnings: string[];
  scopes: SessionScopeSummary[];
};

export type SessionTrashItem = {
  id: string;
  sessionId: string;
  title: string;
  provider: string;
  workspaceId: string | null;
  workspacePath: string | null;
  deletedAt: string;
  expiresAt: string;
  status: "ready" | "restoring" | "failed";
  error: string | null;
};

export type WorkspaceTrashItem = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  sessionCount: number;
  workflowCount: number;
  nativeCount: number;
  deletedAt: string;
  expiresAt: string;
  status: "ready" | "restoring" | "failed";
  error: string | null;
};

export type OperationPreview = {
  action: string;
  totalCount?: number;
  actionableCount?: number;
  sessionCount: number;
  workflowCount: number;
  blockerCount: number;
  blockers: Array<{ id: string; title: string; status: string; reason: string }>;
  sample?: Array<{ id: string; title: string; kind: "session" | "workflow"; workspaceName: string | null }>;
  workspace?: { id: string; name: string; path: string };
  workspaces?: Array<{ id: string; name: string; path: string }>;
  workspaceCount?: number;
  delegatedTaskCount?: number;
  nativeCount?: number;
  projectFilesPreserved?: boolean;
  nativeThreadsPreserved?: boolean;
};

export type RepairReport = {
  scannedAt: string;
  sessionCount: number;
  issueCount: number;
  repairedCount: number;
  orphanedDelegatedTasks: number;
  orphanedBindings: number;
  expiredLeases: number;
  items: SessionInventoryItem[];
};
