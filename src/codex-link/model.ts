export type CodexLinkAccessMode = "resume" | "readOnly";

export type CodexLinkBinding = {
  id: string;
  workspaceId: string;
  sessionId: string;
  threadId: string;
  accessMode: CodexLinkAccessMode;
  threadName: string | null;
  threadPreview: string;
  previousThreadId: string | null;
  compatibilityMessage: string | null;
  updatedAt: string;
};
