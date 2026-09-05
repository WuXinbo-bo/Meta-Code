import { Component, Suspense, lazy, memo, startTransition, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { runtimeInstallationAction, type InstallationRuntime } from "./runtimeInstallation";
import {
  ArrowDown,
  ArrowLeft,
  Activity,
  Archive,
  ArchiveRestore,
  AtSign,
  Bot,
  Brain,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Clock3,
  Copy,
  Download,
  File,
  FileCode2,
  FileImage,
  FileSearch,
  FileText,
  FileSpreadsheet,
  FileType2,
  Folder,
  FolderOpen,
  Globe2,
  GripVertical,
  History,
  Import,
  LoaderCircle,
  Layers3,
  ListChecks,
  Menu,
  MessageSquarePlus,
  MessagesSquare,
  PanelLeftClose,
  Paperclip,
  Pause,
  Play,
  Pin,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Gauge,
  GitBranch,
  ListPlus,
  Pencil,
  Route,
  MoreHorizontal,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import { ProductLogo } from "./branding/ProductLogo";
import { ProviderIcon } from "./branding/ProviderIcon";
import { ConnectedProviderShowcase } from "./branding/ConnectedProviderShowcase";
import { ThemeToggle } from "./branding/ThemeToggle";
import { WorkflowWorkbench } from "./workflow/WorkflowWorkbench";
import { AgentConversation, useAgentOutputFollow } from "./components/AgentConversation";
import { RecoverableSectionBoundary } from "./components/RecoverableSectionBoundary";
import { AgentReplyContent } from "./components/AgentActivityEntry";
import { agentStreamVersion, normalizeAgentStreamLog, type SharedAgentLog } from "./components/activityModel";
import type { CodexLinkBinding } from "./codex-link/model";
import { RequestCoordinator } from "./requestCoordinator";
import { WorkspaceResourceCache } from "./workspaceResourceCache";
import { realtimeCoordinator } from "./realtimeCoordinator";
import { isSessionPayload, matchesSessionNavigation } from "./sessionNavigation";
import type { MarkdownBodyProps } from "./components/MarkdownBody";
import { WorkspaceFileTree } from "./components/WorkspaceFileTree";
import { workspaceFilePathEquals, workspaceFilePathIdentity } from "./files/filePathIdentity";
import { fileKind, isPreviewFileKind, type PreviewFile, type WorkspaceFileNode } from "./files/fileTypes";
import {
  WorkspaceBrowserTabs,
  closeWorkspaceBrowserFileTabs,
  closeWorkspaceBrowserTab,
  createWorkspaceBrowserTabsState,
  loadWorkspaceBrowserTabs,
  reconcileWorkspaceBrowserTabs,
  reduceWorkspaceBrowserTabs,
  remapWorkspaceBrowserFilePath,
  saveWorkspaceBrowserTabs,
  workspaceBrowserConversationViewState,
  workspaceBrowserFilePathAtOrBelow,
  workspaceBrowserResourceKey,
  workspaceBrowserScopeId,
  type FileBrowserResource,
  type WorkspaceBrowserTabsAction,
  type WorkspaceBrowserTabsState
} from "./workspace-browser";
import { PageSettings } from "./settings/PageSettings";
import { SettingsNavigation, type AgentSettingsPage, type SettingsSectionName } from "./settings/SettingsNavigation";
import { AgentMarketSettings } from "./settings/AgentMarketSettings";
import { InstalledProviderConnections } from "./settings/InstalledProviderConnections";
import { ProviderConnectionControl } from "./settings/ProviderConnectionControl";
import { ProviderSettingsPanel } from "./settings/ProviderSettingsPanel";
import { AppUpdateAnnouncement } from "./settings/AppUpdateAnnouncement";
import { AppUpdateSettings } from "./settings/AppUpdateSettings";
import { DataSettings } from "./settings/DataSettings";
import { HelpCenter } from "./help/HelpCenter";
import { HelpButton } from "./help/HelpProvider";
import { CURRENT_GUIDE_VERSION, FirstRunGuide } from "./onboarding/FirstRunGuide";
import { formatRuntimeProgressDuration, runtimeProgressElapsedMs } from "./runtimeProgress";
import { CapabilityProfileControl } from "./chat/CapabilityProfileControl";
import { ComposerRuntimeControl } from "./chat/ComposerRuntimeControl";
import { PendingTurnTray } from "./chat/PendingTurnTray";
import { OperationCenter } from "./components/OperationCenter";
import { confirmAction } from "./components/ConfirmationProvider";
import { WorkspaceDropZone } from "./workspaces/WorkspaceDropZone";
import { GitWorkbench } from "./git/GitWorkbench";
import { workspaceNameFromPath } from "./workspaces/dropValidation";
import type { ExecutionMode, ModelOption, PendingTurn, ProviderSessionConfiguration } from "./chat/types";
import type { AgentProviderDescriptor } from "./agents/types";
import type { ProviderControlSnapshot } from "./providers/types";
import { providerMainAgentUnavailableReason } from "./providers/display";
import {
  DEFAULT_WORKBENCH_INTERFACE_SETTINGS,
  normalizeWorkbenchInterfaceSettings,
  type WorkbenchInterfaceSettings
} from "./settings/pagePreferences";
import "highlight.js/styles/github.css";

const MarkdownBodyRenderer = lazy(() => import("./components/MarkdownBody"));
const FilePreviewRenderer = lazy(() => import("./components/FilePreview"));
const SessionManagementView = lazy(() => import("./session-management/SessionManagementView"));

function MarkdownBody(props: MarkdownBodyProps) {
  return <Suspense fallback={<div className="markdown-planning"><LoaderCircle className="spin" size={15} /></div>}>
    <MarkdownBodyRenderer {...props} />
  </Suspense>;
}

const MESSAGE_INITIAL_RENDER = 80;
const MESSAGE_HISTORY_REQUEST = 100;
const MESSAGE_HISTORY_CHUNK = 20;
const MESSAGE_VIRTUALIZE_THRESHOLD = 40;

type SettingsData = {
  defaultEngine: EngineName;
  baseUrl: string;
  apiKeyConfigured: boolean;
  model: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
  networkAccess: boolean;
  webSearch: "disabled" | "cached" | "live";
  codexPath: string;
  runtime: RuntimeConfiguration;
  interface: WorkbenchInterfaceSettings;
  claude: {
    baseUrl: string;
    apiKeyConfigured: boolean;
    model: string;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    claudePath: string;
    permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  };
};
type SettingsFormData = SettingsData & {
  apiKey: string;
  clearApiKey: boolean;
  claude: SettingsData["claude"] & { apiKey: string; clearApiKey: boolean };
};

function settingsFormData(settings: SettingsData): SettingsFormData {
  return {
    ...settings,
    runtime: normalizeRuntimeConfiguration(settings.runtime),
    interface: normalizeWorkbenchInterfaceSettings(settings.interface),
    apiKey: "",
    clearApiKey: false,
    claude: { ...settings.claude, apiKey: "", clearApiKey: false }
  };
}

function settingsSavePayload(form: SettingsFormData) {
  return {
    defaultEngine: form.defaultEngine,
    baseUrl: form.baseUrl,
    apiKey: form.apiKey,
    clearApiKey: form.clearApiKey,
    model: form.model,
    reasoningEffort: form.reasoningEffort,
    sandboxMode: form.sandboxMode,
    approvalPolicy: form.approvalPolicy,
    networkAccess: form.networkAccess,
    webSearch: form.webSearch,
    runtime: form.runtime,
    interface: form.interface,
    claude: {
      baseUrl: form.claude.baseUrl,
      apiKey: form.claude.apiKey,
      clearApiKey: form.claude.clearApiKey,
      model: form.claude.model,
      effort: form.claude.effort,
      permissionMode: form.claude.permissionMode
    }
  };
}
type EngineName = string;
type ContestMode = "quick" | "balanced" | "champion";
type PaperFormat = "latex" | "docx";
type SkillPolicy = "auto" | "always" | "manual" | "off";
type SkillPolicies = Record<string, SkillPolicy>;
type TaskFolder = { id: string; name: string; createdAt: string };

type Workspace = { id: string; name: string; root: string; createdAt: string; lastOpenedAt?: string; pinned?: boolean; archivedAt?: string | null; taskFolders?: TaskFolder[]; agentSkillPolicies?: SkillPolicies; agentCapabilityProfileId?: string | null; agentSkillOverrides?: SkillPolicies; agentExecutionMode?: ExecutionMode; agentSkillNames?: string[]; agentMode?: AgentDispatchMode };
type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};
type TaskDeletionPolicy = {
  action: "delete" | "terminate-and-delete";
  requiresTermination: boolean;
  reason: string | null;
};
type SessionSummary = {
  id: string;
  title: string;
  scopeKind: "workspace" | "standalone";
  workspaceId: string;
  codexThreadId: string | null;
  engine: EngineName;
  engineSessionId: string | null;
  updatedAt: string;
  messageCount: number;
  usage: Usage;
  usageSource?: "codex" | "claude" | "completed" | "pending";
  usageSummary?: {
    main: Usage;
    agents: Usage;
    total: Usage;
    agentCount: number;
  };
  status: "idle" | "running" | "paused" | "completed" | "failed" | "stopped" | "interrupted";
  runStartedAt?: string;
  runFinishedAt?: string;
  lastError?: string;
  revision: number;
  pinned?: boolean;
  archivedAt?: string | null;
  folderId?: string | null;
  standaloneSkillPolicies?: SkillPolicies;
  standaloneCapabilityProfileId?: string | null;
  standaloneExecutionMode?: ExecutionMode;
  deletionPolicy?: TaskDeletionPolicy;
};
type WorkflowSummary = {
  id: string;
  title: string;
  workspaceId: string;
  workDirectory: string;
  plannerEngine: EngineName;
  maxConcurrentAgents: number | null;
  status: string;
  revision: number;
  pinned: boolean;
  archivedAt: string | null;
  folderId: string | null;
  updatedAt: string;
  createdAt: string;
  deletionPolicy?: TaskDeletionPolicy;
};
type AgentProfile = { name: string; title: string; description: string; builtIn: boolean };
type SkillFolder = { id: string; name: string; position: number; pinned: boolean; createdAt: string; updatedAt: string };
type SkillOrganization = { id: string; skillName: string; folderId: string | null; position: number; archivedAt: string | null; updatedAt: string };
type CapabilityProfile = { id: string; name: string; description: string; skillPolicies: SkillPolicies; createdAt: string; updatedAt: string; lastUsedAt: string | null };
type AgentDispatchMode = "auto" | "all" | "off";
type McpServer = {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string;
  args: string[];
  url: string;
  envKeys: string[];
  headerKeys: string[];
  enabledWorkspaceIds: string[];
  createdAt: string;
  updatedAt: string;
};
type Attachment = {
  id: string;
  name: string;
  relativePath: string;
  mimeType: string;
  size: number;
  sha256: string;
};
type DraftAttachment = {
  id: string;
  file: File;
  uploaded?: Attachment & { sessionId: string };
};
type Message = {
  id: string;
  role: "user" | "assistant" | "event" | "error";
  text: string;
  createdAt: string;
  eventType?: string;
  eventPhase?: "started" | "updated" | "completed";
  activityCategory?: string;
  activityPhase?: "started" | "running" | "completed" | "failed";
  activityDetail?: unknown;
  activity?: SharedAgentLog["activity"];
  payload?: unknown;
  attachments?: Attachment[];
};
type ClaudeQuestionOption = { label: string; description: string };
type ClaudeQuestion = { header: string; question: string; multiSelect: boolean; options: ClaudeQuestionOption[] };
type PendingInput = PendingTurn<Attachment>;
type Session = SessionSummary & {
  messages: Message[];
  pendingInputs: PendingInput[];
  parentSessionId?: string;
  branchedFromMessageId?: string;
  messageWindow?: MessageWindow;
};
type MessageWindow = { start: number; end: number; total: number; hasMore: boolean };
type MessagePage = { messages: Message[]; window: MessageWindow };
type ActivityMessageGroup = { id: string; role: "activity-group"; messages: Message[] };
type SidebarTaskItem = { kind: "chat"; task: SessionSummary } | { kind: "workflow"; task: WorkflowSummary };
type NoticeTone = "error" | "success" | "info" | "warning";
type Notice = { message: string; tone: NoticeTone };
type TreeNode = WorkspaceFileNode;
type CachedFilePreview = { file: PreviewFile; scopeId: string; workspaceRoot: string };
type RuntimeUseMode = "system" | "custom" | "managed";
type CliRuntimeId = string;
type RuntimeConfiguration = {
  network: {
    proxyMode: "system" | "off" | "custom";
    proxyUrl: string;
    registryMode: "auto" | "official" | "custom";
    customRegistry: string;
    inactivityTimeoutSeconds: number;
  };
  selections: Record<CliRuntimeId, { mode: RuntimeUseMode; systemPath: string; customPath: string }>;
};
const DEFAULT_RUNTIME_CONFIGURATION: RuntimeConfiguration = {
  network: {
    proxyMode: "system",
    proxyUrl: "",
    registryMode: "auto",
    customRegistry: "",
    inactivityTimeoutSeconds: 120
  },
  selections: {
    codex: { mode: "system", systemPath: "", customPath: "" },
    claude: { mode: "system", systemPath: "", customPath: "" }
  }
};

function normalizeRuntimeConfiguration(configuration?: Partial<RuntimeConfiguration>): RuntimeConfiguration {
  const normalizeSelection = (id: CliRuntimeId): RuntimeConfiguration["selections"][CliRuntimeId] => {
    const selection = configuration?.selections?.[id];
    const mode: RuntimeUseMode = selection?.mode === "custom" || selection?.mode === "managed" ? selection.mode : "system";
    return { mode, systemPath: String(selection?.systemPath || ""), customPath: String(selection?.customPath || "") };
  };
  const runtimeIds = [...new Set([...Object.keys(DEFAULT_RUNTIME_CONFIGURATION.selections), ...Object.keys(configuration?.selections || {})])];
  return {
    network: { ...DEFAULT_RUNTIME_CONFIGURATION.network, ...(configuration?.network || {}) },
    selections: Object.fromEntries(runtimeIds.map((id) => [id, normalizeSelection(id)]))
  };
}
type CodexRuntimeStatus = InstallationRuntime & {
  available: boolean;
  source: "configured" | "bundled" | "runtime" | "system" | "missing";
  path: string;
  version: string;
  npmAvailable: boolean;
  networkRequired: boolean;
  message: string;
  selectionMode?: RuntimeUseMode;
  candidates?: Array<{ source: "configured" | "bundled" | "runtime" | "system" | "missing"; path: string; version: string; label: string }>;
  managed: { installed: boolean; healthy?: boolean; activeVersion: string; installedVersions: string[] };
};
type RuntimeUpdateStatus = {
  runtimeId: CliRuntimeId;
  mode: RuntimeUseMode;
  currentVersion: string;
  latestVersion: string;
  state: "not-installed" | "latest" | "available" | "newer-local" | "external";
  action: "install" | "update" | "install-managed" | "none";
  selectedRegistry: string;
  probes: RuntimeSourceProbe[];
};
type CliRuntimeCatalogItem = { id: CliRuntimeId; label: string; displayOrder?: number; capabilities?: { managedInstall: boolean; updateCheck: boolean; sourceProbe: boolean }; status: CodexRuntimeStatus };
type RuntimeInstallProgress = {
  runtimeId: CliRuntimeId;
  operationId?: string;
  sequence?: number;
  phase: "started" | "probing" | "downloading" | "installing" | "verifying" | "certifying" | "activated" | "failed" | "interrupted";
  message: string;
  version?: string;
  startedAt: string;
  updatedAt: string;
  active: boolean;
  resumable?: boolean;
  registry?: string;
  artifact?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  sourceProbes?: RuntimeSourceProbe[];
};
type RuntimeSourceProbe = { registry: string; latencyMs: number; available: boolean; version: string; error: string };
type Bootstrap = {
  user: { id: string };
  settings: SettingsData;
  workspaces: Workspace[];
  sessions: SessionSummary[];
  workflows: WorkflowSummary[];
  skills: AgentProfile[];
  skillFolders: SkillFolder[];
  skillOrganizations: SkillOrganization[];
  capabilityProfiles: CapabilityProfile[];
  mcpServers: McpServer[];
  agentProviders: AgentProviderDescriptor[];
  providerControls: ProviderControlSnapshot[];
  runtime: { dataHome: string; codexHome: string; claudeHome: string; sdk: string; codex: CodexRuntimeStatus; claude: CodexRuntimeStatus; providers: Record<string, CodexRuntimeStatus> };
};
type NavigationSnapshot = Pick<Bootstrap, "workspaces" | "sessions" | "workflows">;
type ProviderControlBundle = Pick<Bootstrap["runtime"], "codex" | "claude" | "providers"> & {
  providerControls: ProviderControlSnapshot[];
  generatedAt: string;
};

function mergeBootstrapProviderState(current: Bootstrap | null, next: Bootstrap): Bootstrap {
  if (!current) return next;
  const controlsById = new Map(current.providerControls.map((control) => [control.providerId, control]));
  for (const control of next.providerControls) controlsById.set(control.providerId, control);
  return {
    ...next,
    providerControls: next.agentProviders.map((provider) => controlsById.get(provider.id)).filter(Boolean) as ProviderControlSnapshot[],
    runtime: {
      ...next.runtime,
      providers: { ...current.runtime.providers, ...next.runtime.providers }
    }
  };
}
type SessionNavigationSource = "task" | "workspace" | "scope";
type SessionNavigationState =
  | { phase: "idle" }
  | {
      phase: "loading";
      source: SessionNavigationSource;
      sessionId: string;
      summary: SessionSummary;
      generation: number;
      selectionGeneration: number;
    };

function normalizeBootstrap(value: Bootstrap): Bootstrap {
  return {
    ...value,
    skills: value.skills.map(normalizeSkillProfile),
    agentProviders: value.agentProviders || [],
    providerControls: value.providerControls || [],
    runtime: {
      ...value.runtime,
      providers: value.runtime.providers || { claude: value.runtime.claude, codex: value.runtime.codex }
    }
  };
}

const ACTIVE_WORKSPACE_KEY = "modelx.activeWorkspaceId";
const ACTIVE_TASK_SCOPE_KEY = "modelx.activeTaskScope";
const ACTIVE_SESSION_MAP_KEY = "modelx.activeSessionByWorkspace";
const ACTIVE_WORKFLOW_MAP_KEY = "modelx.activeWorkflowByWorkspace";
const AGENT_SELECTION_KEY_PREFIX = "modelx.agentSelection";
const LAYOUT_WIDTHS_KEY = "modelx.workspaceLayoutWidths.v2";
const DEFAULT_LAYOUT_WIDTHS = { sidebar: 228, inspector: 250 } as const;
const SESSION_CACHE_FRESH_MS = 15_000;
const ACTIVE_TASK_STATUSES = new Set(["running", "paused", "queued", "integrating"]);
type LayoutWidths = { sidebar: number; inspector: number };
type ResizingPane = keyof LayoutWidths;
type SidebarSection = "tasks" | "workspaces";

function readLayoutWidths(): LayoutWidths {
  if (typeof window === "undefined") return { ...DEFAULT_LAYOUT_WIDTHS };
  try {
    const parsed = JSON.parse(localStorage.getItem(LAYOUT_WIDTHS_KEY) || "{}");
    return {
      sidebar: Number.isFinite(parsed.sidebar) ? Math.min(420, Math.max(220, Number(parsed.sidebar))) : DEFAULT_LAYOUT_WIDTHS.sidebar,
      inspector: Number.isFinite(parsed.inspector) ? Math.min(420, Math.max(220, Number(parsed.inspector))) : DEFAULT_LAYOUT_WIDTHS.inspector
    };
  } catch {
    return { ...DEFAULT_LAYOUT_WIDTHS };
  }
}
const BUILTIN_DELEGATION_SKILL_NAME = "claude-codex-planner";
const BUILTIN_SKILL_MANAGER_NAME = "metacode-manager";
const PINNED_BUILTIN_SKILL_ORDER = [BUILTIN_SKILL_MANAGER_NAME, BUILTIN_DELEGATION_SKILL_NAME] as const;

function normalizeSkillProfile(skill: AgentProfile): AgentProfile {
  return skill.name === BUILTIN_SKILL_MANAGER_NAME ? { ...skill, title: "Meta Code 管家" } : skill;
}

function activeSessionMap(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(ACTIVE_SESSION_MAP_KEY) || "{}");
  } catch {
    return {};
  }
}

function activeWorkflowMap(): Record<string, string> {
  try { return JSON.parse(sessionStorage.getItem(ACTIVE_WORKFLOW_MAP_KEY) || "{}"); }
  catch { return {}; }
}

function rememberSession(workspaceId: string, sessionId: string) {
  const map = activeSessionMap();
  map[workspaceId] = sessionId;
  sessionStorage.setItem(ACTIVE_SESSION_MAP_KEY, JSON.stringify(map));
}

function rememberWorkflow(workspaceId: string, workflowId: string) {
  const map = activeWorkflowMap();
  map[workspaceId] = workflowId;
  sessionStorage.setItem(ACTIVE_WORKFLOW_MAP_KEY, JSON.stringify(map));
}

function forgetWorkspaceWorkflow(workspaceId: string) {
  const map = activeWorkflowMap();
  delete map[workspaceId];
  sessionStorage.setItem(ACTIVE_WORKFLOW_MAP_KEY, JSON.stringify(map));
}

function forgetSession(sessionId: string) {
  const map = activeSessionMap();
  for (const [workspaceId, rememberedId] of Object.entries(map)) {
    if (rememberedId === sessionId) delete map[workspaceId];
  }
  sessionStorage.setItem(ACTIVE_SESSION_MAP_KEY, JSON.stringify(map));
}

function forgetWorkflow(workflowId: string) {
  const map = activeWorkflowMap();
  for (const [workspaceId, rememberedId] of Object.entries(map)) if (rememberedId === workflowId) delete map[workspaceId];
  sessionStorage.setItem(ACTIVE_WORKFLOW_MAP_KEY, JSON.stringify(map));
}

function relativeTime(input: string, now = Date.now()) {
  const timestamp = new Date(input).getTime();
  const delta = now - timestamp;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Date(input).toLocaleDateString();
}

function compactLine(text: string, max = 180) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

function productEventText(text: string) {
  return text
    .replaceAll("Codex task started", "任务已开始")
    .replace(/^Working$/i, "智能体正在工作");
}

function eventPhaseLabel(phase?: Message["eventPhase"]) {
  if (phase === "started") return "开始";
  if (phase === "updated") return "进行中";
  if (phase === "completed") return "完成";
  return phase || "";
}

function emptyUsage(): Usage {
  return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
}

function usageTotal(usage?: Usage | null) {
  return (usage?.input_tokens || 0) + (usage?.output_tokens || 0);
}

function formatTokens(value: number) {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatBytes(value = 0) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentList({ attachments, onOpen }: { attachments?: Attachment[]; onOpen: (path: string) => void }) {
  if (!attachments?.length) return null;
  return <div className="message-attachments">
    {attachments.map((attachment) => <button
      type="button"
      key={attachment.id}
      title={`打开 ${attachment.relativePath}`}
      onClick={() => onOpen(attachment.relativePath)}
    >
      {attachment.mimeType.startsWith("image/") ? <FileImage size={15} /> : <File size={15} />}
      <span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size)}</small></span>
    </button>)}
  </div>;
}

function sandboxLabel(mode: SettingsData["sandboxMode"]) {
  if (mode === "danger-full-access") return "完全访问";
  if (mode === "workspace-write") return "工作区写入";
  return "只读";
}

function webSearchLabel(mode: SettingsData["webSearch"]) {
  if (mode === "live") return "实时联网";
  if (mode === "cached") return "缓存联网";
  return "未联网";
}

function sessionStatusLabel(status: SessionSummary["status"]) {
  if (status === "running") return "执行中";
  if (status === "paused") return "已暂停";
  if (status === "failed") return "失败";
  if (status === "stopped") return "已停止";
  if (status === "interrupted") return "可继续";
  if (status === "completed") return "已完成";
  return "未开始";
}

function workflowStatusLabel(status: string) {
  const labels: Record<string, string> = { draft: "待规划", planning: "规划中", awaiting_approval: "待审批", queued: "排队中", running: "执行中", integrating: "整合中", completed: "已完成", needs_review: "待处理", paused: "已暂停", failed: "失败", canceled: "已取消" };
  return labels[status] || status;
}

function policyShortLabel(policy: SkillPolicy) {
  return policy === "auto" ? "自动" : policy === "always" ? "始终" : policy === "manual" ? "手动" : "关闭";
}

function mergeWorkspaceTree(previous: WorkspaceFileNode[], incoming: WorkspaceFileNode[]): WorkspaceFileNode[] {
  const previousByPath = new Map(previous.map((node) => [workspaceFilePathIdentity(node.path), node]));
  return incoming.map((node) => {
    const existing = previousByPath.get(workspaceFilePathIdentity(node.path));
    if (node.type !== "directory") return node;
    if (!node.childrenLoaded && existing?.childrenLoaded) return { ...node, children: existing.children, childrenLoaded: true, hasChildren: Boolean(existing.children?.length) };
    if (node.childrenLoaded) return { ...node, children: mergeWorkspaceTree(existing?.children || [], node.children || []) };
    return node;
  });
}

function replaceWorkspaceTreeChildren(nodes: WorkspaceFileNode[], directoryPath: string, children: WorkspaceFileNode[]): WorkspaceFileNode[] {
  return nodes.map((node) => {
    if (workspaceFilePathEquals(node.path, directoryPath)) return { ...node, children, childrenLoaded: true, hasChildren: Boolean(children.length) };
    if (!node.children?.length) return node;
    return { ...node, children: replaceWorkspaceTreeChildren(node.children, directoryPath, children) };
  });
}

function workspaceTreeContainsQuery(nodes: WorkspaceFileNode[], query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return nodes.length > 0;
  return nodes.some((node) => node.name.toLocaleLowerCase().includes(normalized) || node.path.toLocaleLowerCase().includes(normalized) || workspaceTreeContainsQuery(node.children || [], normalized));
}

function workspaceTreeNodeCount(nodes: WorkspaceFileNode[]): number {
  return nodes.reduce((total, node) => total + 1 + workspaceTreeNodeCount(node.children || []), 0);
}

function workspaceTreeNodeByPath(nodes: WorkspaceFileNode[], targetPath: string): WorkspaceFileNode | undefined {
  for (const node of nodes) {
    if (workspaceFilePathEquals(node.path, targetPath)) return node;
    const nested = workspaceTreeNodeByPath(node.children || [], targetPath);
    if (nested) return nested;
  }
  return undefined;
}

type JsonRecord = Record<string, unknown>;
type SubagentInfo = {
  isSubagent: boolean;
  action: string;
  agentIds: string[];
  nickname?: string;
  agentType?: string;
  provider?: string;
  task?: string;
  status: "running" | "completed" | "failed" | "waiting" | "interrupted" | "unknown";
};
type AgentLog = {
  id: string;
  createdAt: string;
  kind: "status" | "message" | "tool" | "result" | "error" | "reasoning";
  title: string;
  text: string;
  payload?: unknown;
  category?: string;
  phase?: "started" | "running" | "completed" | "failed";
  detail?: unknown;
  activity?: SharedAgentLog["activity"];
};
type AgentThread = {
  id: string;
  parentThreadId: string;
  nickname: string;
  path: string;
  status: "running" | "completed" | "failed" | "interrupted";
  updatedAt: string;
  usage: Usage;
  logs: AgentLog[];
  provider?: string;
  mode?: "analysis" | "review" | "implementation";
  task?: string;
  logCount?: number;
};

const agentThreadSummaryCache = new WorkspaceResourceCache<AgentThread[]>(12);
const agentThreadDetailCache = new WorkspaceResourceCache<AgentThread>(24);

const SUBAGENT_ACTIONS = new Set([
  "spawn_agent",
  "create_agent",
  "send_input",
  "wait_agent",
  "wait_agents",
  "close_agent",
  "resume_agent"
]);
const DEEP_SCAN_SKIP_KEYS = new Set(["logs", "events", "messages"]);

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function parseJsonRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function claudeQuestions(message: Message): ClaudeQuestion[] {
  if (message.eventType !== "user_question") return [];
  const payload = asRecord(message.payload);
  const input = asRecord(payload?.input);
  const values = Array.isArray(payload?.questions) ? payload.questions : Array.isArray(input?.questions) ? input.questions : [];
  return values.flatMap((value) => {
    const question = asRecord(value);
    const text = typeof question?.question === "string" ? question.question.trim() : "";
    if (!text) return [];
    const options = (Array.isArray(question?.options) ? question.options : []).flatMap((optionValue) => {
      const option = asRecord(optionValue);
      const label = typeof option?.label === "string" ? option.label.trim() : "";
      if (!label) return [];
      return [{ label, description: typeof option?.description === "string" ? option.description.trim() : "" }];
    });
    return [{
      header: typeof question?.header === "string" ? question.header.trim() : "",
      question: text,
      multiSelect: question?.multiSelect === true,
      options
    }];
  });
}

function collectDeepValues(value: unknown, keyNames: Set<string>, depth = 0): unknown[] {
  if (depth > 6) return [];
  const record = asRecord(value);
  if (!record) {
    if (Array.isArray(value)) return value.flatMap((item) => collectDeepValues(item, keyNames, depth + 1));
    if (typeof value === "string") {
      const parsed = parseJsonRecord(value);
      return parsed ? collectDeepValues(parsed, keyNames, depth + 1) : [];
    }
    return [];
  }
  const found: unknown[] = [];
  for (const [key, child] of Object.entries(record)) {
    if (keyNames.has(key)) found.push(child);
    if (DEEP_SCAN_SKIP_KEYS.has(key)) continue;
    found.push(...collectDeepValues(child, keyNames, depth + 1));
  }
  return found;
}

function firstDeepString(value: unknown, keys: string[]) {
  return collectDeepValues(value, new Set(keys)).find((item): item is string => typeof item === "string");
}

function subagentInfo(message: Message): SubagentInfo {
  const payload = asRecord(message.payload);
  const action = String(
    payload?.tool ||
    payload?.name ||
    payload?.action ||
    payload?.type ||
    message.eventType ||
    ""
  ).toLowerCase();
  const server = String(payload?.server || "").toLowerCase();
  const type = String(payload?.type || message.eventType || "").toLowerCase();
  const actionIsAgent = SUBAGENT_ACTIONS.has(action);
  const isSubagent =
    actionIsAgent ||
    server.includes("agent") ||
    type.includes("subagent") ||
    type.includes("collab") ||
    message.eventType === "agent_tool_call" ||
    message.eventType === "subagent";

  const directAgentId = typeof payload?.agent_id === "string" ? payload.agent_id : typeof payload?.agentId === "string" ? payload.agentId : "";
  const idValues = [directAgentId, ...collectDeepValues(message.payload, new Set([
    "agent_id",
    "agentId",
    "receiver",
    "ids",
    "receiver_thread_ids"
  ]))];
  const agentIds = [...new Set(idValues.flatMap((value) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") :
    typeof value === "string" ? [value] : []
  ))].filter(Boolean);
  const rawStatus = String(payload?.status || payload?.state || firstDeepString(message.payload, ["status", "state"]) || "").toLowerCase();
  const status =
    rawStatus.includes("fail") || rawStatus.includes("error") ? "failed" :
    rawStatus.includes("complete") || rawStatus.includes("closed") ? "completed" :
    rawStatus.includes("interrupt") || rawStatus.includes("stop") ? "interrupted" :
    action.startsWith("wait") ? "waiting" :
    message.eventPhase === "completed" ? "completed" :
    message.eventPhase === "started" || rawStatus.includes("progress") || action === "spawn_agent" || action === "agent" || action === "task" ? "running" :
    "unknown";
  const nickname = typeof payload?.nickname === "string" ? payload.nickname : firstDeepString(message.payload, ["nickname", "agent_name", "agentName", "description"]);
  const agentType = typeof payload?.agent_type === "string" ? payload.agent_type : firstDeepString(message.payload, ["agent_type", "agentType"]);
  const providerSignals = [
    payload?.provider,
    payload?.engine,
    payload?.model,
    payload?.runtime,
    payload?.backend,
    payload?.agent_type,
    payload?.agentType,
    payload?.name,
    payload?.type,
    server,
    nickname,
    agentType,
    ...collectDeepValues(message.payload, new Set(["provider", "engine", "model", "runtime", "backend", "agent_type", "agentType", "agent_name", "agentName"]))
  ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
  const directProvider = [payload?.provider, payload?.engine, payload?.runtime]
    .find((value): value is string => typeof value === "string" && /^[a-z][a-z0-9._-]{0,63}$/i.test(value.trim()))
    ?.trim().toLowerCase();
  const provider = directProvider || (/claude|anthropic|opus|sonnet|haiku/.test(providerSignals)
    ? "claude"
    : /codex|openai|gpt(?:-|\b)|o[1-9](?:-|\b)/.test(providerSignals)
      ? "codex"
      : undefined);

  return {
    isSubagent,
    action,
    agentIds,
    nickname,
    agentType,
    provider,
    task: typeof payload?.task === "string" ? payload.task : firstDeepString(message.payload, ["message", "task", "prompt"]),
    status
  };
}

function subagentActionLabel(action: string) {
  if (action === "spawn_agent" || action === "create_agent" || action === "agent" || action === "task") return "启动子 Agent";
  if (action === "send_input") return "发送指令";
  if (action === "wait" || action === "wait_agent" || action === "wait_agents") return "等待子 Agent";
  if (action === "close_agent") return "关闭子 Agent";
  if (action === "resume_agent") return "恢复子 Agent";
  return "子 Agent 活动";
}

function subagentActivityText(info: SubagentInfo, fallback: string) {
  const task = info.task?.trim();
  if (task && !task.startsWith("{") && !task.startsWith("[")) return task;
  if (info.action) return subagentActionLabel(info.action);
  return fallback || "子 Agent 状态已更新";
}

function subagentStatusLabel(status: SubagentInfo["status"] | AgentThread["status"]) {
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "waiting") return "等待中";
  if (status === "interrupted") return "已中断";
  return "活动记录";
}

function agentProviderLabel(provider?: AgentThread["provider"] | SubagentInfo["provider"], descriptors: AgentProviderDescriptor[] = []) {
  return descriptors.find((item) => item.id === provider)?.shortName
    || (provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : provider || "Agent");
}

function agentModeLabel(mode?: AgentThread["mode"]) {
  if (mode === "implementation") return "执行";
  if (mode === "review") return "审查";
  if (mode === "analysis") return "分析";
  return "任务";
}

function agentThreadsSnapshot(agents: AgentThread[]) {
  return agents.map((agent) => {
    const latest = agent.logs[0];
    return [agent.id, agent.status, agent.updatedAt, agent.logs.length, latest?.id || "", String(latest?.text || "").length].join(":");
  }).join("|");
}

function normalizeAgentThreads(value: unknown): AgentThread[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, threadIndex) => {
    const source = asRecord(item);
    if (!source) return [];
    const usage = asRecord(source.usage);
    const statusValue = String(source.status || "interrupted");
    const status: AgentThread["status"] = ["running", "completed", "failed", "interrupted"].includes(statusValue) ? statusValue as AgentThread["status"] : "interrupted";
    const providerValue = String(source.provider || "");
    const provider: AgentThread["provider"] = /^[a-z][a-z0-9._-]{0,63}$/.test(providerValue) ? providerValue : undefined;
    const modeValue = String(source.mode || "");
    const mode = ["analysis", "review", "implementation"].includes(modeValue) ? modeValue as AgentThread["mode"] : undefined;
    const logs = (Array.isArray(source.logs) ? source.logs : []).map((log, index) => normalizeAgentStreamLog(log, index));
    return [{
      id: String(source.id || `legacy-agent-${threadIndex}`), parentThreadId: String(source.parentThreadId || ""), nickname: String(source.nickname || `子 Agent ${threadIndex + 1}`), path: String(source.path || ""), status,
      updatedAt: typeof source.updatedAt === "string" && Number.isFinite(Date.parse(source.updatedAt)) ? source.updatedAt : logs.at(-1)?.createdAt || new Date(0).toISOString(),
      usage: { input_tokens: Number(usage?.input_tokens) || 0, cached_input_tokens: Number(usage?.cached_input_tokens) || 0, output_tokens: Number(usage?.output_tokens) || 0, reasoning_output_tokens: Number(usage?.reasoning_output_tokens) || 0 },
      logs, provider, mode, task: typeof source.task === "string" ? source.task : "", logCount: Number(source.logCount) || logs.length
    }];
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function newestAgentActivities<T extends { createdAt: string }>(logs: T[]) {
  return [...logs].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function claudeStatusSubtype(message: Message) {
  if (message.eventType !== "engine_status") return "";
  const payload = message.payload;
  return payload && typeof payload === "object" && "subtype" in payload
    ? String((payload as { subtype?: unknown }).subtype || "")
    : "";
}

function completedReasoningMessage(message: Message): Message {
  return {
    ...message,
    eventPhase: "completed",
    activityPhase: "completed",
    activity: message.activity ? { ...message.activity, phase: "completed" } : message.activity
  };
}

function deletionPolicyFor(kind: "session" | "workflow", task: SessionSummary | WorkflowSummary): TaskDeletionPolicy {
  if (task.deletionPolicy) return task.deletionPolicy;
  const requiresTermination = kind === "session"
    ? task.status === "running" || task.status === "paused"
    : ["planning", "queued", "running", "integrating", "paused"].includes(task.status);
  return {
    action: requiresTermination ? "terminate-and-delete" : "delete",
    requiresTermination,
    reason: requiresTermination ? kind === "session" ? "任务仍在运行或暂停中" : "任务编排仍在执行或暂停中" : null
  };
}

function deletionTaskKey(kind: "session" | "workflow", id: string) {
  return `${kind}:${id}`;
}

function visibleConversationMessages(messages: Message[], sessionStatus?: Session["status"]) {
  let latestRetryKept = false;
  const result: Message[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const subtype = claudeStatusSubtype(message);
    if (subtype === "thinking_tokens" || subtype === "status") continue;
    if (subtype === "api_retry") {
      if (latestRetryKept) continue;
      latestRetryKept = true;
    }
    result.push(message);
  }
  const visible = result.reverse();
  let pendingReasoning = -1;
  for (let index = 0; index < visible.length; index += 1) {
    const message = visible[index];
    const reasoning = message.activityCategory === "reasoning" || message.eventType === "reasoning" || message.activity?.semanticType === "reasoning";
    if (reasoning && message.activityPhase !== "completed" && message.activity?.phase !== "completed") {
      if (pendingReasoning >= 0) visible[pendingReasoning] = completedReasoningMessage(visible[pendingReasoning]);
      pendingReasoning = index;
    } else if (pendingReasoning >= 0) {
      visible[pendingReasoning] = completedReasoningMessage(visible[pendingReasoning]);
      pendingReasoning = -1;
    }
  }
  if (pendingReasoning >= 0 && sessionStatus !== "running") visible[pendingReasoning] = completedReasoningMessage(visible[pendingReasoning]);
  return visible;
}

function sessionSummariesSnapshot(sessions: SessionSummary[]) {
  return sessions.map((session) => [session.id, session.revision, session.status, session.updatedAt, session.messageCount].join(":")).join("|");
}

function mergeLatestSessionWindow(current: Session | null, next: Session) {
  if (!current || current.id !== next.id || !current.messageWindow || !next.messageWindow) return next;
  const previous = current.messageWindow;
  const incoming = next.messageWindow;
  if (incoming.total < previous.total || incoming.start > previous.end) return next;
  const retainedCount = Math.max(0, Math.min(current.messages.length, incoming.start - previous.start));
  return {
    ...next,
    messages: [...current.messages.slice(0, retainedCount), ...next.messages],
    messageWindow: { ...incoming, start: Math.min(previous.start, incoming.start) }
  };
}

function compactActivityMessage(message: Message) {
  return message.role === "event"
    && message.eventType !== "user_question"
    && !subagentInfo(message).isSubagent;
}

function groupMessages(messages: Message[]): Array<Message | ActivityMessageGroup> {
  const result: Array<Message | ActivityMessageGroup> = [];
  for (const message of messages) {
    if (compactActivityMessage(message)) {
      const previous = result.at(-1);
      if (previous?.role === "activity-group") previous.messages.push(message);
      else result.push({ id: `activities-${message.id}`, role: "activity-group", messages: [message] });
      continue;
    }
    if (message.role === "error") {
      const previous = result.at(-1);
      if (previous?.role === "activity-group") previous.messages.push(message);
      else result.push({ id: `activities-${message.id}`, role: "activity-group", messages: [message] });
      continue;
    }
    result.push(message);
  }
  return result;
}

function eventActivityLog(message: Message): AgentLog {
  const eventType = message.eventType || "engine_status";
  const title = eventType === "command_execution" ? "命令执行"
    : eventType === "file_change" ? "文件修改"
    : eventType === "file_read" ? "读取文件"
    : eventType === "reasoning" ? "分析与推理"
    : eventType === "web_search" ? "网络搜索"
    : eventType === "mcp_tool_call" ? "MCP 调用"
    : eventType === "skill_call" ? "Skill 调用"
    : eventType === "tool_call" ? "工具调用"
    : eventType === "todo_list" ? "计划更新"
    : eventType === "error" || message.role === "error" ? "任务失败"
    : eventType.startsWith("turn.") ? "运行轮次"
    : eventType.startsWith("thread.") ? "任务状态"
    : eventType.startsWith("session.") ? "会话状态"
    : "运行状态";
  const failed = message.role === "error" || eventType === "error" || message.activityPhase === "failed";
  const kind: AgentLog["kind"] = failed ? "error"
    : eventType === "reasoning" ? "reasoning"
    : eventType === "engine_status" || eventType.startsWith("turn.") || eventType.startsWith("thread.") || eventType.startsWith("session.") ? "status"
    : "tool";
  const text = eventType === "reasoning"
    ? String((message.payload as { thinking?: unknown } | undefined)?.thinking || message.text || title)
    : message.text || title;
  const category = message.activityCategory || (eventType === "command_execution" ? "command"
    : eventType === "file_change" ? "file"
    : eventType === "file_read" ? "read"
    : eventType === "web_search" ? "search"
    : eventType === "mcp_tool_call" ? "mcp"
    : eventType === "todo_list" ? "todo"
    : eventType === "reasoning" ? "reasoning"
    : failed ? "error"
    : eventType === "tool_call" || eventType === "skill_call" ? "tool"
    : "status");
  const phase = failed ? "failed" : message.activityPhase || (message.eventPhase === "completed" ? "completed" : message.eventPhase === "updated" ? "running" : "started");
  return { id: message.id, createdAt: message.createdAt, kind, title, text, category, phase, detail: message.activityDetail ?? message.payload, activity: message.activity };
}

function activityGroupStatus(messages: Message[]) {
  const logs = messages.map(eventActivityLog);
  if (logs.some((log) => log.kind === "error" || log.phase === "failed")) return "failed";
  const latest = logs.at(-1);
  if (latest?.phase === "started" || latest?.phase === "running") return "running";
  return "completed";
}

function ActivityMessageGroupView({ group, engine, providerLabel, providerControl, workspaceId }: { group: ActivityMessageGroup; engine: EngineName; providerLabel: string; providerControl?: ProviderControlSnapshot; workspaceId?: string }) {
  return <div className="event-row activity-message-group"><AgentConversation logs={group.messages.map(eventActivityLog)} status={activityGroupStatus(group.messages)} provider={engine} providerLabel={providerLabel} providerIcon={providerControl?.identity.icon} providerAccent={providerControl?.identity.accent} workspaceId={workspaceId} showProvider={false} /></div>;
}

type ApiRequestInit = RequestInit & { timeoutMs?: number };

const api = async <T,>(url: string, options?: ApiRequestInit): Promise<T> => {
  const { timeoutMs = 60_000, signal: parentSignal, ...request } = options || {};
  const controller = new AbortController();
  let timedOut = false;
  let timer: number | undefined;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  if (timeoutMs > 0 && !controller.signal.aborted) {
    timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("请求超时", "TimeoutError"));
    }, timeoutMs);
  }
  try {
    const response = await fetch(url, {
      ...request,
      cache: request.cache ?? ((request.method || "GET").toUpperCase() === "GET" ? "no-store" : undefined),
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...request.headers }
    });
    const contentType = response.headers.get("content-type") || "";
    let body = "";
    let data: any = null;
    if (response.status !== 204 && contentType.includes("application/json")) {
      try { data = await response.json(); } catch { data = null; }
    } else if (response.status !== 204) {
      body = await response.text();
    }
    if (!response.ok) {
      const htmlResponse = contentType.includes("text/html") || /^\s*<!doctype html/i.test(body);
      const fallback = htmlResponse && response.status >= 500
        ? `服务端处理请求失败（HTTP ${response.status}）`
        : body.slice(0, 500) || `请求失败（HTTP ${response.status}）`;
      throw new Error(data?.error || fallback);
    }
    return data as T;
  } catch (error) {
    if (timedOut) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒），工作台将保留当前状态并重试`);
    throw error;
  } finally {
    if (timer) window.clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
};

function IconButton({
  label,
  children,
  onClick,
  disabled
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="icon-button" title={label} aria-label={label} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

type SidebarTaskRowProps = {
  item: SidebarTaskItem;
  active: boolean;
  delegationEnabled: boolean;
  providerControl?: ProviderControlSnapshot;
  relativeTimeNow: number;
  onSelect: (item: SidebarTaskItem) => void;
  onPrefetch: (id: string) => void;
  onCancelPrefetch: () => void;
  onOpenContextMenu: (id: string, x: number, y: number) => void;
};

function sameSidebarTaskRow(previous: SidebarTaskRowProps, next: SidebarTaskRowProps) {
  const left = previous.item;
  const right = next.item;
  if (
    left.kind !== right.kind
    || left.task.id !== right.task.id
    || left.task.title !== right.task.title
    || left.task.status !== right.task.status
    || left.task.updatedAt !== right.task.updatedAt
    || left.task.pinned !== right.task.pinned
    || left.task.archivedAt !== right.task.archivedAt
    || previous.active !== next.active
    || previous.delegationEnabled !== next.delegationEnabled
    || previous.providerControl?.identity.icon !== next.providerControl?.identity.icon
    || previous.providerControl?.identity.accent !== next.providerControl?.identity.accent
    || relativeTime(left.task.updatedAt, previous.relativeTimeNow) !== relativeTime(right.task.updatedAt, next.relativeTimeNow)
    || previous.onSelect !== next.onSelect
    || previous.onPrefetch !== next.onPrefetch
    || previous.onCancelPrefetch !== next.onCancelPrefetch
    || previous.onOpenContextMenu !== next.onOpenContextMenu
  ) return false;
  if (left.kind === "workflow" && right.kind === "workflow") return left.task.plannerEngine === right.task.plannerEngine;
  if (left.kind === "chat" && right.kind === "chat") return left.task.engine === right.task.engine;
  return false;
}

const SidebarTaskRow = memo(function SidebarTaskRow({
  item,
  active,
  delegationEnabled,
  providerControl,
  relativeTimeNow,
  onSelect,
  onPrefetch,
  onCancelPrefetch,
  onOpenContextMenu
}: SidebarTaskRowProps) {
  const openPointerMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenContextMenu(
      item.task.id,
      Math.max(8, Math.min(event.clientX, window.innerWidth - 224)),
      Math.max(8, Math.min(event.clientY, window.innerHeight - 330))
    );
  };
  return <div
    className={`session-row ${active ? "active" : ""} ${item.task.pinned ? "pinned" : ""} ${item.task.archivedAt ? "archived" : ""}`}
    onMouseEnter={() => { if (item.kind === "chat") onPrefetch(item.task.id); }}
    onMouseLeave={onCancelPrefetch}
    onFocusCapture={() => { if (item.kind === "chat") onPrefetch(item.task.id); }}
    onContextMenu={openPointerMenu}
  >
    <button className="session-select" onClick={() => onSelect(item)}>
      <ProviderIcon provider={item.kind === "workflow" ? item.task.plannerEngine : item.task.engine} icon={providerControl?.identity.icon} accent={providerControl?.identity.accent} size={15} />
      <span><strong>{item.task.pinned && <Pin size={11} />}{item.task.title}</strong><small>{item.kind === "workflow" ? `编排 · ${workflowStatusLabel(item.task.status)}` : `${delegationEnabled ? "协作" : "原生"} · ${sessionStatusLabel(item.task.status)}`} · {relativeTime(item.task.updatedAt, relativeTimeNow)}</small></span>
    </button>
    <IconButton label="管理任务" onClick={() => onOpenContextMenu(item.task.id, 210, Math.min(window.innerHeight - 330, 130))}><MoreHorizontal size={15} /></IconButton>
  </div>;
}, sameSidebarTaskRow);

const SidebarTaskList = memo(function SidebarTaskList({
  query,
  visibleTaskItems,
  activeTaskShortcuts,
  pinnedTaskShortcuts,
  recentUnfiledTasks,
  folderTaskItems,
  archivedTasks,
  taskFolders,
  taskCount,
  standaloneActive,
  visible,
  searchStale,
  scopeKey,
  activeChatId,
  activeWorkflowId,
  delegationEnabled,
  providerControls,
  onSelect,
  onPrefetch,
  onCancelPrefetch,
  onOpenTaskContextMenu,
  onOpenAreaContextMenu,
  onOpenFolderContextMenu,
  onCreateFolder
}: {
  query: string;
  visibleTaskItems: SidebarTaskItem[];
  activeTaskShortcuts: SidebarTaskItem[];
  pinnedTaskShortcuts: SidebarTaskItem[];
  recentUnfiledTasks: SidebarTaskItem[];
  folderTaskItems: Map<string, SidebarTaskItem[]>;
  archivedTasks: SidebarTaskItem[];
  taskFolders: TaskFolder[];
  taskCount: number;
  standaloneActive: boolean;
  visible: boolean;
  searchStale: boolean;
  scopeKey: string;
  activeChatId: string;
  activeWorkflowId: string;
  delegationEnabled: boolean;
  providerControls: ProviderControlSnapshot[];
  onSelect: (item: SidebarTaskItem) => void;
  onPrefetch: (id: string) => void;
  onCancelPrefetch: () => void;
  onOpenTaskContextMenu: (id: string, x: number, y: number) => void;
  onOpenAreaContextMenu: (x: number, y: number) => void;
  onOpenFolderContextMenu: (id: string, x: number, y: number) => void;
  onCreateFolder: () => void;
}) {
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() => new Set());
  const [archiveState, setArchiveState] = useState({ scopeKey, open: false });
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  const archiveOpen = archiveState.scopeKey === scopeKey && archiveState.open;
  useEffect(() => {
    if (!visible) return;
    setRelativeTimeNow(Date.now());
    const timer = window.setInterval(() => setRelativeTimeNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [visible]);
  useEffect(() => {
    if (archivedTasks.length) return;
    setArchiveState((current) => current.scopeKey === scopeKey && current.open ? { scopeKey, open: false } : current);
  }, [archivedTasks.length, scopeKey]);

  const renderTask = (item: SidebarTaskItem) => <SidebarTaskRow
    key={`${item.kind}:${item.task.id}`}
    item={item}
    active={item.kind === "chat" ? activeChatId === item.task.id : activeWorkflowId === item.task.id}
    delegationEnabled={delegationEnabled}
    providerControl={providerControls.find((control) => control.providerId === (item.kind === "workflow" ? item.task.plannerEngine : item.task.engine))}
    relativeTimeNow={relativeTimeNow}
    onSelect={onSelect}
    onPrefetch={onPrefetch}
    onCancelPrefetch={onCancelPrefetch}
    onOpenContextMenu={onOpenTaskContextMenu}
  />;

  return <div className={`session-list ${searchStale ? "search-stale" : ""}`} aria-busy={searchStale} inert={searchStale || undefined} onContextMenu={(event) => {
    event.preventDefault();
    if (!standaloneActive) onOpenAreaContextMenu(
      Math.max(8, Math.min(event.clientX, window.innerWidth - 210)),
      Math.max(8, Math.min(event.clientY, window.innerHeight - 80))
    );
  }}>
    {query ? <>
      <div className="sidebar-section-heading"><span>搜索结果</span><small>{visibleTaskItems.length}</small></div>
      {visibleTaskItems.length ? <div className="session-group">{visibleTaskItems.map(renderTask)}</div> : <p className="empty-note">没有匹配的任务</p>}
    </> : <>
      {activeTaskShortcuts.length > 0 && <section className="sidebar-task-section"><div className="sidebar-section-heading"><span>进行中</span><small>{activeTaskShortcuts.length}</small></div><div className="session-group">{activeTaskShortcuts.map(renderTask)}</div></section>}
      {pinnedTaskShortcuts.length > 0 && <section className="sidebar-task-section"><div className="sidebar-section-heading"><span>置顶</span><small>{pinnedTaskShortcuts.length}</small></div><div className="session-group">{pinnedTaskShortcuts.map(renderTask)}</div></section>}
      {recentUnfiledTasks.length > 0 && <section className="sidebar-task-section"><div className="sidebar-section-heading"><span>最近</span><small>{recentUnfiledTasks.length}</small></div><div className="session-group">{recentUnfiledTasks.map(renderTask)}</div></section>}
      {!standaloneActive && taskFolders.length > 0 && <section className="sidebar-task-section"><div className="sidebar-section-heading"><span>文件夹</span><button type="button" aria-label="新建任务文件夹" onClick={onCreateFolder}><Plus size={13} /></button></div>{taskFolders.map((folder) => {
        const folderTasks = folderTaskItems.get(folder.id) || [];
        const open = !collapsedFolderIds.has(folder.id);
        return <details className="task-folder-group" key={folder.id} open={open} onToggle={(event) => {
          const nextOpen = event.currentTarget.open;
          setCollapsedFolderIds((current) => {
            if (nextOpen === !current.has(folder.id)) return current;
            const next = new Set(current);
            if (nextOpen) next.delete(folder.id); else next.add(folder.id);
            return next;
          });
        }}><summary onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenFolderContextMenu(
            folder.id,
            Math.max(8, Math.min(event.clientX, window.innerWidth - 210)),
            Math.max(8, Math.min(event.clientY, window.innerHeight - 120))
          );
        }}><Folder size={13} /><span>{folder.name}</span><small>{folderTasks.length}</small></summary>{open && <div>{folderTasks.map(renderTask)}</div>}</details>;
      })}</section>}
      {taskCount === 0 && <div className="sidebar-empty-state"><MessagesSquare size={20} /><strong>还没有任务</strong><small>创建任务后会显示在这里</small></div>}
      {archivedTasks.length > 0 && <details className="archived-session-list" open={archiveOpen} onToggle={(event) => setArchiveState({ scopeKey, open: event.currentTarget.open })}><summary><Archive size={12} />已归档 · {archivedTasks.length}<ChevronRight size={12} /></summary>{archiveOpen && <div>{archivedTasks.map(renderTask)}</div>}</details>}
      {!standaloneActive && <button type="button" className="session-area-empty" onClick={onCreateFolder}><Plus size={13} />新建任务文件夹</button>}
    </>}
  </div>;
});

function Dialog({
  title,
  onClose,
  children,
  className = ""
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const focusableSelector = [
    "button:not([disabled])",
    "[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  useEffect(() => {
    const dialog = dialogRef.current;
    const focusDialog = window.requestAnimationFrame(() => {
      if (!dialog?.contains(document.activeElement)) {
        (dialog?.querySelector<HTMLElement>(focusableSelector) || dialog)?.focus();
      }
    });
    return () => {
      window.cancelAnimationFrame(focusDialog);
      restoreFocusRef.current?.focus();
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((element) => !element.hidden && element.getClientRects().length > 0);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className={`dialog ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={handleKeyDown}>
        <header>
          <h2 id={titleId}>{title}</h2>
          <IconButton label="关闭" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}

function SubagentDrawer({
  message,
  messages,
  sessionId,
  sessionRunning,
  workspaceId,
  workspaceRoot,
  providerControls,
  onOpenLocalFile,
  onClose
}: {
  message: Message;
  messages: Message[];
  sessionId: string;
  sessionRunning: boolean;
  workspaceId: string;
  workspaceRoot: string;
  providerControls: ProviderControlSnapshot[];
  onOpenLocalFile: (path: string) => void;
  onClose: () => void;
}) {
  const info = subagentInfo(message);
  const [agentThreads, setAgentThreads] = useState<AgentThread[] | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedAgentDetail, setSelectedAgentDetail] = useState<AgentThread | null>(null);
  const [agentDetailLoading, setAgentDetailLoading] = useState(false);
  const agentLoadedRef = useRef(false);
  const agentSnapshotRef = useRef("");
  useEffect(() => {
    let stopped = false;
    let emptyRetries = 0;
    let failures = 0;
    let quietPolls = 0;
    let loading = false;
    let rerunRequested = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const schedule = (delay: number) => {
      if (stopped) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(requestLoad, delay);
    };
    const requestLoad = () => {
      if (stopped) return;
      if (timer) window.clearTimeout(timer);
      timer = undefined;
      if (loading) { rerunRequested = true; return; }
      void loadAgents();
    };
    const loadAgents = async () => {
      if (stopped) return;
      if (document.hidden) {
        schedule(1_200);
        return;
      }
      loading = true;
      controller = new AbortController();
      let nextDelay: number | null = null;
      try {
        const agents = normalizeAgentThreads(await api<unknown>(`/api/sessions/${sessionId}/agents`, { signal: controller.signal }));
        if (stopped) return;
        failures = 0;
        emptyRetries = agents.length ? 3 : emptyRetries + 1;
        const snapshot = agentThreadsSnapshot(agents);
        if (!agentLoadedRef.current || snapshot !== agentSnapshotRef.current) {
          quietPolls = 0;
          agentSnapshotRef.current = snapshot;
          agentLoadedRef.current = true;
          agentThreadSummaryCache.set(sessionId, agents);
          startTransition(() => {
            setAgentThreads(agents);
            const preferredId = info.agentIds.find((id) => agents.some((agent) => agent.id === id)) || agents[0]?.id || "";
            setSelectedAgentId((current) => agents.some((agent) => agent.id === current) ? current : preferredId);
          });
        } else quietPolls += 1;
        const hasRunningAgent = agents.some((agent) => agent.status === "running");
        if (sessionRunning || hasRunningAgent || emptyRetries < 3) nextDelay = emptyRetries < 3 ? 1_000 : Math.min(5_000, 1_000 + quietPolls * 500);
      } catch (error) {
        if (stopped || (error instanceof DOMException && error.name === "AbortError")) return;
        failures += 1;
        setAgentThreads((current) => current ?? []);
        nextDelay = Math.min(8_000, 1_200 * (2 ** Math.min(failures, 3)));
      } finally {
        loading = false;
        if (stopped) return;
        if (rerunRequested) {
          rerunRequested = false;
          schedule(0);
        } else if (nextDelay !== null) schedule(nextDelay);
      }
    };
    requestLoad();
    const onVisibilityChange = () => {
      if (!document.hidden) {
        if (timer) window.clearTimeout(timer);
        requestLoad();
      }
    };
    const onAgentsChanged = (detail: Record<string, unknown>) => {
      const changedSessionId = String(detail.sessionId || "");
      if (changedSessionId === sessionId) {
        if (timer) window.clearTimeout(timer);
        requestLoad();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const unsubscribeAgents = realtimeCoordinator.subscribe("agents.changed", onAgentsChanged);
    const unsubscribeReconcile = realtimeCoordinator.subscribeReconcile(() => onVisibilityChange());
    return () => {
      stopped = true;
      controller?.abort();
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unsubscribeAgents();
      unsubscribeReconcile();
    };
  }, [sessionId, sessionRunning, info.agentIds.join("|")]);
  const orderedAgentThreads = useMemo(() => normalizeAgentThreads(agentThreads || []), [agentThreads]);
  useEffect(() => {
    if (!orderedAgentThreads.length) return;
    setSelectedAgentId((current) => orderedAgentThreads.some((agent) => agent.id === current)
      ? current
      : info.agentIds.find((id) => orderedAgentThreads.some((agent) => agent.id === id)) || orderedAgentThreads[0].id);
  }, [orderedAgentThreads, info.agentIds.join("|")]);
  const selectedAgentSummary = orderedAgentThreads.find((agent) => agent.id === selectedAgentId);
  useEffect(() => {
    if (!selectedAgentSummary) {
      setSelectedAgentDetail(null);
      setAgentDetailLoading(false);
      return;
    }
    const cacheKey = `${sessionId}:${selectedAgentSummary.id}`;
    const cached = agentThreadDetailCache.get(cacheKey);
    if (cached?.updatedAt === selectedAgentSummary.updatedAt) {
      setSelectedAgentDetail(cached);
      setAgentDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    setSelectedAgentDetail(cached || null);
    setAgentDetailLoading(true);
    api<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(selectedAgentSummary.id)}`, { signal: controller.signal })
      .then((value) => normalizeAgentThreads([value])[0])
      .then((agent) => {
        if (!agent || controller.signal.aborted) return;
        agentThreadDetailCache.set(cacheKey, agent);
        setSelectedAgentDetail(agent);
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setSelectedAgentDetail((current) => current || null);
      })
      .finally(() => { if (!controller.signal.aborted) setAgentDetailLoading(false); });
    return () => controller.abort();
  }, [sessionId, selectedAgentSummary?.id, selectedAgentSummary?.updatedAt]);
  const selectedAgent = selectedAgentDetail || selectedAgentSummary;
  const selectedAgentLogs = useMemo(() => (selectedAgentDetail?.logs || []).map((log, index) => normalizeAgentStreamLog(log, index)).sort((left, right) => left.createdAt.localeCompare(right.createdAt)), [selectedAgentDetail?.logs]);
  const related = useMemo(() => messages.filter((candidate) => {
    const candidateInfo = subagentInfo(candidate);
    if (!candidateInfo.isSubagent) return false;
    if (!info.agentIds.length) return candidate.id === message.id;
    return candidateInfo.agentIds.some((id) => info.agentIds.includes(id));
  }), [messages, message.id, info.agentIds.join("|")]);
  const logs = useMemo(
    () => newestAgentActivities((related.length ? related : [message]).slice(-20)),
    [related, message]
  );
  const title = selectedAgent?.nickname || info.nickname || info.agentType || "子 Agent";
  const drawerStatus = selectedAgent?.status || info.status;
  const drawerLogCount = selectedAgent?.logs.length ?? logs.length;
  const drawerProvider = selectedAgent?.provider || info.provider;
  const drawerProviderControl = providerControls.find((control) => control.providerId === drawerProvider);
  const drawerLogVersion = `${selectedAgent?.updatedAt || "fallback"}|${agentStreamVersion(selectedAgent ? selectedAgentLogs : logs)}`;
  const followOutput = useAgentOutputFollow(drawerLogVersion, selectedAgentId);
  return (
    <div className="agent-drawer-backdrop" onMouseDown={onClose}>
      <aside className="agent-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div className="agent-drawer-title">
            <span className={`subagent-mark ${drawerProvider || "agent"}`}>{drawerProvider ? <ProviderIcon provider={drawerProvider} icon={drawerProviderControl?.identity.icon} accent={drawerProviderControl?.identity.accent} size={18} /> : <Bot size={18} />}</span>
            <span>
              <strong>{title}<em className={`agent-provider-badge ${drawerProvider || "agent"}`}>{agentProviderLabel(drawerProvider)}</em></strong>
              <small>按执行顺序显示 · {subagentStatusLabel(drawerStatus)} · {drawerLogCount} 条</small>
            </span>
          </div>
          <IconButton label="关闭子 Agent 日志" onClick={onClose}><X size={18} /></IconButton>
        </header>
        <div
          className="agent-drawer-body"
          ref={followOutput.containerRef}
          onScroll={followOutput.onScroll}
        >
          <div className="agent-drawer-content" ref={followOutput.contentRef}>
          {agentThreads === null && <div className="agent-loading"><LoaderCircle className="spin" size={15} />正在读取子 Agent 线程</div>}
          {agentThreads && orderedAgentThreads.length > 0 && (
            <nav className="agent-thread-tabs">
              {orderedAgentThreads.map((agent) => (
                <button
                  className={agent.id === selectedAgentId ? "active" : ""}
                  key={agent.id}
                  onClick={() => setSelectedAgentId(agent.id)}
                >
                  <span className={`agent-status-dot ${agent.status}`} />
                  <span>
                    <strong>{agent.nickname}</strong>
                    <small><em className={`agent-provider-badge ${agent.provider || "agent"}`}>{agentProviderLabel(agent.provider)}</em>{agentModeLabel(agent.mode)} · {formatTokens(usageTotal(agent.usage))} tokens · {agent.logCount ?? agent.logs.length} 条</small>
                  </span>
                </button>
              ))}
            </nav>
          )}
          <section className="agent-summary-line">
            <span className={`agent-status-dot ${drawerStatus}`} />
            <strong>{subagentStatusLabel(drawerStatus)}</strong>
            {selectedAgent && <span>{formatTokens(usageTotal(selectedAgent.usage))} tokens</span>}
            <span>{drawerLogCount} 条活动</span>
          </section>
          {(selectedAgent?.task || info.task) && (
            <section className="agent-task">
              <span>委派任务</span>
              <p>{selectedAgent?.task || info.task}</p>
            </section>
          )}
          <section className="agent-log-section">
            <div className="agent-conversation">
              <AgentConversation
                logs={selectedAgent ? selectedAgentLogs : logs.map(eventActivityLog)}
                status={selectedAgent?.status || drawerStatus}
                provider={selectedAgent?.provider || drawerProvider || "agent"}
                providerLabel={agentProviderLabel(selectedAgent?.provider || drawerProvider)}
                providerIcon={drawerProviderControl?.identity.icon}
                providerAccent={drawerProviderControl?.identity.accent}
                messageLabel="子 Agent"
                workspaceId={workspaceId}
                showProvider={false}
                renderMessage={(text: string) => <MarkdownBody text={text} workspaceId={workspaceId} workspaceRoot={workspaceRoot} onOpenLocalFile={onOpenLocalFile} />}
              />
              {selectedAgent && selectedAgentLogs.length === 0 && <p className="empty-note">该子 Agent 暂无可显示日志</p>}
            </div>
          </section>
          </div>
        </div>
      </aside>
    </div>
  );
}

function ClaudeQuestionCard({
  message,
  onSubmit
}: {
  message: Message;
  onSubmit: (answer: string) => Promise<boolean>;
}) {
  const questions = claudeQuestions(message);
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const complete = questions.length > 0 && questions.every((question, index) =>
    (selected[index]?.length || 0) > 0 || Boolean(custom[index]?.trim()) || question.options.length === 0
  );

  const toggleOption = (questionIndex: number, label: string, multiSelect: boolean) => {
    if (submitted || submitting) return;
    setSelected((current) => {
      const values = current[questionIndex] || [];
      return {
        ...current,
        [questionIndex]: multiSelect
          ? values.includes(label) ? values.filter((value) => value !== label) : [...values, label]
          : [label]
      };
    });
  };

  const submit = async () => {
    if (!complete || submitting || submitted) return;
    const answer = ["以下是我对 Claude 询问的回答：", ...questions.flatMap((question, index) => {
      const values = selected[index] || [];
      const extra = custom[index]?.trim() || "";
      const response = [...values, extra].filter(Boolean).join("；") || "请按合理默认值处理";
      return ["", `${index + 1}. ${question.header ? `【${question.header}】` : ""}${question.question}`, `回答：${response}`];
    })].join("\n");
    setSubmitting(true);
    const accepted = await onSubmit(answer);
    setSubmitting(false);
    if (accepted) setSubmitted(true);
  };

  if (!questions.length) return null;
  return (
    <section className={`claude-question-card ${submitted ? "submitted" : ""}`}>
      <header>
        <span><MessagesSquare size={16} /></span>
        <div><strong>{submitted ? "回答已提交" : "Claude 需要你的确认"}</strong><small>{submitted ? "Claude 将基于所选内容继续任务" : `共 ${questions.length} 个问题，选择后继续`}</small></div>
      </header>
      <div className="claude-question-list">
        {questions.map((question, questionIndex) => (
          <fieldset key={`${message.id}:${questionIndex}`} disabled={submitted || submitting}>
            {question.header && <legend>{question.header}</legend>}
            <p>{question.question}</p>
            {question.options.length > 0 && <div className="claude-question-options">
              {question.options.map((option) => {
                const active = selected[questionIndex]?.includes(option.label);
                return <button
                  type="button"
                  className={active ? "active" : ""}
                  key={option.label}
                  onClick={() => toggleOption(questionIndex, option.label, question.multiSelect)}
                >
                  <span className="question-choice-mark">{active ? <Check size={13} /> : null}</span>
                  <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
                </button>;
              })}
            </div>}
            <textarea
              value={custom[questionIndex] || ""}
              onChange={(event) => setCustom((current) => ({ ...current, [questionIndex]: event.target.value }))}
              placeholder={question.options.length ? "补充说明或填写自定义回答（可选）" : "填写你的回答"}
              rows={2}
            />
          </fieldset>
        ))}
      </div>
      <footer>
        <span>{questions.some((question) => question.multiSelect) ? "部分问题支持多选" : "确认后将沿用当前 Claude 上下文"}</span>
        <button type="button" onClick={submit} disabled={!complete || submitting || submitted}>
          {submitting ? <LoaderCircle className="spin" size={14} /> : submitted ? <Check size={14} /> : <Send size={14} />}
          {submitting ? "正在提交" : submitted ? "已提交" : "提交回答"}
        </button>
      </footer>
    </section>
  );
}

function EventMessage({
  message,
  engine,
  providerControls,
  onOpenAgent,
  onAnswerQuestion
}: {
  message: Message;
  engine: EngineName;
  providerControls: ProviderControlSnapshot[];
  onOpenAgent: (messageId: string) => void;
  onAnswerQuestion: (answer: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const reasoningText = message.eventType === "reasoning"
    ? String((message.payload as { thinking?: unknown } | undefined)?.thinking || message.text || "")
    : "";
  const agent = subagentInfo(message);
  if (message.eventType === "user_question" && claudeQuestions(message).length) {
    return <ClaudeQuestionCard message={message} onSubmit={onAnswerQuestion} />;
  }
  if (agent.isSubagent) {
    const provider = agent.provider || engine;
    const providerControl = providerControls.find((control) => control.providerId === provider);
    return (
      <div className="event-row subagent-row">
        <button className={`${provider || "agent"} ${provider ? "" : "no-provider"}`.trim()} title="打开子 Agent 日志" onClick={() => onOpenAgent(message.id)}>
          {provider && <span className={`subagent-mark ${provider}`}><ProviderIcon provider={provider} icon={providerControl?.identity.icon} accent={providerControl?.identity.accent} size={18} /></span>}
          <span className="subagent-card-title">
            <b>{agent.nickname || agent.agentType || "子 Agent"}</b>
            <i className={agent.status}>{subagentStatusLabel(agent.status)}</i>
          </span>
          <ChevronRight className="subagent-card-chevron" size={14} aria-hidden="true" />
        </button>
      </div>
    );
  }
  const meta =
    message.eventType === "reasoning" ? { icon: <Brain size={15} />, label: "推理" } :
    message.eventType === "command_execution" ? { icon: <TerminalSquare size={15} />, label: "命令" } :
    message.eventType === "file_change" ? { icon: <FileCode2 size={15} />, label: "文件" } :
    message.eventType === "file_read" ? { icon: <FileSearch size={15} />, label: "读取" } :
    message.eventType === "skill_call" ? { icon: <Sparkles size={15} />, label: "Skill" } :
    message.eventType === "mcp_tool_call" ? { icon: <Plug size={15} />, label: "MCP" } :
    message.eventType === "web_search" ? { icon: <Search size={15} />, label: "搜索" } :
    message.eventType === "todo_list" ? { icon: <ListChecks size={15} />, label: "计划" } :
    message.eventType === "schedule" ? { icon: <Clock3 size={15} />, label: "定时任务" } :
    message.eventType === "git_operation" ? { icon: <GitBranch size={15} />, label: "工作树" } :
    message.eventType === "workflow" ? { icon: <Route size={15} />, label: "工作流" } :
    message.eventType === "agent_message" ? { icon: <MessagesSquare size={15} />, label: "Agent 通信" } :
    message.eventType === "context_compaction" ? { icon: <Box size={15} />, label: "上下文" } :
    message.eventType === "rate_limit" ? { icon: <Gauge size={15} />, label: "调用额度" } :
    message.eventType === "auth_status" ? { icon: <ShieldCheck size={15} />, label: "认证" } :
    message.eventType === "hook" ? { icon: <Plug size={15} />, label: "Hook" } :
    message.eventType === "engine_status" ? { icon: <Activity size={15} />, label: "运行状态" } :
    message.eventType === "tool_call" ? { icon: <Wrench size={15} />, label: "工具" } :
    message.eventType === "error" ? { icon: <Activity size={15} />, label: "事件错误" } :
    message.eventType?.startsWith("thread.") || message.eventType?.startsWith("session.") ? { icon: <Activity size={15} />, label: "任务" } :
    message.eventType?.startsWith("turn.") ? { icon: <Gauge size={15} />, label: "轮次" } :
    { icon: <Wrench size={15} />, label: message.eventType || "事件" };
  return (
    <div className="event-row">
      <button onClick={() => setOpen((value) => !value)}>
        {meta.icon}
        <span>
          <b>{meta.label}</b>
          {message.eventPhase && <i>{eventPhaseLabel(message.eventPhase)}</i>}
          {message.eventType === "reasoning"
            ? compactLine(reasoningText || "智能体正在推理", 180)
            : productEventText(message.text) || message.eventType || "未命名事件"}
        </span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (message.eventType === "reasoning"
        ? <div className="reasoning-content">{reasoningText.length > 60_000 ? <pre>{reasoningText.slice(0, 80_000)}</pre> : <MarkdownBody text={reasoningText} />}</div>
        : <div className="event-detail-panel">
            <p>{productEventText(message.text) || "该运行事件已记录"}</p>
            <details><summary>技术详情</summary><pre>{JSON.stringify(message.payload ?? { text: message.text, type: message.eventType }, null, 2)}</pre></details>
          </div>)}
    </div>
  );
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("浏览器未允许访问剪贴板");
}

function CopyMarkdownButton({ text, onError }: { text: string; onError: (error: unknown) => void }) {
  const [copied, setCopied] = useState(false);
  return <button
    type="button"
    className="copy-message-button"
    title="复制 Markdown"
    aria-label="复制 Markdown"
    onClick={async () => {
      try {
        await copyText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      } catch (error) {
        onError(error);
      }
    }}
  >{copied ? <Check size={14} /> : <Copy size={14} />}</button>;
}

function AssistantMessageActions({
  text,
  branching,
  onBranch,
  onError
}: {
  text: string;
  branching: boolean;
  onBranch: () => void;
  onError: (error: unknown) => void;
}) {
  return <div className="message-actions" aria-label="回复操作">
      <CopyMarkdownButton text={text} onError={onError} />
      <IconButton label="从此回复创建分支" disabled={branching} onClick={onBranch}><GitBranch size={14} /></IconButton>
  </div>;
}

class PreviewErrorBoundary extends Component<{ resetKey: string; children: ReactNode; onClose: () => void }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("File preview rendering was isolated", error, info.componentStack);
  }
  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: "" });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="preview-backdrop" onMouseDown={this.props.onClose}><section className="preview-render-fallback" onMouseDown={(event) => event.stopPropagation()}>
      <Activity size={24} /><strong>文件预览已安全终止</strong><p>该内容触发了渲染异常，工作台其他区域不受影响。</p><small>{this.state.error}</small><button type="button" onClick={this.props.onClose}>关闭预览</button>
    </section></div>;
  }
}

const CONTEST_MODES: Array<{ value: ContestMode; label: string; detail: string; prompt: string }> = [
  { value: "quick", label: "快速", detail: "优先完成可用结果", prompt: "快速模式" },
  { value: "balanced", label: "均衡", detail: "兼顾质量与速度", prompt: "均衡模式" },
  { value: "champion", label: "深度", detail: "执行完整高质量流程", prompt: "深度模式" }
];

const PAPER_FORMATS: Array<{ value: PaperFormat; label: string; detail: string; prompt: string }> = [
  { value: "latex", label: "自动测试", detail: "优先运行项目测试与静态检查", prompt: "自动测试" },
  { value: "docx", label: "人工复核", detail: "输出变更摘要、风险与后续清单", prompt: "人工复核" }
];

function TaskLaunch({ workspaceName, onPromptSelect, onOpenWorkflow }: { workspaceName: string; onPromptSelect: (prompt: string) => void; onOpenWorkflow: () => void }) {
  return (
    <section className="task-launch">
      <header className="task-launch-heading">
        <div className="task-launch-brand"><ProductLogo className="task-launch-logo" /></div>
        <h1>想在 {workspaceName || "当前工作区"} 中做些什么？</h1>
      </header>

      <div className="task-launch-actions" aria-label="常用任务">
        <button type="button" onClick={() => onPromptSelect("请探索并理解当前工作区，梳理项目结构、核心逻辑与值得优先改进的问题。")}>
          <Search size={19} />
          <span>探索并理解工作区</span>
        </button>
        <button type="button" onClick={() => onPromptSelect("请在当前工作区中设计并实现一个新功能、应用或工具：")}>
          <Wrench size={19} />
          <span>构建新功能、应用或工具</span>
        </button>
        <button type="button" onClick={onOpenWorkflow}>
          <Route size={19} />
          <span>规划复杂任务并协作执行</span>
        </button>
      </div>
    </section>
  );
}

function ComposerPreferenceSelect<T extends string>({
  label,
  value,
  icon,
  options,
  onChange
}: {
  label: string;
  value: T;
  icon: ReactNode;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) || options[0];
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  const select = async (next: T) => {
    if (next === value) { setOpen(false); return; }
    setSaving(true);
    setError("");
    try { await onChange(next); setOpen(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return <div ref={rootRef} className={`composer-preference ${open ? "open" : ""}`}>
    <button type="button" className="composer-control-button composer-preference-trigger" aria-label={`${label}：${selected.label}`} aria-expanded={open} title={`${label}：${selected.label}`} onClick={() => setOpen((current) => !current)}>{icon}<span>{selected.label}</span><ChevronDown size={12} /></button>
    {open && <div className="composer-preference-menu" role="menu" aria-label={label}>
      {options.map((option) => <button type="button" role="menuitemradio" aria-checked={option.value === value} className={option.value === value ? "selected" : ""} disabled={saving} key={option.value} onClick={() => void select(option.value)}><span>{option.label}</span>{option.value === value && <Check size={13} />}</button>)}
      {error && <p>{error}</p>}
    </div>}
  </div>;
}

export function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [sessionNavigation, setSessionNavigation] = useState<SessionNavigationState>({ phase: "idle" });
  const [activeTaskKind, setActiveTaskKind] = useState<"chat" | "workflow" | "workflow-draft" | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [standaloneScope, setStandaloneScope] = useState(() => sessionStorage.getItem(ACTIVE_TASK_SCOPE_KEY) === "standalone");
  const navigationPending = sessionNavigation.phase === "loading";
  const navigationSummary = sessionNavigation.phase === "loading" ? sessionNavigation.summary : undefined;
  const taskFileScopeId = activeSession
    ? activeSession.scopeKind === "standalone" ? activeSession.id : activeSession.workspaceId
    : activeWorkspaceId;
  const [workspaceArchiveOpen, setWorkspaceArchiveOpen] = useState(false);
  const [sidebarSection, setSidebarSection] = useState<SidebarSection>("tasks");
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [layoutWidths, setLayoutWidths] = useState<LayoutWidths>(readLayoutWidths);
  const [resizingPane, setResizingPane] = useState<ResizingPane | null>(null);
  const [sessionContextMenu, setSessionContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [sessionAreaMenu, setSessionAreaMenu] = useState<{ x: number; y: number } | null>(null);
  const [taskFolderMenu, setTaskFolderMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [view, setView] = useState<"chat" | "agents" | "mcp" | "settings" | "git">("chat");
  const [activeWorkflowId, setActiveWorkflowId] = useState("");
  const [workflowDraftOpen, setWorkflowDraftOpen] = useState(false);
  const activeTaskKindRef = useRef<typeof activeTaskKind>(null);
  const taskSelectionGenerationRef = useRef(0);
  const requestCoordinatorRef = useRef(new RequestCoordinator());
  const sessionNavigationRef = useRef<SessionNavigationState>(sessionNavigation);
  const updateSessionNavigation = useCallback((next: SessionNavigationState) => {
    sessionNavigationRef.current = next;
    setSessionNavigation(next);
  }, []);
  const activateStandaloneScope = (standalone: boolean) => {
    sessionStorage.setItem(ACTIVE_TASK_SCOPE_KEY, standalone ? "standalone" : "workspace");
    setStandaloneScope(standalone);
  };
  const [settingsProvider, setSettingsProvider] = useState<EngineName>("claude");
  const [settingsTarget, setSettingsTarget] = useState<SettingsSectionName>("ai");
  const [prompt, setPrompt] = useState("");
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillQuickConfigOpen, setSkillQuickConfigOpen] = useState(false);
  const [invokedSkillNames, setInvokedSkillNames] = useState<string[]>([]);
  const [tree, setTree] = useState<WorkspaceFileNode[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 720);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 1050);
  const [dialog, setDialog] = useState<"workspace" | "task-mode" | "agent" | "agent-import" | "agents" | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const guideInitializedRef = useRef(false);
  const [pendingNewTaskPrompt, setPendingNewTaskPrompt] = useState("");
  const [pendingNewTaskSkills, setPendingNewTaskSkills] = useState<string[]>([]);
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
  const [pendingNewTaskAttachments, setPendingNewTaskAttachments] = useState<DraftAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [submittingInput, setSubmittingInput] = useState(false);
  const [runControlAction, setRunControlAction] = useState<"pause" | "stop" | "">("");
  const [deletingTaskIds, setDeletingTaskIds] = useState<Set<string>>(() => new Set());
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [notice, setNoticeState] = useState<Notice | null>(null);
  const [agents, setAgents] = useState("");
  const [agentsWorkspaceId, setAgentsWorkspaceId] = useState("");
  const [followOutput, setFollowOutput] = useState(true);
  const [touchActionMessageId, setTouchActionMessageId] = useState("");
  const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
  const [previewScopeId, setPreviewScopeId] = useState("");
  const [previewWorkspaceRoot, setPreviewWorkspaceRoot] = useState("");

  useEffect(() => {
    setTouchActionMessageId("");
  }, [activeSession?.id]);

  useEffect(() => {
    if (!touchActionMessageId) return;
    const dismissTouchActions = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const message = target?.closest<HTMLElement>(".message.assistant");
      if (message?.dataset.messageId !== touchActionMessageId) setTouchActionMessageId("");
    };
    document.addEventListener("pointerdown", dismissTouchActions, true);
    return () => document.removeEventListener("pointerdown", dismissTouchActions, true);
  }, [touchActionMessageId]);
  const pagePreferencesRef = useRef(DEFAULT_WORKBENCH_INTERFACE_SETTINGS.workspaceBrowser);
  if (data?.settings.interface) pagePreferencesRef.current = normalizeWorkbenchInterfaceSettings(data.settings.interface).workspaceBrowser;
  const workspaceBrowserReducer = useCallback((state: WorkspaceBrowserTabsState, action: WorkspaceBrowserTabsAction) => (
    reduceWorkspaceBrowserTabs(state, action, { maxTabs: pagePreferencesRef.current.maxTabs })
  ), []);
  const [workspaceBrowser, dispatchWorkspaceBrowser] = useReducer(
    workspaceBrowserReducer,
    "",
    () => loadWorkspaceBrowserTabs(window.localStorage, undefined, undefined, { maxTabs: DEFAULT_WORKBENCH_INTERFACE_SETTINGS.workspaceBrowser.maxTabs })
  );
  const pageRestoreAppliedRef = useRef(false);
  useEffect(() => {
    if (!data || pageRestoreAppliedRef.current) return;
    pageRestoreAppliedRef.current = true;
    if (!pagePreferencesRef.current.restoreTabs) {
      dispatchWorkspaceBrowser({ type: "replace", state: createWorkspaceBrowserTabsState() });
    }
  }, [data]);
  const activeScopeBrowserResource = workspaceBrowser.tabs.find((tab) => tab.id === workspaceBrowser.activeTabId)?.resource;
  const activeFileScopeId = workspaceBrowserScopeId(activeScopeBrowserResource, taskFileScopeId);
  const settlePendingSessionTab = useCallback(() => {
    const pending = sessionNavigationRef.current;
    if (pending.phase !== "loading") return;
    const workspaceId = pending.summary.scopeKind === "standalone" ? undefined : pending.summary.workspaceId;
    dispatchWorkspaceBrowser({
      type: "update-presentation",
      tabId: workspaceBrowserResourceKey({ kind: "conversation", conversationId: pending.sessionId, ...(workspaceId ? { workspaceId } : {}) }),
      patch: { status: "idle" }
    });
  }, []);
  const cancelSessionNavigation = useCallback(() => {
    if (sessionNavigationRef.current.phase !== "loading") return;
    settlePendingSessionTab();
    taskSelectionGenerationRef.current += 1;
    requestCoordinatorRef.current.beginNavigation();
    updateSessionNavigation({ phase: "idle" });
  }, [settlePendingSessionTab, updateSessionNavigation]);
  const activateTaskKind = useCallback((kind: typeof activeTaskKind) => {
    activeTaskKindRef.current = kind;
    taskSelectionGenerationRef.current += 1;
    requestCoordinatorRef.current.beginNavigation();
    if (sessionNavigationRef.current.phase === "loading") {
      settlePendingSessionTab();
      updateSessionNavigation({ phase: "idle" });
    }
    setActiveTaskKind(kind);
    return taskSelectionGenerationRef.current;
  }, [settlePendingSessionTab, updateSessionNavigation]);
  const [tokenDetailsOpen, setTokenDetailsOpen] = useState(false);
  const [messageRenderLimits, setMessageRenderLimits] = useState<Record<string, number>>({});
  const [runningInputMode, setRunningInputMode] = useState<"queue" | "steer">("queue");
  const [skillPolicies, setSkillPolicies] = useState<SkillPolicies>({});
  const [agentSelectionReady, setAgentSelectionReady] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editingMessageText, setEditingMessageText] = useState("");
  const [branching, setBranching] = useState(false);
  const [treeUpdatedAt, setTreeUpdatedAt] = useState<Date | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState("");
  const treeErrorRef = useRef("");
  const [treeQuery, setTreeQuery] = useState("");
  const [historyLoad, setHistoryLoad] = useState<{ sessionId: string; start: number; target: number } | null>(null);
  const [historyPageLoading, setHistoryPageLoading] = useState(false);
  const [agentDrawerMessageId, setAgentDrawerMessageId] = useState("");
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [, setActiveCodexBinding] = useState<CodexLinkBinding | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const agentConfigSaveRef = useRef<Promise<void>>(Promise.resolve());
  const loadedAgentWorkspaceRef = useRef("");
  const skillPoliciesDirtyRef = useRef(false);
  const skillPoliciesVersionRef = useRef(0);
  const treeRequestsRef = useRef(new Map<string, { id: number; controller: AbortController; loading: boolean }>());
  const treeRequestSequenceRef = useRef(0);
  const sessionCacheRef = useRef(new WorkspaceResourceCache<Session>(12));
  const sessionPrefetchTimerRef = useRef<number | null>(null);
  const taskSelectionHandlerRef = useRef<(item: SidebarTaskItem) => void>(() => undefined);
  const treeCacheRef = useRef(new WorkspaceResourceCache<{ tree: WorkspaceFileNode[]; snapshot: string; updatedAt: Date; error: string }>(8));
  const activeFileScopeIdRef = useRef(activeFileScopeId);
  const previewRequestRef = useRef<AbortController | null>(null);
  const previewRequestTabIdRef = useRef("");
  const previewActivationRef = useRef("");
  const previewCacheRef = useRef(new WorkspaceResourceCache<CachedFilePreview>(12));
  const workspaceBrowserRef = useRef(workspaceBrowser);
  const workspaceBrowserHydratedRef = useRef(false);
  const treeStateRef = useRef<TreeNode[]>([]);
  const treeSnapshotRef = useRef("");
  const historyScrollRestoreRef = useRef<{ sessionId: string; scrollHeight: number; scrollTop: number } | null>(null);
  const historyRevealLockRef = useRef(false);
  const resizeRef = useRef<{ pane: ResizingPane; startX: number; startWidth: number } | null>(null);
  activeFileScopeIdRef.current = activeFileScopeId;
  workspaceBrowserRef.current = workspaceBrowser;
  const cancelFilePreviewRequest = useCallback((settleTab = true) => {
    const tabId = previewRequestTabIdRef.current;
    previewRequestRef.current?.abort();
    previewRequestRef.current = null;
    previewRequestTabIdRef.current = "";
    if (settleTab && tabId) {
      dispatchWorkspaceBrowser({ type: "update-presentation", tabId, patch: { status: "idle" } });
    }
  }, []);
  const handleSidebarTaskSelection = useCallback((item: SidebarTaskItem) => taskSelectionHandlerRef.current(item), []);
  const openSidebarTaskContextMenu = useCallback((id: string, x: number, y: number) => {
    if (sessionNavigationRef.current.phase === "loading") return;
    setSessionAreaMenu(null);
    setTaskFolderMenu(null);
    setSessionContextMenu({ id, x, y });
  }, []);
  const openSidebarTaskAreaMenu = useCallback((x: number, y: number) => {
    if (sessionNavigationRef.current.phase === "loading") return;
    setSessionContextMenu(null);
    setTaskFolderMenu(null);
    setSessionAreaMenu({ x, y });
  }, []);
  const openSidebarTaskFolderMenu = useCallback((id: string, x: number, y: number) => {
    if (sessionNavigationRef.current.phase === "loading") return;
    setSessionContextMenu(null);
    setSessionAreaMenu(null);
    setTaskFolderMenu({ id, x, y });
  }, []);

  useEffect(() => () => cancelFilePreviewRequest(false), [cancelFilePreviewRequest]);

  useEffect(() => () => {
    for (const request of treeRequestsRef.current.values()) request.controller.abort();
    treeRequestsRef.current.clear();
  }, []);

  useEffect(() => {
    saveWorkspaceBrowserTabs(window.localStorage, workspaceBrowser);
  }, [workspaceBrowser]);

  const commitWorkspaceTree = (next: TreeNode[], options: { refreshed?: boolean } = {}) => {
    const snapshot = JSON.stringify(next);
    const changed = snapshot !== treeSnapshotRef.current;
    const updatedAt = new Date();
    treeStateRef.current = next;
    treeSnapshotRef.current = snapshot;
    const scopeId = activeFileScopeIdRef.current;
    if (scopeId) treeCacheRef.current.set(scopeId, { tree: next, snapshot, updatedAt, error: "" });
    if (changed) startTransition(() => setTree(next));
    if (changed || options.refreshed) setTreeUpdatedAt(updatedAt);
  };

  const resetWorkspaceTree = () => {
    treeStateRef.current = [];
    treeSnapshotRef.current = "";
    setTree([]);
  };

  const updateSkillPolicies = (next: SkillPolicies | ((current: SkillPolicies) => SkillPolicies)) => {
    setSkillPolicies((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      if (JSON.stringify(resolved) === JSON.stringify(current)) return current;
      skillPoliciesDirtyRef.current = true;
      skillPoliciesVersionRef.current += 1;
      return resolved;
    });
  };

  useEffect(() => {
    localStorage.setItem(LAYOUT_WIDTHS_KEY, JSON.stringify(layoutWidths));
  }, [layoutWidths]);

  const setPaneWidth = (pane: ResizingPane, width: number) => {
    const otherWidth = pane === "sidebar"
      ? inspectorOpen && view === "chat" ? layoutWidths.inspector : 0
      : sidebarOpen ? layoutWidths.sidebar : 0;
    const maxWidth = Math.min(420, Math.max(220, window.innerWidth - otherWidth - 480));
    setLayoutWidths((current) => ({ ...current, [pane]: Math.round(Math.min(maxWidth, Math.max(220, width))) }));
  };

  const beginPaneResize = (pane: ResizingPane, event: React.PointerEvent<HTMLButtonElement>) => {
    if (window.innerWidth <= 1050) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { pane, startX: event.clientX, startWidth: layoutWidths[pane] };
    setResizingPane(pane);
  };

  const movePaneResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = resizeRef.current;
    if (!current) return;
    const delta = current.pane === "sidebar" ? event.clientX - current.startX : current.startX - event.clientX;
    setPaneWidth(current.pane, current.startWidth + delta);
  };

  const endPaneResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!resizeRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    resizeRef.current = null;
    setResizingPane(null);
  };

  const resetPaneWidth = (pane: ResizingPane) => setPaneWidth(pane, DEFAULT_LAYOUT_WIDTHS[pane]);

  const handlePaneResizeKeyDown = (pane: ResizingPane, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Home") { event.preventDefault(); resetPaneWidth(pane); return; }
    if (event.key === "End") { event.preventDefault(); setPaneWidth(pane, Math.min(420, window.innerWidth - (pane === "sidebar" ? layoutWidths.inspector : layoutWidths.sidebar) - 480)); return; }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = pane === "sidebar" ? (event.key === "ArrowRight" ? 1 : -1) : (event.key === "ArrowLeft" ? 1 : -1);
    setPaneWidth(pane, layoutWidths[pane] + direction * 16);
  };

  useEffect(() => {
    setAgentDrawerMessageId("");
  }, [activeSession?.id]);

  useEffect(() => {
    setDraftAttachments([]);
    setAttachmentDragActive(false);
  }, [activeSession?.id, activeWorkspaceId]);

  const setNotice = useCallback((message: string, tone: NoticeTone = "error") => {
    setNoticeState(message ? { message, tone } : null);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const restoreStatus = url.searchParams.get("dataRestore");
    if (!restoreStatus) return;
    if (restoreStatus === "success") setNotice("已安全回到所选备份点", "success");
    else setNotice(`个人数据恢复失败，原数据已保留：${url.searchParams.get("message") || "请查看工作台日志"}`, "error");
    url.searchParams.delete("dataRestore");
    url.searchParams.delete("backup");
    url.searchParams.delete("message");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [setNotice]);

  useEffect(() => {
    if (!activeSession || activeSession.engine !== "codex") {
      setActiveCodexBinding(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/codex-link/bindings/session/${encodeURIComponent(activeSession.id)}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal
    }).then(async (response) => {
      if (response.status === 404) return null;
      const payload = await response.json() as { binding?: CodexLinkBinding; error?: string };
      if (!response.ok) throw new Error(payload.error || "读取 Codex 联动状态失败");
      return payload.binding || null;
    }).then((binding) => {
      if (!controller.signal.aborted) setActiveCodexBinding(binding);
    }).catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!controller.signal.aborted) setActiveCodexBinding(null);
    });
    return () => controller.abort();
  }, [activeSession?.engine, activeSession?.id]);

  const addDraftFiles = (files: File[]) => {
    if (!files.length) return;
    setDraftAttachments((current) => {
      const next = [...current];
      let rejected = "";
      for (const file of files) {
        if (next.length >= 10) { rejected = "每轮最多附加 10 个文件"; break; }
        if (file.size <= 0) { rejected = `空文件无法附加：${file.name}`; continue; }
        if (file.size > 64 * 1024 * 1024) { rejected = `单个附件不能超过 64 MB：${file.name}`; continue; }
        if (next.some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) continue;
        const total = next.reduce((sum, item) => sum + item.file.size, 0) + file.size;
        if (total > 200 * 1024 * 1024) { rejected = "单轮附件总大小不能超过 200 MB"; break; }
        next.push({ id: crypto.randomUUID(), file });
      }
      if (rejected) window.setTimeout(() => setNotice(rejected, "warning"), 0);
      return next;
    });
  };

  const uploadDraftFiles = async (sessionId: string, drafts: DraftAttachment[]) => {
    const uploaded: DraftAttachment[] = [];
    for (const draft of drafts) {
      if (draft.uploaded?.sessionId === sessionId) {
        uploaded.push(draft);
        continue;
      }
      const attachment = await api<Attachment>(`/api/sessions/${sessionId}/attachments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Attachment-Name": encodeURIComponent(draft.file.name),
          "X-Attachment-Type": draft.file.type || "application/octet-stream"
        },
        body: draft.file,
        timeoutMs: 180_000
      });
      uploaded.push({ ...draft, uploaded: { ...attachment, sessionId } });
    }
    return uploaded;
  };

  const refresh = async () => {
    return requestCoordinatorRef.current.run("bootstrap", async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const next = normalizeBootstrap(await api<Bootstrap>("/api/bootstrap"));
          setData((current) => mergeBootstrapProviderState(current, next));
          const restoreStandalone = sessionStorage.getItem(ACTIVE_TASK_SCOPE_KEY) === "standalone"
            && next.sessions.some((session) => session.scopeKind === "standalone" && !session.archivedAt);
          if (restoreStandalone) {
            setStandaloneScope(true);
            setActiveWorkspaceId("");
            return;
          }
          sessionStorage.setItem(ACTIVE_TASK_SCOPE_KEY, "workspace");
          setStandaloneScope(false);
          setActiveWorkspaceId((current) => {
            const remembered = sessionStorage.getItem(ACTIVE_WORKSPACE_KEY) || localStorage.getItem(ACTIVE_WORKSPACE_KEY) || "";
            const available = next.workspaces.filter((item) => !item.archivedAt);
            const candidate =
              available.some((item) => item.id === current) ? current :
              available.some((item) => item.id === remembered) ? remembered :
              available[0]?.id || next.workspaces[0]?.id || "";
            if (candidate) sessionStorage.setItem(ACTIVE_WORKSPACE_KEY, candidate);
            return candidate;
          });
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 4) await new Promise((resolve) => window.setTimeout(resolve, Math.min(500 * 2 ** attempt, 4_000)));
        }
      }
      throw lastError instanceof Error ? lastError : new Error("工作台服务暂时不可用，请稍后重试");
    });
  };

  const refreshNavigation = async () => {
    const next = await requestCoordinatorRef.current.run("navigation", () => api<NavigationSnapshot>("/api/navigation"));
    setData((current) => current ? { ...current, ...next } : current);
    return next;
  };

  const refreshProviderControls = async (force = false) => {
    const next = await requestCoordinatorRef.current.run(
      "provider-controls",
      () => api<ProviderControlBundle>(`/api/provider-controls${force ? "?fresh=1" : ""}`, { timeoutMs: 20_000 }),
      { mode: force ? "replace" : "coalesce" }
    );
    setData((current) => current ? {
      ...current,
      providerControls: next.providerControls,
      runtime: { ...current.runtime, codex: next.codex, claude: next.claude, providers: next.providers }
    } : current);
    return next;
  };

  useEffect(() => {
    if (!data) return;
    let bootstrapRefreshTimer: number | undefined;
    let navigationRefreshTimer: number | undefined;
    let providerRefreshTimer: number | undefined;
    const refreshBootstrap = () => {
      if (bootstrapRefreshTimer) window.clearTimeout(bootstrapRefreshTimer);
      bootstrapRefreshTimer = window.setTimeout(() => {
        bootstrapRefreshTimer = undefined;
        void refresh().catch(() => undefined);
      }, 120);
    };
    const refreshNavigationSnapshot = () => {
      if (navigationRefreshTimer) window.clearTimeout(navigationRefreshTimer);
      navigationRefreshTimer = window.setTimeout(() => {
        navigationRefreshTimer = undefined;
        void refreshNavigation().catch(() => undefined);
      }, 80);
    };
    const refreshProviderSnapshot = (force = false) => {
      if (providerRefreshTimer) window.clearTimeout(providerRefreshTimer);
      providerRefreshTimer = window.setTimeout(() => {
        providerRefreshTimer = undefined;
        void refreshProviderControls(force).catch(() => undefined);
      }, 120);
    };
    const unsubscribers = [
      ...["settings.changed", "mcp.changed", "skills.changed", "agent-market.changed"]
        .map((type) => realtimeCoordinator.subscribe(type, refreshBootstrap)),
      ...["runtime.changed", "agent-market.changed", "provider-control.changed"]
        .map((type) => realtimeCoordinator.subscribe(type, () => refreshProviderSnapshot(true))),
      ...["session.deleted", "workspaces.changed", "workflow.changed"]
        .map((type) => realtimeCoordinator.subscribe(type, refreshNavigationSnapshot)),
      realtimeCoordinator.subscribeReconcile((reason) => {
        if (reason === "connected" || reason === "error" || reason === "watchdog") return;
        refreshNavigationSnapshot();
        refreshBootstrap();
        refreshProviderSnapshot(false);
      })
    ];
    refreshProviderSnapshot(false);
    realtimeCoordinator.start();
    return () => {
      if (bootstrapRefreshTimer) window.clearTimeout(bootstrapRefreshTimer);
      if (navigationRefreshTimer) window.clearTimeout(navigationRefreshTimer);
      if (providerRefreshTimer) window.clearTimeout(providerRefreshTimer);
      for (const unsubscribe of unsubscribers) unsubscribe();
      realtimeCoordinator.stop();
    };
  }, [Boolean(data)]);

  const loadWorkspaceTree = async (workspaceId: string, options: { force?: boolean; silent?: boolean } = {}) => {
    if (!workspaceId) return;
    const request = treeRequestsRef.current.get(workspaceId);
    if (request?.loading && !options.force) return;
    request?.controller.abort();
    const controller = new AbortController();
    const requestId = ++treeRequestSequenceRef.current;
    treeRequestsRef.current.set(workspaceId, { id: requestId, controller, loading: true });
    if (!options.silent && activeFileScopeIdRef.current === workspaceId) setTreeLoading(true);
    try {
      const freshness = options.force ? "?fresh=1" : "";
      const next = await api<TreeNode[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files${freshness}`, { signal: controller.signal, timeoutMs: 25_000 });
      const current = treeRequestsRef.current.get(workspaceId);
      if (current?.id !== requestId) return;
      const cached = treeCacheRef.current.get(workspaceId);
      const recoveredError = cached?.error || treeErrorRef.current;
      const baseTree = activeFileScopeIdRef.current === workspaceId ? treeStateRef.current : cached?.tree || [];
      const merged = mergeWorkspaceTree(baseTree, next);
      if (activeFileScopeIdRef.current !== workspaceId) {
        const snapshot = JSON.stringify(merged);
        treeCacheRef.current.set(workspaceId, { tree: merged, snapshot, updatedAt: new Date(), error: "" });
        return;
      }
      commitWorkspaceTree(merged, { refreshed: !options.silent });
      treeErrorRef.current = "";
      setTreeError("");
      if (recoveredError) setNoticeState((currentNotice) => currentNotice?.message === recoveredError ? null : currentNotice);
    } catch (error) {
      if (controller.signal.aborted) return;
      const current = treeRequestsRef.current.get(workspaceId);
      if (current?.id !== requestId) return;
      const message = error instanceof Error ? error.message : String(error);
      treeErrorRef.current = message;
      const cached = treeCacheRef.current.get(workspaceId);
      if (cached) treeCacheRef.current.set(workspaceId, { ...cached, error: message });
      if (activeFileScopeIdRef.current !== workspaceId) return;
      setTreeError(message);
      if (!options.silent) setNotice(message);
    } finally {
      const current = treeRequestsRef.current.get(workspaceId);
      if (current?.id === requestId) {
        treeRequestsRef.current.delete(workspaceId);
        if (activeFileScopeIdRef.current === workspaceId) setTreeLoading(false);
      }
    }
  };

  const loadWorkspaceDirectory = async (node: WorkspaceFileNode) => {
    if (!activeFileScopeId || node.type !== "directory") return;
    const workspaceId = activeFileScopeId;
    const generation = requestCoordinatorRef.current.currentGeneration;
    try {
      const children = await requestCoordinatorRef.current.run(
        `tree:${workspaceId}:${node.path}`,
        (signal) => api<WorkspaceFileNode[]>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(node.path)}`, { signal, timeoutMs: 25_000 }),
        { generation }
      );
      if (activeFileScopeIdRef.current !== workspaceId) return;
      const next = replaceWorkspaceTreeChildren(treeStateRef.current, node.path, children);
      commitWorkspaceTree(next);
      const recoveredError = treeErrorRef.current;
      treeErrorRef.current = "";
      setTreeError("");
      if (recoveredError) setNoticeState((currentNotice) => currentNotice?.message === recoveredError ? null : currentNotice);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      const message = error instanceof Error ? error.message : String(error);
      treeErrorRef.current = message;
      setTreeError(message);
      setNotice(message);
      throw error;
    }
  };

  const openModelSettings = (provider: EngineName) => {
    cancelSessionNavigation();
    setSettingsProvider(provider);
    setSettingsTarget("ai");
    setView("settings");
  };

  useEffect(() => {
    if (!data || guideInitializedRef.current) return;
    guideInitializedRef.current = true;
    const guidance = normalizeWorkbenchInterfaceSettings(data.settings.interface).guidance;
    if (guidance.completedVersion < CURRENT_GUIDE_VERSION) setGuideOpen(true);
  }, [data]);

  useEffect(() => {
    const reopenGuide = () => setGuideOpen(true);
    window.addEventListener("metacode:open-guide", reopenGuide);
    return () => window.removeEventListener("metacode:open-guide", reopenGuide);
  }, []);

  const completeFirstRunGuide = async () => {
    if (!data) return;
    const current = normalizeWorkbenchInterfaceSettings(data.settings.interface);
    const result = await api<{ interface: WorkbenchInterfaceSettings }>("/api/settings/interface", {
      method: "PATCH",
      body: JSON.stringify({
        ...current,
        guidance: { ...current.guidance, completedVersion: CURRENT_GUIDE_VERSION }
      })
    });
    setData((snapshot) => snapshot ? {
      ...snapshot,
      settings: { ...snapshot.settings, interface: normalizeWorkbenchInterfaceSettings(result.interface) }
    } : snapshot);
    setGuideOpen(false);
  };

  useEffect(() => {
    refresh().catch((error) => setNotice(error.message));
  }, []);

  useEffect(() => {
    if (data || !notice?.message) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    let retryAttempt = 0;

    const retryBootstrap = async () => {
      try {
        await refresh();
        if (!cancelled) setNotice("");
      } catch {
        if (cancelled) return;
        retryAttempt += 1;
        retryTimer = window.setTimeout(retryBootstrap, Math.min(1_000 * 2 ** retryAttempt, 8_000));
      }
    };

    retryTimer = window.setTimeout(retryBootstrap, 1_000);
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [Boolean(data), notice?.message]);

  useEffect(() => {
    if (view !== "agents") return;
    let stopped = false;
    const syncSkills = async () => {
      try {
        const result = await api<{ skills: AgentProfile[]; folders: SkillFolder[]; organizations: SkillOrganization[] }>("/api/skills");
        if (stopped) return;
        setData((current) => {
          if (!current) return current;
          const skills = result.skills.map(normalizeSkillProfile);
          if (JSON.stringify([current.skills, current.skillFolders, current.skillOrganizations]) === JSON.stringify([skills, result.folders, result.organizations])) return current;
          return { ...current, skills, skillFolders: result.folders, skillOrganizations: result.organizations };
        });
      } catch {
        // The main connection notice owns service availability reporting.
      }
    };
    void syncSkills();
    const timer = window.setInterval(syncSkills, 2_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [view]);

  useEffect(() => {
    if (!notice || notice.tone === "error") return;
    const timer = window.setTimeout(() => {
      setNoticeState((current) => current === notice ? null : current);
    }, notice.tone === "success" ? 3_000 : 4_500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    skillPoliciesDirtyRef.current = false;
    skillPoliciesVersionRef.current += 1;
    loadedAgentWorkspaceRef.current = "";
    setAgentSelectionReady(false);
    setInvokedSkillNames([]);
    setSkillMenuOpen(false);
  }, [activeWorkspaceId, standaloneScope, activeSession?.scopeKind === "standalone" ? activeSession.id : ""]);

  useEffect(() => {
    if (!data || !activeWorkspaceId || agentSelectionReady) return;
    const skillNames = data.skills.map((skill) => skill.name);
    const allowed = new Set(skillNames);
    const builtinNames = new Set(data.skills.filter((skill) => skill.builtIn).map((skill) => skill.name));
    const defaultPolicies = Object.fromEntries(data.skills.map((skill) => [skill.name, skill.builtIn ? "auto" : "manual"])) as SkillPolicies;
    const workspace = data.workspaces.find((item) => item.id === activeWorkspaceId);
    const storageKey = `${AGENT_SELECTION_KEY_PREFIX}.${data.user.id}.${activeWorkspaceId}`;
    try {
      if (workspace?.agentSkillPolicies && typeof workspace.agentSkillPolicies === "object") {
        setSkillPolicies(Object.fromEntries(skillNames.map((name) => [name, workspace.agentSkillPolicies?.[name] || defaultPolicies[name]])) as SkillPolicies);
      } else {
        const stored = JSON.parse(localStorage.getItem(storageKey) || "null") as { policies?: SkillPolicies; mode?: AgentDispatchMode; skills?: string[]; delegationEnabled?: boolean } | null;
        if (stored?.policies && typeof stored.policies === "object") {
          setSkillPolicies(Object.fromEntries(skillNames.map((name) => [name, stored.policies?.[name] || "off"])) as SkillPolicies);
        } else if (stored) {
          const selected = new Set(Array.isArray(stored.skills) ? stored.skills.filter((name) => allowed.has(name)) : []);
          if (stored.delegationEnabled !== false) builtinNames.forEach((name) => selected.add(name));
          const selectedPolicy: SkillPolicy = stored.mode === "all" ? "always" : stored.mode === "off" ? "off" : "auto";
          setSkillPolicies(Object.fromEntries(skillNames.map((name) => [name, selected.has(name) ? selectedPolicy : "off"])) as SkillPolicies);
        } else {
          setSkillPolicies(defaultPolicies);
        }
      }
    } catch {
      setSkillPolicies(defaultPolicies);
    }
    loadedAgentWorkspaceRef.current = activeWorkspaceId;
    skillPoliciesDirtyRef.current = false;
    setAgentSelectionReady(true);
  }, [data, activeWorkspaceId, agentSelectionReady]);

  useEffect(() => {
    if (!data || !activeWorkspaceId || !agentSelectionReady || loadedAgentWorkspaceRef.current !== activeWorkspaceId) return;
    const skillNames = data.skills.map((skill) => skill.name);
    const defaults = Object.fromEntries(data.skills.map((skill) => [skill.name, skill.builtIn ? "auto" : "manual"])) as SkillPolicies;
    const valid = Object.fromEntries(skillNames.map((name) => [name, skillPolicies[name] || defaults[name]])) as SkillPolicies;
    const policyKeys = Object.keys(skillPolicies);
    if (policyKeys.length !== skillNames.length || skillNames.some((name) => skillPolicies[name] !== valid[name])) {
      setSkillPolicies(valid);
      return;
    }
    localStorage.setItem(`${AGENT_SELECTION_KEY_PREFIX}.${data.user.id}.${activeWorkspaceId}`, JSON.stringify({ policies: valid }));
    if (!skillPoliciesDirtyRef.current) return;
    const workspace = data.workspaces.find((item) => item.id === activeWorkspaceId);
    const savedPolicies = workspace?.agentSkillPolicies;
    const samePolicies = savedPolicies && skillNames.every((name) => (savedPolicies[name] || "off") === valid[name]);
    if (samePolicies) {
      skillPoliciesDirtyRef.current = false;
      return;
    }
    if (workspace && !samePolicies) {
      const saveVersion = skillPoliciesVersionRef.current;
      agentConfigSaveRef.current = api<{ workspace: Workspace }>(`/api/workspaces/${encodeURIComponent(activeWorkspaceId)}/agent-config`, {
        method: "PUT",
        body: JSON.stringify({ skillPolicies: valid })
      }).then((result) => {
        if (saveVersion !== skillPoliciesVersionRef.current || result.workspace.id !== activeWorkspaceId) return;
        skillPoliciesDirtyRef.current = false;
        setData((current) => current ? { ...current, workspaces: current.workspaces.map((item) => item.id === result.workspace.id ? result.workspace : item) } : current);
      })
        .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    }
  }, [agentSelectionReady, activeWorkspaceId, data, skillPolicies]);

  useEffect(() => {
    if (!data || activeSession?.scopeKind !== "standalone" || agentSelectionReady) return;
    const defaults = Object.fromEntries(data.skills.map((skill) => [skill.name, skill.builtIn ? "auto" : "manual"])) as SkillPolicies;
    const saved = activeSession.standaloneSkillPolicies || defaults;
    setSkillPolicies(Object.fromEntries(data.skills.map((skill) => [skill.name, saved[skill.name] || defaults[skill.name]])) as SkillPolicies);
    loadedAgentWorkspaceRef.current = `session:${activeSession.id}`;
    skillPoliciesDirtyRef.current = false;
    setAgentSelectionReady(true);
  }, [data, activeSession?.id, activeSession?.scopeKind, activeSession?.standaloneSkillPolicies, agentSelectionReady]);

  useEffect(() => {
    if (!data || activeSession?.scopeKind !== "standalone" || !agentSelectionReady || loadedAgentWorkspaceRef.current !== `session:${activeSession.id}` || !skillPoliciesDirtyRef.current) return;
    const defaults = Object.fromEntries(data.skills.map((skill) => [skill.name, skill.builtIn ? "auto" : "manual"])) as SkillPolicies;
    const valid = Object.fromEntries(data.skills.map((skill) => [skill.name, skillPolicies[skill.name] || defaults[skill.name]])) as SkillPolicies;
    const saveVersion = skillPoliciesVersionRef.current;
    agentConfigSaveRef.current = api<SessionSummary>(`/api/sessions/${encodeURIComponent(activeSession.id)}/metadata`, {
      method: "PUT",
      body: JSON.stringify({ skillPolicies: valid })
    }).then((result) => {
      if (saveVersion !== skillPoliciesVersionRef.current || result.id !== activeSession.id) return;
      skillPoliciesDirtyRef.current = false;
      setActiveSession((current) => current?.id === result.id ? { ...current, standaloneSkillPolicies: result.standaloneSkillPolicies, revision: result.revision } : current);
    }).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, [data, activeSession?.id, activeSession?.scopeKind, agentSelectionReady, skillPolicies]);

  useEffect(() => {
    if (!data || data.runtime.codex.available) return;
    const key = "metamodel.codexRuntimeNotice";
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "shown");
    setNotice("未检测到 Codex CLI，请进入设置页联网安装运行环境。", "warning");
  }, [data?.runtime.codex.available]);

  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    let loading = false;
    let supported = true;
    let rerunRequested = false;
    let refreshTimer: number | undefined;
    const syncTaskStatuses = async () => {
      if (!supported || document.hidden) return;
      if (loading) {
        rerunRequested = true;
        return;
      }
      loading = true;
      try {
        const sessions = await api<SessionSummary[]>("/api/sessions", { timeoutMs: 20_000 });
        if (!cancelled) setData((current) => {
          if (!current || sessionSummariesSnapshot(current.sessions) === sessionSummariesSnapshot(sessions)) return current;
          return { ...current, sessions };
        });
      } catch {
        // Keep the latest known task list during transient connection failures.
      } finally {
        loading = false;
        if (rerunRequested && !cancelled) {
          rerunRequested = false;
          scheduleTaskStatusSync(0);
        }
      }
    };
    const scheduleTaskStatusSync = (delay: number) => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void syncTaskStatuses();
      }, delay);
    };
    const timer = window.setInterval(syncTaskStatuses, 30_000);
    const onSessionChanged = (detail: Record<string, unknown>) => {
      // The active conversation reconciles its own revision immediately. The
      // sidebar needs a full snapshot only after a quiet period or at terminal state.
      scheduleTaskStatusSync(detail.status === "running" ? 2_000 : 100);
    };
    const onSessionsChanged = () => scheduleTaskStatusSync(100);
    const onVisibilityChange = () => {
      if (!document.hidden) scheduleTaskStatusSync(0);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const unsubscribeSession = realtimeCoordinator.subscribe("session.changed", onSessionChanged);
    const unsubscribeSessions = realtimeCoordinator.subscribe("sessions.changed", onSessionsChanged);
    const unsubscribeReconcile = realtimeCoordinator.subscribeReconcile(() => scheduleTaskStatusSync(0));
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (refreshTimer) window.clearTimeout(refreshTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unsubscribeSession();
      unsubscribeSessions();
      unsubscribeReconcile();
    };
  }, [Boolean(data)]);

  const running = activeSession?.status === "running";

  useEffect(() => {
    if (!activeSession?.id || !running) return;
    const sessionId = activeSession.id;
    let stopped = false;
    let failures = 0;
    let quietPolls = 0;
    let terminalHandled = false;
    let loading = false;
    let rerunRequested = false;
    let knownRevision = activeSession.revision;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const schedule = (delay: number) => {
      if (stopped) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(requestPoll, delay);
    };
    const requestPoll = () => {
      if (stopped) return;
      if (timer) window.clearTimeout(timer);
      timer = undefined;
      if (loading) {
        rerunRequested = true;
        return;
      }
      void pollSession();
    };
    const pollSession = async () => {
      if (stopped) return;
      if (document.hidden) {
        schedule(1_200);
        return;
      }
      loading = true;
      controller = new AbortController();
      let nextDelay: number | null = null;
      try {
        const next = await api<Session | null>(`/api/sessions/${sessionId}?sinceRevision=${knownRevision}&messageLimit=${MESSAGE_INITIAL_RENDER}`, { signal: controller.signal });
        if (stopped) return;
        failures = 0;
        if (!next) {
          quietPolls += 1;
          nextDelay = Math.min(5_000, 750 + quietPolls * 500);
          return;
        }
        quietPolls = 0;
        knownRevision = next.revision;
        setActiveSession((current) => {
          if (current?.id !== sessionId) return current;
          const unchanged = current.revision === next.revision && current.status === next.status && current.updatedAt === next.updatedAt;
          return unchanged ? current : mergeLatestSessionWindow(current, next);
        });
        if (next.status !== "running" && !terminalHandled) {
          terminalHandled = true;
          await refresh();
          if (activeFileScopeId) {
            if (!stopped) await loadWorkspaceTree(activeFileScopeId, { force: true, silent: true });
          }
          return;
        }
        nextDelay = 750;
      } catch (error) {
        if (stopped || (error instanceof DOMException && error.name === "AbortError")) return;
        failures += 1;
        if (failures >= 3) setNotice(error instanceof Error ? error.message : String(error));
        nextDelay = Math.min(8_000, 900 * (2 ** Math.min(failures, 3)));
      } finally {
        loading = false;
        if (stopped || terminalHandled) return;
        if (rerunRequested) {
          rerunRequested = false;
          schedule(0);
        } else if (nextDelay !== null) schedule(nextDelay);
      }
    };
    requestPoll();
    const onVisibilityChange = () => {
      if (!document.hidden) {
        if (timer) window.clearTimeout(timer);
        requestPoll();
      }
    };
    const onSessionChanged = (detail: Record<string, unknown>) => {
      const changedSessionId = String(detail.sessionId || "");
      if (changedSessionId === sessionId) {
        if (timer) window.clearTimeout(timer);
        requestPoll();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const unsubscribeSession = realtimeCoordinator.subscribe("session.changed", onSessionChanged);
    const unsubscribeReconcile = realtimeCoordinator.subscribeReconcile(requestPoll);
    return () => {
      stopped = true;
      controller?.abort();
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unsubscribeSession();
      unsubscribeReconcile();
    };
  }, [activeSession?.id, running, activeFileScopeId]);

  useEffect(() => {
    if (!activeFileScopeId) {
      resetWorkspaceTree();
      setTreeLoading(false);
      treeErrorRef.current = "";
      setTreeError("");
      setTreeUpdatedAt(null);
      return;
    }
    const cached = treeCacheRef.current.get(activeFileScopeId);
    setTreeLoading(Boolean(treeRequestsRef.current.get(activeFileScopeId)?.loading) || !cached);
    treeStateRef.current = cached?.tree || [];
    treeSnapshotRef.current = cached?.snapshot || "";
    setTree(cached?.tree || []);
    treeErrorRef.current = cached?.error || "";
    setTreeError(cached?.error || "");
    setTreeUpdatedAt(cached?.updatedAt || null);
    void loadWorkspaceTree(activeFileScopeId, { silent: Boolean(cached) });
    const pollTimer = window.setInterval(() => {
      if (!document.hidden) void loadWorkspaceTree(activeFileScopeId, { silent: true });
    }, 15_000);
    const unsubscribeReconcile = realtimeCoordinator.subscribeReconcile(() => {
      if (!document.hidden) void loadWorkspaceTree(activeFileScopeId, { silent: true });
    });
    return () => {
      window.clearInterval(pollTimer);
      unsubscribeReconcile();
    };
  }, [activeFileScopeId]);

  useEffect(() => {
    if (!activeFileScopeId || !tree.length) return;
    for (const tab of workspaceBrowser.tabs) {
      if (tab.resource.kind !== "file" || tab.resource.workspaceId !== activeFileScopeId) continue;
      const node = workspaceTreeNodeByPath(tree, tab.resource.path);
      const cached = previewCacheRef.current.peek(tab.id);
      const dirty = Boolean(node?.modifiedAt && cached?.file.modifiedAt && node.modifiedAt !== cached.file.modifiedAt);
      if (dirty !== tab.dirty) dispatchWorkspaceBrowser({ type: "update-presentation", tabId: tab.id, patch: { dirty } });
    }
  }, [activeFileScopeId, tree, workspaceBrowser.tabs]);

  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(180, Math.max(72, textarea.scrollHeight))}px`;
  }, [prompt]);

  const workspace = data?.workspaces.find((item) => item.id === activeWorkspaceId);
  const fileScopeWorkspace = data?.workspaces.find((item) => item.id === activeFileScopeId);
  const fileScopeStandalone = !fileScopeWorkspace && data?.sessions.some((item) => item.scopeKind === "standalone" && item.id === activeFileScopeId);
  const manualSkillCandidates = useMemo(
    () => (data?.skills || []).filter((skill) => !skill.builtIn && (skillPolicies[skill.name] || "off") !== "off"),
    [data?.skills, skillPolicies]
  );
  const treeHasVisibleItems = useMemo(() => workspaceTreeContainsQuery(tree, treeQuery), [tree, treeQuery]);
  const standaloneActive = activeScopeBrowserResource?.kind === "conversation"
    ? !activeScopeBrowserResource.workspaceId
    : standaloneScope || activeSession?.scopeKind === "standalone";
  const sessions = useMemo(
    () => (data?.sessions || []).filter((item) => (standaloneActive ? item.scopeKind === "standalone" : item.scopeKind !== "standalone" && item.workspaceId === activeWorkspaceId) && !item.archivedAt).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [data?.sessions, activeWorkspaceId, standaloneActive]
  );
  const workflows = useMemo(
    () => (data?.workflows || []).filter((item) => item.workspaceId === activeWorkspaceId && !item.archivedAt).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [data?.workflows, activeWorkspaceId]
  );
  const browserConversationProviders = useMemo(() => {
    const controlsById = new Map((data?.providerControls || []).map((control) => [control.providerId, control]));
    return Object.fromEntries((data?.sessions || []).map((session) => {
      const control = controlsById.get(session.engine);
      return [session.id, {
        providerId: session.engine,
        icon: control?.identity.icon,
        accent: control?.identity.accent
      }];
    }));
  }, [data?.providerControls, data?.sessions]);
  const activeWorkspaceBrowserTab = useMemo(
    () => workspaceBrowser.tabs.find((tab) => tab.id === workspaceBrowser.activeTabId) || null,
    [workspaceBrowser.activeTabId, workspaceBrowser.tabs]
  );
  const activeBrowserConversationResource = activeWorkspaceBrowserTab?.resource.kind === "conversation" ? activeWorkspaceBrowserTab.resource : null;
  const activeBrowserFileResource = activeWorkspaceBrowserTab?.resource.kind === "file" ? activeWorkspaceBrowserTab.resource : null;
  const activeBrowserWorkflowResource = activeWorkspaceBrowserTab?.resource.kind === "workflow" ? activeWorkspaceBrowserTab.resource : null;
  const activeBrowserToolResource = activeWorkspaceBrowserTab?.resource.kind === "tool" ? activeWorkspaceBrowserTab.resource : null;
  const activeConversationViewState = activeBrowserConversationResource
    ? workspaceBrowserConversationViewState(
        activeBrowserConversationResource,
        activeWorkspaceBrowserTab?.status || "idle",
        sessionNavigation.phase === "loading" ? sessionNavigation.sessionId : undefined
      )
    : null;
  const displayedSession = activeBrowserConversationResource
    ? activeSession?.id === activeBrowserConversationResource.conversationId ? activeSession : null
    : activeWorkspaceBrowserTab ? null : activeSession;
  const displayedWorkflowId = activeBrowserWorkflowResource?.workflowId || (!activeWorkspaceBrowserTab ? activeWorkflowId : "");
  const showWorkflowBrowserContent = !activeBrowserFileResource && !activeBrowserToolResource && (
    Boolean(activeBrowserWorkflowResource)
    || (!activeWorkspaceBrowserTab && (workflowDraftOpen || Boolean(activeWorkflowId)))
  );

  useEffect(() => {
    if (!data || !workspaceBrowser.tabs.length) return;
    const validScopeIds = new Set([
      ...data.workspaces.map((item) => item.id),
      ...data.sessions.filter((item) => item.scopeKind === "standalone").map((item) => item.id)
    ]);
    const next = reconcileWorkspaceBrowserTabs(workspaceBrowser, {
      maxTabs: pagePreferencesRef.current.maxTabs,
      isResourceValid: (resource) => resource.kind === "conversation"
        ? data.sessions.some((item) => item.id === resource.conversationId)
        : resource.kind === "workflow"
          ? data.workflows.some((item) => item.id === resource.workflowId)
          : resource.kind === "file"
            ? validScopeIds.has(resource.workspaceId)
            : true,
      resolvePresentation: (resource) => {
      if (resource.kind === "conversation") {
        const session = data.sessions.find((item) => item.id === resource.conversationId);
        if (session) {
            return {
              title: session.title || "对话",
              detail: session.scopeKind === "standalone" ? "临时任务" : data.workspaces.find((item) => item.id === session.workspaceId)?.name || "工作区"
            };
        }
      } else if (resource.kind === "workflow") {
        const workflow = data.workflows.find((item) => item.id === resource.workflowId);
        if (workflow) {
            return {
              title: workflow.title || "工作流",
              detail: data.workspaces.find((item) => item.id === workflow.workspaceId)?.name || "工作区"
            };
        }
      } else if (resource.kind === "file") {
          const title = resource.path.replaceAll("/", "\\").split("\\").filter(Boolean).at(-1) || "文件";
        const scopeName = data.workspaces.find((item) => item.id === resource.workspaceId)?.name
          || data.sessions.find((item) => item.id === resource.workspaceId)?.title
          || "工作区";
          return { title, detail: `${scopeName} · ${resource.path}` };
      }
        return undefined;
      }
    });
    if (next !== workspaceBrowser) dispatchWorkspaceBrowser({ type: "replace", state: next });
  }, [data, workspaceBrowser]);
  const taskFolders = useMemo(() => workspace?.taskFolders || [], [workspace?.taskFolders]);
  const taskItems = useMemo<SidebarTaskItem[]>(() => [
    ...sessions.map((task) => ({ kind: "chat" as const, task })),
    ...workflows.map((task) => ({ kind: "workflow" as const, task }))
  ].sort((a, b) => Number(Boolean(b.task.pinned)) - Number(Boolean(a.task.pinned)) || Date.parse(b.task.updatedAt) - Date.parse(a.task.updatedAt)), [sessions, workflows]);
  const normalizedSidebarQuery = useMemo(() => sidebarQuery.trim().toLocaleLowerCase(), [sidebarQuery]);
  const deferredSidebarQuery = useDeferredValue(normalizedSidebarQuery);
  const { visibleTaskItems, activeTaskShortcuts, pinnedTaskShortcuts, recentUnfiledTasks, folderTaskItems } = useMemo(() => {
    const knownFolderIds = new Set(taskFolders.map((folder) => folder.id));
    const byFolder = new Map(taskFolders.map((folder) => [folder.id, [] as SidebarTaskItem[]]));
    const visible: SidebarTaskItem[] = [];
    const active: SidebarTaskItem[] = [];
    const pinned: SidebarTaskItem[] = [];
    const recent: SidebarTaskItem[] = [];

    for (const item of taskItems) {
      const isActive = ACTIVE_TASK_STATUSES.has(item.task.status);
      if (!deferredSidebarQuery || item.task.title.toLocaleLowerCase().includes(deferredSidebarQuery)) visible.push(item);
      if (isActive) active.push(item);
      else if (item.task.pinned) pinned.push(item);
      if (!item.task.pinned && !isActive && (!item.task.folderId || !knownFolderIds.has(item.task.folderId))) recent.push(item);
      if (item.task.folderId) byFolder.get(item.task.folderId)?.push(item);
    }

    return {
      visibleTaskItems: visible,
      activeTaskShortcuts: active,
      pinnedTaskShortcuts: pinned,
      recentUnfiledTasks: recent,
      folderTaskItems: byFolder
    };
  }, [taskItems, taskFolders, deferredSidebarQuery]);
  const archivedSessions = useMemo(() => (data?.sessions || []).filter((item) => (standaloneScope ? item.scopeKind === "standalone" : item.scopeKind !== "standalone" && item.workspaceId === activeWorkspaceId) && item.archivedAt).sort((a, b) => Date.parse(b.archivedAt || "") - Date.parse(a.archivedAt || "")), [data?.sessions, activeWorkspaceId, standaloneScope]);
  const archivedWorkflows = useMemo(() => (data?.workflows || []).filter((item) => item.workspaceId === activeWorkspaceId && item.archivedAt).sort((a, b) => Date.parse(b.archivedAt || "") - Date.parse(a.archivedAt || "")), [data?.workflows, activeWorkspaceId]);
  const archivedTasks = useMemo<SidebarTaskItem[]>(() => [
    ...archivedSessions.map((task) => ({ kind: "chat" as const, task })),
    ...archivedWorkflows.map((task) => ({ kind: "workflow" as const, task }))
  ], [archivedSessions, archivedWorkflows]);
  const activeCapabilityProfileId = activeSession?.scopeKind === "standalone" ? activeSession.standaloneCapabilityProfileId || null : workspace?.agentCapabilityProfileId || null;
  const activeCapabilityProfile = useMemo(() => data?.capabilityProfiles?.find((profile) => profile.id === activeCapabilityProfileId) || null, [data?.capabilityProfiles, activeCapabilityProfileId]);
  const currentExecutionMode: ExecutionMode = activeSession?.scopeKind === "standalone"
    ? activeSession.standaloneExecutionMode || "collaborative"
    : workspace?.agentExecutionMode || ((skillPolicies[BUILTIN_DELEGATION_SKILL_NAME] === "auto" || skillPolicies[BUILTIN_DELEGATION_SKILL_NAME] === "always") ? "collaborative" : "native");
  const recentCapabilityProfiles = useMemo(() => [...(data?.capabilityProfiles || [])].sort((left, right) => (right.lastUsedAt || right.updatedAt).localeCompare(left.lastUsedAt || left.updatedAt)).slice(0, 4), [data?.capabilityProfiles]);
  const applyCapabilityProfile = async (profileId: string | null, savedProfile?: CapabilityProfile) => {
    if (activeSession?.scopeKind === "standalone") {
      const profile = profileId ? savedProfile?.id === profileId ? savedProfile : data?.capabilityProfiles?.find((item) => item.id === profileId) : null;
      if (profileId && !profile) throw new Error("能力方案不存在");
      const defaults = Object.fromEntries((data?.skills || []).map((skill) => [skill.name, skill.builtIn ? "auto" : "manual"])) as SkillPolicies;
      const nextPolicies = Object.fromEntries((data?.skills || []).map((skill) => [skill.name, profile?.skillPolicies[skill.name] || defaults[skill.name]])) as SkillPolicies;
      const result = await api<SessionSummary>(`/api/sessions/${encodeURIComponent(activeSession.id)}/metadata`, {
        method: "PUT",
        body: JSON.stringify({ capabilityProfileId: profileId, skillPolicies: nextPolicies })
      });
      skillPoliciesVersionRef.current += 1;
      skillPoliciesDirtyRef.current = false;
      setSkillPolicies(nextPolicies);
      setActiveSession((current) => current?.id === result.id ? { ...current, ...result } : current);
      await refresh();
      return;
    }
    if (!activeWorkspaceId) throw new Error("请先选择工作区");
    const result = await api<{ workspace: Workspace; skillPolicies: SkillPolicies }>(`/api/workspaces/${encodeURIComponent(activeWorkspaceId)}/agent-config`, { method: "PUT", body: JSON.stringify({ capabilityProfileId: profileId }) });
    skillPoliciesDirtyRef.current = false;
    setSkillPolicies(result.skillPolicies);
    setData((current) => current ? { ...current, workspaces: current.workspaces.map((item) => item.id === activeWorkspaceId ? { ...item, ...result.workspace } : item) } : current);
    await refresh();
  };
  const prefetchSession = useCallback((id: string) => {
    if (sessionCacheRef.current.isFresh(id, SESSION_CACHE_FRESH_MS)) return;
    void requestCoordinatorRef.current.run(
      `session:${id}`,
      (signal) => api<Session>(`/api/sessions/${id}?messageLimit=${MESSAGE_INITIAL_RENDER}`, { signal, timeoutMs: 25_000 })
    ).then((session) => {
      if (isSessionPayload(session)) sessionCacheRef.current.set(id, session);
    }).catch(() => undefined);
  }, []);
  const scheduleSessionPrefetch = useCallback((id: string) => {
    if (sessionPrefetchTimerRef.current) window.clearTimeout(sessionPrefetchTimerRef.current);
    sessionPrefetchTimerRef.current = window.setTimeout(() => {
      sessionPrefetchTimerRef.current = null;
      prefetchSession(id);
    }, 140);
  }, [prefetchSession]);
  const cancelSessionPrefetch = useCallback(() => {
    if (sessionPrefetchTimerRef.current) window.clearTimeout(sessionPrefetchTimerRef.current);
    sessionPrefetchTimerRef.current = null;
  }, []);
  const { activeWorkspaces, pinnedWorkspaces, recentWorkspaces, archivedWorkspaces } = useMemo(() => {
    const active: Workspace[] = [];
    const pinned: Workspace[] = [];
    const recent: Workspace[] = [];
    const archived: Workspace[] = [];
    for (const item of data?.workspaces || []) {
      if (item.archivedAt) archived.push(item);
      else {
        active.push(item);
        if (item.pinned) pinned.push(item);
        else recent.push(item);
      }
    }
    recent.sort((a, b) => Date.parse(b.lastOpenedAt || b.createdAt) - Date.parse(a.lastOpenedAt || a.createdAt));
    archived.sort((a, b) => Date.parse(b.archivedAt || "") - Date.parse(a.archivedAt || ""));
    return { activeWorkspaces: active, pinnedWorkspaces: pinned, recentWorkspaces: recent, archivedWorkspaces: archived };
  }, [data?.workspaces]);
  const showSidebarSection = (section: SidebarSection) => {
    if (view === "chat" && sidebarOpen && sidebarSection === section) {
      setSidebarOpen(false);
      return;
    }
    setView("chat");
    setSidebarSection(section);
    setSidebarOpen(true);
  };
  const renderWorkspaceItem = (item: Workspace) => <div className={`workspace-menu-item ${item.id === activeWorkspaceId ? "selected" : ""}`} key={item.id}>
    <button type="button" onClick={() => {
      void openWorkspace(item.id).then(() => setSidebarSection("tasks")).catch((error) => setNotice(error.message));
    }}><FolderOpen size={15} /><span className="workspace-menu-item-copy" title={item.root}><strong>{item.name}</strong><small>{item.root}</small></span>{item.pinned && <Pin size={12} />}</button>
    <details><summary aria-label={`管理工作区：${item.name}`}><MoreHorizontal size={15} /></summary><div className="workspace-actions">
      {!item.archivedAt && <button type="button" onClick={() => updateWorkspaceMetadata(item.id, { pinned: !item.pinned }).catch((error) => setNotice(error.message))}><Pin size={14} />{item.pinned ? "取消置顶" : "置顶"}</button>}
      {item.archivedAt ? <button type="button" onClick={() => updateWorkspaceMetadata(item.id, { archived: false }).catch((error) => setNotice(error.message))}><ArchiveRestore size={14} />恢复工作区</button> : <button type="button" onClick={() => updateWorkspaceMetadata(item.id, { archived: true }).catch((error) => setNotice(error.message))}><Archive size={14} />归档工作区</button>}
      <button type="button" onClick={async () => { const name = window.prompt("修改工作区名称", item.name)?.trim(); if (name && name !== item.name) await updateWorkspaceMetadata(item.id, { name }); }}><Pencil size={14} />重命名</button>
    </div></details>
  </div>;

  const resetTaskViewState = () => {
    cancelFilePreviewRequest();
    setFollowOutput(true);
    setAgentDrawerMessageId("");
    setTokenDetailsOpen(false);
    setHistoryLoad(null);
    setHistoryPageLoading(false);
    setEditingMessageId("");
    setEditingMessageText("");
    setSkillMenuOpen(false);
    setSkillQuickConfigOpen(false);
    setPreviewFile(null);
    setPreviewScopeId("");
    setPreviewWorkspaceRoot("");
  };

  const commitSessionSelection = (session: Session, source: SessionNavigationSource) => {
    if (!isSessionPayload(session)) throw new Error("会话响应不完整，已保留当前界面，请重试");
    const isStandalone = session.scopeKind === "standalone";
    const workspaceId = isStandalone ? "" : session.workspaceId;
    const scopeKey = isStandalone ? "__standalone__" : workspaceId;

    activeTaskKindRef.current = "chat";
    sessionNavigationRef.current = { phase: "idle" };
    sessionStorage.setItem(ACTIVE_TASK_SCOPE_KEY, isStandalone ? "standalone" : "workspace");
    if (workspaceId) sessionStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId);
    rememberSession(scopeKey, session.id);
    forgetWorkspaceWorkflow(scopeKey);
    sessionCacheRef.current.set(session.id, session);
    const workspaceName = isStandalone ? "临时任务" : data?.workspaces.find((item) => item.id === workspaceId)?.name || "工作区";
    dispatchWorkspaceBrowser({
      type: "open",
      input: {
        resource: { kind: "conversation", conversationId: session.id, ...(workspaceId ? { workspaceId } : {}) },
        title: session.title || "对话",
        detail: workspaceName,
        mode: "regular",
        status: "idle"
      }
    });

    setActiveTaskKind("chat");
    setStandaloneScope(isStandalone);
    setActiveWorkspaceId(workspaceId);
    setActiveSession(session);
    setActiveWorkflowId("");
    setWorkflowDraftOpen(false);
    setView("chat");
    setSessionNavigation({ phase: "idle" });
    resetTaskViewState();
    if (source !== "task") setPrompt("");
    if (window.innerWidth <= 720 && source !== "scope") setSidebarOpen(false);
  };

  const navigateToSession = async (id: string, source: SessionNavigationSource = "task"): Promise<boolean> => {
    const previousSelection = {
      session: activeSession,
      standaloneScope,
      workspaceId: activeWorkspaceId
    };
    const pending = sessionNavigationRef.current;
    if (pending.phase === "loading" && pending.sessionId === id) return false;
    if (activeSession?.id === id) {
      const isStandalone = activeSession.scopeKind === "standalone";
      const expectedWorkspaceId = isStandalone ? "" : activeSession.workspaceId;
      const bindingMismatch = standaloneScope !== isStandalone || activeWorkspaceId !== expectedWorkspaceId;
      if (pending.phase === "loading") activateTaskKind("chat");
      if (bindingMismatch) {
        commitSessionSelection(activeSession, source);
      } else if (source !== "task") {
        setView("chat");
      }
      return true;
    }

    const summary = data?.sessions.find((item) => item.id === id);
    if (!summary) {
      sessionCacheRef.current.delete(id);
      setNotice("任务不存在或已被移除");
      return false;
    }
    const summaryWorkspaceName = summary.scopeKind === "standalone"
      ? "临时任务"
      : data?.workspaces.find((item) => item.id === summary.workspaceId)?.name || "工作区";
    const summaryBrowserResource = {
      kind: "conversation" as const,
      conversationId: summary.id,
      ...(summary.scopeKind === "standalone" ? {} : { workspaceId: summary.workspaceId })
    };
    settlePendingSessionTab();
    dispatchWorkspaceBrowser({
      type: "open",
      input: { resource: summaryBrowserResource, title: summary.title || "对话", detail: summaryWorkspaceName, mode: "regular", status: "loading" }
    });
    const targetStandalone = summary.scopeKind === "standalone";
    const targetWorkspaceId = targetStandalone ? "" : summary.workspaceId;
    sessionStorage.setItem(ACTIVE_TASK_SCOPE_KEY, targetStandalone ? "standalone" : "workspace");
    if (targetWorkspaceId) sessionStorage.setItem(ACTIVE_WORKSPACE_KEY, targetWorkspaceId);
    setStandaloneScope(targetStandalone);
    setActiveWorkspaceId(targetWorkspaceId);
    setActiveSession(null);
    setActiveWorkflowId("");
    setWorkflowDraftOpen(false);
    setView("chat");

    taskSelectionGenerationRef.current += 1;
    const selectionGeneration = taskSelectionGenerationRef.current;
    const generation = requestCoordinatorRef.current.beginNavigation();
    setSessionContextMenu(null);
    setSessionAreaMenu(null);
    setTaskFolderMenu(null);
    const cached = sessionCacheRef.current.getEntry(id);
    if (cached && cached.ageMs <= SESSION_CACHE_FRESH_MS && isSessionPayload(cached.value)) {
      commitSessionSelection(cached.value, source);
      return true;
    }

    updateSessionNavigation({ phase: "loading", source, sessionId: id, summary, generation, selectionGeneration });
    try {
      const session = await requestCoordinatorRef.current.run(
        `session:${id}`,
        (signal) => api<Session>(`/api/sessions/${id}?messageLimit=${MESSAGE_INITIAL_RENDER}`, { signal, timeoutMs: 25_000 }),
        { generation }
      );
      if (!isSessionPayload(session)) throw new Error("服务端返回了空会话，已保留原对话");
      const currentNavigation = sessionNavigationRef.current;
      if (!requestCoordinatorRef.current.isCurrentGeneration(generation)
        || selectionGeneration !== taskSelectionGenerationRef.current
        || !matchesSessionNavigation(currentNavigation, { sessionId: id, generation, selectionGeneration })) return false;
      commitSessionSelection(session, source);
      return true;
    } catch (error) {
      const currentNavigation = sessionNavigationRef.current;
      if (!matchesSessionNavigation(currentNavigation, { sessionId: id, generation, selectionGeneration })
        || selectionGeneration !== taskSelectionGenerationRef.current) return false;
      updateSessionNavigation({ phase: "idle" });
      if (previousSelection.session && isSessionPayload(previousSelection.session)) {
        setActiveSession(previousSelection.session);
        setStandaloneScope(previousSelection.standaloneScope);
        setActiveWorkspaceId(previousSelection.workspaceId);
        sessionStorage.setItem(ACTIVE_TASK_SCOPE_KEY, previousSelection.standaloneScope ? "standalone" : "workspace");
        if (previousSelection.workspaceId) sessionStorage.setItem(ACTIVE_WORKSPACE_KEY, previousSelection.workspaceId);
      }
      if (!(error instanceof Error) || error.name !== "AbortError") {
        sessionCacheRef.current.delete(id);
        dispatchWorkspaceBrowser({ type: "update-presentation", tabId: workspaceBrowserResourceKey(summaryBrowserResource), patch: { status: "error" } });
        setNotice(error instanceof Error ? error.message : String(error));
      }
      return false;
    }
  };

  const selectSession = (id: string) => navigateToSession(id, "task");

  const selectWorkflow = (id: string) => {
    const workflow = data?.workflows.find((item) => item.id === id);
    cancelSessionNavigation();
    activateTaskKind("workflow");
    setView("chat");
    setActiveSession(null);
    setActiveWorkflowId(id);
    setWorkflowDraftOpen(false);
    const workspaceId = workflow?.workspaceId || activeWorkspaceId;
    if (workspaceId) {
      sessionStorage.setItem(ACTIVE_TASK_SCOPE_KEY, "workspace");
      sessionStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId);
      setStandaloneScope(false);
      setActiveWorkspaceId(workspaceId);
      rememberWorkflow(workspaceId, id);
    }
    if (workflow) dispatchWorkspaceBrowser({
      type: "open",
      input: {
        resource: { kind: "workflow", workflowId: workflow.id, workspaceId: workflow.workspaceId },
        title: workflow.title || "工作流",
        detail: data?.workspaces.find((item) => item.id === workflow.workspaceId)?.name || "工作区",
        mode: "regular"
      }
    });
    if (window.innerWidth <= 720) setSidebarOpen(false);
  };
  useLayoutEffect(() => {
    taskSelectionHandlerRef.current = (item) => {
      if (item.kind === "chat") void selectSession(item.task.id);
      else selectWorkflow(item.task.id);
    };
  });

  const openWorkspace = async (workspaceId: string, source: "workspace" | "scope" = "workspace") => {
    if (!workspaceId) {
      activateTaskKind(null);
      dispatchWorkspaceBrowser({ type: "deactivate" });
      previewActivationRef.current = "";
      setPreviewFile(null);
      setPreviewScopeId("");
      setPreviewWorkspaceRoot("");
      setActiveWorkspaceId("");
      setActiveSession(null);
      setActiveWorkflowId("");
      setWorkflowDraftOpen(false);
      return;
    }
    const workspaceSessions = (data?.sessions || []).filter((item) => item.scopeKind !== "standalone" && item.workspaceId === workspaceId && !item.archivedAt);
    const workspaceWorkflows = (data?.workflows || []).filter((item) => item.workspaceId === workspaceId && !item.archivedAt);
    const rememberedSessionId = activeSessionMap()[workspaceId];
    const rememberedWorkflowId = activeWorkflowMap()[workspaceId];
    const rememberedWorkflow = workspaceWorkflows.find((item) => item.id === rememberedWorkflowId)
      || (!workspaceSessions.length ? workspaceWorkflows[0] : undefined);
    const existing = workspaceSessions.find((item) => item.id === rememberedSessionId) || workspaceSessions[0];
    if (!rememberedWorkflow && existing) {
      const opened = await navigateToSession(existing.id, source);
      if (opened) void api(`/api/workspaces/${encodeURIComponent(workspaceId)}/metadata`, { method: "PUT", body: JSON.stringify({ opened: true }) }).catch(() => undefined);
      return;
    }
    if (rememberedWorkflow) {
      selectWorkflow(rememberedWorkflow.id);
      void api(`/api/workspaces/${encodeURIComponent(workspaceId)}/metadata`, { method: "PUT", body: JSON.stringify({ opened: true }) }).catch(() => undefined);
      if (window.innerWidth <= 720 && source !== "scope") setSidebarOpen(false);
      return;
    }

    activateTaskKind("chat");
    dispatchWorkspaceBrowser({ type: "deactivate" });
    previewActivationRef.current = "";
    setPreviewFile(null);
    setPreviewScopeId("");
    setPreviewWorkspaceRoot("");
    sessionStorage.setItem(ACTIVE_TASK_SCOPE_KEY, "workspace");
    sessionStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId);
    setStandaloneScope(false);
    setActiveWorkspaceId(workspaceId);
    setActiveSession(null);
    setActiveWorkflowId("");
    setWorkflowDraftOpen(false);
    setView("chat");
    resetTaskViewState();
    void api(`/api/workspaces/${encodeURIComponent(workspaceId)}/metadata`, { method: "PUT", body: JSON.stringify({ opened: true }) }).catch(() => undefined);
    if (window.innerWidth <= 720 && source !== "scope") setSidebarOpen(false);
  };

  const openTaskScope = (scope: "workspace" | "standalone") => {
    const pending = sessionNavigationRef.current;
    const revealTaskSidebar = () => {
      setView("chat");
      setSidebarSection("tasks");
      setSidebarOpen(true);
    };

    if (scope === "standalone") {
      const pendingStandalone = pending.phase === "loading" && pending.summary.scopeKind === "standalone";
      const alreadyStandalone = standaloneScope || activeSession?.scopeKind === "standalone";
      if (pendingStandalone) {
        revealTaskSidebar();
        return;
      }
      if (alreadyStandalone && pending.phase === "idle") {
        showSidebarSection("tasks");
        return;
      }

      cancelSessionNavigation();
      revealTaskSidebar();
      const available = (data?.sessions || []).filter((item) => item.scopeKind === "standalone" && !item.archivedAt);
      const rememberedSessionId = activeSessionMap().__standalone__;
      const target = available.find((item) => item.id === rememberedSessionId) || available[0];
      if (target) {
        void navigateToSession(target.id, "scope").catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
        return;
      }

      activateTaskKind("chat");
      dispatchWorkspaceBrowser({ type: "deactivate" });
      previewActivationRef.current = "";
      setPreviewFile(null);
      setPreviewScopeId("");
      setPreviewWorkspaceRoot("");
      sessionStorage.setItem(ACTIVE_TASK_SCOPE_KEY, "standalone");
      setStandaloneScope(true);
      setActiveWorkspaceId("");
      setActiveSession(null);
      setActiveWorkflowId("");
      setWorkflowDraftOpen(false);
      setPrompt("");
      resetTaskViewState();
      return;
    }

    const pendingWorkspaceId = pending.phase === "loading" && pending.summary.scopeKind !== "standalone"
      ? pending.summary.workspaceId
      : "";
    const pendingWorkspace = data?.workspaces.find((item) => item.id === pendingWorkspaceId && !item.archivedAt);
    if (pendingWorkspace) {
      revealTaskSidebar();
      return;
    }

    const currentWorkspace = data?.workspaces.find((item) => item.id === activeWorkspaceId && !item.archivedAt);
    const alreadyInWorkspace = !standaloneScope && activeSession?.scopeKind !== "standalone" && Boolean(currentWorkspace);
    if (alreadyInWorkspace && pending.phase === "idle") {
      showSidebarSection("tasks");
      return;
    }

    const rememberedWorkspaceId = sessionStorage.getItem(ACTIVE_WORKSPACE_KEY) || localStorage.getItem(ACTIVE_WORKSPACE_KEY) || "";
    const targetWorkspace = currentWorkspace
      || data?.workspaces.find((item) => item.id === rememberedWorkspaceId && !item.archivedAt)
      || data?.workspaces.find((item) => !item.archivedAt);
    cancelSessionNavigation();
    if (!targetWorkspace) {
      dispatchWorkspaceBrowser({ type: "deactivate" });
      previewActivationRef.current = "";
      setPreviewFile(null);
      setPreviewScopeId("");
      setPreviewWorkspaceRoot("");
      setView("chat");
      setSidebarSection("workspaces");
      setSidebarOpen(true);
      return;
    }

    revealTaskSidebar();
    void openWorkspace(targetWorkspace.id, "scope").catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  };

  useEffect(() => {
    if (sessionNavigationRef.current.phase === "loading") return;
    if (!data || (!activeWorkspaceId && !standaloneScope)) {
      if (activeSession) setActiveSession(null);
      return;
    }
    if (workspaceBrowserHydratedRef.current && workspaceBrowser.activeTabId === null && workspaceBrowser.tabs.length === 0 && activeTaskKind === null) {
      if (activeSession) setActiveSession(null);
      return;
    }
    if (activeTaskKind === "workflow-draft" || workflowDraftOpen) {
      if (activeSession) setActiveSession(null);
      return;
    }
    if (workspaceBrowser.activeTabId !== null) return;
    if (workspaceBrowser.activeTabId === null && workspaceBrowser.tabs.length > 0) {
      if (activeSession) setActiveSession(null);
      return;
    }

    const scopeKey = standaloneScope ? "__standalone__" : activeWorkspaceId;
    const scopedSessions = data.sessions.filter((session) => standaloneScope
      ? session.scopeKind === "standalone" && !session.archivedAt
      : session.scopeKind !== "standalone" && session.workspaceId === activeWorkspaceId && !session.archivedAt);
    const scopedWorkflows = standaloneScope
      ? []
      : data.workflows.filter((workflow) => workflow.workspaceId === activeWorkspaceId && !workflow.archivedAt);
    const rememberedSessionId = activeSessionMap()[scopeKey];
    const rememberedWorkflowId = activeWorkflowMap()[scopeKey];
    const selectedWorkflowId = scopedWorkflows.some((workflow) => workflow.id === activeWorkflowId) ? activeWorkflowId : "";
    const validRememberedWorkflowId = scopedWorkflows.some((workflow) => workflow.id === rememberedWorkflowId) ? rememberedWorkflowId : "";
    const desiredKind = activeTaskKind || (selectedWorkflowId || validRememberedWorkflowId ? "workflow" : "chat");

    if (desiredKind === "workflow") {
      const desiredWorkflowId = selectedWorkflowId || validRememberedWorkflowId;
      if (desiredWorkflowId) {
        if (activeWorkflowId !== desiredWorkflowId || activeSession) selectWorkflow(desiredWorkflowId);
        return;
      }
      activeTaskKindRef.current = "chat";
      setActiveTaskKind("chat");
    }

    const desiredSessionId = scopedSessions.some((session) => session.id === rememberedSessionId)
      ? rememberedSessionId
      : scopedSessions[0]?.id;
    if (!desiredSessionId) {
      if (!activeTaskKind) {
        activeTaskKindRef.current = "chat";
        setActiveTaskKind("chat");
      }
      if (activeSession) setActiveSession(null);
      return;
    }
    if (activeSession?.id !== desiredSessionId && sessionNavigationRef.current.phase === "idle") {
      void navigateToSession(desiredSessionId, "workspace");
    }
  }, [data, activeWorkspaceId, standaloneScope, activeSession?.id, activeWorkflowId, activeTaskKind, workflowDraftOpen, workspaceBrowser.activeTabId, workspaceBrowser.tabs.length]);

  const updateWorkspaceMetadata = async (workspaceId: string, body: { pinned?: boolean; archived?: boolean; name?: string }) => {
    const updated = await api<Workspace>(`/api/workspaces/${encodeURIComponent(workspaceId)}/metadata`, { method: "PUT", body: JSON.stringify(body) });
    setData((current) => current ? { ...current, workspaces: current.workspaces.map((item) => item.id === updated.id ? updated : item) } : current);
    if (body.archived && workspaceId === activeWorkspaceId) {
      const next = data?.workspaces.find((item) => item.id !== workspaceId && !item.archivedAt);
      if (next) await openWorkspace(next.id);
      else { setActiveWorkspaceId(""); setActiveSession(null); }
    }
  };

  const createSession = () => {
    cancelSessionNavigation();
    setPendingNewTaskPrompt("");
    setPendingNewTaskSkills([]);
    setPendingNewTaskAttachments([]);
    setDraftAttachments([]);
    setDialog("task-mode");
  };

  const openWorkflowDraft = async () => {
    activateTaskKind("workflow-draft");
    dispatchWorkspaceBrowser({ type: "deactivate" });
    previewActivationRef.current = "";
    setPreviewFile(null);
    setPreviewScopeId("");
    setPreviewWorkspaceRoot("");
    setActiveSession(null);
    setActiveWorkflowId("");
    setWorkflowDraftOpen(true);
    setDialog(null);
    setView("chat");
  };

  const createWorkflow = async (plannerEngine: EngineName, workflowPrompt: string, maxConcurrentAgents: number | null) => {
    if (!activeWorkspaceId || !workflowPrompt.trim()) throw new Error("请输入完整任务");
    const created = await api<WorkflowSummary>("/api/workflows", { method: "POST", body: JSON.stringify({ workspaceId: activeWorkspaceId, prompt: workflowPrompt.trim(), plannerEngine, maxConcurrentAgents }) });
    activateTaskKind("workflow");
    setActiveSession(null);
    setActiveWorkflowId(created.id);
    setWorkflowDraftOpen(false);
    rememberWorkflow(activeWorkspaceId, created.id);
    setDialog(null);
    setView("chat");
    dispatchWorkspaceBrowser({
      type: "open",
      input: {
        resource: { kind: "workflow", workflowId: created.id, workspaceId: activeWorkspaceId },
        title: created.title || "工作流",
        detail: data?.workspaces.find((item) => item.id === activeWorkspaceId)?.name || "工作区",
        mode: "regular"
      }
    });
    await refresh();
    setNotice("任务已创建，规划 Agent 正在分析", "success");
    void api(`/api/workflows/${encodeURIComponent(created.id)}/plan`, { method: "POST" })
      .then(() => refresh())
      .catch((error) => { setNotice(error instanceof Error ? error.message : String(error), "error"); void refresh(); });
    return created;
  };

  const createSessionForEngine = async (engine: EngineName, scopeKind: "workspace" | "standalone") => {
    if (scopeKind === "workspace" && !activeWorkspaceId) throw new Error("请先选择工作区");
    await agentConfigSaveRef.current;
    const initialPrompt = pendingNewTaskPrompt.trim();
    const initialSkills = pendingNewTaskSkills;
    const initialAttachments = pendingNewTaskAttachments;
    setUploadingAttachments(true);
    try {
      const session = await api<Session>(`/api/sessions?messageLimit=${MESSAGE_INITIAL_RENDER}`, {
        method: "POST",
        body: JSON.stringify({ workspaceId: scopeKind === "workspace" ? activeWorkspaceId : undefined, scopeKind, engine, skillPolicies: scopeKind === "standalone" ? skillPolicies : undefined, capabilityProfileId: scopeKind === "standalone" ? activeCapabilityProfileId : undefined, executionMode: scopeKind === "standalone" ? currentExecutionMode : undefined })
      });
      const scopeKey = scopeKind === "standalone" ? "__standalone__" : activeWorkspaceId;
      rememberSession(scopeKey, session.id);
      forgetWorkspaceWorkflow(scopeKey);
      commitSessionSelection({ ...session, messageCount: 0 }, "task");
      const preparedAttachments = await uploadDraftFiles(session.id, initialAttachments);
      if (initialPrompt || preparedAttachments.length) {
        const attachments = preparedAttachments.map((item) => item.uploaded!).filter(Boolean);
        const started = await api<Session>(`/api/sessions/${session.id}/run?messageLimit=${MESSAGE_INITIAL_RENDER}`, {
          method: "POST",
          body: JSON.stringify({ prompt: initialPrompt, skillNames: initialSkills, attachments })
        });
        commitSessionSelection(started, "task");
      }
      setPendingNewTaskPrompt("");
      setPendingNewTaskSkills([]);
      setPendingNewTaskAttachments([]);
      setDraftAttachments([]);
      setPrompt("");
      setDialog(null);
      setView("chat");
      await refresh();
    } catch (error) {
      setPrompt(initialPrompt);
      setDraftAttachments(initialAttachments);
      setDialog(null);
      setView("chat");
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setUploadingAttachments(false);
    }
  };

  const deleteSession = async (id: string) => {
    const target = data?.sessions.find((session) => session.id === id);
    const key = deletionTaskKey("session", id);
    if (deletingTaskIds.has(key)) return;
    const policy = deletionPolicyFor("session", target || activeSession || ({ id, status: "idle" } as SessionSummary));
    const subject = target?.scopeKind === "standalone" ? "临时任务" : "任务";
    const message = policy.requiresTermination
      ? `${policy.reason || "任务仍在运行或暂停中"}。继续后会先停止主任务和子 Agent，再将${subject}移入回收站。工作区文件不会被删除。`
      : `将这个${subject}移入回收站？工作区文件不会被删除。`;
    if (!await confirmAction(message, {
      title: policy.requiresTermination ? "停止并删除任务" : "删除任务",
      confirmLabel: policy.requiresTermination ? "停止并删除" : "移入回收站",
      destructive: true
    })) return;
    setDeletingTaskIds((current) => new Set(current).add(key));
    try {
      await api(`/api/sessions/${encodeURIComponent(id)}${policy.requiresTermination ? "?terminate=1" : ""}`, { method: "DELETE", timeoutMs: 90_000 });
      setData((current) => current ? { ...current, sessions: current.sessions.filter((session) => session.id !== id) } : current);
      forgetSession(id);
      const tabId = workspaceBrowserResourceKey({
        kind: "conversation",
        conversationId: id,
        ...(target?.scopeKind === "standalone" ? {} : target?.workspaceId ? { workspaceId: target.workspaceId } : {})
      });
      const hadTab = workspaceBrowserRef.current.tabs.some((tab) => tab.id === tabId);
      closeWorkspaceBrowserResource(tabId);
      if (activeSession?.id === id && !hadTab) setActiveSession(null);
      setNotice("任务已移入回收站", "success");
      void refreshNavigation().catch(() => undefined);
    } catch (error) {
      setNotice(`删除失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setDeletingTaskIds((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  };

  const updateSessionMetadata = async (id: string, body: { title?: string; pinned?: boolean; archived?: boolean; folderId?: string | null }) => {
    if (sessionNavigationRef.current.phase === "loading") return;
    const updated = await api<SessionSummary>(`/api/sessions/${encodeURIComponent(id)}/metadata`, { method: "PUT", body: JSON.stringify(body) });
    setSessionContextMenu(null);
    setData((current) => current ? { ...current, sessions: current.sessions.map((item) => item.id === id ? { ...item, ...updated } : item) } : current);
    if (activeSession?.id === id) setActiveSession((current) => current ? { ...current, ...updated } : current);
  };

  const updateWorkflowMetadata = async (id: string, body: { title?: string; pinned?: boolean; archived?: boolean; folderId?: string | null }) => {
    if (sessionNavigationRef.current.phase === "loading") return;
    const updated = await api<WorkflowSummary>(`/api/workflows/${encodeURIComponent(id)}/metadata`, { method: "PUT", body: JSON.stringify(body) });
    setSessionContextMenu(null);
    setData((current) => current ? { ...current, workflows: current.workflows.map((item) => item.id === id ? { ...item, ...updated } : item) } : current);
    if (body.archived && activeWorkflowId === id) { forgetWorkflow(id); activateTaskKind("chat"); setActiveWorkflowId(""); setActiveSession(null); }
  };

  const deleteWorkflow = async (id: string) => {
    const target = data?.workflows.find((workflow) => workflow.id === id);
    const key = deletionTaskKey("workflow", id);
    if (deletingTaskIds.has(key)) return;
    const policy = deletionPolicyFor("workflow", target || ({ id, status: "draft" } as WorkflowSummary));
    const message = policy.requiresTermination
      ? `${policy.reason || "任务编排仍在执行或暂停中"}。继续后会取消未完成节点，等待全部 Agent 退出，再删除任务记录。成果目录和已有文件不会被删除。`
      : "删除这个编排任务记录？成果目录和已有文件不会被删除。";
    if (!await confirmAction(message, {
      title: policy.requiresTermination ? "取消并删除编排任务" : "删除编排任务",
      confirmLabel: policy.requiresTermination ? "取消并删除" : "确认删除",
      destructive: true
    })) return;
    setDeletingTaskIds((current) => new Set(current).add(key));
    try {
      await api(`/api/workflows/${encodeURIComponent(id)}${policy.requiresTermination ? "?terminate=1" : ""}`, { method: "DELETE", timeoutMs: 90_000 });
      setData((current) => current ? { ...current, workflows: current.workflows.filter((workflow) => workflow.id !== id) } : current);
      const tabId = workspaceBrowserResourceKey({ kind: "workflow", workflowId: id, ...(target?.workspaceId ? { workspaceId: target.workspaceId } : {}) });
      const hadTab = workspaceBrowserRef.current.tabs.some((tab) => tab.id === tabId);
      closeWorkspaceBrowserResource(tabId);
      if (activeWorkflowId === id && !hadTab) { activateTaskKind("chat"); setActiveWorkflowId(""); setActiveSession(null); }
      forgetWorkflow(id);
      setNotice("编排任务记录已删除，成果目录保持不变", "success");
      void refreshNavigation().catch(() => undefined);
    } catch (error) {
      setNotice(`删除失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setDeletingTaskIds((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  };

  const openWorkflowFolder = async (id: string) => {
    try { await api(`/api/workflows/${encodeURIComponent(id)}/open-folder`, { method: "POST" }); setSessionContextMenu(null); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };

  const createTaskFolder = useCallback(async () => {
    if (!activeWorkspaceId) return;
    const name = window.prompt("新建任务文件夹")?.trim();
    if (!name) return;
    try {
      const result = await api<{ workspace: Workspace }>(`/api/workspaces/${encodeURIComponent(activeWorkspaceId)}/task-folders`, { method: "POST", body: JSON.stringify({ name }) });
      setData((current) => current ? { ...current, workspaces: current.workspaces.map((item) => item.id === result.workspace.id ? result.workspace : item) } : current);
      setSessionAreaMenu(null);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }, [activeWorkspaceId, setNotice]);

  const renameTaskFolder = async (folder: TaskFolder) => {
    const name = window.prompt("重命名任务文件夹", folder.name)?.trim();
    if (!name || name === folder.name) return;
    try {
      const result = await api<{ workspace: Workspace }>(`/api/workspaces/${encodeURIComponent(activeWorkspaceId)}/task-folders/${encodeURIComponent(folder.id)}`, { method: "PUT", body: JSON.stringify({ name }) });
      setData((current) => current ? { ...current, workspaces: current.workspaces.map((item) => item.id === result.workspace.id ? result.workspace : item) } : current);
      setTaskFolderMenu(null);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };

  const deleteTaskFolder = async (folder: TaskFolder) => {
    if (!await confirmAction(`删除任务文件夹「${folder.name}」？\n其中的任务会移回最近任务，不会被删除。`, { destructive: true })) return;
    try {
      const result = await api<{ workspace: Workspace }>(`/api/workspaces/${encodeURIComponent(activeWorkspaceId)}/task-folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" });
      setData((current) => current ? { ...current, workspaces: current.workspaces.map((item) => item.id === result.workspace.id ? result.workspace : item), sessions: current.sessions.map((item) => item.folderId === folder.id ? { ...item, folderId: null } : item), workflows: current.workflows.map((item) => item.folderId === folder.id ? { ...item, folderId: null } : item) } : current);
      setTaskFolderMenu(null);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };

  const openSessionFolder = async (id: string, kind: "workspace" | "tasks" | "attachments" | "results") => {
    try { await api(`/api/sessions/${encodeURIComponent(id)}/open-folder`, { method: "POST", body: JSON.stringify({ kind }) }); setSessionContextMenu(null); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };

  const deleteSkill = async (agent: AgentProfile) => {
    if (agent.builtIn) return;
    if (!await confirmAction(`删除 Skill「${agent.title}」？\n\n只会删除工作台托管副本，不会删除最初导入的源文件夹。`, { destructive: true })) return;
    try {
      await api(`/api/skills/${encodeURIComponent(agent.name)}`, { method: "DELETE" });
      setSkillPolicies((current) => Object.fromEntries(Object.entries(current).filter(([name]) => name !== agent.name)) as SkillPolicies);
      await refresh();
      setNotice(`已删除 Skill：${agent.title}`, "success");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const executePrompt = async (rawPrompt: string, explicitSkills = invokedSkillNames) => {
    if (navigationPending) return;
    const text = rawPrompt.trim();
    const drafts = draftAttachments;
    if (!text && !drafts.length) return;
    await agentConfigSaveRef.current;
    if (!activeSession) {
      setPendingNewTaskPrompt(text);
      setPendingNewTaskSkills(explicitSkills);
      setPendingNewTaskAttachments(drafts);
      setDraftAttachments([]);
      setDialog("task-mode");
      return;
    }
    if (running && activeSession) {
      let optimisticId = "";
      try {
        if (drafts.length) setUploadingAttachments(true);
        const preparedDrafts = await uploadDraftFiles(activeSession.id, drafts);
        setUploadingAttachments(false);
        const clientMutationId = crypto.randomUUID();
        optimisticId = `optimistic-${clientMutationId}`;
        const createdAt = new Date().toISOString();
        const optimisticInput: PendingInput = {
          schemaVersion: 1,
          id: optimisticId,
          clientMutationId,
          text: text || "请处理以下附件。",
          mode: runningInputMode,
          status: runningInputMode === "steer" ? "steering" : "queued",
          createdAt,
          updatedAt: createdAt,
          revision: 0,
          skillNames: explicitSkills,
          attachments: preparedDrafts.flatMap((item) => item.uploaded ? [item.uploaded] : [])
        };
        setActiveSession((current) => {
          if (current?.id !== activeSession.id) return current;
          const pendingInputs = runningInputMode === "steer"
            ? [optimisticInput, ...current.pendingInputs.map((item) => item.status === "steering" ? { ...item, mode: "queue" as const, status: "queued" as const } : item)]
            : [...current.pendingInputs, optimisticInput];
          return { ...current, pendingInputs };
        });
        setPrompt("");
        setDraftAttachments([]);
        setInvokedSkillNames([]);
        setSkillMenuOpen(false);
        setFollowOutput(true);
        setSubmittingInput(true);
        const updated = await api<Session>(`/api/sessions/${activeSession.id}/input?messageLimit=${MESSAGE_INITIAL_RENDER}`, {
          method: "POST",
          body: JSON.stringify({ clientMutationId, text, mode: runningInputMode, skillNames: explicitSkills, attachments: preparedDrafts.map((item) => item.uploaded).filter(Boolean) })
        });
        setActiveSession((current) => current?.id === updated.id
          ? { ...mergeLatestSessionWindow(current, updated), usageSummary: current.usageSummary, usageSource: current.usageSource }
          : current);
      } catch (error) {
        if (optimisticId) setActiveSession((current) => current?.id === activeSession.id
          ? { ...current, pendingInputs: current.pendingInputs.filter((item) => item.id !== optimisticId) }
          : current);
        setPrompt((current) => current || text);
        setDraftAttachments((current) => current.length ? current : drafts);
        setNotice(error instanceof Error ? error.message : String(error));
      } finally {
        setUploadingAttachments(false);
        setSubmittingInput(false);
      }
      return;
    }
    setUploadingAttachments(true);
    const session = activeSession;
    setFollowOutput(true);
    try {
      const preparedDrafts = await uploadDraftFiles(session.id, drafts);
      setDraftAttachments(preparedDrafts);
      const started = await api<Session>(`/api/sessions/${session.id}/run?messageLimit=${MESSAGE_INITIAL_RENDER}`, {
        method: "POST",
        body: JSON.stringify({ prompt: text, skillNames: explicitSkills, attachments: preparedDrafts.map((item) => item.uploaded).filter(Boolean) })
      });
      rememberSession(started.scopeKind === "standalone" ? "__standalone__" : started.workspaceId, started.id);
      setPrompt("");
      setDraftAttachments([]);
      setInvokedSkillNames([]);
      setSkillMenuOpen(false);
      setActiveSession((current) => mergeLatestSessionWindow(current, started));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setUploadingAttachments(false);
    }
  };

  const run = async () => executePrompt(prompt);

  const answerClaudeQuestion = async (answer: string) => {
    if (!activeSession || !answer.trim()) return false;
    await agentConfigSaveRef.current;
    try {
      const updated = running
        ? await api<Session>(`/api/sessions/${activeSession.id}/input?messageLimit=${MESSAGE_INITIAL_RENDER}`, {
            method: "POST",
            body: JSON.stringify({ clientMutationId: crypto.randomUUID(), text: answer.trim(), mode: "steer", skillNames: [] })
          })
        : await api<Session>(`/api/sessions/${activeSession.id}/run?messageLimit=${MESSAGE_INITIAL_RENDER}`, {
            method: "POST",
            body: JSON.stringify({ prompt: answer.trim(), skillNames: [] })
          });
      setFollowOutput(true);
      setActiveSession((current) => current?.id === updated.id
        ? { ...mergeLatestSessionWindow(current, updated), usageSummary: current.usageSummary, usageSource: current.usageSource }
        : updated);
      await refresh();
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const cancelPendingInput = async (inputId: string) => {
    if (!activeSession) return;
    try {
      const updated = await api<Session>(`/api/sessions/${activeSession.id}/input/${inputId}?messageLimit=${MESSAGE_INITIAL_RENDER}`, { method: "DELETE" });
      setActiveSession((current) => current?.id === updated.id
        ? { ...mergeLatestSessionWindow(current, updated), usageSummary: current.usageSummary, usageSource: current.usageSource }
        : current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const editPendingInput = async (inputId: string, text: string) => {
    if (!activeSession) return;
    try {
      const updated = await api<Session>(`/api/sessions/${activeSession.id}/input/${inputId}?messageLimit=${MESSAGE_INITIAL_RENDER}`, {
        method: "PATCH",
        body: JSON.stringify({ text })
      });
      setActiveSession((current) => current?.id === updated.id
        ? { ...mergeLatestSessionWindow(current, updated), usageSummary: current.usageSummary, usageSource: current.usageSource }
        : current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const promotePendingInput = async (inputId: string) => {
    if (!activeSession) return;
    try {
      const updated = await api<Session>(`/api/sessions/${activeSession.id}/input/${inputId}/promote?messageLimit=${MESSAGE_INITIAL_RENDER}`, { method: "POST" });
      setFollowOutput(true);
      setActiveSession((current) => current?.id === updated.id
        ? { ...mergeLatestSessionWindow(current, updated), usageSummary: current.usageSummary, usageSource: current.usageSource }
        : current);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const branchFromMessage = async (messageId: string) => {
    if (!activeSession || !editingMessageText.trim() || running) return;
    setBranching(true);
    try {
      const branch = await api<Session>(`/api/sessions/${activeSession.id}/branch?messageLimit=${MESSAGE_INITIAL_RENDER}`, {
        method: "POST",
        body: JSON.stringify({ messageId, text: editingMessageText.trim() })
      });
      rememberSession(branch.scopeKind === "standalone" ? "__standalone__" : branch.workspaceId, branch.id);
      commitSessionSelection(branch, "task");
      setEditingMessageId("");
      setEditingMessageText("");
      setFollowOutput(true);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBranching(false);
    }
  };

  const overwriteFromMessage = async (messageId: string) => {
    if (!activeSession || branching || running) return;
    const text = editingMessageText.trim();
    if (!text) return;
    if (!await confirmAction("覆盖重做会删除这条消息之后的聊天记录和委派日志，但不会回滚工作区文件。继续吗？", { title: "覆盖并重新执行", confirmLabel: "覆盖重做", destructive: true })) return;
    setBranching(true);
    try {
      const updated = await api<Session>(`/api/sessions/${activeSession.id}/overwrite?messageLimit=${MESSAGE_INITIAL_RENDER}`, { method: "POST", body: JSON.stringify({ messageId, text }) });
      setActiveSession(updated);
      setEditingMessageId("");
      setEditingMessageText("");
      setFollowOutput(true);
      await refresh();
      setNotice("已覆盖并重新开始执行", "success");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBranching(false); }
  };

  const branchFromAssistantMessage = async (messageId: string) => {
    if (!activeSession || branching) return;
    setBranching(true);
    try {
      const branch = await api<Session>(`/api/sessions/${activeSession.id}/branch?messageLimit=${MESSAGE_INITIAL_RENDER}`, { method: "POST", body: JSON.stringify({ messageId }) });
      setData((current) => current ? { ...current, sessions: [branch, ...current.sessions.filter((session) => session.id !== branch.id)] } : current);
      setNotice(`已创建分支：${branch.title}`, "success");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBranching(false); }
  };

  const stop = async () => {
    if (!activeSession || runControlAction) return;
    setRunControlAction("stop");
    try {
      const result = await api<{ session: Session }>(`/api/sessions/${activeSession.id}/stop?messageLimit=${MESSAGE_INITIAL_RENDER}`, { method: "POST" });
      setActiveSession((current) => mergeLatestSessionWindow(current, result.session));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally { setRunControlAction(""); }
  };

  const pause = async () => {
    if (!activeSession || runControlAction) return;
    setRunControlAction("pause");
    try {
      const result = await api<{ session: Session }>(`/api/sessions/${activeSession.id}/pause?messageLimit=${MESSAGE_INITIAL_RENDER}`, { method: "POST" });
      setActiveSession((current) => mergeLatestSessionWindow(current, result.session));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally { setRunControlAction(""); }
  };

  const resume = async () => {
    if (!activeSession || activeSession.status !== "paused") return;
    const pendingGuidance = activeSession.pendingInputs.find((item) => item.mode === "steer" || item.status === "steering");
    if (pendingGuidance) {
      await promotePendingInput(pendingGuidance.id);
      return;
    }
    try {
      const started = await api<Session>(`/api/sessions/${activeSession.id}/run?messageLimit=${MESSAGE_INITIAL_RENDER}`, {
        method: "POST",
        body: JSON.stringify({ prompt: "继续执行刚才暂停的任务，从已完成的进度接着处理，并先检查当前工作区状态。", internal: true })
      });
      setFollowOutput(true);
      setActiveSession((current) => mergeLatestSessionWindow(current, started));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const openAgents = async () => {
    const workspaceId = fileScopeWorkspace?.id || activeWorkspaceId;
    if (!workspaceId) return;
    const result = await api<{ content: string }>(`/api/workspaces/${workspaceId}/instructions`);
    setAgents(result.content);
    setAgentsWorkspaceId(workspaceId);
    setDialog("agents");
  };

  const loadFileBrowserResource = async (resource: FileBrowserResource, node?: TreeNode) => {
    const tabId = workspaceBrowserResourceKey(resource);
    const name = node?.name || resource.path.replaceAll("/", "\\").split("\\").filter(Boolean).at(-1) || resource.path;
    const kind = fileKind(name);
    if (!kind) {
      dispatchWorkspaceBrowser({ type: "update-presentation", tabId, patch: { status: "error" } });
      setNotice("该文件类型暂不支持轻量预览", "warning");
      return;
    }
    const cached = previewCacheRef.current.get(tabId);
    if (cached && (!node?.modifiedAt || !cached.file.modifiedAt || cached.file.modifiedAt === node.modifiedAt)) {
      if (previewActivationRef.current === tabId) {
        setPreviewFile(cached.file);
        setPreviewScopeId(cached.scopeId);
        setPreviewWorkspaceRoot(cached.workspaceRoot);
      }
      dispatchWorkspaceBrowser({ type: "update-presentation", tabId, patch: { status: "idle", dirty: false } });
      return;
    }

    cancelFilePreviewRequest();
    const controller = new AbortController();
    previewRequestRef.current = controller;
    previewRequestTabIdRef.current = tabId;
    dispatchWorkspaceBrowser({ type: "update-presentation", tabId, patch: { status: "loading" } });
    const url = `/api/workspaces/${encodeURIComponent(resource.workspaceId)}/file?path=${encodeURIComponent(resource.path)}`;
    let workspaceRoot = data?.workspaces.find((item) => item.id === resource.workspaceId)?.root || "";
    try {
      let file: PreviewFile;
      if (kind === "pdf" || kind === "image") {
        file = { name, path: resource.path, type: "file", ...node, kind, url };
      } else {
        const result = await api<Partial<PreviewFile>>(url, { signal: controller.signal, timeoutMs: kind === "document" ? 20_000 : 12_000 });
        if (controller.signal.aborted || previewRequestRef.current !== controller) return;
        if (typeof result.workspaceRoot === "string") workspaceRoot = result.workspaceRoot;
        file = { name, path: resource.path, type: "file", ...node, ...result, kind: isPreviewFileKind(result.kind) ? result.kind : kind };
      }
      const cachedPreview = { file, scopeId: resource.workspaceId, workspaceRoot };
      previewCacheRef.current.set(tabId, cachedPreview);
      if (previewActivationRef.current === tabId) {
        setPreviewFile(file);
        setPreviewScopeId(resource.workspaceId);
        setPreviewWorkspaceRoot(workspaceRoot);
      }
      dispatchWorkspaceBrowser({ type: "update-presentation", tabId, patch: { status: "idle", dirty: false } });
    } catch (error) {
      if (controller.signal.aborted) return;
      dispatchWorkspaceBrowser({ type: "update-presentation", tabId, patch: { status: "error" } });
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (previewRequestRef.current === controller) {
        previewRequestRef.current = null;
        previewRequestTabIdRef.current = "";
      }
    }
  };

  const reloadFileBrowserResource = (resource: FileBrowserResource) => {
    const tabId = workspaceBrowserResourceKey(resource);
    previewCacheRef.current.delete(tabId);
    const node = activeFileScopeIdRef.current === resource.workspaceId
      ? workspaceTreeNodeByPath(treeStateRef.current, resource.path)
      : undefined;
    void loadFileBrowserResource(resource, node);
  };

  const openFilePreview = async (node: TreeNode, options: { pinned?: boolean } = {}) => {
    const scopeId = activeFileScopeId;
    if (!scopeId) return;
    const kind = fileKind(node.name);
    if (!kind) {
      setNotice("该文件类型暂不支持轻量预览", "warning");
      return;
    }
    const resource: FileBrowserResource = { kind: "file", workspaceId: scopeId, path: node.path };
    const tabId = workspaceBrowserResourceKey(resource);
    const existingTab = workspaceBrowserRef.current.tabs.find((tab) => tab.id === tabId);
    cancelSessionNavigation();
    previewActivationRef.current = tabId;
    const scopeName = data?.workspaces.find((item) => item.id === scopeId)?.name || (activeSession?.scopeKind === "standalone" ? "临时目录" : "工作区");
    dispatchWorkspaceBrowser({
      type: "open",
      input: {
        resource,
        title: node.name,
        detail: `${scopeName} · ${node.path}`,
        mode: options.pinned ? "pinned" : pagePreferencesRef.current.fileOpenMode === "persistent" ? "regular" : "preview",
        status: existingTab?.status || "loading"
      }
    });
    setView("chat");
    if (options.pinned && existingTab) return;
    await loadFileBrowserResource(resource, node);
  };

  const openFilePreviewPath = async (relativePath: string) => {
    const normalized = relativePath.replaceAll("/", "\\");
    const name = normalized.split("\\").filter(Boolean).at(-1) || normalized;
    await openFilePreview({ name, path: normalized, type: "file" });
  };

  const activateWorkspaceBrowserTab = (tabId: string) => {
    const tab = workspaceBrowserRef.current.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    dispatchWorkspaceBrowser({ type: "activate", tabId });
    previewActivationRef.current = tabId;
    if (tab.resource.kind === "file") {
      cancelSessionNavigation();
      setView("chat");
      void loadFileBrowserResource(tab.resource);
      return;
    }
    setPreviewFile(null);
    setPreviewScopeId("");
    setPreviewWorkspaceRoot("");
    if (tab.resource.kind === "conversation") {
      void navigateToSession(tab.resource.conversationId, "task");
      return;
    }
    if (tab.resource.kind === "workflow") {
      selectWorkflow(tab.resource.workflowId);
      return;
    }
    cancelSessionNavigation();
    setView("chat");
    setNotice("该工具页签已经保留接口，当前版本尚未接入内容视图", "info");
  };

  const closeWorkspaceBrowserResource = (tabId: string) => {
    const current = workspaceBrowserRef.current;
    const wasActive = current.activeTabId === tabId;
    const closing = current.tabs.find((tab) => tab.id === tabId);
    const next = closeWorkspaceBrowserTab(current, tabId);
    if (wasActive) {
      cancelSessionNavigation();
      if (closing?.resource.kind === "file") cancelFilePreviewRequest(false);
    }
    dispatchWorkspaceBrowser({ type: "replace", state: next });
    if (closing?.resource.kind === "file") previewCacheRef.current.delete(tabId);
    if (!wasActive) return;
    if (next.activeTabId) {
      const fallback = next.tabs.find((tab) => tab.id === next.activeTabId);
      if (fallback) {
        previewActivationRef.current = fallback.id;
        if (fallback.resource.kind === "file") void loadFileBrowserResource(fallback.resource);
        else {
          setPreviewFile(null);
          setPreviewScopeId("");
          setPreviewWorkspaceRoot("");
          if (fallback.resource.kind === "conversation") void navigateToSession(fallback.resource.conversationId, "task");
          else if (fallback.resource.kind === "workflow") selectWorkflow(fallback.resource.workflowId);
          else setView("chat");
        }
      }
      return;
    }
    activateTaskKind(null);
    previewActivationRef.current = "";
    setPreviewFile(null);
    setPreviewScopeId("");
    setPreviewWorkspaceRoot("");
    setActiveSession(null);
    setActiveWorkflowId("");
    setWorkflowDraftOpen(false);
    setView("chat");
  };

  useEffect(() => {
    if (!data) return;
    const activeTab = workspaceBrowser.tabs.find((tab) => tab.id === workspaceBrowser.activeTabId);
    if (!activeTab) {
      workspaceBrowserHydratedRef.current = true;
      return;
    }
    const resource = activeTab.resource;
    const available = resource.kind === "conversation"
      ? data.sessions.some((item) => item.id === resource.conversationId)
      : resource.kind === "workflow"
        ? data.workflows.some((item) => item.id === resource.workflowId)
        : resource.kind === "file"
          ? data.workspaces.some((item) => item.id === resource.workspaceId)
            || data.sessions.some((item) => item.scopeKind === "standalone" && item.id === resource.workspaceId)
          : true;
    if (!available) return;
    workspaceBrowserHydratedRef.current = true;
    if (activeTab.status === "error") return;
    if (resource.kind === "conversation") {
      const loadingThisConversation = sessionNavigationRef.current.phase === "loading"
        && sessionNavigationRef.current.sessionId === resource.conversationId;
      if (activeSession?.id === resource.conversationId || loadingThisConversation) return;
    } else if (resource.kind === "workflow") {
      if (activeTaskKindRef.current === "workflow" && activeWorkflowId === resource.workflowId) return;
    } else if (previewActivationRef.current === activeTab.id) {
      return;
    }
    activateWorkspaceBrowserTab(activeTab.id);
  }, [data, activeSession?.id, activeWorkflowId, workspaceBrowser.activeTabId]);

  const openWorkspaceFolder = async (relativePath?: string) => {
    if (!activeFileScopeId) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(activeFileScopeId)}/open-folder`, {
        method: "POST",
        body: JSON.stringify(relativePath ? { path: relativePath, select: true } : {})
      });
      setNotice(relativePath ? "已在文件资源管理器中定位文件" : "已打开工作区文件夹", "success");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const copyWorkspacePaths = async (paths: string[]) => {
    try {
      await navigator.clipboard.writeText(paths.join("\n"));
      setNotice(paths.length > 1 ? `已复制 ${paths.length} 个相对路径` : "已复制相对路径", "success");
    } catch (error) {
      setNotice(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const moveWorkspaceFiles = async (paths: string[], targetDirectory: string) => {
    if (!activeFileScopeId || !paths.length) return false;
    const scopeId = activeFileScopeId;
    try {
      const result = await api<{ moved: Array<{ from: string; to: string }>; skipped: number }>(`/api/workspaces/${encodeURIComponent(scopeId)}/files/move`, {
        method: "POST",
        body: JSON.stringify({ paths, targetDirectory })
      });
      if (!result.moved.length) {
        setNotice("所选项目已经位于目标文件夹", "info");
        return true;
      }
      let activeMovedResource: FileBrowserResource | null = null;
      for (const tab of workspaceBrowserRef.current.tabs) {
        if (tab.resource.kind !== "file" || tab.resource.workspaceId !== scopeId) continue;
        const nextPath = remapWorkspaceBrowserFilePath(tab.resource.path, result.moved);
        if (workspaceFilePathEquals(tab.resource.path, nextPath)) continue;
        const nextResource: FileBrowserResource = { ...tab.resource, path: nextPath };
        const nextTabId = workspaceBrowserResourceKey(nextResource);
        if (previewRequestTabIdRef.current === tab.id) cancelFilePreviewRequest();
        const cached = previewCacheRef.current.peek(tab.id);
        previewCacheRef.current.delete(tab.id);
        if (cached) {
          const name = nextPath.split("/").filter(Boolean).at(-1) || cached.file.name;
          previewCacheRef.current.set(nextTabId, { ...cached, file: { ...cached.file, name, path: nextPath } });
        }
        if (previewActivationRef.current === tab.id) {
          previewActivationRef.current = nextTabId;
          activeMovedResource = nextResource;
          setPreviewFile((current) => current ? {
            ...current,
            name: nextPath.split("/").filter(Boolean).at(-1) || current.name,
            path: nextPath
          } : current);
        }
      }
      dispatchWorkspaceBrowser({ type: "remap-file-paths", workspaceId: scopeId, moves: result.moved });
      if (activeMovedResource) void loadFileBrowserResource(activeMovedResource);
      await loadWorkspaceTree(scopeId, { force: true });
      setNotice(`已移动 ${result.moved.length} 个项目${result.skipped ? `，忽略 ${result.skipped} 个重复子项` : ""}`, "success");
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const deleteWorkspaceFiles = async (paths: string[]) => {
    if (!activeFileScopeId || !paths.length) return false;
    const scopeId = activeFileScopeId;
    const runningWarning = activeSession?.status === "running" ? "\n\n当前 AI 任务仍在运行，删除正在使用的文件可能导致任务失败。" : "";
    if (!await confirmAction(`永久删除选中的 ${paths.length} 个项目？此操作无法撤销。${runningWarning}`, { destructive: true })) return false;
    try {
      const result = await api<{ deleted: string[]; skipped: number }>(`/api/workspaces/${encodeURIComponent(scopeId)}/files/delete`, {
        method: "POST",
        body: JSON.stringify({ paths })
      });
      const currentBrowser = workspaceBrowserRef.current;
      const removedTabs = currentBrowser.tabs.filter((tab) => {
        const resource = tab.resource;
        return resource.kind === "file"
          && resource.workspaceId === scopeId
          && result.deleted.some((deleted) => workspaceBrowserFilePathAtOrBelow(resource.path, deleted));
      });
      const activeRemoved = removedTabs.some((tab) => tab.id === currentBrowser.activeTabId);
      if (removedTabs.some((tab) => tab.id === previewRequestTabIdRef.current)) cancelFilePreviewRequest();
      for (const tab of removedTabs) previewCacheRef.current.delete(tab.id);
      const nextBrowser = closeWorkspaceBrowserFileTabs(currentBrowser, scopeId, result.deleted);
      dispatchWorkspaceBrowser({ type: "replace", state: nextBrowser });
      if (activeRemoved) {
        previewActivationRef.current = "";
        setPreviewFile(null);
        setPreviewScopeId("");
        setPreviewWorkspaceRoot("");
        const fallback = nextBrowser.tabs.find((tab) => tab.id === nextBrowser.activeTabId);
        if (fallback) {
          previewActivationRef.current = fallback.id;
          if (fallback.resource.kind === "file") void loadFileBrowserResource(fallback.resource);
          else if (fallback.resource.kind === "conversation") void navigateToSession(fallback.resource.conversationId, "task");
          else if (fallback.resource.kind === "workflow") selectWorkflow(fallback.resource.workflowId);
        }
      }
      await loadWorkspaceTree(scopeId, { force: true });
      setNotice(`已删除 ${result.deleted.length} 个项目${result.skipped ? `，忽略 ${result.skipped} 个重复子项` : ""}`, "success");
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const storedUsage = activeSession?.usage || emptyUsage();
  const usageSummary = activeSession?.usageSummary || {
    main: storedUsage,
    agents: emptyUsage(),
    total: storedUsage,
    agentCount: 0
  };
  const displayedTokens = usageTotal(usageSummary.total);
  const mainTokens = usageTotal(usageSummary.main);
  const agentTokens = usageTotal(usageSummary.agents);
  const delegationEnabled = currentExecutionMode === "collaborative";
  const activeCapabilityProfileAdjusted = Boolean(activeCapabilityProfile && (activeSession?.scopeKind === "standalone"
    ? Object.entries(activeCapabilityProfile.skillPolicies).some(([name, policy]) => name !== BUILTIN_DELEGATION_SKILL_NAME && (skillPolicies[name] || "off") !== policy)
    : Object.keys(workspace?.agentSkillOverrides || {}).length));
  const loadComposerModels = useCallback(async (provider: EngineName) => {
    const result = await api<{ models: ModelOption[] }>(`/api/agent-providers/${encodeURIComponent(provider)}/models`, { method: "POST", body: JSON.stringify({}), timeoutMs: 30_000 });
    return result.models || [];
  }, []);
  const saveComposerModel = useCallback(async (provider: EngineName, model: string, effort: string) => {
    const result = await api<{ selection: { model: string; reasoningValue?: string | number | boolean }; settings: SettingsData }>(`/api/agent-providers/${encodeURIComponent(provider)}/model-selection`, { method: "PATCH", body: JSON.stringify({ model, reasoningValue: effort }) });
    setData((current) => current ? {
      ...current,
      settings: result.settings,
      providerControls: current.providerControls.map((control) => control.providerId === provider ? { ...control, configuration: { ...control.configuration, model: result.selection.model, reasoningValue: result.selection.reasoningValue } } : control)
    } : current);
  }, []);
  const loadComposerSessionConfiguration = useCallback((sessionId: string) => api<ProviderSessionConfiguration>(`/api/sessions/${encodeURIComponent(sessionId)}/provider-configuration`), []);
  const saveComposerSessionConfiguration = useCallback((sessionId: string, configId: string, value: string | boolean) => api<ProviderSessionConfiguration>(`/api/sessions/${encodeURIComponent(sessionId)}/provider-configuration`, { method: "PATCH", body: JSON.stringify({ configId, value }) }), []);
  const saveComposerProfileConfiguration = useCallback((provider: EngineName, configId: string, value: string | boolean) => api<ProviderSessionConfiguration>(`/api/agent-providers/${encodeURIComponent(provider)}/profile-configuration`, { method: "PATCH", body: JSON.stringify({ configId, value }) }).then((result) => {
    setData((current) => current ? {
      ...current,
      providerControls: current.providerControls.map((control) => control.providerId === provider
        ? { ...control, configuration: { ...control.configuration, sessionOptions: result.options } }
        : control)
    } : current);
    return result;
  }), []);
  const updateComposerExecutionMode = async (executionMode: ExecutionMode) => {
    if (activeSession?.scopeKind === "standalone") {
      const result = await api<SessionSummary>(`/api/sessions/${encodeURIComponent(activeSession.id)}/metadata`, { method: "PUT", body: JSON.stringify({ executionMode }) });
      setActiveSession((current) => current?.id === result.id ? { ...current, ...result } : current);
      return;
    }
    if (!activeWorkspaceId) throw new Error("请先选择工作区");
    const result = await api<{ workspace: Workspace; skillPolicies: SkillPolicies; executionMode: ExecutionMode }>(`/api/workspaces/${encodeURIComponent(activeWorkspaceId)}/agent-config`, { method: "PUT", body: JSON.stringify({ executionMode }) });
    skillPoliciesDirtyRef.current = false;
    setSkillPolicies(result.skillPolicies);
    setData((current) => current ? { ...current, workspaces: current.workspaces.map((item) => item.id === activeWorkspaceId ? { ...item, ...result.workspace, agentExecutionMode: result.executionMode } : item) } : current);
  };
  const updateExecutionSetting = async (setting: { sandboxMode?: SettingsData["sandboxMode"]; webSearch?: SettingsData["webSearch"] }) => {
    const settings = await api<SettingsData>("/api/settings/execution", {
      method: "PATCH",
      body: JSON.stringify(setting)
    });
    setData((current) => current ? { ...current, settings } : current);
  };
  const usageLabel = activeSession?.usageSource === "codex" || activeSession?.usageSource === "claude"
    ? running ? "实时" : activeSession.usageSource === "claude" ? "Claude" : "Codex"
    : activeSession?.usageSource === "pending" ? "统计中" : "已结算";
  const isNewConversation = !navigationPending && (!activeSession || activeSession.messages.length === 0);
  // Older sessions may already contain noisy Claude system events. Filter them
  // at render time as well as at ingestion time so opening history is stable
  // immediately after the fix, without rewriting persisted conversation data.
  const activeMessages = useMemo(
    () => visibleConversationMessages(activeSession?.messages || [], activeSession?.status),
    [activeSession?.messages, activeSession?.status]
  );
  const messageRenderLimit = activeSession ? messageRenderLimits[activeSession.id] || MESSAGE_INITIAL_RENDER : MESSAGE_INITIAL_RENDER;
  const unloadedMessageCount = activeSession?.messageWindow?.start || 0;
  const locallyHiddenMessageCount = Math.max(0, activeMessages.length - messageRenderLimit);
  const hiddenMessageCount = unloadedMessageCount + locallyHiddenMessageCount;
  const visibleMessages = useMemo(
    () => locallyHiddenMessageCount > 0 ? activeMessages.slice(-messageRenderLimit) : activeMessages,
    [activeMessages, locallyHiddenMessageCount, messageRenderLimit]
  );
  const displayMessages = useMemo(() => groupMessages(visibleMessages), [visibleMessages]);
  const agentDrawerMessage = useMemo(
    () => activeSession?.messages.find((message) => message.id === agentDrawerMessageId && message.role === "event") || null,
    [activeSession?.messages, agentDrawerMessageId]
  );
  const virtualizeMessages = displayMessages.length >= MESSAGE_VIRTUALIZE_THRESHOLD;
  const messageVirtualizer = useVirtualizer({
    count: displayMessages.length,
    getScrollElement: () => messagesRef.current,
    estimateSize: () => 104,
    overscan: 8,
    getItemKey: (index) => displayMessages[index]?.id || index,
    enabled: virtualizeMessages,
    useFlushSync: false,
    useAnimationFrameWithResizeObserver: true
  });
  const virtualMessageHeight = virtualizeMessages ? messageVirtualizer.getTotalSize() : 0;
  const renderedMessageItems = virtualizeMessages
    ? messageVirtualizer.getVirtualItems()
    : displayMessages.map((message, index) => ({ index, key: message.id, start: 0 }));

  useLayoutEffect(() => {
    const pending = historyScrollRestoreRef.current;
    const messages = messagesRef.current;
    if (!pending || !messages || pending.sessionId !== activeSession?.id) return;
    historyScrollRestoreRef.current = null;
    messages.scrollTop = pending.scrollTop + Math.max(0, messages.scrollHeight - pending.scrollHeight);
  }, [activeSession?.id, visibleMessages.length]);

  useLayoutEffect(() => {
    if (!followOutput || historyScrollRestoreRef.current) return;
    const messages = messagesRef.current;
    if (!messages) return;
    const frame = window.requestAnimationFrame(() => {
      messages.scrollTop = messages.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSession?.id, activeSession?.revision, displayMessages.length, followOutput, running, virtualMessageHeight]);

  useEffect(() => {
    if (!historyLoad || historyLoad.sessionId !== activeSession?.id) return;
    if (messageRenderLimit >= historyLoad.target) {
      setHistoryLoad(null);
      return;
    }
    let cancelled = false;
    const appendChunk = () => {
      if (cancelled) return;
      const messages = messagesRef.current;
      if (messages) {
        historyScrollRestoreRef.current = {
          sessionId: historyLoad.sessionId,
          scrollHeight: messages.scrollHeight,
          scrollTop: messages.scrollTop
        };
      }
      startTransition(() => setMessageRenderLimits((limits) => {
        const current = limits[historyLoad.sessionId] || MESSAGE_INITIAL_RENDER;
        return {
          ...limits,
          [historyLoad.sessionId]: Math.min(historyLoad.target, current + MESSAGE_HISTORY_CHUNK)
        };
      }));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleCallback: number | undefined;
    if (typeof window.requestIdleCallback === "function") {
      idleCallback = window.requestIdleCallback(appendChunk, { timeout: 180 });
    } else {
      timer = globalThis.setTimeout(appendChunk, 16);
    }
    return () => {
      cancelled = true;
      if (idleCallback !== undefined) window.cancelIdleCallback(idleCallback);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [activeSession?.id, historyLoad, messageRenderLimit]);

  useEffect(() => {
    historyRevealLockRef.current = false;
  }, [activeSession?.id]);

  useEffect(() => {
    if (!historyLoad && !historyPageLoading) historyRevealLockRef.current = false;
  }, [historyLoad, historyPageLoading]);

  const revealEarlierMessages = async () => {
    if (!activeSession || hiddenMessageCount <= 0 || historyRevealLockRef.current || historyLoad?.sessionId === activeSession.id || historyPageLoading) return;
    historyRevealLockRef.current = true;
    if (locallyHiddenMessageCount <= 0 && activeSession.messageWindow?.hasMore) {
      const sessionId = activeSession.id;
      const before = activeSession.messageWindow.start;
      setHistoryPageLoading(true);
      try {
        const messages = messagesRef.current;
        if (messages) historyScrollRestoreRef.current = { sessionId, scrollHeight: messages.scrollHeight, scrollTop: messages.scrollTop };
        const page = await api<MessagePage>(`/api/sessions/${sessionId}/messages?before=${before}&limit=${MESSAGE_HISTORY_REQUEST}`);
        startTransition(() => {
          setActiveSession((current) => {
            if (!current?.messageWindow || current.id !== sessionId || page.window.end !== current.messageWindow.start) return current;
            return {
              ...current,
              messages: [...page.messages, ...current.messages],
              messageWindow: { ...current.messageWindow, start: page.window.start, hasMore: page.window.hasMore }
            };
          });
          setMessageRenderLimits((limits) => ({
            ...limits,
            [sessionId]: (limits[sessionId] || MESSAGE_INITIAL_RENDER) + page.messages.length
          }));
        });
      } catch (error) {
        historyScrollRestoreRef.current = null;
        setNotice(error instanceof Error ? error.message : String(error));
      } finally {
        setHistoryPageLoading(false);
      }
      return;
    }
    setHistoryLoad({
      sessionId: activeSession.id,
      start: messageRenderLimit,
      target: Math.min(activeMessages.length, messageRenderLimit + MESSAGE_HISTORY_REQUEST)
    });
  };

  if (!data) {
    return <main className="splash"><LoaderCircle className="spin" /><span>{notice?.message || "正在启动 Meta Code"}</span>{notice && <button type="button" className="primary" onClick={() => { setNotice(""); refresh().catch((error) => setNotice(error.message)); }}>重试连接</button>}</main>;
  }

  const agentProviders = data.agentProviders || [];
  const sidebarVisible = sidebarOpen && view === "chat";
  const inspectorVisible = inspectorOpen && view === "chat" && !activeBrowserToolResource;
  const workspaceBrowserVisible = view === "chat" && workspaceBrowser.tabs.length > 0;
  const displayedDeletionKind = displayedWorkflowId ? "workflow" : displayedSession ? "session" : null;
  const displayedDeletionId = displayedWorkflowId || displayedSession?.id || "";
  const displayedDeletionTarget = displayedDeletionKind === "workflow"
    ? data.workflows.find((workflow) => workflow.id === displayedDeletionId)
    : data.sessions.find((session) => session.id === displayedDeletionId);
  const displayedDeletionPolicy = displayedDeletionKind && displayedDeletionTarget
    ? deletionPolicyFor(displayedDeletionKind, displayedDeletionTarget)
    : null;
  const displayedDeletionBusy = displayedDeletionKind
    ? deletingTaskIds.has(deletionTaskKey(displayedDeletionKind, displayedDeletionId))
    : false;

  return (
    <div
      className={`app-shell ${sidebarVisible ? "" : "sidebar-collapsed"} ${inspectorVisible ? "" : "inspector-collapsed"} ${resizingPane ? "is-resizing" : ""} ${navigationPending ? "navigation-pending" : ""}`}
      style={{ "--sidebar-width": sidebarVisible ? `${layoutWidths.sidebar}px` : "0px", "--inspector-width": inspectorVisible ? `${layoutWidths.inspector}px` : "0px" } as React.CSSProperties}
    >
      <nav className="activity-rail" aria-label="工作台导航">
        <button type="button" className="activity-brand" title="返回 Meta Code 工作台" aria-label="返回 Meta Code 工作台" onClick={() => { cancelSessionNavigation(); setView("chat"); }}><ProductLogo variant="mark" /></button>
        <div className="activity-primary">
          <button type="button" className={sidebarOpen && sidebarSection === "tasks" && !standaloneActive ? "active" : ""} aria-label="任务" title="工作区任务" onClick={() => openTaskScope("workspace")}><MessagesSquare size={20} /></button>
          <button type="button" className={sidebarOpen && sidebarSection === "tasks" && standaloneActive ? "active" : ""} aria-label="临时任务" title="临时任务" onClick={() => openTaskScope("standalone")}><Clock3 size={19} /></button>
          <button type="button" className={sidebarOpen && sidebarSection === "workspaces" ? "active" : ""} aria-label="工作区" title="工作区" onClick={() => showSidebarSection("workspaces")}><FolderOpen size={20} /></button>
        </div>
        <div className="activity-secondary">
          <button type="button" className={view === "agents" ? "active" : ""} aria-label="Skill 中心" title="Skill 中心" onClick={() => { cancelSessionNavigation(); setView("agents"); if (window.innerWidth <= 720) setSidebarOpen(false); }}><Sparkles size={19} /></button>
          <button type="button" className={view === "mcp" ? "active" : ""} aria-label="MCP" title="MCP" onClick={() => { cancelSessionNavigation(); setView("mcp"); if (window.innerWidth <= 720) setSidebarOpen(false); }}><Plug size={19} /></button>
          <button type="button" className={view === "git" ? "active" : ""} aria-label="版本管理" title="版本管理" onClick={() => { cancelSessionNavigation(); setView("git"); if (window.innerWidth <= 720) setSidebarOpen(false); }}><GitBranch size={19} /></button>
          <button type="button" className={view === "settings" ? "active" : ""} aria-label="设置" title="设置" onClick={() => openModelSettings(settingsProvider)}><Settings size={19} /></button>
          <HelpButton topic="getting-started" />
        </div>
      </nav>
      <aside className="sidebar">
        <header className="sidebar-pane-header">
          <span><strong>{sidebarSection === "tasks" ? standaloneActive ? "临时任务" : "任务" : "工作区"}</strong><small>{sidebarSection === "tasks" ? standaloneActive ? "不绑定项目目录" : workspace?.name || "尚未选择工作区" : `${activeWorkspaces.length} 个可用工作区`}</small></span>
          <IconButton label="收起导航面板" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={16} /></IconButton>
        </header>
        {sidebarSection === "tasks" ? <>
          {!standaloneActive && <div className="sidebar-workspace-row">
            <button type="button" className="sidebar-workspace-current" onClick={() => showSidebarSection("workspaces")} title={workspace?.root || "选择工作区"}><FolderOpen size={15} /><span><strong>{workspace?.name || "选择工作区"}</strong><small>{workspace?.root || "添加工作区后开始"}</small></span><ChevronRight size={14} /></button>
            <IconButton label="添加工作区" onClick={() => setDialog("workspace")}><Plus size={15} /></IconButton>
          </div>}
          <div className="sidebar-task-actions"><button className="new-task" onClick={createSession}><MessageSquarePlus size={16} /><span>新任务</span></button></div>
          <label className="sidebar-search"><Search size={14} /><input value={sidebarQuery} onChange={(event) => setSidebarQuery(event.target.value)} placeholder="搜索任务" aria-label="搜索任务" />{sidebarQuery && <button type="button" aria-label="清除搜索" onClick={() => setSidebarQuery("")}><X size={13} /></button>}</label>
          <SidebarTaskList
            query={deferredSidebarQuery}
            visibleTaskItems={visibleTaskItems}
            activeTaskShortcuts={activeTaskShortcuts}
            pinnedTaskShortcuts={pinnedTaskShortcuts}
            recentUnfiledTasks={recentUnfiledTasks}
            folderTaskItems={folderTaskItems}
            archivedTasks={archivedTasks}
            taskFolders={taskFolders}
            taskCount={taskItems.length}
            standaloneActive={standaloneActive}
            visible={sidebarVisible && sidebarSection === "tasks"}
            searchStale={normalizedSidebarQuery !== deferredSidebarQuery}
            scopeKey={standaloneActive ? "__standalone__" : activeWorkspaceId}
            activeChatId={activeBrowserConversationResource?.conversationId || navigationSummary?.id || activeSession?.id || ""}
            activeWorkflowId={activeWorkflowId}
            delegationEnabled={delegationEnabled}
            providerControls={data.providerControls}
            onSelect={handleSidebarTaskSelection}
            onPrefetch={scheduleSessionPrefetch}
            onCancelPrefetch={cancelSessionPrefetch}
            onOpenTaskContextMenu={openSidebarTaskContextMenu}
            onOpenAreaContextMenu={openSidebarTaskAreaMenu}
            onOpenFolderContextMenu={openSidebarTaskFolderMenu}
            onCreateFolder={createTaskFolder}
          />
        </> : <div className="workspace-panel">
          <div className="workspace-panel-actions"><button type="button" className="primary" onClick={() => setDialog("workspace")}><Plus size={15} />添加工作区</button></div>
          <div className="workspace-panel-list">
            {pinnedWorkspaces.length > 0 && <section><div className="sidebar-section-heading"><span>置顶</span><small>{pinnedWorkspaces.length}</small></div>{pinnedWorkspaces.map(renderWorkspaceItem)}</section>}
            {recentWorkspaces.length > 0 && <section><div className="sidebar-section-heading"><span>最近使用</span><small>{recentWorkspaces.length}</small></div>{recentWorkspaces.map(renderWorkspaceItem)}</section>}
            {archivedWorkspaces.length > 0 && <section className="workspace-archive-section"><button type="button" className="workspace-archive-toggle" aria-expanded={workspaceArchiveOpen} onClick={() => setWorkspaceArchiveOpen((value) => !value)}><Archive size={13} /><span>已归档</span><small>{archivedWorkspaces.length}</small><ChevronRight size={13} /></button>{workspaceArchiveOpen && <div className="workspace-archive-items">{archivedWorkspaces.map(renderWorkspaceItem)}</div>}</section>}
            {data.workspaces.length === 0 && <div className="sidebar-empty-state"><FolderOpen size={20} /><strong>还没有工作区</strong><small>添加本地文件夹后开始</small></div>}
          </div>
        </div>}
      </aside>
      {!navigationPending && sessionContextMenu && (() => {
        const session = data.sessions.find((item) => item.id === sessionContextMenu.id);
        const workflow = data.workflows.find((item) => item.id === sessionContextMenu.id);
        const task = session || workflow;
        if (!task) return null;
        const isWorkflow = Boolean(workflow);
        const isStandaloneTask = Boolean(session?.scopeKind === "standalone");
        const cannotArchive = session ? session.status === "running" || session.status === "paused" : ["queued", "running", "integrating"].includes(workflow!.status);
        const deletionKind = isWorkflow ? "workflow" : "session";
        const deletionPolicy = deletionPolicyFor(deletionKind, task);
        const deletionBusy = deletingTaskIds.has(deletionTaskKey(deletionKind, task.id));
        const updateMetadata = (body: { title?: string; pinned?: boolean; archived?: boolean; folderId?: string | null }) => isWorkflow ? updateWorkflowMetadata(task.id, body) : updateSessionMetadata(task.id, body);
        return <><button type="button" className="session-context-dismiss" aria-label="关闭任务菜单" onClick={() => setSessionContextMenu(null)} /><div className="session-context-menu" role="menu" style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}>
          {!task.archivedAt && <button type="button" onClick={() => void updateMetadata({ pinned: !task.pinned })}><Pin size={14} />{task.pinned ? "取消置顶" : "置顶任务"}</button>}
          <button type="button" onClick={() => { const title = window.prompt("修改任务名称", task.title)?.trim(); if (title && title !== task.title) void updateMetadata({ title }); }}><Pencil size={14} />重命名</button>
          <button type="button" onClick={() => isWorkflow ? void openWorkflowFolder(task.id) : void openSessionFolder(task.id, "workspace")}><FolderOpen size={14} />{isWorkflow || isStandaloneTask ? "打开任务文件夹" : "打开工作区"}</button>
          {!isStandaloneTask && <details><summary><Folder size={14} />移动到文件夹<ChevronRight size={13} /></summary><div className="session-folder-submenu">
            {taskFolders.map((folder) => <button type="button" key={folder.id} onClick={() => void updateMetadata({ folderId: folder.id })}>{folder.name}</button>)}
            {task.folderId && <button type="button" onClick={() => void updateMetadata({ folderId: null })}>移出文件夹</button>}
            {!taskFolders.length && <span className="session-folder-empty">暂无文件夹</span>}
          </div></details>}
          <button type="button" disabled={cannotArchive} title={cannotArchive ? "执行中的任务不能归档" : ""} onClick={() => void updateMetadata({ archived: !task.archivedAt })}>{task.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}{task.archivedAt ? "恢复任务" : "归档任务"}</button>
          <button type="button" className="danger" disabled={deletionBusy} title={deletionPolicy.reason || ""} onClick={() => { setSessionContextMenu(null); isWorkflow ? void deleteWorkflow(task.id) : void deleteSession(task.id); }}>{deletionBusy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{deletionPolicy.requiresTermination ? isWorkflow ? "取消并删除" : "停止并删除" : "删除任务"}</button>
        </div></>;
      })()}
      {!navigationPending && sessionAreaMenu && !standaloneActive && <><button type="button" className="session-context-dismiss" aria-label="关闭任务区菜单" onClick={() => setSessionAreaMenu(null)} /><div className="session-context-menu" role="menu" style={{ left: sessionAreaMenu.x, top: sessionAreaMenu.y }}><button type="button" onClick={() => void createTaskFolder()}><Folder size={14} />新建任务文件夹</button></div></>}
      {!navigationPending && taskFolderMenu && (() => { const folder = taskFolders.find((item) => item.id === taskFolderMenu.id); if (!folder) return null; return <><button type="button" className="session-context-dismiss" aria-label="关闭文件夹菜单" onClick={() => setTaskFolderMenu(null)} /><div className="session-context-menu" role="menu" style={{ left: taskFolderMenu.x, top: taskFolderMenu.y }}><button type="button" onClick={() => void renameTaskFolder(folder)}><Pencil size={14} />重命名文件夹</button><button type="button" className="danger" onClick={() => void deleteTaskFolder(folder)}><Trash2 size={14} />删除文件夹</button></div></>; })()}
      {sidebarVisible && <button className="mobile-sidebar-backdrop" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} />}
      {sidebarVisible && <button className="pane-resizer pane-resizer-sidebar" type="button" role="separator" aria-label="调整任务区宽度" aria-valuemin={220} aria-valuemax={420} aria-valuenow={layoutWidths.sidebar} onPointerDown={(event) => beginPaneResize("sidebar", event)} onPointerMove={movePaneResize} onPointerUp={endPaneResize} onPointerCancel={endPaneResize} onDoubleClick={() => resetPaneWidth("sidebar")} onKeyDown={(event) => handlePaneResizeKeyDown("sidebar", event)}><GripVertical size={14} /></button>}

      <main className={`main-panel ${workspaceBrowserVisible ? "has-workspace-browser-tabs" : ""}`} aria-busy={navigationPending}>
        <header className="topbar">
          {view !== "chat" && <IconButton label="返回任务" onClick={() => setView("chat")}><ArrowLeft size={18} /></IconButton>}
          <div className="title-block">
            <strong>{view === "chat" ? activeWorkspaceBrowserTab?.title || (workflowDraftOpen ? "Meta 任务编排" : activeWorkflowId ? data.workflows.find((item) => item.id === activeWorkflowId)?.title : activeSession?.title) || "新任务" : view === "agents" ? "Skill 中心" : view === "mcp" ? "MCP" : view === "git" ? "版本管理" : "设置"}</strong>
            <span>{view === "chat" && activeWorkspaceBrowserTab?.detail ? activeWorkspaceBrowserTab.detail : workspace?.root || "请添加一个工作区"}</span>
          </div>
          {displayedSession?.status === "running" && <div className="run-status"><LoaderCircle className="spin" size={13} />执行中</div>}
          {!navigationPending && displayedSession?.status === "paused" && <div className="run-status paused"><Pause size={13} />已暂停</div>}
          {!navigationPending && displayedSession && (
            <div className="token-status-wrap">
              <button
                type="button"
                className={`token-status ${displayedSession.usageSource === "pending" ? "pending" : ""}`}
                title="查看任务 Token 明细"
                onClick={() => setTokenDetailsOpen((value) => !value)}
              >
                <Gauge size={13} />
                <span>{displayedSession.usageSource === "pending" && displayedSession.status === "running" ? "统计中" : `${formatTokens(displayedTokens)} tokens`}</span>
                <i>总计</i>
              </button>
              {tokenDetailsOpen && (
                <section className="token-details">
                  <header><strong>任务 Token</strong><span>{usageLabel}</span></header>
                  <div className="token-detail-total"><span>全部线程</span><strong>{displayedTokens.toLocaleString()}</strong></div>
                  <div><span>主线程</span><strong>{mainTokens.toLocaleString()}</strong></div>
                  <div><span>子 Agent（{usageSummary.agentCount}）</span><strong>{agentTokens.toLocaleString()}</strong></div>
                  <div><span>输入 / 输出</span><strong>{usageSummary.total.input_tokens.toLocaleString()} / {usageSummary.total.output_tokens.toLocaleString()}</strong></div>
                  <div><span>缓存输入</span><strong>{usageSummary.total.cached_input_tokens.toLocaleString()}</strong></div>
                  <div><span>推理输出</span><strong>{usageSummary.total.reasoning_output_tokens.toLocaleString()}</strong></div>
                  <p>总计仅为输入 + 输出；缓存和推理是其中的明细，不会重复相加。</p>
                </section>
              )}
            </div>
          )}
          {view === "chat" && !activeBrowserFileResource && !activeBrowserToolResource && !showWorkflowBrowserContent && <ConnectedProviderShowcase items={data.providerControls} activeProvider={displayedSession?.engine || data.settings.defaultEngine} onSelect={openModelSettings} />}
          {view === "chat" && !navigationPending && (displayedSession || displayedWorkflowId) && <IconButton disabled={displayedDeletionBusy} label={displayedDeletionPolicy?.requiresTermination ? displayedDeletionKind === "workflow" ? "取消并删除当前编排任务" : "停止并删除当前任务" : "删除当前任务"} onClick={() => displayedWorkflowId ? void deleteWorkflow(displayedWorkflowId) : displayedSession ? void deleteSession(displayedSession.id) : undefined}>{displayedDeletionBusy ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}</IconButton>}
          <ThemeToggle />
          {view === "chat" && !activeBrowserToolResource && <IconButton label={inspectorOpen ? "关闭检查器" : "打开检查器"} onClick={() => setInspectorOpen((value) => !value)}><Menu size={18} /></IconButton>}
        </header>

        {workspaceBrowserVisible && <WorkspaceBrowserTabs
          tabs={workspaceBrowser.tabs}
          conversationProviders={browserConversationProviders}
          activeTabId={workspaceBrowser.activeTabId}
          maxTabs={pagePreferencesRef.current.maxTabs}
          motion={pagePreferencesRef.current.tabMotion}
          recentlyClosedCount={workspaceBrowser.recentlyClosed.length}
          onActivate={activateWorkspaceBrowserTab}
          onClose={closeWorkspaceBrowserResource}
          onCloseOthers={(tabId) => dispatchWorkspaceBrowser({ type: "close-others", tabId })}
          onCloseRight={(tabId) => dispatchWorkspaceBrowser({ type: "close-right", tabId })}
          onMove={(tabId, targetIndex) => dispatchWorkspaceBrowser({ type: "move", tabId, targetIndex })}
          onPinnedChange={(tabId, pinned) => dispatchWorkspaceBrowser({ type: "set-pinned", tabId, pinned })}
          onReopenLastClosed={() => dispatchWorkspaceBrowser({ type: "reopen-last-closed" })}
        />}

        {view === "chat" && activeBrowserFileResource && (
          <section className="workspace-browser-preview" aria-label={`预览 ${activeWorkspaceBrowserTab?.title || activeBrowserFileResource.path}`}>
            {previewFile
              && previewScopeId === activeBrowserFileResource.workspaceId
              && workspaceFilePathEquals(previewFile.path, activeBrowserFileResource.path)
              ? <PreviewErrorBoundary key={`${previewScopeId}:${previewFile.path}:${previewFile.modifiedAt || ""}`} resetKey={`${previewScopeId}:${previewFile.path}:${previewFile.modifiedAt || ""}`} onClose={() => closeWorkspaceBrowserResource(activeWorkspaceBrowserTab!.id)}>
                  <Suspense fallback={<div className="preview-state"><LoaderCircle className="spin" size={20} />正在准备预览</div>}>
                    <FilePreviewRenderer
                      key={`${previewScopeId}:${previewFile.path}:${previewFile.modifiedAt || ""}`}
                      file={previewFile}
                      workspaceId={previewScopeId}
                      workspaceRoot={previewWorkspaceRoot}
                      presentation="workspace"
                      onOpenLocalFile={(path) => openFilePreviewPath(path).catch((error) => setNotice(error.message))}
                      onReveal={(path) => void api(`/api/workspaces/${encodeURIComponent(previewScopeId)}/open-folder`, { method: "POST", body: JSON.stringify({ path, select: true }) }).catch((error) => setNotice(error instanceof Error ? error.message : String(error)))}
                      onReload={() => reloadFileBrowserResource(activeBrowserFileResource)}
                      onClose={() => closeWorkspaceBrowserResource(activeWorkspaceBrowserTab!.id)}
                    />
                  </Suspense>
                </PreviewErrorBoundary>
              : activeWorkspaceBrowserTab?.status === "error"
                ? <div className="preview-state error"><CircleAlert size={20} /><span>文件预览加载失败</span><button type="button" onClick={() => reloadFileBrowserResource(activeBrowserFileResource)}>重试</button></div>
                : <div className="preview-state"><LoaderCircle className="spin" size={20} />正在读取文件</div>}
          </section>
        )}

        {view === "chat" && activeBrowserToolResource && (
          <section className="workspace-browser-placeholder" aria-label={activeWorkspaceBrowserTab?.title || "工具视图"}>
            <Wrench size={22} />
            <strong>{activeWorkspaceBrowserTab?.title || "工具视图"}</strong>
            <span>该页签已接入统一资源协议，工具内容可在后续通过独立渲染器挂载。</span>
          </section>
        )}

        {view === "chat" && activeBrowserConversationResource && !displayedSession && (
          <section className="workspace-browser-placeholder" aria-label={activeWorkspaceBrowserTab?.title || "对话"} aria-live="polite">
            {activeConversationViewState === "error"
              ? <CircleAlert size={22} />
              : activeConversationViewState === "loading"
                ? <LoaderCircle className="spin" size={22} />
                : <MessagesSquare size={22} />}
            <strong>{activeConversationViewState === "error" ? "无法打开对话" : activeConversationViewState === "loading" ? "正在载入对话" : "对话尚未载入"}</strong>
            <span>{activeConversationViewState === "error" ? "目标对话没有加载成功，原对话内容已隔离。" : activeConversationViewState === "loading" ? "正在恢复消息、任务状态和工作区上下文。" : "上次载入已取消，可重新打开这个对话。"}</span>
            {activeConversationViewState !== "loading" && <button type="button" onClick={() => void navigateToSession(activeBrowserConversationResource.conversationId, "task")}>{activeConversationViewState === "error" ? "重试" : "重新打开"}</button>}
          </section>
        )}

        {view === "chat" && showWorkflowBrowserContent ? <WorkflowWorkbench workflowId={activeBrowserWorkflowResource?.workflowId || activeWorkflowId || undefined} defaultPlannerEngine={data.settings.defaultEngine} runtime={data.runtime} providers={agentProviders} workspaceId={activeWorkspaceId} renderAgentMessage={(text) => <MarkdownBody text={text} workspaceId={activeWorkspaceId} workspaceRoot={workspace?.root || ""} onOpenLocalFile={(path) => openFilePreviewPath(path).catch((error) => setNotice(error.message))} />} onCreate={createWorkflow} onOpenWorkflow={selectWorkflow} onOpenLocalFile={(path) => void openFilePreviewPath(path)} onChanged={refresh} onNotice={setNotice} /> : view === "chat" && !activeBrowserFileResource && !activeBrowserToolResource && (!activeBrowserConversationResource || Boolean(displayedSession)) && (
          <section className="chat-view">
            <div
              className="messages"
              ref={messagesRef}
              aria-busy={navigationPending}
              onScroll={(event) => {
                const target = event.currentTarget;
                setFollowOutput(target.scrollHeight - target.scrollTop - target.clientHeight < 96);
                if (!navigationPending && target.scrollTop < 120 && hiddenMessageCount > 0) void revealEarlierMessages();
              }}
            >
              {isNewConversation && activeWorkspaceId && (
                <TaskLaunch
                  workspaceName={workspace?.name || "当前工作区"}
                  onPromptSelect={(suggestion) => {
                    setPrompt(suggestion);
                    window.requestAnimationFrame(() => composerRef.current?.focus());
                  }}
                  onOpenWorkflow={() => { void openWorkflowDraft(); }}
                />
              )}
              {isNewConversation && !activeWorkspaceId && (
                <div className="welcome">
                  <div className="welcome-icon"><Sparkles size={26} /></div>
                  <h1>添加工作区后开始</h1>
                  <p>选择一个项目文件夹，Agent 将为它创建独立的新对话和执行上下文。</p>
                </div>
              )}
              {activeSession?.status === "interrupted" && (
                <div className="resume-note">
                  <Activity size={15} />
                  <span>上次运行因服务重启而中断。直接发送下一条消息即可沿用原任务上下文继续。</span>
                </div>
              )}
              {activeSession && (hiddenMessageCount > 0 || activeMessages.length > MESSAGE_INITIAL_RENDER) && (
                <div className="history-window-control">
                  {hiddenMessageCount > 0 ? (
                    <>
                      <span>已隐藏较早的 {hiddenMessageCount} 条消息，当前只渲染最近 {visibleMessages.length} 条。</span>
                      <button
                        type="button"
                        disabled={historyLoad?.sessionId === activeSession.id || historyPageLoading}
                        onClick={revealEarlierMessages}
                      >
                        {historyPageLoading
                          ? "正在读取更早消息"
                          : historyLoad?.sessionId === activeSession.id
                          ? `正在加载 ${Math.max(0, messageRenderLimit - historyLoad.start)} / ${historyLoad.target - historyLoad.start}`
                          : `显示更早 ${Math.min(MESSAGE_HISTORY_REQUEST, hiddenMessageCount)} 条`}
                      </button>
                    </>
                  ) : (
                    <>
                      <span>当前已展开全部 {activeMessages.length} 条消息。</span>
                      <button
                        type="button"
                        onClick={() => {
                          setHistoryLoad(null);
                          setHistoryPageLoading(false);
                          startTransition(() => setMessageRenderLimits((limits) => ({ ...limits, [activeSession.id]: MESSAGE_INITIAL_RENDER })));
                        }}
                      >
                        收起历史
                      </button>
                    </>
                  )}
                </div>
              )}
              <div className={virtualizeMessages ? "message-virtual-content" : "message-static-content"} style={virtualizeMessages ? { height: `${virtualMessageHeight}px`, position: "relative" } : undefined}>
                {renderedMessageItems.map((virtualItem) => {
                  const message = displayMessages[virtualItem.index];
                  return <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    ref={virtualizeMessages ? messageVirtualizer.measureElement : undefined}
                    className={`message-virtual-row message-virtual-row-${message.role}`}
                    style={virtualizeMessages ? { position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualItem.start}px)` } : undefined}
                  >
                    {message.role === "activity-group" ? <ActivityMessageGroupView group={message} engine={activeSession?.engine || "codex"} providerLabel={agentProviderLabel(activeSession?.engine || "codex", agentProviders)} providerControl={data.providerControls.find((control) => control.providerId === (activeSession?.engine || "codex"))} workspaceId={activeFileScopeId || undefined} /> : message.role === "event" ? (
                      <EventMessage
                        message={message}
                        engine={activeSession?.engine || "codex"}
                        providerControls={data.providerControls}
                        onOpenAgent={setAgentDrawerMessageId}
                        onAnswerQuestion={answerClaudeQuestion}
                      />
                    ) : (() => {
                      const editing = message.role === "user" && editingMessageId === message.id;
                      return <article
                        className={`message ${message.role}${touchActionMessageId === message.id ? " touch-actions-open" : ""}`}
                        data-message-id={message.id}
                        onPointerUp={(event) => {
                          if (message.role !== "assistant" || event.pointerType === "mouse") return;
                          const target = event.target instanceof Element ? event.target : null;
                          if (target?.closest("button, a, input, textarea, summary")) return;
                          setTouchActionMessageId((current) => current === message.id ? "" : message.id);
                        }}
                      >
                        {message.role !== "user" && <div className="avatar"><Bot size={17} /></div>}
                        <div className="message-body">
                          {editing ? (
                            <div className="message-edit-panel">
                              <textarea value={editingMessageText} onChange={(event) => setEditingMessageText(event.target.value)} autoFocus />
                              <div>
                                <button type="button" onClick={() => { setEditingMessageId(""); setEditingMessageText(""); }}>取消</button>
                                <button type="button" disabled={branching || !editingMessageText.trim()} onClick={() => void overwriteFromMessage(message.id)}>
                                  {branching ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}覆盖重做
                                </button>
                                <button type="button" className="primary" disabled={branching || !editingMessageText.trim()} onClick={() => branchFromMessage(message.id)}>
                                  {branching ? <LoaderCircle className="spin" size={14} /> : <GitBranch size={14} />}创建分支
                                </button>
                              </div>
                            </div>
                          ) : message.role === "assistant" ? (
                            <AgentReplyContent text={message.text} renderMessage={(text) => <MarkdownBody
                              text={text}
                              workspaceId={activeFileScopeId}
                              workspaceRoot={workspace?.root || ""}
                              onOpenLocalFile={(path) => openFilePreviewPath(path).catch((error) => setNotice(error.message))}
                            />} />
                          ) : <p>{message.text}</p>}
                          {!editing && <AttachmentList attachments={message.attachments} onOpen={(path) => openFilePreviewPath(path).catch((error) => setNotice(error.message))} />}
                          {!editing && message.role === "assistant" && <AssistantMessageActions
                            text={message.text}
                            branching={branching}
                            onBranch={() => void branchFromAssistantMessage(message.id)}
                            onError={(error) => setNotice(`复制失败：${error instanceof Error ? error.message : String(error)}`)}
                          />}
                        </div>
                        {message.role === "user" && !editing && (
                          <button
                            type="button"
                            className="message-edit-button"
                            title={running ? "任务执行期间不能创建历史分支" : "编辑并从此处创建分支"}
                            disabled={running}
                            onClick={() => {
                              setEditingMessageId(message.id);
                              setEditingMessageText(message.text);
                            }}
                          ><Pencil size={13} /></button>
                        )}
                      </article>;
                    })()}
                  </div>;
                })}
              </div>
              {running && <div className="working-line"><LoaderCircle className="spin" size={16} />智能体正在工作</div>}
              <div />
            </div>
            {!navigationPending && !followOutput && (
              <button
                className="jump-bottom"
                onClick={() => {
                  setFollowOutput(true);
                  const messages = messagesRef.current;
                  if (messages) messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
                }}
              >
                <ArrowDown size={15} />回到底部
              </button>
            )}
            <div className={`composer-wrap ${navigationPending ? "switching" : ""}`} aria-busy={navigationPending}>
              <PendingTurnTray
                items={(activeSession?.pendingInputs || []).filter((item) => item.mode !== "steer" && item.status !== "steering")}
                running={running}
                onEdit={editPendingInput}
                onRemove={cancelPendingInput}
                onPromote={promotePendingInput}
              />
              <div
                className={`composer ${attachmentDragActive ? "attachment-drag-active" : ""}`}
                onDragEnter={(event) => { event.preventDefault(); setAttachmentDragActive(true); }}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAttachmentDragActive(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setAttachmentDragActive(false);
                  addDraftFiles(Array.from(event.dataTransfer.files));
                }}
              >
                <input
                  ref={attachmentInputRef}
                  className="attachment-file-input"
                  type="file"
                  multiple
                  onChange={(event) => {
                    addDraftFiles(Array.from(event.target.files || []));
                    event.target.value = "";
                  }}
                />
                {skillMenuOpen && (
                  <div className="skill-invoke-menu" role="menu" aria-label="选择本轮调用的 Skill">
                    <div className="skill-invoke-menu-header"><strong>本轮调用 Skill</strong><small>仅当前消息生效</small></div>
                    {manualSkillCandidates.length ? manualSkillCandidates.map((skill) => {
                      const selected = invokedSkillNames.includes(skill.name);
                      return <button type="button" role="menuitemcheckbox" aria-checked={selected} className={selected ? "selected" : ""} key={skill.name} onClick={() => {
                        setInvokedSkillNames((current) => selected ? current.filter((name) => name !== skill.name) : [...current, skill.name]);
                        setPrompt("");
                      }}>
                        <Sparkles size={13} /><span><strong>{skill.title}</strong><small>{skill.name}</small></span><Check size={14} className={selected ? "" : "invisible"} />
                      </button>;
                    }) : <p className="skill-invoke-empty">当前工作区没有可手动调用的扩展 Skill</p>}
                    <button type="button" className="skill-invoke-close" onClick={() => setSkillMenuOpen(false)}>取消</button>
                  </div>
                )}
                {invokedSkillNames.length > 0 && (
                  <div className="skill-invocation-bar">
                    <Sparkles size={13} /><span>本轮调用</span>{invokedSkillNames.map((name) => <em key={name}>@{name}</em>)}
                    <button type="button" onClick={() => setInvokedSkillNames([])} aria-label="清除本轮 Skill">清除</button>
                  </div>
                )}
                {draftAttachments.length > 0 && (
                  <div className="draft-attachments" aria-label="待发送附件">
                    {draftAttachments.map((attachment) => <div className="draft-attachment" key={attachment.id} title={attachment.file.name}>
                      {attachment.file.type.startsWith("image/") ? <FileImage size={14} /> : <File size={14} />}
                      <span><strong>{attachment.file.name}</strong><small>{formatBytes(attachment.file.size)}</small></span>
                      <button type="button" aria-label={`移除 ${attachment.file.name}`} disabled={uploadingAttachments} onClick={() => setDraftAttachments((items) => items.filter((item) => item.id !== attachment.id))}><X size={13} /></button>
                    </div>)}
                  </div>
                )}
                {attachmentDragActive && <div className="attachment-drop-hint"><Paperclip size={17} />松开以添加附件</div>}
                {activeSession?.status === "failed" && activeSession.lastError && <div className="task-recovery-panel" role="alert">
                  <CircleAlert size={16} />
                  <span><strong>任务未完成</strong><small>{activeSession.lastError}</small></span>
                  <button type="button" onClick={() => openModelSettings(activeSession.engine)}>检查 Agent</button>
                  <button type="button" onClick={() => setPrompt([...activeSession.messages].reverse().find((message) => message.role === "user")?.text || "请从上次失败的位置继续。")}>准备重试</button>
                </div>}
                <textarea
                  ref={composerRef}
                  value={prompt}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value.trim() === "@") {
                      setPrompt("");
                      setSkillQuickConfigOpen(false);
                      setSkillMenuOpen(true);
                    } else setPrompt(value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      run();
                    }
                  }}
                  onPaste={(event) => {
                    const files = Array.from(event.clipboardData.files || []);
                    if (files.length) addDraftFiles(files);
                  }}
                    placeholder={!activeFileScopeId ? (standaloneActive ? "请先创建临时任务" : "请先添加工作区") : runningInputMode === "steer" && running ? "立即引导当前任务..." : running ? "添加到任务队列..." : activeSession ? `给 ${agentProviderLabel(activeSession.engine, agentProviders)} 一个任务...` : "输入任务，发送前选择运行模式..."}
                  disabled={!activeFileScopeId || navigationPending}
                />
                <div className="composer-footer">
                  <button type="button" className="attachment-button composer-control-button icon-only" onClick={() => attachmentInputRef.current?.click()} disabled={!activeFileScopeId || uploadingAttachments || submittingInput || navigationPending} title="添加附件"><Paperclip size={15} /></button>
                  <ComposerPreferenceSelect label="项目权限" value={data.settings.sandboxMode} icon={<ShieldCheck size={14} />} options={[{ value: "danger-full-access", label: "完全访问" }, { value: "workspace-write", label: "仅工作区" }, { value: "read-only", label: "只读" }]} onChange={(sandboxMode) => updateExecutionSetting({ sandboxMode })} />
                  <ComposerPreferenceSelect label="联网模式" value={data.settings.webSearch} icon={<Globe2 size={14} />} options={[{ value: "live", label: "实时联网" }, { value: "cached", label: "缓存搜索" }, { value: "disabled", label: "关闭联网" }]} onChange={(webSearch) => updateExecutionSetting({ webSearch })} />
                  <CapabilityProfileControl
                    open={skillQuickConfigOpen}
                    activeProfileId={activeCapabilityProfileId}
                    activeLabel={activeCapabilityProfile?.name || "自定义配置"}
                    adjusted={activeCapabilityProfileAdjusted}
                    profiles={recentCapabilityProfiles}
                    onToggle={() => { setSkillMenuOpen(false); setSkillQuickConfigOpen((value) => !value); }}
                    onClose={() => setSkillQuickConfigOpen(false)}
                    onSelect={async (profileId) => { try { await applyCapabilityProfile(profileId); setSkillQuickConfigOpen(false); setNotice(profileId ? `已应用能力方案：${data.capabilityProfiles.find((item) => item.id === profileId)?.name || ""}` : "已切换为自定义配置", "success"); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } }}
                    onTemporarySkills={() => { setSkillQuickConfigOpen(false); setSkillMenuOpen(true); }}
                    onManage={() => { setSkillQuickConfigOpen(false); setView("agents"); }}
                  />
                  <ComposerRuntimeControl
                    provider={activeSession?.engine || data.settings.defaultEngine}
                    descriptor={agentProviders.find((provider) => provider.id === (activeSession?.engine || data.settings.defaultEngine))}
                    control={data.providerControls.find((control) => control.providerId === (activeSession?.engine || data.settings.defaultEngine))}
                    sessionId={activeSession?.id}
                    model={data.providerControls.find((control) => control.providerId === (activeSession?.engine || data.settings.defaultEngine))?.configuration.model || ""}
                    effort={String(data.providerControls.find((control) => control.providerId === (activeSession?.engine || data.settings.defaultEngine))?.configuration.reasoningValue ?? "")}
                    executionMode={currentExecutionMode}
                    loadModels={loadComposerModels}
                    onModelChange={saveComposerModel}
                    loadSessionConfiguration={loadComposerSessionConfiguration}
                    onSessionConfigurationChange={saveComposerSessionConfiguration}
                    onProfileConfigurationChange={saveComposerProfileConfiguration}
                    onExecutionModeChange={updateComposerExecutionMode}
                  />
                  {running ? (
                    <>
                      <div className="running-input-mode" aria-label="运行中消息方式">
                        <button type="button" className={runningInputMode === "queue" ? "active" : ""} onClick={() => setRunningInputMode("queue")} title="当前轮次完成后发送"><ListPlus size={14} />排队</button>
                        <button type="button" className={runningInputMode === "steer" ? "active" : ""} onClick={() => setRunningInputMode("steer")} title="中断当前轮次并立即应用"><Route size={14} />引导</button>
                      </div>
                      <button className={`send-button ${runningInputMode === "steer" ? "steer" : ""}`} onClick={run} disabled={uploadingAttachments || submittingInput || (!prompt.trim() && !draftAttachments.length)} title={submittingInput ? "正在确认消息" : runningInputMode === "steer" ? "立即引导" : "加入队列"}>{uploadingAttachments || submittingInput ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button>
                      <div className="run-controls">
                      <button type="button" className="send-button pause" onClick={pause} disabled={Boolean(runControlAction)} title={runControlAction === "pause" ? "正在暂停" : "暂停任务"}>{runControlAction === "pause" ? <LoaderCircle className="spin" size={18} /> : <Pause size={18} />}</button>
                      <button type="button" className="send-button stop" onClick={stop} disabled={Boolean(runControlAction)} title={runControlAction === "stop" ? "正在停止" : "停止任务"}>{runControlAction === "stop" ? <LoaderCircle className="spin" size={18} /> : <CircleStop size={18} />}</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <button className="send-button" onClick={run} disabled={uploadingAttachments || submittingInput || (!prompt.trim() && !draftAttachments.length) || !activeFileScopeId || navigationPending} title="发送">{uploadingAttachments || submittingInput ? <LoaderCircle className="spin" size={17} /> : <Send size={18} />}</button>
                      {!navigationPending && activeSession?.status === "paused" && (
                        <div className="run-controls">
                          <button className="send-button resume" onClick={resume} title="继续任务" aria-label="继续任务"><Play size={18} /></button>
                          <button type="button" className="send-button stop" onClick={stop} disabled={Boolean(runControlAction)} title={runControlAction === "stop" ? "正在停止" : "停止任务"} aria-label="停止任务">{runControlAction === "stop" ? <LoaderCircle className="spin" size={18} /> : <CircleStop size={18} />}</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="composer-disclaimers">
                <small>智能体可能会修改工作区文件，请使用版本控制检查变更。 · AI 产出声明：最终产物可查考，务必检查后使用。</small>
              </div>
            </div>
            {agentDrawerMessage && activeSession && (
              <SubagentDrawer
                key={agentDrawerMessage.id}
                message={agentDrawerMessage}
                messages={activeSession.messages}
                sessionId={activeSession.id}
                sessionRunning={running}
                workspaceId={activeFileScopeId}
                workspaceRoot={workspace?.root || ""}
                providerControls={data.providerControls}
                onOpenLocalFile={(path) => openFilePreviewPath(path).catch((error) => setNotice(error.message))}
                onClose={() => setAgentDrawerMessageId("")}
              />
            )}
          </section>
        )}

        {view === "agents" && (
          <AgentsView agents={data.skills} folders={data.skillFolders || []} organizations={data.skillOrganizations || []} profiles={data.capabilityProfiles || []} activeProfileId={activeCapabilityProfileId} policies={skillPolicies} onPoliciesChange={updateSkillPolicies} onApplyProfile={applyCapabilityProfile} onImport={() => setDialog("agent-import")} onDelete={deleteSkill} onLibraryChanged={refresh} onNotice={setNotice} onOpenFolder={async (agent) => {
            try {
              await api(`/api/skills/${encodeURIComponent(agent.name)}/open-folder`, { method: "POST" });
            } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
          }} onRename={async (agent, displayName) => {
            try {
              const result = await api<{ skill: AgentProfile }>(`/api/skills/${encodeURIComponent(agent.name)}/display-name`, { method: "PUT", body: JSON.stringify({ displayName }) });
              setData((current) => current ? { ...current, skills: current.skills.map((item) => item.name === agent.name ? normalizeSkillProfile(result.skill) : item) } : current);
              setNotice(`已更新显示名：${result.skill.title}`, "success");
            } catch (error) {
              setNotice(error instanceof Error ? error.message : String(error));
            }
          }} />
        )}
        {view === "mcp" && <McpView servers={data.mcpServers || []} workspaces={data.workspaces} activeWorkspaceId={activeWorkspaceId} onChanged={refresh} onNotice={setNotice} />}
        {view === "git" && <GitWorkbench workspaceId={activeWorkspaceId} />}
        {view === "settings" && <RecoverableSectionBoundary resetKey={`${settingsTarget}:${settingsProvider}`} title="设置页面暂时无法显示"><SettingsView
          initialSection={settingsTarget}
          settings={data.settings}
          dataHome={data.runtime.dataHome}
          codexHome={data.runtime.codexHome}
          claudeHome={data.runtime.claudeHome}
          codexRuntime={data.runtime.codex}
          claudeRuntime={data.runtime.claude}
          providers={agentProviders}
          providerControls={data.providerControls}
          providerTab={settingsProvider}
          onProviderChange={setSettingsProvider}
          onSettingsChanged={(settings) => setData((current) => current ? {
            ...current,
            settings,
            providerControls: current.providerControls.map((control) => ({ ...control, isDefault: control.providerId === settings.defaultEngine }))
          } : current)}
          onResetTabs={async () => {
            if (!await confirmAction("关闭全部工作区页面？任务、文件和对话不会被删除。")) return;
            dispatchWorkspaceBrowser({ type: "replace", state: createWorkspaceBrowserTabsState() });
          }}
          onResetLayout={() => setLayoutWidths({ ...DEFAULT_LAYOUT_WIDTHS })}
          onOpenSession={(id) => { setView("chat"); void navigateToSession(id, "task"); }}
          onOpenWorkflow={(id) => { setView("chat"); void selectWorkflow(id); }}
          onNotice={(message, tone) => setNotice(message, tone)}
          onChanged={refresh}
        /></RecoverableSectionBoundary>}
        {navigationPending && (
          <div className="conversation-switch-state" role="status" aria-live="polite">
            <span><ProviderIcon provider={navigationSummary?.engine || "codex"} icon={data.providerControls.find((control) => control.providerId === (navigationSummary?.engine || "codex"))?.identity.icon} accent={data.providerControls.find((control) => control.providerId === (navigationSummary?.engine || "codex"))?.identity.accent} size={18} /><LoaderCircle className="spin" size={16} /></span>
            <strong>{navigationSummary?.title || "正在打开任务"}</strong>
            <small>正在载入最近消息</small>
          </div>
        )}
      </main>

      {inspectorVisible && <button type="button" className="mobile-inspector-backdrop" aria-label="关闭文件区" onClick={() => setInspectorOpen(false)} />}
      {inspectorVisible && (
        <aside className={`inspector ${navigationPending ? "navigation-pending" : ""}`} aria-busy={navigationPending}>
          <div className="inspector-header">
            <span>
              <strong>{fileScopeStandalone ? "临时目录" : "工作区"}</strong>
              <small>{treeLoading ? "正在读取" : `${workspaceTreeNodeCount(tree)} 项 · ${treeUpdatedAt ? `${treeUpdatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 更新` : "尚未读取"}`}</small>
            </span>
            <span className="inspector-header-actions">
              {fileScopeWorkspace && <button type="button" className="agents-file-button" onClick={openAgents} title="编辑 AGENTS.md" aria-label="编辑 AGENTS.md"><FileCode2 size={15} /></button>}
              <IconButton label="在文件管理器中打开工作区" disabled={!activeFileScopeId} onClick={() => openWorkspaceFolder()}><FolderOpen size={15} /></IconButton>
              <IconButton label="刷新文件" disabled={!activeFileScopeId || treeLoading} onClick={() => void loadWorkspaceTree(activeFileScopeId, { force: true })}>
                <RefreshCw className={treeLoading ? "spin" : undefined} size={15} />
              </IconButton>
              <IconButton label="关闭文件区" onClick={() => setInspectorOpen(false)}><X size={15} /></IconButton>
            </span>
          </div>
          <label className="tree-search">
            <Search size={14} aria-hidden="true" />
            <input value={treeQuery} onChange={(event) => setTreeQuery(event.target.value)} placeholder="搜索文件和目录" aria-label="搜索文件和目录" />
            {treeQuery && <button type="button" aria-label="清除文件搜索" onClick={() => setTreeQuery("")}><X size={13} /></button>}
          </label>
          {treeError && <div className="tree-error"><span>{treeError}</span><button type="button" onClick={() => void loadWorkspaceTree(activeFileScopeId, { force: true })}>重试</button></div>}
          {treeHasVisibleItems ? <RecoverableSectionBoundary resetKey={`${activeFileScopeId}:${treeUpdatedAt?.getTime() || 0}`} title="文件列表暂时无法显示"><WorkspaceFileTree workspaceId={activeFileScopeId} nodes={tree} query={treeQuery} selectedPath={activeBrowserFileResource?.workspaceId === activeFileScopeId ? activeBrowserFileResource.path : undefined} onFileOpen={openFilePreview} onDirectoryOpen={loadWorkspaceDirectory} onMove={moveWorkspaceFiles} onCopyPaths={copyWorkspacePaths} onDelete={deleteWorkspaceFiles} /></RecoverableSectionBoundary> : <p className="empty-note">{treeLoading ? "正在读取工作区文件" : treeQuery ? "没有匹配的文件" : "没有可显示的文件"}</p>}
        </aside>
      )}
      {inspectorVisible && <button className="pane-resizer pane-resizer-inspector" type="button" role="separator" aria-label="调整文件区宽度" aria-valuemin={220} aria-valuemax={420} aria-valuenow={layoutWidths.inspector} onPointerDown={(event) => beginPaneResize("inspector", event)} onPointerMove={movePaneResize} onPointerUp={endPaneResize} onPointerCancel={endPaneResize} onDoubleClick={() => resetPaneWidth("inspector")} onKeyDown={(event) => handlePaneResizeKeyDown("inspector", event)}><GripVertical size={14} /></button>}

      {dialog === "workspace" && <WorkspaceDialog onClose={() => setDialog(null)} onCreated={async (item) => {
        await refresh();
        await openWorkspace(item.id);
        setDialog(null);
      }} />}
      {dialog === "task-mode" && <TaskEngineDialog
        runtime={data.runtime}
        providers={agentProviders}
        providerControls={data.providerControls}
        defaultEngine={data.settings.defaultEngine}
        hasWorkspace={Boolean(activeWorkspaceId)}
        onClose={() => { setPendingNewTaskPrompt(""); setPendingNewTaskSkills([]); setDialog(null); }}
        onSelect={createSessionForEngine}
        onSelectWorkflow={openWorkflowDraft}
      />}
      {dialog === "agent" && <AgentDialog mode="create" onClose={() => setDialog(null)} onDone={async () => { await refresh(); setDialog(null); }} />}
      {dialog === "agent-import" && <AgentDialog mode="import" onClose={() => setDialog(null)} onDone={async () => { await refresh(); setDialog(null); }} />}
      {dialog === "agents" && <Dialog title="工作区指令 AGENTS.md" onClose={() => setDialog(null)}>
        <textarea className="large-editor" value={agents} onChange={(event) => setAgents(event.target.value)} placeholder="# 项目指令" />
        <div className="dialog-actions"><button className="primary" onClick={async () => {
          if (!agentsWorkspaceId) return;
          await api(`/api/workspaces/${agentsWorkspaceId}/instructions`, { method: "PUT", body: JSON.stringify({ content: agents }) });
          setDialog(null);
        }}><Save size={16} />保存</button></div>
      </Dialog>}
      {guideOpen && <FirstRunGuide
        connectedAgents={data.providerControls.filter((control) => control.connection.status === "ready").length}
        workspaceCount={data.workspaces.filter((workspace) => !workspace.archivedAt).length}
        dataHome={data.runtime.dataHome}
        onComplete={completeFirstRunGuide}
        onSkip={completeFirstRunGuide}
        onOpenAgentSettings={() => {
          setGuideOpen(false);
          cancelSessionNavigation();
          setSettingsTarget("ai");
          setView("settings");
        }}
        onAddWorkspace={() => {
          setGuideOpen(false);
          setDialog("workspace");
        }}
      />}
      <AppUpdateAnnouncement hidden={view === "settings"} />
      <OperationCenter />
      {notice && <div className={`toast ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"}><span>{notice.message}</span><button aria-label="关闭提示" onClick={() => setNotice("")}><X size={15} /></button></div>}
    </div>
  );
}

function WorkspaceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (workspace: Workspace) => void }) {
  const [root, setRoot] = useState("");
  const [name, setName] = useState("");
  const [create, setCreate] = useState(false);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  return <Dialog title="添加工作区" onClose={onClose}>
    <div className="form-grid">
      <WorkspaceDropZone disabled={picking} onFolder={(path) => {
        setRoot(path);
        setCreate(false);
        setError("");
        setName((current) => current || workspaceNameFromPath(path));
      }} />
      <label>
        <span>文件夹位置</span>
        <div className="path-picker">
          <input value={root} onChange={(event) => setRoot(event.target.value)} autoFocus />
          <button
            type="button"
            disabled={picking}
            onClick={async () => {
              setPicking(true);
              setError("");
              try {
                const result = await api<{ path: string | null }>("/api/dialogs/folder", {
                  method: "POST",
                  body: JSON.stringify({
                    initialPath: root,
                    title: "选择智能体工作区"
                  }),
                  timeoutMs: 10 * 60_000
                });
                if (result.path) setRoot(result.path);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setPicking(false);
              }
            }}
          >
            {picking ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />}
            浏览
          </button>
        </div>
      </label>
      <label><span>显示名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="默认使用文件夹名" /></label>
      <label className="check-row"><input type="checkbox" checked={create} onChange={(event) => setCreate(event.target.checked)} /><span>路径不存在时创建文件夹</span></label>
      {error && <p className="form-error">{error}</p>}
    </div>
    <div className="dialog-actions"><button onClick={onClose}>取消</button><button className="primary" onClick={async () => {
      try {
        onCreated(await api<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ root, name, create }) }));
      } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    }}><FolderOpen size={16} />添加</button></div>
  </Dialog>;
}

function TaskEngineDialog({ runtime, providers, providerControls, defaultEngine, hasWorkspace, onClose, onSelect, onSelectWorkflow }: { runtime: Bootstrap["runtime"]; providers: AgentProviderDescriptor[]; providerControls: ProviderControlSnapshot[]; defaultEngine: EngineName; hasWorkspace: boolean; onClose: () => void; onSelect: (engine: EngineName, scopeKind: "workspace" | "standalone") => Promise<void>; onSelectWorkflow: () => Promise<void> }) {
  const engines = providers.filter((provider) => provider.capabilities.sessions.create).map((provider) => ({
    engine: provider.id,
    title: provider.shortName,
    description: provider.description,
    detail: provider.capabilities.delegation.nativeSubagents
      ? "原生模式保留 CLI 自身的 Agent 能力；协作模式使用工作台统一委派。"
      : "协作模式通过工作台统一委派；不假定该 CLI 具备原生子 Agent。"
  }));
  const engineReady = (engine: EngineName) => {
    const control = providerControls.find((candidate) => candidate.providerId === engine);
    return control ? control.operations.setDefault : Boolean(runtime.providers[engine]?.available);
  };
  const initialEngine = engineReady(defaultEngine) ? defaultEngine : engines.find((item) => engineReady(item.engine))?.engine || defaultEngine;
  const [selected, setSelected] = useState<EngineName | "workflow">(initialEngine);
  const [scopeKind, setScopeKind] = useState<"workspace" | "standalone">(hasWorkspace ? "workspace" : "standalone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const workflowReady = providers.some((provider) => provider.capabilities.workflow.planner && engineReady(provider.id));
  const selectedAvailable = selected === "workflow" ? scopeKind === "workspace" && workflowReady : engineReady(selected);
  const taskTypes = [...engines.map((item) => ({ ...item, engine: item.engine as EngineName | "workflow" })), { engine: "workflow" as const, title: "Meta 任务编排", description: "先规划审批，再并行调度多个子 Agent", detail: "适合可拆分的大任务；会在当前工作区创建独立任务文件夹。" }];
  return <Dialog title="新建任务" onClose={busy ? () => undefined : onClose}>
    <div className="task-mode-intro-row"><p className="task-mode-intro">普通任务选择对话协议；Meta 编排会先生成计划并等待审批。</p><HelpButton topic="workspace-scope" /></div>
    <div className="task-scope-control" role="group" aria-label="任务位置">
      <button type="button" className={scopeKind === "standalone" ? "selected" : ""} onClick={() => { setScopeKind("standalone"); if (selected === "workflow") setSelected(initialEngine); }}>临时任务</button>
      <button type="button" className={scopeKind === "workspace" ? "selected" : ""} disabled={!hasWorkspace} onClick={() => setScopeKind("workspace")}>当前工作区</button>
    </div>
    <div className="task-mode-grid">
      {taskTypes.map((item) => {
        if (item.engine === "workflow") return <button type="button" key="workflow" className={`task-mode-card ${selected === "workflow" ? "selected" : ""}`} disabled={busy || scopeKind === "standalone" || !workflowReady} title={scopeKind === "standalone" ? "任务编排需要真实工作区" : !workflowReady ? "请先连接支持规划的 Agent" : undefined} onClick={() => setSelected("workflow")}><span className="task-mode-icon"><Route size={19} /></span><span><strong>{item.title}</strong><small>{item.description}</small><p>{scopeKind === "standalone" ? "任务编排需要选择真实工作区" : !workflowReady ? "请先连接支持规划的 Agent" : item.detail}</p></span><i>{workflowReady && selected === "workflow" ? <Check size={15} /> : !workflowReady ? "不可用" : null}</i></button>;
        const control = providerControls.find((candidate) => candidate.providerId === item.engine);
        const available = engineReady(item.engine);
        return <button type="button" key={item.engine} className={`task-mode-card ${selected === item.engine ? "selected" : ""}`} disabled={!available || busy} onClick={() => setSelected(item.engine)}>
          <span className="task-mode-icon"><ProviderIcon provider={item.engine} icon={control?.identity.icon} accent={control?.identity.accent} size={21} /></span>
          <span><strong>{item.title}</strong><small>{control?.identity.transport === "acp" ? "ACP 标准接入" : "原生增强"} · {item.description}</small><p>{available ? control?.identity.transport === "acp" && !control.capabilities.tools.shell ? "支持原生任务；该 Agent 未声明终端能力，因此不开放工作台协作模式。" : item.detail : providerMainAgentUnavailableReason(control)}</p></span>
          <i>{available ? selected === item.engine ? <Check size={15} /> : null : "不可用"}</i>
        </button>;
      })}
    </div>
    {error && <p className="form-error">{error}</p>}
    <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary" disabled={busy || !selectedAvailable} onClick={async () => {
      setBusy(true); setError("");
      try { if (selected === "workflow") await onSelectWorkflow(); else await onSelect(selected, scopeKind); }
      catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false); }
    }}>{busy ? <LoaderCircle className="spin" size={16} /> : selected === "workflow" ? <Route size={16} /> : <Check size={16} />}{selected === "workflow" ? "进入画布" : "创建任务"}</button></div>
  </Dialog>;
}

function AgentDialog({ mode, onClose, onDone }: { mode: "create" | "import"; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  return <Dialog title={mode === "create" ? "新建 Skill" : "导入 Skill"} onClose={onClose}>
    <div className="form-grid">
      {mode === "import" ? (
        <label>
          <span>Skill 文件夹路径</span>
          <div className="path-picker">
            <input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="目录内需要包含 SKILL.md" autoFocus />
            <button type="button" disabled={picking} onClick={async () => {
              setPicking(true);
              setError("");
              try {
                const result = await api<{ path: string | null }>("/api/dialogs/folder", {
                  method: "POST",
                  body: JSON.stringify({ initialPath: sourcePath, title: "选择要导入的 Skill 文件夹" }),
                  timeoutMs: 10 * 60_000
                });
                if (result.path) setSourcePath(result.path);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setPicking(false);
              }
            }}>
              {picking ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />}浏览
            </button>
          </div>
        </label>
      ) : <>
        <label><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="my-agent" autoFocus /></label>
        <label><span>描述</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="智能体应在什么时候使用它" /></label>
        <label><span>指令</span><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="写下工作步骤、约束和验证标准" /></label>
      </>}
      {error && <p className="form-error">{error}</p>}
    </div>
    <div className="dialog-actions"><button onClick={onClose}>取消</button><button className="primary" onClick={async () => {
      try {
        await api(mode === "import" ? "/api/skills/import" : "/api/skills", {
          method: "POST",
          body: JSON.stringify(mode === "import" ? { sourcePath } : { name, description, instructions })
        });
        onDone();
      } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    }}>{mode === "import" ? <Import size={16} /> : <Plus size={16} />}{mode === "import" ? "导入" : "创建"}</button></div>
  </Dialog>;
}

function CapabilityProfileDialog({ profile, agents, initialPolicies, onClose, onSaved }: { profile?: CapabilityProfile; agents: AgentProfile[]; initialPolicies: SkillPolicies; onClose: () => void; onSaved: (profile: CapabilityProfile) => Promise<void> | void }) {
  const [name, setName] = useState(profile?.name || "");
  const [description, setDescription] = useState(profile?.description || "");
  const [policies, setPolicies] = useState<SkillPolicies>(profile?.skillPolicies || initialPolicies);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleAgents = agents.filter((agent) => !normalizedQuery || `${agent.title}\n${agent.name}\n${agent.description}`.toLocaleLowerCase().includes(normalizedQuery));
  return <Dialog title={profile ? "编辑能力方案" : "新建能力方案"} className="capability-profile-dialog" onClose={onClose}>
    <div className="capability-profile-editor">
      <div className="capability-profile-fields"><label><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} autoFocus maxLength={60} placeholder="输入方案名称" /></label><label><span>说明</span><input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={240} placeholder="这个方案适合什么工作" /></label></div>
      <label className="capability-profile-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skill" aria-label="搜索能力方案中的 Skill" /></label>
      <div className="capability-profile-skill-list">
        {visibleAgents.map((agent) => {
          const policy = policies[agent.name] || (agent.builtIn ? "auto" : "manual");
          return <label key={agent.name}><span><strong>{agent.title}</strong><small>{agent.name}</small></span><select value={policy} aria-label={`${agent.title} 方案策略`} onChange={(event) => setPolicies((current) => ({ ...current, [agent.name]: event.target.value as SkillPolicy }))}><option value="auto">自动</option><option value="always">始终</option>{!agent.builtIn && <option value="manual">手动</option>}<option value="off">关闭</option></select></label>;
        })}
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
    <div className="dialog-actions"><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={saving || !name.trim()} onClick={async () => {
      setSaving(true); setError("");
      try {
        const result = await api<{ profile: CapabilityProfile }>(profile ? `/api/capability-profiles/${encodeURIComponent(profile.id)}` : "/api/capability-profiles", { method: profile ? "PATCH" : "POST", body: JSON.stringify({ name, description, skillPolicies: policies }) });
        await onSaved(result.profile);
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setSaving(false); }
    }}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{profile ? "保存方案" : "创建方案"}</button></div>
  </Dialog>;
}

function AgentsView({ agents, folders, organizations, profiles, activeProfileId, policies, onPoliciesChange, onApplyProfile, onImport, onDelete, onOpenFolder, onRename, onLibraryChanged, onNotice }: { agents: AgentProfile[]; folders: SkillFolder[]; organizations: SkillOrganization[]; profiles: CapabilityProfile[]; activeProfileId: string | null; policies: SkillPolicies; onPoliciesChange: (policies: SkillPolicies) => void; onApplyProfile: (profileId: string | null, savedProfile?: CapabilityProfile) => Promise<void>; onImport: () => void; onDelete: (agent: AgentProfile) => void; onOpenFolder: (agent: AgentProfile) => Promise<void>; onRename: (agent: AgentProfile, displayName: string) => Promise<void>; onLibraryChanged: () => Promise<void>; onNotice: (message: string, tone?: NoticeTone) => void }) {
  type Category = "all" | "builtin" | "enabled" | "uncategorized" | "archived" | `folder:${string}`;
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [sortMode, setSortMode] = useState<"name" | "policy">("name");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [selectionAnchorName, setSelectionAnchorName] = useState("");
  const [focusedName, setFocusedName] = useState("");
  const [healthCheckStep, setHealthCheckStep] = useState(-1);
  const [dragTarget, setDragTarget] = useState("");
  const [contextMenu, setContextMenu] = useState<{ name: string; names: string[]; x: number; y: number } | null>(null);
  const [profileEditor, setProfileEditor] = useState<CapabilityProfile | "new" | null>(null);
  const [savingCurrentProfile, setSavingCurrentProfile] = useState(false);
  const optionalAgents = agents.filter((agent) => !agent.builtIn);
  const organizationMap = useMemo(() => new Map(organizations.map((item) => [item.skillName, item])), [organizations]);
  const folderMap = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
  const selectedSet = useMemo(() => new Set(selectedNames), [selectedNames]);
  const setPolicy = (name: string, policy: SkillPolicy) => onPoliciesChange({ ...policies, [name]: policy });
  const activeOptional = optionalAgents.filter((agent) => (policies[agent.name] || "off") !== "off").length;
  const autoCount = agents.filter((agent) => (policies[agent.name] || "off") === "auto").length;
  const alwaysCount = agents.filter((agent) => (policies[agent.name] || "off") === "always").length;
  const manualCount = agents.filter((agent) => (policies[agent.name] || "off") === "manual").length;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const archivedCount = agents.filter((agent) => Boolean(organizationMap.get(agent.name)?.archivedAt)).length;
  const activeLibraryCount = agents.length - archivedCount;
  const unclassifiedCount = agents.filter((agent) => {
    const item = organizationMap.get(agent.name);
    return !item?.archivedAt && !item?.folderId;
  }).length;
  const folderCount = (folderId: string) => agents.filter((agent) => {
    const item = organizationMap.get(agent.name);
    return !item?.archivedAt && item?.folderId === folderId;
  }).length;
  const categoryLabel = category === "all" ? "全部 Skill" : category === "builtin" ? "系统内置" : category === "enabled" ? "当前工作区已启用" : category === "uncategorized" ? "未分类" : category === "archived" ? "归档" : folderMap.get(category.slice(7))?.name || "文件夹";
  const filteredAgents = agents.filter((agent) => {
    const organization = organizationMap.get(agent.name);
    const archived = Boolean(organization?.archivedAt);
    if (category === "archived") { if (!archived) return false; }
    else {
      if (archived) return false;
      if (category === "builtin" && !agent.builtIn) return false;
      if (category === "enabled" && (policies[agent.name] || "off") === "off") return false;
      if (category === "uncategorized" && organization?.folderId) return false;
      if (category.startsWith("folder:") && organization?.folderId !== category.slice(7)) return false;
    }
    return !normalizedQuery || `${agent.title}\n${agent.name}\n${agent.description}`.toLocaleLowerCase().includes(normalizedQuery);
  }).sort((left, right) => {
    const leftPinned = PINNED_BUILTIN_SKILL_ORDER.indexOf(left.name as typeof PINNED_BUILTIN_SKILL_ORDER[number]);
    const rightPinned = PINNED_BUILTIN_SKILL_ORDER.indexOf(right.name as typeof PINNED_BUILTIN_SKILL_ORDER[number]);
    if (leftPinned !== rightPinned) return (leftPinned < 0 ? Number.MAX_SAFE_INTEGER : leftPinned) - (rightPinned < 0 ? Number.MAX_SAFE_INTEGER : rightPinned);
    return sortMode === "policy"
      ? (policies[left.name] || "off").localeCompare(policies[right.name] || "off") || left.title.localeCompare(right.title, "zh-CN")
      : left.title.localeCompare(right.title, "zh-CN");
  });
  const selectSkill = (agent: AgentProfile, event: React.MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button,select,input")) return;
    const additive = event.ctrlKey || event.metaKey;
    if (event.shiftKey) {
      const anchorName = selectionAnchorName || focusedName || agent.name;
      const anchorIndex = Math.max(0, filteredAgents.findIndex((item) => item.name === anchorName));
      const targetIndex = filteredAgents.findIndex((item) => item.name === agent.name);
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const range = filteredAgents.slice(start, end + 1).map((item) => item.name);
      setSelectedNames((current) => additive ? [...new Set([...current, ...range])] : range);
      setFocusedName(agent.name);
      return;
    }
    if (additive || selectionMode) {
      setSelectedNames((current) => current.includes(agent.name) ? current.filter((name) => name !== agent.name) : [...current, agent.name]);
      setSelectionAnchorName(agent.name);
      setFocusedName(agent.name);
      return;
    }
    setSelectedNames([]);
    setSelectionAnchorName(agent.name);
    setFocusedName(agent.name);
  };
  const focusedAgent = filteredAgents.find((agent) => agent.name === focusedName)
    || filteredAgents[0]
    || null;
  const focusedOrganization = focusedAgent ? organizationMap.get(focusedAgent.name) : undefined;
  const focusedFolder = focusedOrganization?.folderId ? folderMap.get(focusedOrganization.folderId) : undefined;
  const focusedPolicy = focusedAgent ? policies[focusedAgent.name] || "off" : "off";
  const policyLabel = (policy: SkillPolicy) => policy === "auto" ? "自动调用" : policy === "always" ? "始终启用" : policy === "manual" ? "手动点名" : "已关闭";
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  const profileOverrideCount = activeProfile ? Object.keys(policies).filter((name) => (activeProfile.skillPolicies[name] || (agents.find((agent) => agent.name === name)?.builtIn ? "auto" : "manual")) !== policies[name]).length : 0;

  const saveCurrentProfile = async () => {
    if (!activeProfile) {
      setProfileEditor("new");
      return;
    }
    setSavingCurrentProfile(true);
    try {
      const result = await api<{ profile: CapabilityProfile }>(`/api/capability-profiles/${encodeURIComponent(activeProfile.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ skillPolicies: policies })
      });
      await onLibraryChanged();
      await onApplyProfile(result.profile.id, result.profile);
      onNotice(`已更新能力方案：${activeProfile.name}`, "success");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingCurrentProfile(false);
    }
  };

  useEffect(() => {
    if (focusedAgent && focusedAgent.name !== focusedName) setFocusedName(focusedAgent.name);
  }, [focusedAgent?.name, focusedName]);
  useEffect(() => { setHealthCheckStep(-1); }, [focusedAgent?.name, focusedPolicy]);
  useEffect(() => {
    if (healthCheckStep < 0 || healthCheckStep > 3 || !focusedAgent) return;
    const timer = window.setTimeout(() => {
      if (healthCheckStep < 3) setHealthCheckStep(healthCheckStep + 1);
      else {
        setHealthCheckStep(4);
        onNotice(`${focusedAgent.title} 配置检查完成`, focusedOrganization?.archivedAt || focusedPolicy === "off" ? "warning" : "success");
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [healthCheckStep, focusedAgent?.name, focusedOrganization?.archivedAt, focusedPolicy]);

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("blur", close); };
  }, []);

  const updateOrganization = async (skillNames: string[], folderId: string | null, archived?: boolean) => {
    if (!skillNames.length) return;
    try {
      await api("/api/skills/organization", { method: "PUT", body: JSON.stringify({ skillNames, folderId, ...(archived === undefined ? {} : { archived }) }) });
      await onLibraryChanged();
      setSelectedNames([]);
      onNotice(archived ? `已归档 ${skillNames.length} 个 Skill` : `已移动 ${skillNames.length} 个 Skill`, "success");
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error)); }
  };
  const createFolder = async () => {
    const name = window.prompt("新建 Skill 文件夹");
    if (!name?.trim()) return;
    try {
      const result = await api<{ folder: SkillFolder }>("/api/skill-folders", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      await onLibraryChanged();
      setCategory(`folder:${result.folder.id}`);
      onNotice(`已创建文件夹：${result.folder.name}`, "success");
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error)); }
  };
  const updateFolder = async (folder: SkillFolder, body: { name?: string; pinned?: boolean }) => {
    try {
      await api(`/api/skill-folders/${encodeURIComponent(folder.id)}`, { method: "PATCH", body: JSON.stringify(body) });
      await onLibraryChanged();
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error)); }
  };
  const deleteFolder = async (folder: SkillFolder) => {
    if (!await confirmAction(`删除文件夹「${folder.name}」？其中的 Skill 会回到“未分类”，不会被删除。`, { destructive: true })) return;
    try {
      await api(`/api/skill-folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" });
      if (category === `folder:${folder.id}`) setCategory("uncategorized");
      await onLibraryChanged();
      onNotice(`已删除文件夹：${folder.name}`, "success");
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error)); }
  };
  const dragNames = (agent: AgentProfile) => selectedSet.has(agent.name) ? selectedNames : [agent.name];
  const acceptDrop = (event: React.DragEvent, target: string, folderId: string | null, archived = false) => {
    event.preventDefault();
    setDragTarget("");
    let names: string[] = [];
    try { names = JSON.parse(event.dataTransfer.getData("application/x-workbench-skills") || "[]"); } catch { names = []; }
    void updateOrganization(names, folderId, archived);
  };
  const applyPolicyToNames = (names: string[], policy: SkillPolicy) => {
    const eligibleNames = policy === "manual" ? names.filter((name) => !agents.find((agent) => agent.name === name)?.builtIn) : names;
    if (!eligibleNames.length) return onNotice("系统内置 Skill 不支持手动模式", "warning");
    onPoliciesChange({ ...policies, ...Object.fromEntries(eligibleNames.map((name) => [name, policy])) });
    const skipped = names.length - eligibleNames.length;
    onNotice(`已将 ${eligibleNames.length} 个 Skill 设为${policy === "auto" ? "自动" : policy === "always" ? "始终" : policy === "manual" ? "手动" : "关闭"}${skipped ? `，跳过 ${skipped} 个系统内置 Skill` : ""}`, skipped ? "warning" : "success");
  };
  const applyBulkPolicy = (policy: SkillPolicy) => applyPolicyToNames(selectedNames, policy);
  const contextAgent = contextMenu ? agents.find((agent) => agent.name === contextMenu.name) : undefined;
  const contextSelectionNames = contextMenu?.names || [];
  const contextIsBulk = contextSelectionNames.length > 1;
  const contextAllArchived = contextSelectionNames.length > 0 && contextSelectionNames.every((name) => Boolean(organizationMap.get(name)?.archivedAt));
  const contextManualEligible = contextSelectionNames.some((name) => !agents.find((agent) => agent.name === name)?.builtIn);

  return <section className="content-view skill-library-view">
    <div className="section-heading agent-selection-heading"><div><span className="help-inline-heading"><h1>Skill 中心</h1><HelpButton topic="capability-profiles" /></span><p>管理当前工作区可供各 Agent 与任务编排调用的 Skill。</p></div><button type="button" className="primary" onClick={onImport}><Import size={16} />导入 Skill</button></div>
    <div className="capability-profile-panel">
      <div className="capability-profile-copy"><span><Layers3 size={16} /></span><div><strong>能力方案</strong><p>方案定义基础策略，单个 Skill 的调整作为当前工作区覆盖。</p></div></div>
      <div className="capability-profile-actions">
        <select aria-label="当前能力方案" value={activeProfileId || ""} onChange={async (event) => { try { await onApplyProfile(event.target.value || null); onNotice(event.target.value ? "已应用能力方案" : "已切换为自定义配置", "success"); } catch (error) { onNotice(error instanceof Error ? error.message : String(error)); } }}><option value="">自定义配置</option>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select>
        <button type="button" className="skill-profile-save-current" disabled={savingCurrentProfile || Boolean(activeProfile && profileOverrideCount === 0)} title={activeProfile ? profileOverrideCount ? `将 ${profileOverrideCount} 项调整保存到「${activeProfile.name}」` : "当前方案没有待保存调整" : "将当前 Skill 配置保存为新方案"} onClick={() => void saveCurrentProfile()}>{savingCurrentProfile ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}<span>{activeProfile ? "保存方案" : "保存当前方案"}</span></button>
        {activeProfile && <button type="button" title="编辑当前能力方案" onClick={() => setProfileEditor(activeProfile)}><Pencil size={14} /></button>}
        {activeProfile && profileOverrideCount > 0 && <button type="button" title={`清除 ${profileOverrideCount} 项工作区覆盖`} onClick={async () => { try { await onApplyProfile(activeProfile.id); onNotice("已清除工作区覆盖，恢复能力方案", "success"); } catch (error) { onNotice(error instanceof Error ? error.message : String(error)); } }}><RefreshCw size={14} /></button>}
        {activeProfile && <button type="button" title="删除当前能力方案" onClick={async () => { if (!await confirmAction(`删除能力方案「${activeProfile.name}」？当前工作区会保留现有有效策略。`, { destructive: true })) return; try { await api(`/api/capability-profiles/${encodeURIComponent(activeProfile.id)}`, { method: "DELETE" }); await onLibraryChanged(); onNotice("能力方案已删除，当前配置已保留", "success"); } catch (error) { onNotice(error instanceof Error ? error.message : String(error)); } }}><Trash2 size={14} /></button>}
        {activeProfile && <button type="button" className="primary" onClick={() => setProfileEditor("new")}><Plus size={14} />另存为</button>}
      </div>
    </div>
    <div className="agent-dispatch-panel">
      <div className="agent-dispatch-copy"><span><Sparkles size={16} /></span><div><strong>工作区 Skill 策略</strong><p>{autoCount} 个自动 · {alwaysCount} 个始终启用 · {manualCount} 个手动 · {agents.length - autoCount - alwaysCount - manualCount} 个关闭</p></div></div>
    </div>
    <div className="skill-library-layout">
      <aside className="skill-folder-sidebar">
        <header><strong>分类</strong><IconButton label="新建 Skill 文件夹" onClick={() => void createFolder()}><Plus size={15} /></IconButton></header>
        <nav className="skill-smart-folders">
          {([
            ["all", "全部 Skill", activeLibraryCount, <Box size={15} />],
            ["builtin", "系统内置", agents.filter((agent) => agent.builtIn && !organizationMap.get(agent.name)?.archivedAt).length, <ShieldCheck size={15} />],
            ["enabled", "当前已启用", agents.filter((agent) => !organizationMap.get(agent.name)?.archivedAt && (policies[agent.name] || "off") !== "off").length, <Sparkles size={15} />],
            ["uncategorized", "未分类", unclassifiedCount, <Folder size={15} />],
            ["archived", "归档", archivedCount, <Archive size={15} />]
          ] as Array<[Category, string, number, React.ReactNode]>).map(([id, label, count, icon]) => <button type="button" className={`${category === id ? "active" : ""} ${dragTarget === id ? "drag-over" : ""}`} onClick={() => setCategory(id)} onDragOver={(event) => { if (id === "uncategorized" || id === "archived") { event.preventDefault(); setDragTarget(id); } }} onDragLeave={() => setDragTarget("")} onDrop={(event) => id === "uncategorized" ? acceptDrop(event, id, null, false) : id === "archived" ? acceptDrop(event, id, null, true) : undefined} key={id}>{icon}<span>{label}</span><em>{count}</em></button>)}
        </nav>
        <div className="skill-folder-divider"><span>我的文件夹</span></div>
        <nav className="skill-custom-folders">
          {folders.map((folder) => <div className={`skill-folder-row ${category === `folder:${folder.id}` ? "active" : ""} ${dragTarget === folder.id ? "drag-over" : ""}`} key={folder.id} onDragOver={(event) => { event.preventDefault(); setDragTarget(folder.id); }} onDragLeave={() => setDragTarget("")} onDrop={(event) => acceptDrop(event, folder.id, folder.id, false)}>
            <button type="button" onClick={() => setCategory(`folder:${folder.id}`)}>{folder.pinned ? <Pin size={14} /> : <Folder size={14} />}<span>{folder.name}</span><em>{folderCount(folder.id)}</em></button>
            <div><IconButton label={folder.pinned ? `取消置顶：${folder.name}` : `置顶：${folder.name}`} onClick={() => void updateFolder(folder, { pinned: !folder.pinned })}><Pin size={12} /></IconButton><IconButton label={`重命名文件夹：${folder.name}`} onClick={() => { const name = window.prompt("重命名 Skill 文件夹", folder.name); if (name?.trim() && name.trim() !== folder.name) void updateFolder(folder, { name: name.trim() }); }}><Pencil size={12} /></IconButton><IconButton label={`删除文件夹：${folder.name}`} onClick={() => void deleteFolder(folder)}><Trash2 size={12} /></IconButton></div>
          </div>)}
          {!folders.length && <p>拖拽 Skill 前，请先新建文件夹。</p>}
        </nav>
      </aside>
      <div className="skill-library-main">
        <div className="agent-list-toolbar skill-library-toolbar">
          <span><strong>{categoryLabel}</strong> · {filteredAgents.length} 个{activeOptional ? ` · 扩展已启用 ${activeOptional}/${optionalAgents.length}` : ""}</span>
          <div className="skill-toolbar-actions"><label className="skill-sort"><span>排序</span><select value={sortMode} onChange={(event) => setSortMode(event.target.value as "name" | "policy")}><option value="name">名称</option><option value="policy">策略</option></select></label><button type="button" className={selectionMode ? "active" : ""} onClick={() => { setSelectionMode((current) => !current); setSelectedNames([]); setSelectionAnchorName(""); }} title="批量选择"><ListChecks size={14} /></button><label className="skill-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skill" aria-label="搜索 Skill" />{query && <button type="button" aria-label="清除搜索" title="清除搜索" onClick={() => setQuery("")}><X size={13} /></button>}</label></div>
        </div>
        {(selectionMode || selectedNames.length > 0) && <div className="skill-bulk-toolbar"><span>已选 {selectedNames.length} 个</span><button type="button" disabled={!selectedNames.length} onClick={() => applyBulkPolicy("auto")}><Sparkles size={13} />自动</button><button type="button" disabled={!selectedNames.length} onClick={() => applyBulkPolicy("always")}><Globe2 size={13} />始终</button><button type="button" disabled={!selectedNames.length} onClick={() => applyBulkPolicy("manual")}><AtSign size={13} />手动</button><button type="button" disabled={!selectedNames.length} onClick={() => applyBulkPolicy("off")}><CircleStop size={13} />关闭</button><select disabled={!selectedNames.length} value="" onChange={(event) => { if (event.target.value === "unclassified") void updateOrganization(selectedNames, null, false); else if (event.target.value) void updateOrganization(selectedNames, event.target.value, false); }}><option value="">移动到...</option><option value="unclassified">未分类</option>{folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select><button type="button" disabled={!selectedNames.length} onClick={() => void updateOrganization(selectedNames, null, true)}><Archive size={13} />归档</button></div>}
        <div className="skill-list">
          {filteredAgents.map((agent) => {
            const policy = policies[agent.name] || "off";
            const organization = organizationMap.get(agent.name);
            const folder = organization?.folderId ? folderMap.get(organization.folderId) : undefined;
            const selected = selectedSet.has(agent.name);
            return <article className={`skill-item agent-select-row ${selected ? "batch-selected" : ""} ${focusedAgent?.name === agent.name ? "focused" : ""} ${(selectionMode || selectedNames.length > 0) ? "selection-mode" : ""}`} key={agent.name} draggable onDragStart={(event) => { const names = dragNames(agent); event.dataTransfer.setData("application/x-workbench-skills", JSON.stringify(names)); event.dataTransfer.effectAllowed = "move"; }} onClick={(event) => selectSkill(agent, event)} onContextMenu={(event) => { event.preventDefault(); const names = selected ? selectedNames : [agent.name]; if (!selected) { setSelectedNames(names); setSelectionAnchorName(agent.name); } setFocusedName(agent.name); setContextMenu({ name: agent.name, names, x: event.clientX, y: event.clientY }); }}>
              <div className="skill-copy"><h3>{agent.title}{agent.builtIn && <span className="builtin-skill-badge">系统内置</span>}</h3><div className="skill-meta-line"><span><Folder size={10} />{folder?.name || (agent.builtIn ? "系统内置" : "未分类")}</span></div></div>
              <label className={`skill-card-policy-select ${policy}`} title={`${agent.title}：${policyLabel(policy)}`}>
                <i aria-hidden="true" />
                <span>{policyShortLabel(policy)}</span>
                <ChevronDown size={12} aria-hidden="true" />
                <select value={policy} aria-label={`${agent.title} 调用策略`} onChange={(event) => setPolicy(agent.name, event.target.value as SkillPolicy)}>
                  <option value="auto">自动</option>
                  <option value="always">始终</option>
                  {!agent.builtIn && <option value="manual">手动</option>}
                  <option value="off">关闭</option>
                </select>
              </label>
            </article>;
          })}
          {!agents.length && <div className="blank-state"><Sparkles size={25} /><h3>暂无可用 Skill</h3><p>点击“导入 Skill”，选择根目录包含 SKILL.md 的文件夹。</p></div>}
          {agents.length > 0 && !filteredAgents.length && <div className="blank-state skill-search-empty"><Search size={24} /><h3>当前分类没有匹配的 Skill</h3><button type="button" onClick={() => { setQuery(""); setCategory("all"); }}>查看全部</button></div>}
        </div>
      </div>
      <aside className="skill-detail-panel" aria-label="Skill 详情">
        {focusedAgent ? <>
          <header><div className="skill-detail-mark"><Box size={20} /></div><div><strong>{focusedAgent.title}</strong><code>{focusedAgent.name}</code></div>{focusedAgent.builtIn && <span>内置</span>}</header>
          <p>{focusedAgent.description || "这个 Skill 暂无用途说明。"}</p>
          <section><h3>调用策略</h3><div className="skill-detail-policy agent-policy-segments" role="radiogroup" aria-label={`${focusedAgent.title} 调度策略`}>
            <button type="button" role="radio" aria-checked={focusedPolicy === "auto"} className={focusedPolicy === "auto" ? "active" : ""} onClick={() => setPolicy(focusedAgent.name, "auto")}><Sparkles size={12} />自动</button>
            <button type="button" role="radio" aria-checked={focusedPolicy === "always"} className={focusedPolicy === "always" ? "active" : ""} onClick={() => setPolicy(focusedAgent.name, "always")}><Globe2 size={12} />始终</button>
            {!focusedAgent.builtIn && <button type="button" role="radio" aria-checked={focusedPolicy === "manual"} className={focusedPolicy === "manual" ? "active" : ""} onClick={() => setPolicy(focusedAgent.name, "manual")}><AtSign size={12} />手动</button>}
            <button type="button" role="radio" aria-checked={focusedPolicy === "off"} className={focusedPolicy === "off" ? "active" : ""} onClick={() => setPolicy(focusedAgent.name, "off")}><CircleStop size={12} />关闭</button>
          </div></section>
          <section className="skill-health-section"><button type="button" className={`skill-health-strip ${healthCheckStep >= 0 && healthCheckStep < 4 ? "checking" : ""}`} disabled={healthCheckStep >= 0 && healthCheckStep < 4} onClick={() => setHealthCheckStep(0)}>
            <RefreshCw size={14} />
            <span><strong>配置检查</strong><small>{healthCheckStep === 0 ? "正在检查资源索引" : healthCheckStep === 1 ? `正在检查来源：${focusedAgent.builtIn ? "工作台内置" : "用户安装目录"}` : healthCheckStep === 2 ? `正在检查可见性：${focusedOrganization?.archivedAt ? "已归档" : focusedFolder ? focusedFolder.name : "正常"}` : healthCheckStep === 3 ? `正在检查调度状态：${policyLabel(focusedPolicy)}` : healthCheckStep === 4 ? (focusedOrganization?.archivedAt || focusedPolicy === "off" ? "检查完成，有 1 项提醒" : "检查完成，4 项通过") : "检查索引、来源、可见性与调度状态"}</small></span>
            {healthCheckStep === 4 ? <Check size={14} /> : <ChevronRight size={14} />}
          </button></section>
          <footer><button type="button" onClick={() => void onOpenFolder(focusedAgent)}><FolderOpen size={14} />打开目录</button><button type="button" onClick={async () => { const displayName = window.prompt("输入 Skill 显示名", focusedAgent.title); if (displayName !== null && displayName.trim() !== focusedAgent.title) await onRename(focusedAgent, displayName.trim()); }}><Pencil size={14} />重命名</button>{!focusedAgent.builtIn && <button type="button" className="danger" onClick={() => onDelete(focusedAgent)}><Trash2 size={14} />删除</button>}</footer>
        </> : <div className="skill-detail-empty"><Box size={22} /><strong>选择一个 Skill</strong><span>查看作用域、策略和配置状态</span></div>}
      </aside>
    </div>
    {contextMenu && contextAgent && <div className="skill-context-menu" style={{ left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 228)), top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 420)) }} onClick={(event) => event.stopPropagation()}><strong>{contextAgent.title}</strong><button type="button" onClick={() => { void onOpenFolder(contextAgent); setContextMenu(null); }}><FolderOpen size={14} />打开目录</button><button type="button" onClick={() => { const displayName = window.prompt("输入 Skill 显示名", contextAgent.title); if (displayName?.trim() && displayName.trim() !== contextAgent.title) void onRename(contextAgent, displayName.trim()); setContextMenu(null); }}><Pencil size={14} />重命名</button><div className="skill-context-divider" /><small>移动到</small><button type="button" onClick={() => { void updateOrganization([contextAgent.name], null, false); setContextMenu(null); }}><Folder size={14} />未分类</button>{folders.map((folder) => <button type="button" key={folder.id} onClick={() => { void updateOrganization([contextAgent.name], folder.id, false); setContextMenu(null); }}><Folder size={14} />{folder.name}</button>)}<div className="skill-context-divider" />{organizationMap.get(contextAgent.name)?.archivedAt ? <button type="button" onClick={() => { void updateOrganization([contextAgent.name], organizationMap.get(contextAgent.name)?.folderId || null, false); setContextMenu(null); }}><ArchiveRestore size={14} />移出归档</button> : <button type="button" onClick={() => { void updateOrganization([contextAgent.name], null, true); setContextMenu(null); }}><Archive size={14} />归档</button>}{!contextAgent.builtIn && <button type="button" className="danger" onClick={() => { onDelete(contextAgent); setContextMenu(null); }}><Trash2 size={14} />删除 Skill</button>}</div>}
    {profileEditor && <CapabilityProfileDialog key={profileEditor === "new" ? "new" : profileEditor.id} profile={profileEditor === "new" ? undefined : profileEditor} agents={agents} initialPolicies={policies} onClose={() => setProfileEditor(null)} onSaved={async (saved) => { const created = profileEditor === "new"; setProfileEditor(null); await onLibraryChanged(); await onApplyProfile(saved.id, saved); onNotice(created ? `已创建并应用能力方案：${saved.name}` : `已更新能力方案：${saved.name}`, "success"); }} />}
  </section>;
}

function parseConfigLines(value: string) {
  return Object.fromEntries(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`配置项格式错误：${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1)];
  }));
}

function McpView({ servers, workspaces, activeWorkspaceId, onChanged, onNotice }: { servers: McpServer[]; workspaces: Workspace[]; activeWorkspaceId: string; onChanged: () => Promise<void>; onNotice: (message: string, tone?: NoticeTone) => void }) {
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  const [busyId, setBusyId] = useState("");
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  const enabledCount = servers.filter((server) => activeWorkspaceId && server.enabledWorkspaceIds.includes(activeWorkspaceId)).length;

  const updateWorkspace = async (server: McpServer, enabled: boolean) => {
    if (!activeWorkspaceId) return;
    setBusyId(server.id);
    try {
      await api(`/api/mcp/${encodeURIComponent(server.id)}/workspaces/${encodeURIComponent(activeWorkspaceId)}`, { method: "PUT", body: JSON.stringify({ enabled }) });
      await onChanged();
      onNotice(enabled ? `已为当前工作区启用 ${server.name}` : `已为当前工作区关闭 ${server.name}`, "success");
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusyId(""); }
  };

  const test = async (server: McpServer) => {
    if (!activeWorkspaceId) return onNotice("请先选择工作区", "warning");
    setBusyId(server.id);
    try {
      const result = await api<{ ok: boolean; output: string }>(`/api/mcp/${encodeURIComponent(server.id)}/test`, { method: "POST", body: JSON.stringify({ workspaceId: activeWorkspaceId }), timeoutMs: 55_000 });
      setTestResults((current) => ({ ...current, [server.id]: { ok: result.ok, text: result.output || (result.ok ? "连接成功" : "连接失败") } }));
      onNotice(result.ok ? `${server.name} 连接成功` : `${server.name} 连接失败`, result.ok ? "success" : "warning");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTestResults((current) => ({ ...current, [server.id]: { ok: false, text: message } }));
      onNotice(message);
    } finally { setBusyId(""); }
  };

  return <section className="content-view mcp-view">
    <div className="section-heading"><div><span className="help-inline-heading"><h1>MCP 管理</h1><HelpButton topic="mcp" /></span><p>连接外部工具和数据源；配置由工作台托管，并按工作区注入支持 MCP 的 Agent。</p></div><button type="button" className="primary" onClick={() => setEditing("new")}><Plus size={16} />添加 MCP</button></div>
    <div className="mcp-summary"><div><span><Plug size={17} /></span><div><strong>{activeWorkspace ? activeWorkspace.name : "尚未选择工作区"}</strong><p>{servers.length} 个 MCP · 当前启用 {enabledCount} 个</p></div></div><small>各 Agent 按自身能力与连接配置使用 MCP</small></div>
    <div className="mcp-list">
      {servers.map((server) => {
        const enabled = Boolean(activeWorkspaceId && server.enabledWorkspaceIds.includes(activeWorkspaceId));
        const result = testResults[server.id];
        return <article className={`mcp-item ${enabled ? "enabled" : ""}`} key={server.id}>
          <div className="mcp-item-icon"><Plug size={18} /></div>
          <div className="mcp-item-copy"><div className="mcp-item-title"><strong>{server.name}</strong><span>{server.transport.toUpperCase()}</span></div><code>{server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url}</code>{(server.envKeys.length > 0 || server.headerKeys.length > 0) && <small>{server.envKeys.length ? `环境变量：${server.envKeys.join(", ")}` : ""}{server.envKeys.length && server.headerKeys.length ? " · " : ""}{server.headerKeys.length ? `请求头：${server.headerKeys.join(", ")}` : ""}</small>}{result && <pre className={result.ok ? "success" : "error"}>{result.text}</pre>}</div>
          <div className="mcp-item-actions"><label className="mcp-workspace-toggle"><span>{enabled ? "当前工作区已启用" : "当前工作区已关闭"}</span><button type="button" className="agent-switch" role="switch" aria-checked={enabled} disabled={!activeWorkspaceId || busyId === server.id} onClick={() => void updateWorkspace(server, !enabled)}><span /></button></label><div><button type="button" disabled={!activeWorkspaceId || busyId === server.id} onClick={() => void test(server)}>{busyId === server.id ? <LoaderCircle className="spin" size={14} /> : <Activity size={14} />}测试</button><IconButton label={`编辑 MCP：${server.name}`} onClick={() => setEditing(server)}><Pencil size={14} /></IconButton><IconButton label={`删除 MCP：${server.name}`} onClick={async () => { if (!await confirmAction(`删除 MCP「${server.name}」？`, { destructive: true })) return; try { await api(`/api/mcp/${encodeURIComponent(server.id)}`, { method: "DELETE" }); await onChanged(); onNotice(`已删除 MCP：${server.name}`, "success"); } catch (error) { onNotice(error instanceof Error ? error.message : String(error)); } }}><Trash2 size={14} /></IconButton></div></div>
        </article>;
      })}
      {!servers.length && <div className="blank-state"><Plug size={25} /><h3>尚未配置 MCP</h3><p>添加 stdio、HTTP 或 SSE MCP，并为需要的工作区单独启用。</p></div>}
    </div>
    {editing && <McpDialog server={editing === "new" ? undefined : editing} workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onClose={() => setEditing(null)} onDone={async () => { setEditing(null); await onChanged(); onNotice(editing === "new" ? "MCP 已添加" : "MCP 配置已更新", "success"); }} />}
  </section>;
}

function McpDialog({ server, workspaces, activeWorkspaceId, onClose, onDone }: { server?: McpServer; workspaces: Workspace[]; activeWorkspaceId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState(server?.name || "");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">(server?.transport || "stdio");
  const [command, setCommand] = useState(server?.command || "");
  const [args, setArgs] = useState((server?.args || []).join("\n"));
  const [url, setUrl] = useState(server?.url || "");
  const [env, setEnv] = useState("");
  const [headers, setHeaders] = useState("");
  const [workspaceIds, setWorkspaceIds] = useState<string[]>(server?.enabledWorkspaceIds || (activeWorkspaceId ? [activeWorkspaceId] : []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return <Dialog title={server ? `编辑 MCP · ${server.name}` : "添加 MCP"} onClose={onClose}>
    <div className="form-grid mcp-form">
      <div className="mcp-transport-tabs" role="radiogroup" aria-label="MCP 传输方式">{(["stdio", "http", "sse"] as const).map((item) => <button type="button" role="radio" aria-checked={transport === item} className={transport === item ? "active" : ""} onClick={() => setTransport(item)} key={item}>{item.toUpperCase()}</button>)}</div>
      <label><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="playwright" autoFocus /></label>
      {transport === "stdio" ? <><label><span>启动命令</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" /></label><label><span>参数（每行一个）</span><textarea value={args} onChange={(event) => setArgs(event.target.value)} placeholder={'-y\n@playwright/mcp@latest'} /></label><label><span>环境变量（KEY=value，每行一个）</span><textarea value={env} onChange={(event) => setEnv(event.target.value)} placeholder={server?.envKeys.length ? `留空保留现有键：${server.envKeys.join(", ")}` : "API_KEY=..."} /></label></> : <><label><span>服务地址</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" /></label><label><span>请求头（KEY=value，每行一个）</span><textarea value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder={server?.headerKeys.length ? `留空保留现有键：${server.headerKeys.join(", ")}` : "Authorization=Bearer ..."} /></label></>}
      <fieldset className="mcp-workspace-fieldset"><legend>启用工作区</legend>{workspaces.map((workspace) => <label className="check-row" key={workspace.id}><input type="checkbox" checked={workspaceIds.includes(workspace.id)} onChange={(event) => setWorkspaceIds((current) => event.target.checked ? [...new Set([...current, workspace.id])] : current.filter((id) => id !== workspace.id))} /><span>{workspace.name}</span></label>)}</fieldset>
      {error && <p className="form-error">{error}</p>}
    </div>
    <div className="dialog-actions"><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={saving} onClick={async () => {
      setSaving(true); setError("");
      try {
        const body: Record<string, unknown> = { name, transport, command, args: args.split(/\r?\n/).map((item) => item.trim()).filter(Boolean), url };
        if (!server || env.trim()) body.env = parseConfigLines(env);
        if (!server || headers.trim()) body.headers = parseConfigLines(headers);
        if (!server) body.workspaceIds = workspaceIds;
        const result = await api<{ server: McpServer }>(server ? `/api/mcp/${encodeURIComponent(server.id)}` : "/api/mcp", { method: server ? "PATCH" : "POST", body: JSON.stringify(body) });
        if (server) {
          const previous = new Set(server.enabledWorkspaceIds);
          const desired = new Set(workspaceIds);
          for (const workspace of workspaces) if (previous.has(workspace.id) !== desired.has(workspace.id)) await api(`/api/mcp/${encodeURIComponent(result.server.id)}/workspaces/${encodeURIComponent(workspace.id)}`, { method: "PUT", body: JSON.stringify({ enabled: desired.has(workspace.id) }) });
        }
        await onDone();
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setSaving(false); }
    }}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{server ? "保存" : "添加"}</button></div>
  </Dialog>;
}

function SettingsView({
  initialSection,
  settings,
  dataHome,
  codexHome,
  claudeHome,
  codexRuntime,
  claudeRuntime,
  providers,
  providerControls,
  providerTab,
  onProviderChange,
  onSettingsChanged,
  onResetTabs,
  onResetLayout,
  onOpenSession,
  onOpenWorkflow,
  onNotice,
  onChanged
}: {
  initialSection: SettingsSectionName;
  settings: SettingsData;
  dataHome: string;
  codexHome: string;
  claudeHome: string;
  codexRuntime: CodexRuntimeStatus;
  claudeRuntime: CodexRuntimeStatus;
  providers: AgentProviderDescriptor[];
  providerControls: ProviderControlSnapshot[];
  providerTab: EngineName;
  onProviderChange: (provider: EngineName) => void;
  onSettingsChanged: (settings: SettingsData) => void;
  onResetTabs: () => void;
  onResetLayout: () => void;
  onOpenSession: (id: string) => void;
  onOpenWorkflow: (id: string) => void;
  onNotice: (message: string, tone?: "success" | "warning" | "error") => void;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<SettingsFormData>(() => settingsFormData(settings));
  const [saveState, setSaveState] = useState<"clean" | "dirty" | "saving" | "saved" | "error">("clean");
  const [saveError, setSaveError] = useState("");
  const formDirtyRef = useRef(false);
  const [runtime, setRuntime] = useState(codexRuntime);
  const [claudeRuntimeState, setClaudeRuntimeState] = useState(claudeRuntime);
  const [runtimeCatalog, setRuntimeCatalog] = useState<CliRuntimeCatalogItem[]>([
    { id: "claude", label: "Claude CLI", status: claudeRuntime },
    { id: "codex", label: "Codex CLI", status: codexRuntime }
  ]);
  const [additionalRuntimeNotices, setAdditionalRuntimeNotices] = useState<Record<CliRuntimeId, string>>({});
  const [checkingCodexRuntime, setCheckingCodexRuntime] = useState(false);
  const [installingCodexRuntime, setInstallingCodexRuntime] = useState(false);
  const [codexRuntimeNotice, setCodexRuntimeNotice] = useState("");
  const [checkingClaudeRuntime, setCheckingClaudeRuntime] = useState(false);
  const [installingClaudeRuntime, setInstallingClaudeRuntime] = useState(false);
  const [claudeRuntimeNotice, setClaudeRuntimeNotice] = useState("");
  const [runtimeSourceChecks, setRuntimeSourceChecks] = useState<Partial<Record<CliRuntimeId, { selected: string; version: string; probes: RuntimeSourceProbe[] }>>>({});
  const [runtimeUpdates, setRuntimeUpdates] = useState<Partial<Record<CliRuntimeId, RuntimeUpdateStatus>>>({});
  const [checkingRuntimeSources, setCheckingRuntimeSources] = useState(false);
  const [checkingRuntimeUpdates, setCheckingRuntimeUpdates] = useState<Record<CliRuntimeId, boolean>>({ codex: false, claude: false });
  const [codexModels, setCodexModels] = useState<ModelOption[]>([]);
  const [claudeModels, setClaudeModels] = useState<ModelOption[]>([]);
  const [detectingCodexModels, setDetectingCodexModels] = useState(false);
  const [detectingClaudeModels, setDetectingClaudeModels] = useState(false);
  const [codexModelNotice, setCodexModelNotice] = useState("");
  const [claudeModelNotice, setClaudeModelNotice] = useState("");
  const [settingsSection, setSettingsSection] = useState<SettingsSectionName>(initialSection);
  const [aiSettingsPage, setAiSettingsPage] = useState<AgentSettingsPage>("providers");
  const [runtimeInstallFeeds, setRuntimeInstallFeeds] = useState<Record<CliRuntimeId, { progress: RuntimeInstallProgress | null; events: RuntimeInstallProgress[] }>>({
    codex: { progress: null, events: [] },
    claude: { progress: null, events: [] }
  });
  const runtimeProgressOrderRef = useRef<Record<CliRuntimeId, { operationId: string; sequence: number; updatedAt: number }>>({});
  const [, setRuntimeClock] = useState(0);
  useEffect(() => setSettingsSection(initialSection), [initialSection]);
  useEffect(() => setRuntime(codexRuntime), [codexRuntime]);
  useEffect(() => setClaudeRuntimeState(claudeRuntime), [claudeRuntime]);
  useEffect(() => {
    if (formDirtyRef.current) return;
    setForm(settingsFormData(settings));
  }, [settings]);
  const setRuntimeStatus = (runtimeId: CliRuntimeId, status: CodexRuntimeStatus) => {
    if (runtimeId === "codex") setRuntime(status);
    else if (runtimeId === "claude") setClaudeRuntimeState(status);
    setRuntimeCatalog((current) => current.map((item) => item.id === runtimeId ? { ...item, status } : item));
  };
  const setRuntimeNotice = (runtimeId: CliRuntimeId, message: string) => {
    if (runtimeId === "codex") setCodexRuntimeNotice(message);
    else if (runtimeId === "claude") setClaudeRuntimeNotice(message);
    else setAdditionalRuntimeNotices((current) => ({ ...current, [runtimeId]: message }));
  };
  const runtimeNotice = (runtimeId: CliRuntimeId) => runtimeId === "codex" ? codexRuntimeNotice : runtimeId === "claude" ? claudeRuntimeNotice : additionalRuntimeNotices[runtimeId] || "";
  useEffect(() => {
    let disposed = false;
    void api<{ items: CliRuntimeCatalogItem[] }>("/api/cli-runtimes").then(({ items }) => {
      if (disposed) return;
      setRuntimeCatalog(items);
      setForm((current) => ({
        ...current,
        runtime: {
          ...current.runtime,
          selections: Object.fromEntries(items.map((item) => [item.id, current.runtime.selections[item.id] || { mode: "system", systemPath: "", customPath: "" }]))
        }
      }));
    }).catch(() => { /* Initial Claude/Codex status remains available. */ });
    return () => { disposed = true; };
  }, []);
  const recordRuntimeProgress = (progress: RuntimeInstallProgress) => {
    const updatedAt = new Date(progress.updatedAt).getTime();
    const operationId = progress.operationId || `${progress.runtimeId}:${progress.startedAt}`;
    const sequence = Number(progress.sequence) || 0;
    const previousOrder = runtimeProgressOrderRef.current[progress.runtimeId];
    if (previousOrder?.operationId === operationId) {
      if (sequence && previousOrder.sequence && sequence <= previousOrder.sequence) return;
      if (!sequence && Number.isFinite(updatedAt) && updatedAt < previousOrder.updatedAt) return;
    } else if (previousOrder && Date.parse(progress.startedAt) < previousOrder.updatedAt) return;
    runtimeProgressOrderRef.current[progress.runtimeId] = { operationId, sequence, updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now() };
    setRuntimeInstallFeeds((current) => {
      const previous = current[progress.runtimeId] || { progress: null, events: [] };
      const sameOperation = previous.progress?.startedAt === progress.startedAt;
      const rawEvents = sameOperation ? previous.events : [];
      const events = rawEvents.filter((item, index) => index === rawEvents.length - 1 || rawEvents[index + 1].phase !== item.phase);
      const lastEvent = events.at(-1);
      const nextEvents = lastEvent?.phase === progress.phase
        ? [...events.slice(0, -1), progress]
        : [...events, progress].slice(-8);
      return {
        ...current,
        [progress.runtimeId]: { progress, events: nextEvents }
      };
    });
    if (progress.runtimeId === "codex") {
      setInstallingCodexRuntime(progress.active);
      setCodexRuntimeNotice(progress.message);
    } else if (progress.runtimeId === "claude") {
      setInstallingClaudeRuntime(progress.active);
      setClaudeRuntimeNotice(progress.message);
    } else setRuntimeNotice(progress.runtimeId, progress.message);
    if (!progress.active) {
      void onChanged();
      if (progress.phase === "activated") void (async () => {
        try {
          const status = await api<CodexRuntimeStatus>(`/api/runtime/${progress.runtimeId}/status`);
          setRuntimeStatus(progress.runtimeId, status);
          if (status.selectionMode) setForm((current) => ({ ...current, runtime: { ...current.runtime, selections: { ...current.runtime.selections, [progress.runtimeId]: { mode: status.selectionMode!, customPath: "", systemPath: "" } } } }));
          const update = await api<RuntimeUpdateStatus>(`/api/runtime/${progress.runtimeId}/check-update`, { method: "POST", timeoutMs: 60_000 });
          setRuntimeUpdates((current) => ({ ...current, [progress.runtimeId]: update }));
        } catch { /* The persisted completion remains visible if refresh fails. */ }
      })();
    }
  };
  useEffect(() => {
    let disposed = false;
    Promise.all(runtimeCatalog.map(async ({ id: runtimeId }) => {
      try {
        const result = await api<{ progress: RuntimeInstallProgress | null }>(`/api/runtime/${runtimeId}/install-status`);
        if (!disposed && result.progress) recordRuntimeProgress(result.progress);
      } catch { /* Settings may be visible before an owner session is restored. */ }
    }));
    const listener = (detail: Record<string, unknown>) => {
      const progress = detail as RuntimeInstallProgress;
      if (!disposed && progress) recordRuntimeProgress(progress);
    };
    const unsubscribe = realtimeCoordinator.subscribe("runtime.install", listener);
    return () => { disposed = true; unsubscribe(); };
  }, [runtimeCatalog.map((item) => item.id).join("|")]);
  useEffect(() => {
    const activeRuntimeIds = Object.entries(runtimeInstallFeeds).filter(([, feed]) => feed.progress?.active).map(([runtimeId]) => runtimeId);
    if (!activeRuntimeIds.length) return;
    let syncing = false;
    const syncActiveInstalls = async () => {
      if (syncing || document.hidden) return;
      syncing = true;
      try {
        await Promise.all(activeRuntimeIds.map(async (runtimeId) => {
          try {
            const result = await api<{ progress: RuntimeInstallProgress | null }>(`/api/runtime/${runtimeId}/install-status`);
            if (result.progress) recordRuntimeProgress(result.progress);
          } catch { /* SSE remains the fast path while a transient poll fails. */ }
        }));
      } finally { syncing = false; }
    };
    const tick = () => {
      setRuntimeClock((value) => value + 1);
      void syncActiveInstalls();
    };
    const timer = window.setInterval(tick, 1_000);
    const onVisibilityChange = () => { if (!document.hidden) void syncActiveInstalls(); };
    const unsubscribeReconcile = realtimeCoordinator.subscribeReconcile(() => void syncActiveInstalls());
    document.addEventListener("visibilitychange", onVisibilityChange);
    void syncActiveInstalls();
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unsubscribeReconcile();
    };
  }, [Object.entries(runtimeInstallFeeds).filter(([, feed]) => feed.progress?.active).map(([runtimeId]) => runtimeId).join("|")]);
  const markSettingsDirty = () => {
    formDirtyRef.current = true;
    setSaveError("");
    setSaveState("dirty");
  };
  const update = (key: string, value: unknown) => {
    markSettingsDirty();
    setForm((current) => ({ ...current, [key]: value }));
  };
  const updateClaude = (key: string, value: unknown) => {
    markSettingsDirty();
    setForm((current) => ({ ...current, claude: { ...current.claude, [key]: value } }));
  };
  const updatePagePreferences = (workspaceBrowser: WorkbenchInterfaceSettings["workspaceBrowser"]) => {
    markSettingsDirty();
    setForm((current) => ({ ...current, interface: { ...current.interface, workspaceBrowser } }));
  };
  const updateRuntimeNetwork = (key: string, value: unknown) => {
    markSettingsDirty();
    setForm((current) => ({ ...current, runtime: { ...current.runtime, network: { ...current.runtime.network, [key]: value } } }));
  };
  const updateRuntimeSelection = (runtimeId: CliRuntimeId, next: Partial<RuntimeConfiguration["selections"][CliRuntimeId]>) => {
    markSettingsDirty();
    setForm((current) => ({
      ...current,
      runtime: { ...current.runtime, selections: { ...current.runtime.selections, [runtimeId]: { ...(current.runtime.selections[runtimeId] || { mode: "system", systemPath: "", customPath: "" }), ...next } } }
    }));
  };
  const persistRuntimeConfiguration = async (configuration = form.runtime) => {
    const result = await api<{ configuration: RuntimeConfiguration }>("/api/runtime/network", { method: "PATCH", body: JSON.stringify(configuration.network) });
    setForm((current) => ({ ...current, runtime: result.configuration }));
    onChanged();
    return result;
  };
  const persistRuntimeSelection = async (runtimeId: CliRuntimeId, selection: RuntimeConfiguration["selections"][CliRuntimeId]) => {
    const result = await api<{ configuration: RuntimeConfiguration; status: CodexRuntimeStatus }>(`/api/runtime/${runtimeId}/selection`, { method: "PATCH", body: JSON.stringify(selection) });
    setForm((current) => ({ ...current, runtime: result.configuration }));
    setRuntimeStatus(runtimeId, result.status);
    setRuntimeUpdates((current) => ({ ...current, [runtimeId]: undefined }));
    onChanged();
    return result;
  };
  const chooseRuntime = async (runtimeId: CliRuntimeId, mode: RuntimeUseMode) => {
    const selection = form.runtime.selections[runtimeId];
    if (mode === "custom" && !selection.customPath.trim()) {
      const notice = "请先填写要使用的 CLI 路径";
      setRuntimeNotice(runtimeId, notice);
      return;
    }
    try {
      await persistRuntimeSelection(runtimeId, { ...selection, mode });
      const notice = mode === "managed" ? "已切换到工作台托管模式" : mode === "system" ? "已切换到系统 CLI，工作台数据保持隔离" : "指定路径已验证并启用，工作台数据保持隔离";
      setRuntimeNotice(runtimeId, notice);
    } catch (error) {
      const notice = error instanceof Error ? error.message : String(error);
      setRuntimeNotice(runtimeId, notice);
    }
  };
  const checkRuntimeSources = async () => {
    setCheckingRuntimeSources(true);
    try {
      await persistRuntimeConfiguration();
      const entries = await Promise.all(runtimeCatalog.filter((item) => item.capabilities?.sourceProbe !== false).map(async ({ id: runtimeId }) => [runtimeId, await api<{ selected: string; version: string; probes: RuntimeSourceProbe[] }>(`/api/runtime/${runtimeId}/sources`, { method: "POST", body: JSON.stringify({ version: "latest" }), timeoutMs: 60_000 })] as const));
      setRuntimeSourceChecks(Object.fromEntries(entries));
    } catch (error) {
      setClaudeRuntimeNotice(error instanceof Error ? error.message : String(error));
    } finally { setCheckingRuntimeSources(false); }
  };
  const checkRuntimeUpdate = async (runtimeId: CliRuntimeId) => {
    setCheckingRuntimeUpdates((current) => ({ ...current, [runtimeId]: true }));
    try {
      const result = await api<RuntimeUpdateStatus>(`/api/runtime/${runtimeId}/check-update`, { method: "POST", timeoutMs: 60_000 });
      setRuntimeUpdates((current) => ({ ...current, [runtimeId]: result }));
      setRuntimeNotice(runtimeId, result.state === "latest" ? "当前托管版本已经是最新版" : result.state === "available" ? `发现新版本 ${result.latestVersion}` : result.state === "not-installed" ? `可以安装 ${result.latestVersion}` : result.state === "newer-local" ? "当前托管版本高于公开最新版" : `公开最新版为 ${result.latestVersion}，外部 CLI 不会由工作台修改`);
    } catch (error) { setRuntimeNotice(runtimeId, error instanceof Error ? error.message : String(error)); }
    finally { setCheckingRuntimeUpdates((current) => ({ ...current, [runtimeId]: false })); }
  };
  const save = async () => {
    if (saveState === "saving") return;
    setSaveState("saving");
    setSaveError("");
    try {
      const updated = await api<SettingsData>("/api/settings", { method: "PUT", body: JSON.stringify(settingsSavePayload(form)) });
      formDirtyRef.current = false;
      setForm(settingsFormData(updated));
      onSettingsChanged(updated);
      setSaveState("saved");
      window.setTimeout(() => setSaveState((current) => current === "saved" ? "clean" : current), 1800);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      setSaveState("error");
    }
  };
  const startRuntimeInstall = async (runtimeId: CliRuntimeId, repair = false) => {
    if (!await confirmAction(repair ? "重新安装托管 CLI，保留账号配置和任务数据。" : "安装完成后将使用工作台托管的 CLI，现有系统安装保持不变。", { title: repair ? "修复 CLI" : "安装 CLI", confirmLabel: repair ? "重新安装" : "开始安装" })) return;
    if (runtimeId === "codex") { setInstallingCodexRuntime(true); setCodexRuntimeNotice("正在提交安装任务"); }
    else if (runtimeId === "claude") { setInstallingClaudeRuntime(true); setClaudeRuntimeNotice("正在提交安装任务"); }
    else setRuntimeNotice(runtimeId, "正在提交安装任务");
    try {
      const version = runtimeUpdates[runtimeId]?.latestVersion;
      const result = await api<{ accepted: boolean; progress: RuntimeInstallProgress | null }>(`/api/runtime/${runtimeId}/install`, { method: "POST", body: JSON.stringify({ version, repair }) });
      if (result.progress) recordRuntimeProgress(result.progress);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runtimeId === "codex") { setInstallingCodexRuntime(false); setCodexRuntimeNotice(message); }
      else if (runtimeId === "claude") { setInstallingClaudeRuntime(false); setClaudeRuntimeNotice(message); }
      else setRuntimeNotice(runtimeId, message);
    }
  };
  const runtimeProgressPanel = (runtimeId: CliRuntimeId) => {
    const feed = runtimeInstallFeeds[runtimeId] || { progress: null, events: [] };
    const progress = feed.progress;
    if (!progress) return null;
    const elapsed = formatRuntimeProgressDuration(runtimeProgressElapsedMs(progress));
    const ratio = progress.totalBytes && progress.downloadedBytes !== undefined ? Math.min(100, Math.max(0, progress.downloadedBytes / progress.totalBytes * 100)) : null;
    const speed = progress.bytesPerSecond ? progress.bytesPerSecond >= 1024 * 1024 ? `${(progress.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s` : `${(progress.bytesPerSecond / 1024).toFixed(1)} KB/s` : "";
    return <div className={`runtime-install-progress wide ${progress.phase}`} aria-live="polite">
      <div className="runtime-install-progress-head"><span>{progress.active ? <LoaderCircle className="spin" size={14} /> : progress.phase === "activated" ? <Check size={14} /> : <X size={14} />}<strong>{progress.message}</strong></span><small><Clock3 size={12} />{elapsed}</small></div>
      {progress.active && <div className={`runtime-install-track ${ratio === null ? "indeterminate" : ""}`} role="progressbar" aria-label={`${runtimeId} CLI 安装进行中`} aria-valuenow={ratio === null ? undefined : Math.round(ratio)}><span style={ratio === null ? undefined : { width: `${ratio}%` }} /></div>}
      {(progress.registry || speed || progress.resumable) && <div className="runtime-install-meta">{progress.registry && <span>{new URL(progress.registry).host}</span>}{speed && <span>{speed}</span>}{progress.resumable && <span>支持断点继续</span>}</div>}
      <ol>{feed.events.map((item) => <li key={`${item.phase}-${item.updatedAt}`} className={item.phase}><time>{new Date(item.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><span>{item.message}</span></li>)}</ol>
    </div>;
  };
  const discoverCodexModels = async () => {
    setDetectingCodexModels(true);
    setCodexModelNotice("");
    try {
      const result = await api<{ models: ModelOption[]; endpoint: string }>("/api/runtime/codex/models", {
        method: "POST",
        body: JSON.stringify({ baseUrl: form.baseUrl, apiKey: form.apiKey })
      });
      setCodexModels(result.models);
      const currentModel = form.model.trim();
      const suggestedModel = result.models.some((item) => item.id === currentModel)
        ? currentModel
        : result.models.find((item) => /(?:^|[-_.])(gpt|codex|o\d)/i.test(item.id))?.id || result.models[0]?.id || "";
      if (suggestedModel && suggestedModel !== currentModel) update("model", suggestedModel);
      setCodexModelNotice(`已发现 ${result.models.length} 个模型${suggestedModel ? `，已选择 ${suggestedModel}` : ""}`);
    } catch (error) {
      setCodexModelNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setDetectingCodexModels(false);
    }
  };
  const discoverClaudeModels = async () => {
    setDetectingClaudeModels(true);
    setClaudeModelNotice("");
    try {
      const result = await api<{ models: ModelOption[]; endpoint: string }>("/api/runtime/claude/models", {
        method: "POST",
        body: JSON.stringify({ baseUrl: form.claude.baseUrl, apiKey: form.claude.apiKey })
      });
      setClaudeModels(result.models);
      const currentModel = form.claude.model.trim();
      const suggestedModel = result.models.some((item) => item.id === currentModel)
        ? currentModel
        : result.models.find((item) => /claude/i.test(item.id))?.id || result.models[0]?.id || "";
      if (suggestedModel && suggestedModel !== currentModel) updateClaude("model", suggestedModel);
      setClaudeModelNotice(`已发现 ${result.models.length} 个模型${suggestedModel ? `，已选择 ${suggestedModel}` : ""}`);
    } catch (error) {
      setClaudeModelNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setDetectingClaudeModels(false);
    }
  };
  const runtimeChoicePanel = (runtimeId: CliRuntimeId, status: CodexRuntimeStatus) => {
    const selection = form.runtime.selections[runtimeId] || { mode: "system" as const, systemPath: "", customPath: "" };
    const systemCandidates = status.candidates?.filter((candidate) => candidate.source === "system") || [];
    const sourceDescription = selection.mode === "managed" ? "独立安装、更新和回退，不影响系统 CLI" : selection.mode === "custom" ? "只验证并使用指定文件，不覆盖或更新它" : systemCandidates.length ? `已检测到 ${systemCandidates.length} 个可用安装` : "尚未检测到系统安装";
    return <div className="runtime-choice wide">
      <div className="runtime-source-control">
        <label><span>程序来源</span><select value={selection.mode} onChange={(event) => { const mode = event.target.value as RuntimeUseMode; if (mode === "custom") updateRuntimeSelection(runtimeId, { mode }); else void chooseRuntime(runtimeId, mode); }} aria-label={`${runtimeId} CLI 程序来源`}><option value="system">系统 CLI</option><option value="custom">指定路径</option><option value="managed">工作台托管</option></select></label>
        <small>{sourceDescription}</small>
      </div>
      {selection.mode === "system" && <div className="runtime-system-path"><select value={selection.systemPath} disabled={!systemCandidates.length} onChange={(event) => void persistRuntimeSelection(runtimeId, { ...selection, systemPath: event.target.value })} aria-label={`${runtimeId} 系统 CLI 位置`}><option value="">按系统 PATH 优先级</option>{systemCandidates.map((candidate) => <option key={candidate.path} value={candidate.path}>{candidate.version} · {candidate.path}</option>)}</select><button type="button" onClick={() => void inspectRuntime(runtimeId)}><RefreshCw size={13} />重新扫描</button></div>}
      {selection.mode === "custom" && <div className="runtime-custom-path"><input value={selection.customPath} onChange={(event) => updateRuntimeSelection(runtimeId, { customPath: event.target.value })} placeholder="CLI 可执行文件路径" autoFocus /><button type="button" onClick={() => void chooseRuntime(runtimeId, "custom")}>应用路径</button></div>}
    </div>;
  };
  const runtimeSourceLabel = (status: CodexRuntimeStatus) => status.source === "runtime" ? "工作台托管" : status.source === "system" ? "系统安装" : status.source === "configured" ? "指定路径" : status.source === "bundled" ? "产品内置" : "未配置";
  const runtimeVersionNumber = (value: string) => /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(value)?.[0] || value.trim();
  const inspectRuntime = async (runtimeId: CliRuntimeId) => {
    const setChecking = runtimeId === "codex" ? setCheckingCodexRuntime : runtimeId === "claude" ? setCheckingClaudeRuntime : null;
    setChecking?.(true);
    setRuntimeNotice(runtimeId, "");
    try {
      const status = await api<CodexRuntimeStatus>(`/api/runtime/${runtimeId}/discover`, { method: "POST" });
      setRuntimeStatus(runtimeId, status);
      setRuntimeNotice(runtimeId, status.candidates?.some((candidate) => candidate.source === "system") ? `已发现 ${status.candidates.filter((candidate) => candidate.source === "system").length} 个系统安装` : status.message);
    } catch (error) { setRuntimeNotice(runtimeId, error instanceof Error ? error.message : String(error)); }
    finally { setChecking?.(false); }
  };
  const testRuntimeApi = async (runtimeId: EngineName) => {
    const setChecking = runtimeId === "codex" ? setCheckingCodexRuntime : setCheckingClaudeRuntime;
    const setNotice = runtimeId === "codex" ? setCodexRuntimeNotice : setClaudeRuntimeNotice;
    setChecking(true);
    setNotice("");
    try {
      const body = runtimeId === "codex" ? { baseUrl: form.baseUrl, apiKey: form.apiKey, model: form.model } : { baseUrl: form.claude.baseUrl, apiKey: form.claude.apiKey, model: form.claude.model };
      await api(`/api/runtime/${runtimeId}/test`, { method: "POST", body: JSON.stringify(body) });
      setNotice(runtimeId === "codex" ? "OpenAI Responses API 连接成功" : "Anthropic Messages API 连接成功");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setChecking(false); }
  };
  const rollbackRuntime = async (runtimeId: CliRuntimeId) => {
    try {
      const status = await api<CodexRuntimeStatus>(`/api/runtime/${runtimeId}/rollback`, { method: "POST" });
      setRuntimeStatus(runtimeId, status);
      setRuntimeNotice(runtimeId, "已回退到上一托管版本");
    } catch (error) { setRuntimeNotice(runtimeId, error instanceof Error ? error.message : String(error)); }
  };
  const runtimeProviderPanel = (runtimeId: CliRuntimeId, label: string, status: CodexRuntimeStatus) => {
    const installing = Boolean(runtimeInstallFeeds[runtimeId]?.progress?.active) || runtimeId === "claude" && installingClaudeRuntime || runtimeId === "codex" && installingCodexRuntime;
    const notice = runtimeNotice(runtimeId);
    const mode = (form.runtime.selections[runtimeId] || { mode: "system" as const }).mode;
    const managed = status.managed || { installed: status.source === "runtime", activeVersion: "", installedVersions: [] };
    const updateStatus = runtimeUpdates[runtimeId];
    const checkingUpdate = checkingRuntimeUpdates[runtimeId];
    const currentVersion = mode === "managed" ? managed.activeVersion || runtimeVersionNumber(status.version || "") : runtimeVersionNumber(status.version || "");
    const updateCopy = !updateStatus ? (mode === "managed" && !managed.installed ? "尚未安装，将安装公开最新版" : "尚未检查公开版本") : updateStatus.state === "latest" ? "已是最新版" : updateStatus.state === "available" ? `可更新至 ${updateStatus.latestVersion}` : updateStatus.state === "not-installed" ? `将安装 ${updateStatus.latestVersion}` : updateStatus.state === "newer-local" ? "本地版本高于公开最新版" : `公开最新版 ${updateStatus.latestVersion}，外部安装不会被修改`;
    const providerControl = providerControls.find((control) => control.providerId === runtimeId);
    const installation = runtimeInstallationAction(status);
    const pendingSource = Boolean(status.selectionMode && status.selectionMode !== mode);
    return <section className="settings-provider-panel runtime-provider-panel" key={runtimeId}>
      <header><ProviderIcon provider={runtimeId} icon={providerControl?.identity.icon} accent={providerControl?.identity.accent} size={22} /><span><strong>{label}</strong><small>{status.version || "尚未检测版本"}</small></span><div className={`runtime-health ${status.available ? "ready" : "missing"}`}><i />{status.available ? "可用" : "未连接"}</div><i className={`runtime-source-badge ${status.available ? "ready" : "missing"}`}>{runtimeSourceLabel(status)}</i></header>
      <div className="settings-grid">
        {runtimeChoicePanel(runtimeId, status)}
        {pendingSource ? <p className="runtime-inline-note wide">请填写并应用路径，验证后生效；也可以直接安装到工作台。</p> : !status.available && <p className="runtime-inline-note wide">{status.message}</p>}
        <div className="runtime-version-row wide"><div><span>当前版本</span><strong>{currentVersion || "未安装"}</strong>{updateStatus?.latestVersion && <small>公开版 {updateStatus.latestVersion}</small>}</div><div className={`runtime-update-state ${updateStatus?.state === "latest" ? "ready" : updateStatus?.state === "available" || updateStatus?.state === "not-installed" ? "available" : ""}`}>{updateStatus?.state === "latest" && <Check size={13} />}{updateCopy}</div></div>
        <div className="runtime-actions wide">
          <button type="button" disabled={checkingUpdate || installing || pendingSource} onClick={() => void checkRuntimeUpdate(runtimeId)}><RefreshCw className={checkingUpdate ? "spin" : ""} size={14} />{checkingUpdate ? "正在检查" : updateStatus ? "重新检查" : "检查版本"}</button>
          {(!managed.installed || installation.repair) && <button type="button" className="primary" disabled={!installation.supported || installing} onClick={() => void startRuntimeInstall(runtimeId, installation.repair)}><Download size={14} />{installing ? "处理中" : installation.label}</button>}
          {mode === "managed" && managed.installed && !installation.repair && updateStatus?.action === "update" && <button type="button" className="primary" disabled={!installation.supported || installing} onClick={() => void startRuntimeInstall(runtimeId)}><Download size={14} />{installing ? "更新中" : `更新到 ${updateStatus.latestVersion}`}</button>}
        </div>
        {runtimeProgressPanel(runtimeId)}
        {notice && notice !== runtimeInstallFeeds[runtimeId].progress?.message && <p className={`settings-runtime-note wide ${/失败|错误|不可用|未找到/.test(notice) ? "error" : "success"}`}>{notice}</p>}
        <div className="runtime-path-line wide"><span>路径</span><code title={status.path}>{status.path || "尚未检测到可用 CLI"}</code></div>
        {(managed.installedVersions.length > 1 || status.source === "runtime") && <details className="runtime-advanced wide"><summary>托管版本管理</summary><div><span>{managed.installedVersions.length ? `已安装 ${managed.installedVersions.join("、")}` : "没有历史版本"}</span>{managed.installedVersions.length > 1 && <button type="button" disabled={installing} onClick={() => void rollbackRuntime(runtimeId)}><ArchiveRestore size={13} />回退上一版本</button>}</div></details>}
      </div>
    </section>;
  };
  const displayedRuntimeCatalog = runtimeCatalog.map((item) => ({ ...item, status: item.id === "claude" ? claudeRuntimeState : item.id === "codex" ? runtime : item.status }));
  const selectedDefaultControl = providerControls.find((control) => control.providerId === form.defaultEngine);
  const eligibleDefaultControls = providerControls.filter((control) => control.operations.setDefault);
  const selectedDefaultEligible = eligibleDefaultControls.some((control) => control.providerId === form.defaultEngine);
  const claudeProviderControl = providerControls.find((control) => control.providerId === "claude");
  const codexProviderControl = providerControls.find((control) => control.providerId === "codex");
  const saveLabel = saveState === "saving" ? "保存中" : saveState === "saved" ? "已保存" : saveState === "error" ? "重试保存" : "保存设置";
  const runtimeNetworkPanel = <details className="runtime-network-panel">
    <summary><Globe2 size={16} /><div><strong>下载与网络</strong><span>代理、下载源和无数据超时</span></div><ChevronDown size={14} /></summary>
    <div className="runtime-network-body"><div className="runtime-network-actions"><span>这些设置只影响工作台托管 CLI 的下载。</span><button type="button" disabled={checkingRuntimeSources} onClick={() => void checkRuntimeSources()}><RefreshCw className={checkingRuntimeSources ? "spin" : ""} size={14} />{checkingRuntimeSources ? "正在检测" : "检测下载源"}</button></div><div className="runtime-network-fields">
      <label><span>代理</span><select value={form.runtime.network.proxyMode} onChange={(event) => updateRuntimeNetwork("proxyMode", event.target.value)}><option value="system">跟随系统环境</option><option value="off">不使用代理</option><option value="custom">自定义代理</option></select></label>
      <label><span>下载源</span><select value={form.runtime.network.registryMode} onChange={(event) => updateRuntimeNetwork("registryMode", event.target.value)}><option value="auto">自动选择可用快源</option><option value="official">npm 官方源</option><option value="custom">自定义源</option></select></label>
      <label><span>无数据超时</span><select value={form.runtime.network.inactivityTimeoutSeconds} onChange={(event) => updateRuntimeNetwork("inactivityTimeoutSeconds", Number(event.target.value))}><option value={60}>60 秒</option><option value={120}>120 秒</option><option value={300}>300 秒</option></select></label>
      {form.runtime.network.proxyMode === "custom" && <label className="wide"><span>代理地址</span><input value={form.runtime.network.proxyUrl} onChange={(event) => updateRuntimeNetwork("proxyUrl", event.target.value)} placeholder="http://127.0.0.1:7890" /></label>}
      {form.runtime.network.registryMode === "custom" && <label className="wide"><span>npm Registry</span><input value={form.runtime.network.customRegistry} onChange={(event) => updateRuntimeNetwork("customRegistry", event.target.value)} placeholder="https://registry.example.com" /></label>}
    </div>
    {Object.keys(runtimeSourceChecks).length > 0 && <div className="runtime-source-results">{displayedRuntimeCatalog.map(({ id: runtimeId, label }) => { const result = runtimeSourceChecks[runtimeId]; return result && <div key={runtimeId}><strong>{label} · {result.version}</strong>{result.probes.map((probe) => <span key={probe.registry} className={probe.available ? "ready" : "failed"}>{new URL(probe.registry).host}<small>{probe.available ? `${probe.latencyMs} ms` : probe.error}</small>{probe.registry === result.selected && <i>已选</i>}</span>)}</div>; })}</div>}
    </div>
  </details>;
  return <section className="content-view settings-view">
    <div className="section-heading settings-sticky-heading"><div><h1>设置</h1><p>管理 Agent、会话、页面、个人数据与软件版本。</p></div>{!(["updates", "sessions", "data"] as SettingsSectionName[]).includes(settingsSection) && <div className="settings-save-actions">{saveError && <span role="alert">{saveError}</span>}<button className="primary" disabled={saveState === "clean" || saveState === "saving"} onClick={() => void save()}>{saveState === "saving" ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{saveLabel}</button></div>}</div>
    <div className="settings-shell">
    <SettingsNavigation value={settingsSection} agentPage={aiSettingsPage} onChange={setSettingsSection} onAgentPageChange={setAiSettingsPage} />
    <div className="settings-page-content">
    {settingsSection === "sessions" && <RecoverableSectionBoundary resetKey={settingsSection} title="会话管理暂时无法显示"><Suspense fallback={<div className="session-management-loading"><LoaderCircle className="spin" size={20} />正在载入会话管理</div>}><SessionManagementView embedded request={api} onOpenSession={onOpenSession} onOpenWorkflow={onOpenWorkflow} onChanged={onChanged} onNotice={onNotice} /></Suspense></RecoverableSectionBoundary>}
    {settingsSection === "ai" && aiSettingsPage === "market" && <div className="settings-market-view"><AgentMarketSettings onNativeConfigure={(providerId, runtime) => { onProviderChange(providerId); setAiSettingsPage(runtime ? "runtime" : "providers"); }} /></div>}
    {settingsSection === "ai" && aiSettingsPage === "overview" && <div className="settings-section settings-agent-overview">
      <div className="settings-page-heading"><h2>Agent 总览</h2><p>设置默认主脑，并查看所有已连接 Agent 的运行状态。</p></div>
      <div className="settings-default-engine"><div><strong>默认主脑</strong><span>新任务默认使用的 Agent；任务内仍可随时切换，协作模式由工作区 Skill 管理。</span>{selectedDefaultControl && !selectedDefaultEligible && <small>{selectedDefaultControl.connection.message}</small>}</div><select value={form.defaultEngine} onChange={(event) => update("defaultEngine", event.target.value)}>{selectedDefaultControl && !selectedDefaultEligible && <option value={selectedDefaultControl.providerId} disabled>{selectedDefaultControl.identity.shortName}（待连接）</option>}{eligibleDefaultControls.map((control) => <option key={control.providerId} value={control.providerId}>{control.identity.shortName}</option>)}</select></div>
      <div className="settings-provider-overview-grid">{providerControls.map((control) => <button type="button" key={control.providerId} className={`settings-provider-summary ${providerTab === control.providerId ? "focused" : ""}`} onClick={() => { onProviderChange(control.providerId); setAiSettingsPage("providers"); }}><ProviderIcon provider={control.providerId} icon={control.identity.icon} accent={control.identity.accent} size={24} /><span><strong>{control.identity.shortName}</strong><small>{control.lifecycle.version || "未检测版本"} · {control.identity.transport === "native" ? "原生增强" : "ACP"}</small></span><i className={control.connection.status === "ready" ? "ready" : "attention"}>{control.connection.status === "ready" ? "已连接" : control.connection.status === "checking" ? "检测中" : control.connection.status === "attention" ? "待配置" : "不可用"}</i></button>)}</div>
    </div>}
    {settingsSection === "ai" && aiSettingsPage === "providers" && <div id="native-provider-settings" className="settings-section settings-ai-models">
      <div className="settings-page-heading settings-provider-page-heading"><div><span className="help-inline-heading"><h2>Provider</h2><HelpButton topic="provider-connections" /></span><p>统一管理账号、连接、模型和 Agent 动态配置。</p></div><button type="button" onClick={() => setAiSettingsPage("market")}><Plus size={14} />添加 Agent</button></div>
      <div className="settings-provider-config-grid">
        {claudeProviderControl && <ProviderSettingsPanel control={claudeProviderControl} focused={providerTab === "claude"} subtitle="原生增强 · Anthropic 协议" onFocus={() => onProviderChange("claude")}><ProviderConnectionControl providerId="claude" control={claudeProviderControl} /></ProviderSettingsPanel>}
        {codexProviderControl && <ProviderSettingsPanel control={codexProviderControl} focused={providerTab === "codex"} subtitle="原生增强 · OpenAI Responses 协议" onFocus={() => onProviderChange("codex")}><ProviderConnectionControl providerId="codex" control={codexProviderControl} /></ProviderSettingsPanel>}
        <InstalledProviderConnections controls={providerControls} focusedProvider={providerTab} onProviderChange={onProviderChange} />
      </div>
    </div>}
    {settingsSection === "pages" && <PageSettings
      value={form.interface.workspaceBrowser}
      onChange={updatePagePreferences}
      onResetTabs={onResetTabs}
      onResetLayout={onResetLayout}
    />}
    {settingsSection === "ai" && aiSettingsPage === "overview" && <div className="settings-section settings-agent-policy-section">
      <div className="settings-page-heading"><div><span className="help-inline-heading"><h2>执行与权限</h2><HelpButton topic="execution-permissions" /></span><p>工作台默认策略与原生 Provider 增强选项。</p></div></div>
      <div className="settings-provider-config-grid">
        <section className="settings-provider-panel settings-host-policy"><header><ShieldCheck size={20} /><span><strong>工作台执行策略</strong><small>适用于所有声明对应能力的 Provider</small></span></header><div className="settings-grid">
          <label><span>项目权限</span><select value={form.sandboxMode} onChange={(event) => update("sandboxMode", event.target.value)}><option value="danger-full-access">完全访问</option><option value="workspace-write">仅工作区写入</option><option value="read-only">只读</option></select></label>
          <label><span>审批</span><select value={form.approvalPolicy} onChange={(event) => update("approvalPolicy", event.target.value)}><option value="never">自动执行</option><option value="on-request">按需询问</option><option value="on-failure">失败时询问</option><option value="untrusted">仅可信命令自动执行</option></select></label>
          <label><span>联网策略</span><select value={form.webSearch} onChange={(event) => update("webSearch", event.target.value)}><option value="live">实时联网</option><option value="cached">缓存搜索</option><option value="disabled">关闭联网</option></select></label>
          <label className="toggle-row"><span>允许网络访问</span><input type="checkbox" checked={form.networkAccess} onChange={(event) => update("networkAccess", event.target.checked)} /></label>
        </div></section>
        <section className={`settings-provider-panel ${providerTab === "claude" ? "focused" : ""}`} onFocus={() => onProviderChange("claude")}><header><ProviderIcon provider="claude" size={20} /><span><strong>Claude 原生增强</strong><small>Claude CLI 专属权限与推理</small></span></header><div className="settings-grid">
          <label><span>权限模式</span><select value={form.claude.permissionMode} onChange={(event) => updateClaude("permissionMode", event.target.value)}><option value="bypassPermissions">完全访问</option><option value="acceptEdits">自动接受编辑</option><option value="default">默认询问</option><option value="plan">仅计划</option></select></label>
          <label><span>思考深度</span><select value={form.claude.effort} onChange={(event) => updateClaude("effort", event.target.value)}>{["low", "medium", "high", "xhigh", "max"].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        </div></section>
        <section className={`settings-provider-panel ${providerTab === "codex" ? "focused" : ""}`} onFocus={() => onProviderChange("codex")}><header><ProviderIcon provider="codex" size={20} /><span><strong>Codex 原生增强</strong><small>Codex CLI 专属推理与搜索</small></span></header><div className="settings-grid">
          <label><span>推理强度</span><select value={form.reasoningEffort} onChange={(event) => update("reasoningEffort", event.target.value)}>{["minimal", "low", "medium", "high", "xhigh"].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label><span>Web Search</span><select value={form.webSearch} onChange={(event) => update("webSearch", event.target.value)}><option value="live">实时</option><option value="cached">缓存</option><option value="disabled">关闭</option></select></label>
        </div></section>
        {providerControls.filter((control) => control.identity.transport === "acp").map((control) => <section className="settings-provider-panel settings-acp-policy" key={control.providerId}><header><ProviderIcon provider={control.providerId} icon={control.identity.icon} accent={control.identity.accent} size={20} /><span><strong>{control.identity.shortName}</strong><small>ACP 能力协商 · 会话配置由 Agent 动态提供</small></span></header><div className="settings-capability-summary"><span>{control.capabilities.workspace.write ? "可写工作区" : "只读工作区"}</span><span>{control.capabilities.tools.shell ? "支持终端" : "无终端"}</span><span>{control.capabilities.tools.mcp ? "支持 MCP" : "无 MCP"}</span><span>{control.configuration.modelSource === "session" ? "动态模型配置" : "固定配置"}</span></div></section>)}
      </div>
    </div>}
    {settingsSection === "ai" && aiSettingsPage === "runtime" && <div className="settings-section">
      <div className="settings-page-heading"><div><span className="help-inline-heading"><h2>运行环境</h2><HelpButton topic="cli-runtime" /></span><p>管理 CLI 来源、版本、安装更新和下载网络。</p></div></div>
      {runtimeNetworkPanel}
      <div className="settings-provider-config-grid runtime-grid">
        {displayedRuntimeCatalog.map((item) => runtimeProviderPanel(item.id, item.label, item.status))}
      </div>
    </div>}
    {settingsSection === "data" && <DataSettings dataHome={dataHome} claudeHome={claudeHome} codexHome={codexHome} request={api} onNotice={onNotice} />}
    {settingsSection === "updates" && <AppUpdateSettings />}
    {settingsSection === "help" && <HelpCenter />}
    </div>
    </div>
  </section>;
}
