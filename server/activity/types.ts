export const CURRENT_ACTIVITY_SCHEMA_VERSION = 1 as const;

/** Open provider id; unknown providers remain renderable through the fallback UI. */
export type ActivityProvider = string;
export type ActivityActorKind = "main" | "native" | "delegated" | "workflow" | "unknown";
export type ActivitySemanticType = "message" | "reasoning" | "command" | "file" | "read" | "search" | "mcp" | "tool" | "todo" | "status" | "result" | "error" | "unknown";
export type ActivityPhase = "started" | "running" | "completed" | "failed";

export type ActivityActor = {
  kind: ActivityActorKind;
  id?: string;
  parentId?: string;
  name?: string;
};

export type ActivityScope = {
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  workflowId?: string;
  nodeId?: string;
  attempt?: number;
};

export type ActivityArtifactRef = {
  id: string;
  kind: "diff" | "command-output" | "tool-result" | "raw-event" | "other";
  mediaType?: string;
  size?: number;
  path?: string;
};

export type ActivityDiagnostic = {
  code: string;
  message: string;
  level: "info" | "warning" | "error";
};

export type CommandActivityDetail = {
  command: string;
  cwd?: string;
  output?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  status?: string;
};

export type FileActivityChange = { path: string; kind?: "add" | "update" | "delete" | "rename"; previousPath?: string };
export type FileActivityDetail = {
  changes: FileActivityChange[];
  eventDiffs?: Record<string, { available: boolean; reason?: string; additions: number; deletions: number; lines: string[]; truncated: boolean; binary: boolean; artifactId?: string }>;
};
export type McpActivityDetail = { server: string; tool: string; arguments?: unknown; result?: unknown; error?: string };
export type TodoActivityDetail = { items: Array<{ id?: string; text: string; status?: string; completed?: boolean }> };
export type SubagentActivityDetail = { agentId: string; provider: string; name: string; status: string; parentId?: string };

export type StandardActivityDetail =
  | CommandActivityDetail
  | FileActivityDetail
  | McpActivityDetail
  | TodoActivityDetail
  | SubagentActivityDetail
  | Record<string, unknown>;

/** Stable provider-neutral event stored by every activity producer. */
export type CanonicalActivityRecord = {
  schemaVersion: typeof CURRENT_ACTIVITY_SCHEMA_VERSION;
  id: string;
  sourceId?: string;
  rawType: string;
  provider: ActivityProvider;
  actor: ActivityActor;
  scope?: ActivityScope;
  semanticType: ActivitySemanticType;
  phase: ActivityPhase;
  sequence?: number;
  occurredAt: string;
  title: string;
  summary: string;
  detail?: unknown;
  artifactRefs?: ActivityArtifactRef[];
  diagnostics?: ActivityDiagnostic[];
};

export type ActivityRecordInput = Omit<CanonicalActivityRecord, "schemaVersion" | "occurredAt" | "actor"> & {
  schemaVersion?: number;
  occurredAt?: string;
  actor?: Partial<ActivityActor>;
};
