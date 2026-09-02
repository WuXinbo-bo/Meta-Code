export type CodexLinkThreadStatus = {
  type: string;
  activeFlags?: string[];
};

export type CodexLinkThread = {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  modelProvider: string;
  sourceKind: string;
  createdAt: number;
  updatedAt: number;
  status: CodexLinkThreadStatus;
  forkedFromId: string | null;
  isPinned: boolean;
  archived: boolean;
  turnCount?: number;
  historyMode: "legacy" | "paginated" | "unknown";
  resumable: boolean;
};

export type CodexLinkBinding = {
  id: string;
  ownerUserId: string;
  workspaceId: string;
  sessionId: string;
  threadId: string;
  accessMode: "resume" | "readOnly";
  threadName: string | null;
  threadPreview: string;
  previousThreadId: string | null;
  compatibilityMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CodexLinkThreadRead = {
  thread: CodexLinkThread;
  totalTurnCount: number;
  turns: CodexLinkTurnSummary[];
  limited: boolean;
  compatibilityMessage: string | null;
};

export type CodexLinkTurnSummary = {
  id: string;
  status: string;
  userText: string;
  assistantText: string;
};

export type CodexLinkConnection = {
  available: boolean;
  officialHome: string;
  executableAvailable: boolean;
  message: string;
};

export type CodexLinkLease = {
  ownerUserId: string;
  workspaceId: string;
  sessionId: string;
  threadId: string;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
};
