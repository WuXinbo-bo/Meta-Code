import {
  normalizeWorkspaceFilePath,
  workspaceFilePathAtOrBelow,
  workspaceFilePathIdentity
} from "../files/filePathIdentity";

export const WORKSPACE_BROWSER_SNAPSHOT_VERSION = 1 as const;
export const DEFAULT_WORKSPACE_BROWSER_TAB_LIMIT = 24;
export const DEFAULT_WORKSPACE_BROWSER_STORAGE_KEY = "metamodel.workspace-browser.tabs.v1";
export const MAX_RECENTLY_CLOSED_WORKSPACE_BROWSER_TABS = 20;

export type WorkspaceBrowserResourceKind = "conversation" | "file" | "workflow" | "tool";

export type ConversationBrowserResource = {
  kind: "conversation";
  conversationId: string;
  workspaceId?: string;
};

export type FileBrowserResource = {
  kind: "file";
  workspaceId: string;
  path: string;
};

export type WorkflowBrowserResource = {
  kind: "workflow";
  workflowId: string;
  workspaceId?: string;
};

export type ToolBrowserResource = {
  kind: "tool";
  toolId: string;
  workspaceId?: string;
  invocationId?: string;
};

export type WorkspaceBrowserResource =
  | ConversationBrowserResource
  | FileBrowserResource
  | WorkflowBrowserResource
  | ToolBrowserResource;

export type WorkspaceBrowserTabStatus = "idle" | "loading" | "error";
export type WorkspaceBrowserOpenMode = "regular" | "preview" | "pinned";

export type WorkspaceBrowserTab = {
  id: string;
  resource: WorkspaceBrowserResource;
  title: string;
  detail?: string;
  pinned: boolean;
  transient: boolean;
  dirty: boolean;
  status: WorkspaceBrowserTabStatus;
  lastActivatedAt: number;
};

export type WorkspaceBrowserTabsState = {
  tabs: WorkspaceBrowserTab[];
  activeTabId: string | null;
  recentlyClosed: WorkspaceBrowserRecentlyClosedTab[];
};

export type WorkspaceBrowserRecentlyClosedTab = {
  tab: WorkspaceBrowserTab;
  index: number;
};

export type WorkspaceBrowserConversationViewState = "idle" | "loading" | "error";

export type OpenWorkspaceBrowserTabInput = {
  resource: WorkspaceBrowserResource;
  title?: string;
  detail?: string;
  mode?: WorkspaceBrowserOpenMode;
  dirty?: boolean;
  status?: WorkspaceBrowserTabStatus;
};

export type WorkspaceBrowserTabPresentation = Pick<WorkspaceBrowserTab, "title"> & {
  detail?: string;
};

export type WorkspaceBrowserTabsOptions = {
  maxTabs?: number;
};

export type WorkspaceBrowserTabsReconcileOptions = WorkspaceBrowserTabsOptions & {
  isResourceValid?: (resource: WorkspaceBrowserResource) => boolean;
  resolvePresentation?: (resource: WorkspaceBrowserResource) => WorkspaceBrowserTabPresentation | undefined;
};

export type WorkspaceBrowserFileMove = {
  from: string;
  to: string;
};

export type WorkspaceBrowserTabsAction =
  | { type: "open"; input: OpenWorkspaceBrowserTabInput; at?: number }
  | { type: "activate"; tabId: string; at?: number }
  | { type: "deactivate" }
  | { type: "close"; tabId: string }
  | { type: "close-others"; tabId: string }
  | { type: "close-right"; tabId: string }
  | { type: "reopen-last-closed"; at?: number }
  | { type: "move"; tabId: string; targetIndex: number }
  | { type: "move-relative"; tabId: string; offset: number }
  | { type: "move-to-edge"; tabId: string; edge: "start" | "end" }
  | { type: "set-pinned"; tabId: string; pinned: boolean }
  | { type: "remap-file-paths"; workspaceId: string; moves: WorkspaceBrowserFileMove[] }
  | { type: "close-file-paths"; workspaceId: string; paths: string[] }
  | { type: "update-presentation"; tabId: string; patch: Partial<Pick<WorkspaceBrowserTab, "title" | "detail" | "dirty" | "status">> }
  | { type: "replace"; state: WorkspaceBrowserTabsState };

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type PersistedWorkspaceBrowserTab = {
  resource: WorkspaceBrowserResource;
  pinned: boolean;
  transient: boolean;
  lastActivatedAt: number;
};

type PersistedWorkspaceBrowserSnapshot = {
  version: typeof WORKSPACE_BROWSER_SNAPSHOT_VERSION;
  activeTabId: string | null;
  tabs: PersistedWorkspaceBrowserTab[];
};

const MAX_PERSISTED_TABS = 100;
const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 4_096;

function encoded(value: string | undefined) {
  return encodeURIComponent(value || "");
}

function normalizedFilePath(path: string) {
  return normalizeWorkspaceFilePath(path);
}

export function canonicalWorkspaceBrowserFilePath(path: string) {
  return workspaceFilePathIdentity(path);
}

export function workspaceBrowserFilePathAtOrBelow(path: string, root: string) {
  return workspaceFilePathAtOrBelow(path, root);
}

export function remapWorkspaceBrowserFilePath(path: string, moves: readonly WorkspaceBrowserFileMove[]) {
  const normalizedPath = normalizedFilePath(path).replace(/\/$/, "");
  const ordered = moves
    .map((move) => ({ from: normalizedFilePath(move.from).replace(/\/$/, ""), to: normalizedFilePath(move.to).replace(/\/$/, "") }))
    .filter((move) => move.from && move.to)
    .sort((left, right) => right.from.length - left.from.length);
  const move = ordered.find((candidate) => workspaceBrowserFilePathAtOrBelow(normalizedPath, candidate.from));
  if (!move) return normalizedPath;
  return `${move.to}${normalizedPath.slice(move.from.length)}`;
}

export function workspaceBrowserResourceKey(resource: WorkspaceBrowserResource): string {
  if (resource.kind === "conversation") {
    return `conversation:${encoded(resource.workspaceId)}:${encoded(resource.conversationId)}`;
  }
  if (resource.kind === "file") {
    return `file:${encoded(resource.workspaceId)}:${encoded(canonicalWorkspaceBrowserFilePath(resource.path))}`;
  }
  if (resource.kind === "workflow") {
    return `workflow:${encoded(resource.workspaceId)}:${encoded(resource.workflowId)}`;
  }
  return `tool:${encoded(resource.workspaceId)}:${encoded(resource.toolId)}:${encoded(resource.invocationId)}`;
}

export function workspaceBrowserResourcesEqual(left: WorkspaceBrowserResource, right: WorkspaceBrowserResource) {
  return workspaceBrowserResourceKey(left) === workspaceBrowserResourceKey(right);
}

export function workspaceBrowserScopeId(resource: WorkspaceBrowserResource | null | undefined, fallbackScopeId: string) {
  if (!resource) return fallbackScopeId;
  if (resource.kind === "file") return resource.workspaceId;
  if (resource.kind === "conversation") return resource.workspaceId || resource.conversationId;
  return resource.workspaceId || fallbackScopeId;
}

export function workspaceBrowserConversationViewState(
  resource: ConversationBrowserResource,
  tabStatus: WorkspaceBrowserTabStatus,
  loadingConversationId?: string
): WorkspaceBrowserConversationViewState {
  if (tabStatus === "error") return "error";
  return loadingConversationId === resource.conversationId ? "loading" : "idle";
}

export function defaultWorkspaceBrowserTitle(resource: WorkspaceBrowserResource): string {
  if (resource.kind === "file") {
    const parts = normalizedFilePath(resource.path).split("/").filter(Boolean);
    return parts.at(-1) || "文件";
  }
  if (resource.kind === "conversation") return "对话";
  if (resource.kind === "workflow") return "工作流";
  return "工具";
}

export function createWorkspaceBrowserTabsState(): WorkspaceBrowserTabsState {
  return { tabs: [], activeTabId: null, recentlyClosed: [] };
}

function resolvedLimit(options?: WorkspaceBrowserTabsOptions) {
  const requested = options?.maxTabs ?? DEFAULT_WORKSPACE_BROWSER_TAB_LIMIT;
  return Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : DEFAULT_WORKSPACE_BROWSER_TAB_LIMIT;
}

function recentlyClosedOf(state: WorkspaceBrowserTabsState) {
  return Array.isArray(state.recentlyClosed) ? state.recentlyClosed : [];
}

function pinnedLimit(options?: WorkspaceBrowserTabsOptions) {
  return Math.max(0, resolvedLimit(options) - 1);
}

function canPinWorkspaceBrowserTab(state: WorkspaceBrowserTabsState, tabId: string, options?: WorkspaceBrowserTabsOptions) {
  return state.tabs.filter((tab) => tab.pinned && tab.id !== tabId).length < pinnedLimit(options);
}

function trimTabsToLimit(state: WorkspaceBrowserTabsState, options?: WorkspaceBrowserTabsOptions): WorkspaceBrowserTabsState {
  const maxTabs = resolvedLimit(options);
  const maxPinnedTabs = pinnedLimit(options);
  const recentlyClosed = recentlyClosedOf(state).slice(0, MAX_RECENTLY_CLOSED_WORKSPACE_BROWSER_TABS);
  let pinnedCount = 0;
  let changed = recentlyClosed !== state.recentlyClosed;
  const tabs = state.tabs.map((tab) => {
    if (!tab.pinned) return tab;
    pinnedCount += 1;
    if (pinnedCount <= maxPinnedTabs) return tab;
    changed = true;
    return { ...tab, pinned: false };
  });
  while (tabs.length > maxTabs) {
    const removable = tabs
      .map((tab, index) => ({ tab, index }))
      .filter(({ tab }) => !tab.pinned && tab.id !== state.activeTabId)
      .sort((left, right) => left.tab.lastActivatedAt - right.tab.lastActivatedAt || left.index - right.index);
    if (!removable.length) {
      const fallbackIndex = tabs.findIndex((tab) => tab.id !== state.activeTabId);
      if (fallbackIndex < 0) break;
      tabs.splice(fallbackIndex, 1);
      changed = true;
      continue;
    }
    tabs.splice(removable[0].index, 1);
    changed = true;
  }
  const activeTabId = state.activeTabId !== null && tabs.some((tab) => tab.id === state.activeTabId)
    ? state.activeTabId
    : null;
  if (activeTabId !== state.activeTabId) changed = true;
  return changed ? { tabs, activeTabId, recentlyClosed } : state;
}

export function openWorkspaceBrowserTab(
  state: WorkspaceBrowserTabsState,
  input: OpenWorkspaceBrowserTabInput,
  options?: WorkspaceBrowserTabsOptions,
  at = Date.now()
): WorkspaceBrowserTabsState {
  const id = workspaceBrowserResourceKey(input.resource);
  const mode = input.mode ?? "regular";
  const existingIndex = state.tabs.findIndex((tab) => tab.id === id);
  if (existingIndex >= 0) {
    const existing = state.tabs[existingIndex];
    const pinned = existing.pinned || (mode === "pinned" && canPinWorkspaceBrowserTab(state, id, options));
    const becomesRegular = mode === "regular" || mode === "pinned";
    const updated: WorkspaceBrowserTab = {
      ...existing,
      resource: input.resource,
      title: input.title?.trim() || existing.title,
      detail: input.detail !== undefined ? input.detail : existing.detail,
      pinned,
      transient: pinned || becomesRegular ? false : existing.transient,
      dirty: input.dirty ?? existing.dirty,
      status: input.status ?? existing.status,
      lastActivatedAt: at
    };
    const tabs = [...state.tabs];
    tabs[existingIndex] = updated;
    return trimTabsToLimit({ ...state, tabs, activeTabId: id }, options);
  }

  const isTransientFile = mode === "preview" && input.resource.kind === "file";
  const nextTab: WorkspaceBrowserTab = {
    id,
    resource: input.resource,
    title: input.title?.trim() || defaultWorkspaceBrowserTitle(input.resource),
    detail: input.detail,
    pinned: mode === "pinned" && canPinWorkspaceBrowserTab(state, id, options),
    transient: isTransientFile,
    dirty: input.dirty ?? false,
    status: input.status ?? "idle",
    lastActivatedAt: at
  };

  const tabs = [...state.tabs];
  const reusablePreviewIndex = isTransientFile
    ? tabs.findIndex((tab) => tab.resource.kind === "file" && tab.transient && !tab.pinned)
    : -1;
  if (reusablePreviewIndex >= 0) tabs[reusablePreviewIndex] = nextTab;
  else tabs.push(nextTab);

  return trimTabsToLimit({ ...state, tabs, activeTabId: id }, options);
}

export function activateWorkspaceBrowserTab(state: WorkspaceBrowserTabsState, tabId: string, at = Date.now()): WorkspaceBrowserTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  const tabs = [...state.tabs];
  tabs[index] = { ...tabs[index], lastActivatedAt: at };
  return { ...state, tabs, activeTabId: tabId };
}

function closeWorkspaceBrowserTabInternal(
  state: WorkspaceBrowserTabsState,
  tabId: string,
  recordRecentlyClosed: boolean
): WorkspaceBrowserTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  const closedTab = state.tabs[index];
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  const recentlyClosed = recordRecentlyClosed
    ? [{ tab: closedTab, index }, ...recentlyClosedOf(state)].slice(0, MAX_RECENTLY_CLOSED_WORKSPACE_BROWSER_TABS)
    : recentlyClosedOf(state);
  if (state.activeTabId !== tabId) return { ...state, tabs, recentlyClosed };
  const fallback = tabs[index] || tabs[index - 1] || null;
  return { ...state, tabs, activeTabId: fallback?.id ?? null, recentlyClosed };
}

export function closeWorkspaceBrowserTab(state: WorkspaceBrowserTabsState, tabId: string): WorkspaceBrowserTabsState {
  return closeWorkspaceBrowserTabInternal(state, tabId, true);
}

export function closeOtherWorkspaceBrowserTabs(state: WorkspaceBrowserTabsState, tabId: string): WorkspaceBrowserTabsState {
  if (!state.tabs.some((tab) => tab.id === tabId)) return state;
  const ids = state.tabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id).reverse();
  const closed = ids.reduce((current, id) => closeWorkspaceBrowserTabInternal(current, id, true), state);
  return closed.activeTabId === tabId ? closed : { ...closed, activeTabId: tabId };
}

export function closeWorkspaceBrowserTabsToRight(state: WorkspaceBrowserTabsState, tabId: string): WorkspaceBrowserTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0 || index === state.tabs.length - 1) return state;
  const ids = state.tabs.slice(index + 1).map((tab) => tab.id).reverse();
  return ids.reduce((current, id) => closeWorkspaceBrowserTabInternal(current, id, true), state);
}

export function moveWorkspaceBrowserTab(
  state: WorkspaceBrowserTabsState,
  tabId: string,
  targetIndex: number
): WorkspaceBrowserTabsState {
  const currentIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (currentIndex < 0 || !Number.isFinite(targetIndex)) return state;
  const nextIndex = Math.max(0, Math.min(state.tabs.length - 1, Math.trunc(targetIndex)));
  if (currentIndex === nextIndex) return state;
  const tabs = [...state.tabs];
  const [tab] = tabs.splice(currentIndex, 1);
  tabs.splice(nextIndex, 0, tab);
  return { ...state, tabs };
}

export function moveWorkspaceBrowserTabRelative(
  state: WorkspaceBrowserTabsState,
  tabId: string,
  offset: number
): WorkspaceBrowserTabsState {
  const currentIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (currentIndex < 0 || !Number.isFinite(offset)) return state;
  return moveWorkspaceBrowserTab(state, tabId, currentIndex + Math.trunc(offset));
}

export function moveWorkspaceBrowserTabToEdge(
  state: WorkspaceBrowserTabsState,
  tabId: string,
  edge: "start" | "end"
): WorkspaceBrowserTabsState {
  return moveWorkspaceBrowserTab(state, tabId, edge === "start" ? 0 : state.tabs.length - 1);
}

export function reopenLastClosedWorkspaceBrowserTab(
  state: WorkspaceBrowserTabsState,
  options?: WorkspaceBrowserTabsOptions,
  at = Date.now()
): WorkspaceBrowserTabsState {
  const [entry, ...recentlyClosed] = recentlyClosedOf(state);
  if (!entry) return state;
  const id = workspaceBrowserResourceKey(entry.tab.resource);
  const existing = state.tabs.find((tab) => tab.id === id);
  if (existing) {
    return activateWorkspaceBrowserTab({ ...state, recentlyClosed }, existing.id, at);
  }

  const pinned = entry.tab.pinned && canPinWorkspaceBrowserTab(state, id, options);
  const restoredTab: WorkspaceBrowserTab = {
    ...entry.tab,
    id,
    pinned,
    transient: pinned ? false : entry.tab.transient,
    lastActivatedAt: at
  };
  const tabs = [...state.tabs];
  const insertAt = Math.max(0, Math.min(tabs.length, entry.index));
  tabs.splice(insertAt, 0, restoredTab);
  return trimTabsToLimit({ tabs, activeTabId: id, recentlyClosed }, options);
}

export function remapWorkspaceBrowserFileTabs(
  state: WorkspaceBrowserTabsState,
  workspaceId: string,
  moves: readonly WorkspaceBrowserFileMove[]
): WorkspaceBrowserTabsState {
  if (!workspaceId || !moves.length) return state;
  let changed = false;
  let activeTabId = state.activeTabId;
  const tabs = state.tabs.map((tab) => {
    if (tab.resource.kind !== "file" || tab.resource.workspaceId !== workspaceId) return tab;
    const path = remapWorkspaceBrowserFilePath(tab.resource.path, moves);
    if (path === normalizedFilePath(tab.resource.path)) return tab;
    changed = true;
    const resource: FileBrowserResource = { ...tab.resource, path };
    const id = workspaceBrowserResourceKey(resource);
    if (activeTabId === tab.id) activeTabId = id;
    return { ...tab, id, resource, title: defaultWorkspaceBrowserTitle(resource), dirty: false };
  });
  return changed ? { ...state, tabs, activeTabId } : state;
}

export function closeWorkspaceBrowserFileTabs(
  state: WorkspaceBrowserTabsState,
  workspaceId: string,
  paths: readonly string[]
): WorkspaceBrowserTabsState {
  if (!workspaceId || !paths.length) return state;
  const closed = state.tabs.filter((tab) => {
    const resource = tab.resource;
    return resource.kind === "file"
      && resource.workspaceId === workspaceId
      && paths.some((path) => workspaceBrowserFilePathAtOrBelow(resource.path, path));
  });
  if (!closed.length) return state;
  return closed.reduce((current, tab) => closeWorkspaceBrowserTabInternal(current, tab.id, false), state);
}

export function setWorkspaceBrowserTabPinned(
  state: WorkspaceBrowserTabsState,
  tabId: string,
  pinned: boolean,
  options?: WorkspaceBrowserTabsOptions
): WorkspaceBrowserTabsState {
  const constrained = trimTabsToLimit(state, options);
  const index = constrained.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return constrained;
  if (pinned && !canPinWorkspaceBrowserTab(constrained, tabId, options)) return constrained;
  if (constrained.tabs[index].pinned === pinned) return constrained;
  const tabs = [...constrained.tabs];
  tabs[index] = { ...tabs[index], pinned, transient: pinned ? false : tabs[index].transient };
  return trimTabsToLimit({ ...constrained, tabs }, options);
}

export function updateWorkspaceBrowserTabPresentation(
  state: WorkspaceBrowserTabsState,
  tabId: string,
  patch: Partial<Pick<WorkspaceBrowserTab, "title" | "detail" | "dirty" | "status">>
): WorkspaceBrowserTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  const tabs = [...state.tabs];
  tabs[index] = {
    ...tabs[index],
    ...patch,
    title: patch.title?.trim() || tabs[index].title
  };
  return { ...state, tabs };
}

export function reconcileWorkspaceBrowserTabs(
  state: WorkspaceBrowserTabsState,
  options: WorkspaceBrowserTabsReconcileOptions = {}
): WorkspaceBrowserTabsState {
  let changed = false;
  const survivingOriginalIndices: number[] = [];
  const tabs = state.tabs.flatMap((tab, originalIndex) => {
    if (options.isResourceValid && !options.isResourceValid(tab.resource)) {
      changed = true;
      return [];
    }
    survivingOriginalIndices.push(originalIndex);
    const presentation = options.resolvePresentation?.(tab.resource);
    if (!presentation) return [tab];
    const title = presentation.title.trim() || tab.title;
    const detail = presentation.detail;
    if (title === tab.title && detail === tab.detail) return [tab];
    changed = true;
    return [{ ...tab, title, detail }];
  });
  let activeTabId = state.activeTabId;
  if (activeTabId !== null && !tabs.some((tab) => tab.id === activeTabId)) {
    const activeOriginalIndex = state.tabs.findIndex((tab) => tab.id === activeTabId);
    if (activeOriginalIndex >= 0) {
      const rightIndex = survivingOriginalIndices.findIndex((index) => index > activeOriginalIndex);
      if (rightIndex >= 0) {
        activeTabId = tabs[rightIndex]?.id ?? null;
      } else {
        let leftIndex = -1;
        for (let index = survivingOriginalIndices.length - 1; index >= 0; index -= 1) {
          if (survivingOriginalIndices[index] < activeOriginalIndex) {
            leftIndex = index;
            break;
          }
        }
        activeTabId = leftIndex >= 0 ? tabs[leftIndex]?.id ?? null : null;
      }
    } else {
      activeTabId = tabs.at(-1)?.id ?? null;
    }
  }
  if (!changed && activeTabId === state.activeTabId) return state;
  return trimTabsToLimit({ ...state, tabs, activeTabId }, options);
}

export function reduceWorkspaceBrowserTabs(
  state: WorkspaceBrowserTabsState,
  action: WorkspaceBrowserTabsAction,
  options?: WorkspaceBrowserTabsOptions
): WorkspaceBrowserTabsState {
  switch (action.type) {
    case "open":
      return openWorkspaceBrowserTab(state, action.input, options, action.at);
    case "activate":
      return activateWorkspaceBrowserTab(state, action.tabId, action.at);
    case "deactivate":
      return state.activeTabId === null ? state : { ...state, activeTabId: null };
    case "close":
      return closeWorkspaceBrowserTab(state, action.tabId);
    case "close-others":
      return closeOtherWorkspaceBrowserTabs(state, action.tabId);
    case "close-right":
      return closeWorkspaceBrowserTabsToRight(state, action.tabId);
    case "reopen-last-closed":
      return reopenLastClosedWorkspaceBrowserTab(state, options, action.at);
    case "move":
      return moveWorkspaceBrowserTab(state, action.tabId, action.targetIndex);
    case "move-relative":
      return moveWorkspaceBrowserTabRelative(state, action.tabId, action.offset);
    case "move-to-edge":
      return moveWorkspaceBrowserTabToEdge(state, action.tabId, action.edge);
    case "set-pinned":
      return setWorkspaceBrowserTabPinned(state, action.tabId, action.pinned, options);
    case "remap-file-paths":
      return trimTabsToLimit(remapWorkspaceBrowserFileTabs(state, action.workspaceId, action.moves), options);
    case "close-file-paths":
      return closeWorkspaceBrowserFileTabs(state, action.workspaceId, action.paths);
    case "update-presentation":
      return updateWorkspaceBrowserTabPresentation(state, action.tabId, action.patch);
    case "replace":
      return trimTabsToLimit(action.state, options);
  }
}

export function createWorkspaceBrowserTabsReducer(options?: WorkspaceBrowserTabsOptions) {
  return (state: WorkspaceBrowserTabsState, action: WorkspaceBrowserTabsAction) => reduceWorkspaceBrowserTabs(state, action, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validString(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function parseResource(value: unknown): WorkspaceBrowserResource | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  const workspaceId = value.workspaceId === undefined ? undefined : validString(value.workspaceId) ? value.workspaceId : null;
  if (workspaceId === null) return null;
  if (value.kind === "conversation" && validString(value.conversationId)) {
    return { kind: "conversation", conversationId: value.conversationId, ...(workspaceId ? { workspaceId } : {}) };
  }
  if (value.kind === "file" && validString(workspaceId) && validString(value.path, MAX_PATH_LENGTH)) {
    return { kind: "file", workspaceId, path: normalizedFilePath(value.path) };
  }
  if (value.kind === "workflow" && validString(value.workflowId)) {
    return { kind: "workflow", workflowId: value.workflowId, ...(workspaceId ? { workspaceId } : {}) };
  }
  if (value.kind === "tool" && validString(value.toolId)) {
    const invocationId = value.invocationId === undefined ? undefined : validString(value.invocationId) ? value.invocationId : null;
    if (invocationId === null) return null;
    return { kind: "tool", toolId: value.toolId, ...(workspaceId ? { workspaceId } : {}), ...(invocationId ? { invocationId } : {}) };
  }
  return null;
}

export function serializeWorkspaceBrowserTabs(state: WorkspaceBrowserTabsState): string {
  const snapshot: PersistedWorkspaceBrowserSnapshot = {
    version: WORKSPACE_BROWSER_SNAPSHOT_VERSION,
    activeTabId: state.activeTabId,
    tabs: state.tabs.map(({ resource, pinned, transient, lastActivatedAt }) => ({
      resource,
      pinned,
      transient,
      lastActivatedAt
    }))
  };
  return JSON.stringify(snapshot);
}

export function deserializeWorkspaceBrowserTabs(
  serialized: string | null | undefined,
  resolvePresentation?: (resource: WorkspaceBrowserResource) => WorkspaceBrowserTabPresentation | undefined,
  options?: WorkspaceBrowserTabsOptions
): WorkspaceBrowserTabsState {
  if (!serialized) return createWorkspaceBrowserTabsState();
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.version !== WORKSPACE_BROWSER_SNAPSHOT_VERSION || !Array.isArray(parsed.tabs)) {
      return createWorkspaceBrowserTabsState();
    }
    const tabs: WorkspaceBrowserTab[] = [];
    const seen = new Set<string>();
    for (const value of parsed.tabs.slice(0, MAX_PERSISTED_TABS)) {
      if (!isRecord(value)) continue;
      const resource = parseResource(value.resource);
      if (!resource) continue;
      const id = workspaceBrowserResourceKey(resource);
      if (seen.has(id)) continue;
      seen.add(id);
      const presentation = resolvePresentation?.(resource);
      const pinned = value.pinned === true;
      tabs.push({
        id,
        resource,
        title: presentation?.title.trim() || defaultWorkspaceBrowserTitle(resource),
        detail: presentation?.detail,
        pinned,
        transient: !pinned && value.transient === true && resource.kind === "file",
        dirty: false,
        status: "idle",
        lastActivatedAt: typeof value.lastActivatedAt === "number" && Number.isFinite(value.lastActivatedAt) ? value.lastActivatedAt : 0
      });
    }
    const requestedActiveId = typeof parsed.activeTabId === "string" ? parsed.activeTabId : null;
    const activeTabId = parsed.activeTabId === null
      ? null
      : tabs.some((tab) => tab.id === requestedActiveId)
        ? requestedActiveId
        : tabs.at(-1)?.id ?? null;
    return trimTabsToLimit({ tabs, activeTabId, recentlyClosed: [] }, options);
  } catch {
    return createWorkspaceBrowserTabsState();
  }
}

export function loadWorkspaceBrowserTabs(
  storage: StorageLike,
  key = DEFAULT_WORKSPACE_BROWSER_STORAGE_KEY,
  resolvePresentation?: (resource: WorkspaceBrowserResource) => WorkspaceBrowserTabPresentation | undefined,
  options?: WorkspaceBrowserTabsOptions
): WorkspaceBrowserTabsState {
  try {
    return deserializeWorkspaceBrowserTabs(storage.getItem(key), resolvePresentation, options);
  } catch {
    return createWorkspaceBrowserTabsState();
  }
}

export function saveWorkspaceBrowserTabs(storage: StorageLike, state: WorkspaceBrowserTabsState, key = DEFAULT_WORKSPACE_BROWSER_STORAGE_KEY): boolean {
  try {
    storage.setItem(key, serializeWorkspaceBrowserTabs(state));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkspaceBrowserTabs(storage: StorageLike, key = DEFAULT_WORKSPACE_BROWSER_STORAGE_KEY): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
