import type { Usage } from "@openai/codex-sdk";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { EngineName } from "../engines/types.js";
import type { RuntimeConfiguration } from "../runtime/config.js";
import type { RuntimeExecutionIdentity } from "../runtime/types.js";
import type { WorkbenchInterfaceSettings } from "../settings/pagePreferences.js";
import type { Attachment } from "../attachments.js";
import type { CanonicalActivityRecord } from "../activity/types.js";
import type { PendingInput as QueuePendingInput } from "../sessionInputs/types.js";
import type { ProviderConnectionProfile } from "../providers/connections.js";
import type { AgentProviderId, DelegationMode } from "../agents/types.js";

export type ClaudeSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  claudePath: string;
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
};

export type ModelOption = {
  id: string;
  displayName: string;
  createdAt?: string;
};

export type Settings = {
  defaultEngine: EngineName;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
  networkAccess: boolean;
  webSearch: "disabled" | "cached" | "live";
  codexPath: string;
  claude: ClaudeSettings;
  runtime: RuntimeConfiguration;
  interface: WorkbenchInterfaceSettings;
};

export type SkillPolicy = "auto" | "always" | "manual" | "off";
export type SkillPolicies = Record<string, SkillPolicy>;
export type ExecutionMode = "native" | "collaborative";
export type TaskFolder = { id: string; name: string; createdAt: string };
export type SkillFolder = { id: string; ownerUserId: string; name: string; position: number; pinned: boolean; createdAt: string; updatedAt: string };
export type SkillOrganization = { id: string; ownerUserId: string; skillName: string; folderId: string | null; position: number; archivedAt: string | null; updatedAt: string };
export type CapabilityProfile = { id: string; ownerUserId: string; name: string; description: string; skillPolicies: SkillPolicies; createdAt: string; updatedAt: string; lastUsedAt: string | null };

export type Workspace = {
  id: string;
  ownerUserId: string;
  name: string;
  root: string;
  createdAt: string;
  lastOpenedAt?: string;
  pinned?: boolean;
  archivedAt?: string | null;
  taskFolders?: TaskFolder[];
  agentSkillPolicies?: SkillPolicies;
  agentCapabilityProfileId?: string | null;
  agentSkillOverrides?: SkillPolicies;
  agentExecutionMode?: ExecutionMode;
  // Legacy fields are retained only while old state files migrate.
  agentSkillNames?: string[];
  agentMode?: "auto" | "all" | "off";
};

export type Message = {
  id: string;
  role: "user" | "assistant" | "event" | "error";
  text: string;
  createdAt: string;
  eventType?: string;
  eventPhase?: "started" | "updated" | "completed";
  activityCategory?: string;
  activityPhase?: "started" | "running" | "completed" | "failed";
  activityDetail?: unknown;
  activity?: CanonicalActivityRecord;
  sourceId?: string;
  payload?: unknown;
  attachments?: Attachment[];
};

export type SessionStatus = "idle" | "running" | "paused" | "completed" | "failed" | "stopped" | "interrupted";
export type PendingInput = QueuePendingInput<Attachment, SkillPolicies>;

export type Session = {
  id: string;
  ownerUserId: string;
  title: string;
  scopeKind: "workspace" | "standalone";
  workspaceId: string;
  codexThreadId: string | null;
  engine: EngineName;
  engineSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  usage: Usage;
  messages: Message[];
  pendingInputs: PendingInput[];
  status: SessionStatus;
  runStartedAt?: string;
  runFinishedAt?: string;
  lastError?: string;
  stopReason?: "user" | "pause" | "steer" | "shutdown" | "crash" | "timeout" | "unknown";
  deadlineAt?: string;
  parentSessionId?: string;
  branchedFromMessageId?: string;
  claudeInstructionsInjected?: boolean;
  revision: number;
  pinned?: boolean;
  archivedAt?: string | null;
  folderId?: string | null;
  standaloneSkillPolicies?: SkillPolicies;
  standaloneCapabilityProfileId?: string | null;
  standaloneExecutionMode?: ExecutionMode;
  providerConfigOptions?: SessionConfigOption[];
  providerConfigValues?: Record<string, string | boolean>;
  runtimeBinding?: RuntimeExecutionIdentity;
  creationMutationId?: string;
};

export type McpTransport = "stdio" | "http" | "sse";
export type McpServer = {
  id: string;
  ownerUserId: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabledWorkspaceIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type State = {
  settings: Settings;
  workspaces: Workspace[];
  sessions: Session[];
  delegatedTasks: DelegatedTask[];
  mcpServers: McpServer[];
  skillFolders: SkillFolder[];
  skillOrganizations: SkillOrganization[];
  capabilityProfiles: CapabilityProfile[];
  providerConnections: ProviderConnectionProfile[];
  delegationProtocolVersion: number;
};

export type DelegatedTask = {
  requestedProvider?: AgentProviderId | "auto";
  selectedProvider?: AgentProviderId;
  routingPolicy?: Record<string, unknown>;
  traceId?: string;
  reviewProvider?: AgentProviderId;
  capabilityRequirements?: string[];
  adapterOptions?: Record<string, unknown>;
  id: string;
  parentSessionId: string;
  provider: AgentProviderId;
  adapterId?: string;
  mode?: DelegationMode;
  nickname: string;
  cwd: string;
  task: string;
  status: "queued" | "running" | "completed" | "failed" | "interrupted";
  createdAt: string;
  updatedAt: string;
  usage: Usage;
  finalText?: string;
  lastError?: string;
  completedAt?: string;
  reviewedAt?: string;
  idempotencyKey?: string;
  requestFingerprint?: string;
  deadlineAt?: string;
  timeoutReason?: string;
  acceptance?: string[];
  retryCount?: number;
  retryOf?: string;
  runtimeBinding?: RuntimeExecutionIdentity;
  agentRevision?: number;
};

export type AgentLog = {
  id: string;
  createdAt: string;
  kind: "status" | "message" | "tool" | "result" | "error" | "reasoning";
  title: string;
  text: string;
  payload?: unknown;
  category?: string;
  phase?: "started" | "running" | "completed" | "failed";
  detail?: unknown;
  activity?: CanonicalActivityRecord;
};

export type AgentThread = {
  id: string;
  toolUseId?: string;
  parentThreadId: string;
  nickname: string;
  path: string;
  status: "running" | "completed" | "failed" | "interrupted";
  updatedAt: string;
  usage: Usage;
  logs: AgentLog[];
  provider?: AgentProviderId;
  mode?: DelegationMode;
  task?: string;
  logCount?: number;
  revision?: number;
  /** Immutable identity contract used to keep Provider/source attribution stable. */
  identity?: AgentThreadIdentity;
  /** Explicit aliases allow native and bridge projections of the same invocation to merge. */
  identityAliases?: string[];
};

export type AgentThreadSourceKind = "native" | "bridge" | "acp";
export type AgentThreadIdentity = {
  key: string;
  agentId: string;
  providerId: AgentProviderId;
  sourceKind: AgentThreadSourceKind;
  parentSessionId: string;
  identityVersion: 1;
};
