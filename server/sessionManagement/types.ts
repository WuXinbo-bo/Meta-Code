export type SessionSource = "workbench" | "codex-official" | "claude-native";

export type SessionHealthCode =
  | "healthy"
  | "running"
  | "missing-workspace"
  | "missing-native-thread"
  | "orphaned-assets"
  | "inconsistent-index"
  | "recoverable"
  | "broken";

export type SessionCapability =
  | "open"
  | "resume"
  | "rename"
  | "pin"
  | "unpin"
  | "archive"
  | "unarchive"
  | "delete"
  | "delete-native"
  | "repair"
  | "export"
  | "branch";

export type WorkspaceCapability = "pin" | "unpin" | "archive" | "unarchive" | "delete" | "rename" | "open-folder";

export type SessionHealthIssue = {
  code: SessionHealthCode;
  severity: "info" | "warning" | "error";
  message: string;
  repairable: boolean;
};

export type SessionInventoryItem = {
  id: string;
  resourceId: string;
  kind: "session" | "workflow";
  source: SessionSource;
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
  issues: SessionHealthIssue[];
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

export const DEFAULT_SESSION_MANAGEMENT_PREFERENCES: SessionManagementPreferences = {
  quickCheckOnStartup: true,
  autoRepairSafeIssues: false,
  includeNativeSessions: true,
  trashRetentionDays: 30,
  pageSize: 50
};

export type SessionRecoverySnapshot = {
  schemaVersion: 1;
  session: Record<string, unknown>;
  delegatedTasks: Array<Record<string, unknown>>;
  binding: Record<string, unknown> | null;
  createdAt: string;
};

export type SessionTrashItem = {
  id: string;
  sessionId: string;
  ownerUserId: string;
  title: string;
  provider: string;
  workspaceId: string | null;
  workspacePath: string | null;
  snapshotPath: string;
  batchId: string | null;
  deletedAt: string;
  expiresAt: string;
  status: "ready" | "restoring" | "failed";
  error: string | null;
};

export type WorkspaceTrashSnapshot = {
  schemaVersion: 1;
  workspace: Record<string, unknown>;
  workflowIds: string[];
  sessionTrashIds: string[];
  createdAt: string;
};

export type WorkspaceTrashItem = {
  id: string;
  ownerUserId: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  sessionCount: number;
  workflowCount: number;
  nativeCount: number;
  snapshot: WorkspaceTrashSnapshot;
  deletedAt: string;
  expiresAt: string;
  status: "ready" | "restoring" | "failed";
  error: string | null;
};

export type SessionManagementSummary = {
  total: number;
  healthy: number;
  attention: number;
  running: number;
  archived: number;
  trash: number;
};
