import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileJson,
  FileText,
  Folder,
  FolderArchive,
  FolderOpen,
  GitBranch,
  HeartPulse,
  History,
  Inbox,
  Layers3,
  LoaderCircle,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
  Workflow,
  X
} from "lucide-react";
import { ProviderIcon } from "../branding/ProviderIcon";
import { retainAvailableSelection, updateRangeSelection } from "./selection";
import type {
  OperationPreview,
  RepairReport,
  SessionCapability,
  SessionInventoryItem,
  SessionInventoryResponse,
  SessionManagementPreferences,
  SessionScopeSummary,
  SessionTrashItem,
  WorkspaceTrashItem
} from "./types";

type RequestOptions = RequestInit & { timeoutMs?: number };
type SessionManagementViewProps = {
  request: <T>(url: string, options?: RequestOptions) => Promise<T>;
  onOpenSession: (id: string) => void;
  onOpenWorkflow: (id: string) => void;
  onChanged: () => Promise<void> | void;
  onNotice: (message: string, tone?: "success" | "warning" | "error") => void;
  embedded?: boolean;
};

type Section = "inventory" | "health" | "trash" | "preferences";
type BulkAction = "pin" | "unpin" | "archive" | "unarchive" | "delete";
type WorkspaceAction = "pin" | "unpin" | "archive" | "unarchive" | "delete";
type Selection = { mode: "ids"; ids: Set<string> } | { mode: "filter"; excluded: Set<string>; total: number };
type PendingOperation =
  | { kind: "bulk"; action: BulkAction; preview: OperationPreview }
  | { kind: "workspace"; action: WorkspaceAction; workspaceIds: string[]; preview: OperationPreview };

const EMPTY_SELECTION: Selection = { mode: "ids", ids: new Set() };
const WORKBENCH_BULK_CAPABILITIES: SessionCapability[] = ["pin", "unpin", "archive", "unarchive", "delete"];
const HEALTH_LABELS: Record<string, string> = {
  healthy: "正常", running: "执行中", "missing-workspace": "工作区失效", "missing-native-thread": "原生线程丢失",
  "orphaned-assets": "存在孤立资源", "inconsistent-index": "索引不一致", recoverable: "可恢复", broken: "损坏"
};
const STATUS_LABELS: Record<string, string> = {
  idle: "待开始", draft: "草稿", planning: "规划中", queued: "排队中", running: "执行中", integrating: "整合中",
  paused: "已暂停", completed: "已完成", failed: "失败", stopped: "已停止", interrupted: "已中断",
  awaiting_approval: "待批准", needs_review: "待复核", canceled: "已取消", notLoaded: "未载入", "read-only": "只读"
};
const SOURCE_LABELS: Record<SessionInventoryItem["source"], string> = {
  workbench: "工作台", "codex-official": "Codex 官方", "claude-native": "Claude 原生"
};

function sourceLabel(source: SessionInventoryItem["source"]) {
  return SOURCE_LABELS[source] || source;
}

function relativeTime(value: string | null) {
  if (!value) return "暂无活动";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN");
}

function downloadSession(id: string, format: "markdown" | "json") {
  const anchor = document.createElement("a");
  anchor.href = `/api/session-management/sessions/${encodeURIComponent(id)}/export?format=${format}`;
  anchor.download = "";
  anchor.click();
}

function scopeIcon(kind: SessionScopeSummary["kind"]) {
  if (kind === "workspace") return <Folder size={15} />;
  if (kind === "standalone") return <Inbox size={15} />;
  if (kind === "missing") return <FolderArchive size={15} />;
  return <Layers3 size={15} />;
}

function operationTitle(operation: PendingOperation) {
  if (operation.kind === "workspace") {
    const count = operation.preview.workspaceCount || operation.workspaceIds.length;
    if (operation.action === "delete") return count === 1 ? `移除工作区“${operation.preview.workspace?.name || ""}”` : `移除所选 ${count} 个工作区`;
    const labels: Record<WorkspaceAction, string> = { pin: "置顶", unpin: "取消置顶", archive: "归档", unarchive: "恢复归档", delete: "移除" };
    return `${labels[operation.action]}所选 ${count} 个工作区`;
  }
  if (operation.action === "delete") return "将所选会话移入回收站";
  return ({ pin: "置顶所选项目", unpin: "取消置顶所选项目", archive: "归档所选项目", unarchive: "恢复所选归档" } as const)[operation.action];
}

export default function SessionManagementView({ request, onOpenSession, onOpenWorkflow, onChanged, onNotice, embedded = false }: SessionManagementViewProps) {
  const [section, setSection] = useState<Section>("inventory");
  const [response, setResponse] = useState<SessionInventoryResponse | null>(null);
  const [trash, setTrash] = useState<SessionTrashItem[]>([]);
  const [workspaceTrash, setWorkspaceTrash] = useState<WorkspaceTrashItem[]>([]);
  const [preferences, setPreferences] = useState<SessionManagementPreferences | null>(null);
  const [scope, setScope] = useState("all");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [source, setSource] = useState("all");
  const [status, setStatus] = useState("all");
  const [health, setHealth] = useState("all");
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [workspaceSelection, setWorkspaceSelection] = useState<Set<string>>(new Set());
  const [workspaceAnchorId, setWorkspaceAnchorId] = useState<string | null>(null);
  const [workspaceTrashSelection, setWorkspaceTrashSelection] = useState<Set<string>>(new Set());
  const [workspaceTrashAnchorId, setWorkspaceTrashAnchorId] = useState<string | null>(null);
  const [sessionAnchorId, setSessionAnchorId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [nativeLoading, setNativeLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [repair, setRepair] = useState<RepairReport | null>(null);
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const importInput = useRef<HTMLInputElement | null>(null);
  const inventoryRequestId = useRef(0);
  const onNoticeRef = useRef(onNotice);
  useEffect(() => { onNoticeRef.current = onNotice; }, [onNotice]);

  const workspaceFilterKey = useMemo(() => [...workspaceSelection].sort().join(","), [workspaceSelection]);
  const filter = useMemo(() => ({
    query, provider, source, status, health,
    scope: workspaceSelection.size > 1 ? "all" : scope,
    workspaceIds: workspaceSelection.size > 1 ? workspaceFilterKey : ""
  }), [health, provider, query, scope, source, status, workspaceFilterKey, workspaceSelection.size]);
  const loadInventory = useCallback(async (targetPage = page, includeNative = false, refreshNative = false, requestId = inventoryRequestId.current) => {
    const params = new URLSearchParams({ page: String(targetPage), ...filter, includeNative: String(includeNative), ...(refreshNative ? { refreshNative: "true" } : {}) });
    const result = await request<SessionInventoryResponse>(`/api/session-management/sessions?${params}`);
    if (requestId !== inventoryRequestId.current) return result;
    setResponse(result);
    setPreferences((current) => current || result.preferences);
    setPage(result.page);
    return result;
  }, [filter, page, request]);

  const loadTrash = useCallback(async () => {
    const result = await request<{ items: SessionTrashItem[]; workspaces: WorkspaceTrashItem[] }>("/api/session-management/trash");
    setTrash(result.items);
    setWorkspaceTrash(result.workspaces || []);
  }, [request]);

  const refresh = useCallback(async (refreshNative = false) => {
    const requestId = ++inventoryRequestId.current;
    setLoading(true);
    setNativeLoading(false);
    try {
      const [inventory] = await Promise.all([loadInventory(page, false, false, requestId), loadTrash()]);
      if (requestId !== inventoryRequestId.current) return;
      if (inventory.preferences.includeNativeSessions && source !== "workbench") {
        setNativeLoading(true);
        void loadInventory(page, true, refreshNative, requestId)
          .catch((error) => { if (requestId === inventoryRequestId.current) onNoticeRef.current(error instanceof Error ? error.message : String(error), "warning"); })
          .finally(() => { if (requestId === inventoryRequestId.current) setNativeLoading(false); });
      }
    } catch (error) {
      if (requestId === inventoryRequestId.current) onNoticeRef.current(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (requestId === inventoryRequestId.current) setLoading(false);
    }
  }, [loadInventory, loadTrash, page, source]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setPage(1); setSelection(EMPTY_SELECTION); setFocusedId(""); setSessionAnchorId(null); }, [query, provider, source, status, health, scope, workspaceFilterKey]);
  useEffect(() => {
    if (!pending) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !acting) setPending(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [acting, pending]);

  const scopes = response?.scopes || [];
  const providerFacets = response?.facets?.providers || [];
  const sourceFacets = response?.facets?.sources || [];
  const workspaceScopes = useMemo(() => scopes.filter((item) => item.kind === "workspace" && item.workspaceId), [scopes]);
  const selectedWorkspaceScopes = useMemo(() => workspaceScopes.filter((item) => item.workspaceId && workspaceSelection.has(item.workspaceId)), [workspaceScopes, workspaceSelection]);
  const selectedScopeSummary = useMemo(() => {
    if (selectedWorkspaceScopes.length <= 1) return null;
    return selectedWorkspaceScopes.reduce<SessionScopeSummary>((summary, item) => ({
      ...summary,
      sessionCount: summary.sessionCount + item.sessionCount,
      workflowCount: summary.workflowCount + item.workflowCount,
      runningCount: summary.runningCount + item.runningCount,
      archivedCount: summary.archivedCount + item.archivedCount,
      usageTokens: summary.usageTokens + item.usageTokens,
      updatedAt: !summary.updatedAt || item.updatedAt && item.updatedAt > summary.updatedAt ? item.updatedAt : summary.updatedAt
    }), {
      id: "workspace-selection", kind: "all", workspaceId: null, name: `${selectedWorkspaceScopes.length} 个工作区`, path: "批量工作区视图",
      sessionCount: 0, workflowCount: 0, runningCount: 0, archivedCount: 0, usageTokens: 0, updatedAt: null,
      pinned: false, archivedAt: null, capabilities: []
    });
  }, [selectedWorkspaceScopes]);
  const activeScope = selectedScopeSummary || scopes.find((item) => item.id === scope) || scopes[0] || null;
  const focused = useMemo(() => response?.items.find((item) => item.id === focusedId) || null, [focusedId, response?.items]);
  const totalPages = Math.max(1, Math.ceil((response?.total || 0) / (response?.pageSize || 50)));
  const attentionCount = Math.max(response?.summary.attention || 0, repair?.issueCount || 0);
  const visibleSelectable = response?.items.filter((item) => item.source === "workbench" && WORKBENCH_BULK_CAPABILITIES.some((capability) => item.capabilities.includes(capability))) || [];
  const selectionCount = selection.mode === "ids" ? selection.ids.size : Math.max(0, selection.total - selection.excluded.size);
  const isSelected = (id: string) => selection.mode === "ids" ? selection.ids.has(id) : !selection.excluded.has(id);
  const allVisibleSelected = visibleSelectable.length > 0 && visibleSelectable.every((item) => isSelected(item.id));
  const selectionPayload = selection.mode === "ids"
    ? { mode: "ids", ids: [...selection.ids] }
    : { mode: "filter", filter, excludeIds: [...selection.excluded] };

  useEffect(() => {
    const available = new Set(workspaceScopes.map((item) => item.workspaceId!).filter(Boolean));
    setWorkspaceSelection((current) => {
      const next = retainAvailableSelection(current, available);
      return next.size === current.size ? current : next;
    });
    if (workspaceAnchorId && !available.has(workspaceAnchorId)) setWorkspaceAnchorId(null);
  }, [workspaceAnchorId, workspaceScopes]);
  useEffect(() => {
    const available = new Set(workspaceTrash.map((item) => item.id));
    setWorkspaceTrashSelection((current) => {
      const next = retainAvailableSelection(current, available);
      return next.size === current.size ? current : next;
    });
    if (workspaceTrashAnchorId && !available.has(workspaceTrashAnchorId)) setWorkspaceTrashAnchorId(null);
  }, [workspaceTrash, workspaceTrashAnchorId]);

  const selectScope = (event: React.MouseEvent, item: SessionScopeSummary) => {
    if (item.kind !== "workspace" || !item.workspaceId) {
      setWorkspaceSelection(new Set());
      setWorkspaceAnchorId(null);
      setScope(item.id);
      return;
    }
    const result = updateRangeSelection({
      orderedIds: workspaceScopes.map((scopeItem) => scopeItem.workspaceId!),
      selectedIds: workspaceSelection,
      clickedId: item.workspaceId,
      anchorId: workspaceAnchorId,
      toggle: event.ctrlKey || event.metaKey,
      range: event.shiftKey
    });
    setWorkspaceSelection(result.selectedIds);
    setWorkspaceAnchorId(result.anchorId);
    if (result.selectedIds.size === 1) {
      const selectedId = [...result.selectedIds][0];
      setScope(`workspace:${selectedId}`);
    } else setScope("all");
  };

  const toggleItem = (id: string) => setSelection((current) => {
    if (current.mode === "ids") {
      const ids = new Set(current.ids);
      if (ids.has(id)) ids.delete(id); else ids.add(id);
      return { mode: "ids", ids };
    }
    const excluded = new Set(current.excluded);
    if (excluded.has(id)) excluded.delete(id); else excluded.add(id);
    return { ...current, excluded };
  });

  const selectSessionItem = (event: React.MouseEvent, id: string) => {
    const orderedIds = visibleSelectable.map((item) => item.id);
    if (!orderedIds.includes(id)) return;
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
      toggleItem(id);
      setSessionAnchorId(id);
      return;
    }
    const selectedIds = new Set(orderedIds.filter((itemId) => isSelected(itemId)));
    const result = updateRangeSelection({
      orderedIds,
      selectedIds,
      clickedId: id,
      anchorId: sessionAnchorId,
      toggle: event.ctrlKey || event.metaKey,
      range: event.shiftKey
    });
    setSelection({ mode: "ids", ids: result.selectedIds });
    setSessionAnchorId(result.anchorId);
  };

  const toggleVisible = () => setSelection((current) => {
    if (allVisibleSelected) {
      if (current.mode === "filter") {
        const excluded = new Set(current.excluded);
        for (const item of visibleSelectable) excluded.add(item.id);
        return { ...current, excluded };
      }
      const ids = new Set(current.ids);
      for (const item of visibleSelectable) ids.delete(item.id);
      return { mode: "ids", ids };
    }
    if (current.mode === "filter") {
      const excluded = new Set(current.excluded);
      for (const item of visibleSelectable) excluded.delete(item.id);
      return { ...current, excluded };
    }
    return { mode: "ids", ids: new Set([...current.ids, ...visibleSelectable.map((item) => item.id)]) };
  });

  const beginBulk = async (action: BulkAction, singleId?: string) => {
    const payload = singleId ? { mode: "ids", ids: [singleId] } : selectionPayload;
    if (!singleId && !selectionCount) return;
    setActing(true);
    try {
      const preview = await request<OperationPreview>("/api/session-management/operations/preview", { method: "POST", body: JSON.stringify({ action, selection: payload }) });
      setPending({ kind: "bulk", action, preview });
      if (singleId) setSelection({ mode: "ids", ids: new Set([singleId]) });
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const beginWorkspaceBulk = async (action: WorkspaceAction, singleWorkspaceId?: string) => {
    const workspaceIds = singleWorkspaceId ? [singleWorkspaceId] : [...workspaceSelection];
    if (!workspaceIds.length) return;
    setActing(true);
    try {
      const preview = await request<OperationPreview>("/api/session-management/operations/preview", {
        method: "POST",
        body: JSON.stringify({ action, selection: { resourceType: "workspace", mode: "ids", ids: workspaceIds } })
      });
      setPending({ kind: "workspace", action, workspaceIds, preview });
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const confirmOperation = async () => {
    if (!pending) return;
    setActing(true);
    try {
      if (pending.kind === "workspace") {
        const result = await request<{ results: Array<{ id: string; ok: boolean; error?: string }> }>("/api/session-management/workspaces/bulk", {
          method: "POST",
          body: JSON.stringify({ action: pending.action, selection: { resourceType: "workspace", mode: "ids", ids: pending.workspaceIds } })
        });
        const failed = result.results.filter((item) => !item.ok);
        onNotice(failed.length ? `${result.results.length - failed.length} 个工作区完成，${failed.length} 个未处理` : `已处理 ${result.results.length} 个工作区`, failed.length ? "warning" : "success");
        if (pending.action === "archive" || pending.action === "delete") {
          setScope("all");
          setWorkspaceSelection(new Set());
          setWorkspaceAnchorId(null);
        }
      } else {
        const result = await request<{ results: Array<{ id: string; ok: boolean; error?: string }> }>("/api/session-management/bulk", { method: "POST", body: JSON.stringify({ action: pending.action, selection: selectionPayload }) });
        const failed = result.results.filter((item) => !item.ok);
        onNotice(failed.length ? `${result.results.length - failed.length} 项完成，${failed.length} 项未处理` : `已处理 ${result.results.length} 项`, failed.length ? "warning" : "success");
      }
      setPending(null);
      setSelection(EMPTY_SELECTION);
      setFocusedId("");
      await Promise.all([refresh(), onChanged()]);
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const restoreSession = async (item: SessionTrashItem) => {
    setActing(true);
    try {
      await request(`/api/session-management/trash/${encodeURIComponent(item.id)}/restore`, { method: "POST" });
      onNotice("会话及其子 Agent、联动关系已恢复", "success");
      await Promise.all([refresh(), onChanged()]);
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const purgeSession = async (item: SessionTrashItem) => {
    if (!window.confirm(`永久删除“${item.title}”的工作台记录与附件？项目源码和原生线程不受影响。`)) return;
    setActing(true);
    try {
      await request(`/api/session-management/trash/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      onNotice("会话已永久删除", "success");
      await refresh();
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const restoreWorkspace = async (item: WorkspaceTrashItem) => {
    setActing(true);
    try {
      const result = await request<{ remainingSessionCount: number }>(`/api/session-management/workspace-trash/${encodeURIComponent(item.id)}/restore`, { method: "POST" });
      onNotice(result.remainingSessionCount ? `工作区已恢复，仍有 ${result.remainingSessionCount} 个会话可重试` : "工作区及其会话已恢复", result.remainingSessionCount ? "warning" : "success");
      await Promise.all([refresh(), onChanged()]);
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const purgeWorkspace = async (item: WorkspaceTrashItem) => {
    if (!window.confirm(`永久清理“${item.workspaceName}”的工作台会话与任务编排？项目目录和原生线程会保留。`)) return;
    setActing(true);
    try {
      await request(`/api/session-management/workspace-trash/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      onNotice("工作区的工作台记录已永久清理", "success");
      await refresh();
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const updateWorkspaceMetadata = async (workspaceId: string, body: { name?: string; pinned?: boolean; archived?: boolean }) => {
    setActing(true);
    try {
      await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/metadata`, { method: "PUT", body: JSON.stringify(body) });
      onNotice("工作区信息已更新", "success");
      await Promise.all([refresh(), onChanged()]);
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const renameSelectedWorkspace = async () => {
    const workspace = selectedWorkspaceScopes.length === 1 ? selectedWorkspaceScopes[0] : null;
    if (!workspace?.workspaceId) return;
    const name = window.prompt("修改工作区名称", workspace.name)?.trim();
    if (name && name !== workspace.name) await updateWorkspaceMetadata(workspace.workspaceId, { name });
  };

  const openSelectedWorkspaceFolder = async () => {
    const workspaceId = selectedWorkspaceScopes.length === 1 ? selectedWorkspaceScopes[0].workspaceId : null;
    if (!workspaceId) return;
    setActing(true);
    try { await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/open-folder`, { method: "POST" }); }
    catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const selectWorkspaceTrash = (event: React.MouseEvent, id: string) => {
    const result = updateRangeSelection({
      orderedIds: workspaceTrash.map((item) => item.id), selectedIds: workspaceTrashSelection, clickedId: id,
      anchorId: workspaceTrashAnchorId, toggle: event.ctrlKey || event.metaKey, range: event.shiftKey
    });
    setWorkspaceTrashSelection(result.selectedIds);
    setWorkspaceTrashAnchorId(result.anchorId);
  };

  const bulkWorkspaceTrash = async (action: "restore" | "purge") => {
    const ids = [...workspaceTrashSelection];
    if (!ids.length) return;
    if (action === "purge" && !window.confirm(`永久清理所选 ${ids.length} 个工作区的工作台记录？项目目录和原生线程仍会保留。`)) return;
    setActing(true);
    try {
      const result = await request<{ results: Array<{ id: string; ok: boolean; error?: string }> }>("/api/session-management/workspace-trash/bulk", { method: "POST", body: JSON.stringify({ action, ids }) });
      const failed = result.results.filter((item) => !item.ok);
      onNotice(failed.length ? `${result.results.length - failed.length} 项完成，${failed.length} 项需要处理` : `已完成 ${result.results.length} 项`, failed.length ? "warning" : "success");
      setWorkspaceTrashSelection(new Set(failed.map((item) => item.id)));
      await Promise.all([refresh(), onChanged()]);
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const runRepair = async (applySafe: boolean) => {
    setActing(true);
    try {
      const report = await request<RepairReport>("/api/session-management/repair", { method: "POST", body: JSON.stringify({ applySafe }) });
      setRepair(report);
      onNotice(applySafe ? `安全修复完成：处理 ${report.repairedCount} 项` : `检查完成：发现 ${report.issueCount} 项`, report.issueCount && !applySafe ? "warning" : "success");
      if (applySafe) await Promise.all([refresh(), onChanged()]);
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const savePreferences = async () => {
    if (!preferences) return;
    setActing(true);
    try {
      setPreferences(await request<SessionManagementPreferences>("/api/session-management/preferences", { method: "PUT", body: JSON.stringify(preferences) }));
      onNotice("会话管理设置已保存", "success");
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const importSession = async (file: File | undefined) => {
    if (!file) return;
    setActing(true);
    try {
      if (file.size > 1_800_000) throw new Error("会话包超过 1.8 MB 导入上限");
      const result = await request<{ session: { id: string } }>("/api/session-management/import", { method: "POST", body: JSON.stringify(JSON.parse(await file.text())) });
      onNotice("会话已作为新的工作台任务导入", "success");
      await Promise.all([refresh(true), onChanged()]);
      onOpenSession(result.session.id);
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); if (importInput.current) importInput.current.value = ""; }
  };

  const renameItem = async (item: SessionInventoryItem) => {
    const name = window.prompt("修改名称", item.title)?.trim();
    if (!name || name === item.title) return;
    setActing(true);
    try {
      if (item.source === "codex-official") await request(`/api/codex-link/threads/${encodeURIComponent(item.resourceId)}/metadata`, { method: "PATCH", body: JSON.stringify({ name }) });
      else if (item.source === "workbench" && item.kind === "workflow") await request(`/api/workflows/${encodeURIComponent(item.resourceId)}/metadata`, { method: "PUT", body: JSON.stringify({ title: name }) });
      else if (item.source === "workbench") await request(`/api/sessions/${encodeURIComponent(item.resourceId)}/metadata`, { method: "PUT", body: JSON.stringify({ title: name }) });
      else throw new Error("该来源不支持重命名");
      onNotice("名称已更新", "success");
      await Promise.all([refresh(true), onChanged()]);
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const branchItem = async (item: SessionInventoryItem) => {
    setActing(true);
    try {
      if (item.source === "codex-official") {
        await request(`/api/codex-link/threads/${encodeURIComponent(item.resourceId)}/fork`, { method: "POST", body: JSON.stringify({}) });
        onNotice("已创建官方 Codex 线程分支", "success");
        await refresh(true);
      } else if (item.source === "workbench" && item.kind === "session" && item.branchAnchorId) {
        const branch = await request<{ id: string }>(`/api/sessions/${encodeURIComponent(item.resourceId)}/branch`, { method: "POST", body: JSON.stringify({ messageId: item.branchAnchorId }) });
        onNotice("已创建工作台会话分支", "success");
        await onChanged();
        onOpenSession(branch.id);
      } else throw new Error("当前项目没有可用的分支点");
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const adoptCodexThread = async (item: SessionInventoryItem) => {
    setActing(true);
    try {
      const result = await request<{ session: { id: string }; created: boolean }>(`/api/session-management/native/codex/${encodeURIComponent(item.resourceId)}/adopt`, { method: "POST" });
      onNotice(result.created ? "已创建工作台接管任务" : "该线程已经由工作台接管", "success");
      await onChanged();
      onOpenSession(result.session.id);
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const toggleArchiveItem = async (item: SessionInventoryItem) => {
    const unarchive = item.capabilities.includes("unarchive");
    if (item.source === "workbench") return beginBulk(unarchive ? "unarchive" : "archive", item.id);
    if (item.source !== "codex-official") return;
    setActing(true);
    try {
      await request(`/api/codex-link/threads/${encodeURIComponent(item.resourceId)}/${unarchive ? "unarchive" : "archive"}`, { method: "POST" });
      onNotice(unarchive ? "官方线程已恢复" : "官方线程已归档", "success");
      setFocusedId("");
      await refresh(true);
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const deleteNativeCodexThread = async (item: SessionInventoryItem) => {
    if (!window.confirm(`永久删除官方 Codex 线程“${item.title}”及其派生线程？此操作不进入工作台回收站，无法撤销。`)) return;
    setActing(true);
    try {
      await request(`/api/codex-link/threads/${encodeURIComponent(item.resourceId)}`, { method: "DELETE", body: JSON.stringify({ confirmDescendants: true }) });
      onNotice("官方 Codex 线程已永久删除", "success");
      setFocusedId("");
      await refresh(true);
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setActing(false); }
  };

  const openItem = (item: SessionInventoryItem) => item.kind === "workflow" ? onOpenWorkflow(item.resourceId) : onOpenSession(item.resourceId);

  return <section className={`session-management-view ${embedded ? "embedded" : ""}`}>
    <header className="session-management-heading">
      <div>{embedded ? <h2>会话管理</h2> : <h1>会话管理</h1>}<p>按工作区管理任务、编排与可恢复记录，项目文件和原生历史始终独立。</p></div>
      <div className="session-management-heading-actions"><input ref={importInput} className="session-import-input" type="file" accept="application/json,.json" onChange={(event) => void importSession(event.target.files?.[0])} /><button type="button" disabled={acting} onClick={() => importInput.current?.click()}><Upload size={15} />导入</button><button type="button" disabled={loading || acting} onClick={() => void refresh(true)}><RefreshCw className={loading ? "spin" : ""} size={15} />刷新</button></div>
    </header>

    <nav className="session-management-tabs" aria-label="会话管理类别">
      <button className={section === "inventory" ? "active" : ""} onClick={() => setSection("inventory")}><History size={15} />会话<span>{response?.summary.total || 0}</span></button>
      <button className={section === "health" ? "active" : ""} onClick={() => setSection("health")}><HeartPulse size={15} />健康<span className={attentionCount ? "attention" : ""}>{attentionCount}</span></button>
      <button className={section === "trash" ? "active" : ""} onClick={() => setSection("trash")}><Trash2 size={15} />回收站<span>{trash.length + workspaceTrash.length}</span></button>
      <button className={section === "preferences" ? "active" : ""} onClick={() => setSection("preferences")}><Settings2 size={15} />设置</button>
    </nav>

    {(section === "inventory" || section === "health") && <div className={`session-console ${focused ? "with-detail" : ""}`}>
      <aside className="session-scope-sidebar">
        <header><strong>工作区</strong><span>{workspaceSelection.size ? `已选 ${workspaceSelection.size}` : workspaceScopes.length}</span></header>
        <div className="session-scope-list" role="listbox" aria-label="工作区范围" aria-multiselectable="true" onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();
            setWorkspaceSelection(new Set(workspaceScopes.map((item) => item.workspaceId!).filter(Boolean)));
            setWorkspaceAnchorId(workspaceScopes[0]?.workspaceId || null);
          } else if (event.key === "Escape") {
            setWorkspaceSelection(new Set());
            setWorkspaceAnchorId(null);
            setScope("all");
          }
        }}>{scopes.map((item) => {
          const selected = Boolean(item.workspaceId && workspaceSelection.has(item.workspaceId));
          const active = item.kind === "workspace"
            ? workspaceSelection.size === 1 && scope === item.id
            : workspaceSelection.size === 0 && scope === item.id;
          return <button key={item.id} role="option" aria-selected={selected || active} className={`${active ? "active" : ""} ${selected ? "selected" : ""}`} onClick={(event) => selectScope(event, item)}>
            <span className="session-scope-select" aria-hidden="true">{selected ? <Check size={11} /> : scopeIcon(item.kind)}</span>
            <span><strong>{item.name}</strong><small>{item.sessionCount} 会话{item.workflowCount ? ` · ${item.workflowCount} 编排` : ""}{item.archivedAt ? " · 已归档" : ""}</small></span>
            {item.pinned && <Pin className="session-scope-pinned" size={11} />}{item.runningCount > 0 && <i>{item.runningCount}</i>}
          </button>;
        })}</div>
      </aside>

      <main className="session-console-main">
        <header className="session-scope-heading"><div><strong>{activeScope?.name || "全部会话"}</strong><span>{activeScope?.path || "统一查看全部工作台和原生会话"}</span></div><dl><div><dt>会话</dt><dd>{activeScope?.sessionCount || 0}</dd></div><div><dt>编排</dt><dd>{activeScope?.workflowCount || 0}</dd></div><div><dt>归档</dt><dd>{activeScope?.archivedCount || 0}</dd></div></dl></header>
        {workspaceSelection.size > 0 && <div className="workspace-bulk-bar"><strong>已选择 {workspaceSelection.size} 个工作区</strong>{workspaceSelection.size === 1 && <button disabled={acting} onClick={() => void openSelectedWorkspaceFolder()}><FolderOpen size={14} />打开目录</button>}{workspaceSelection.size === 1 && <button disabled={acting} onClick={() => void renameSelectedWorkspace()}><Pencil size={14} />重命名</button>}<button disabled={acting} onClick={() => void beginWorkspaceBulk("pin")}><Pin size={14} />置顶</button><button disabled={acting} onClick={() => void beginWorkspaceBulk("unpin")}><PinOff size={14} />取消置顶</button><button disabled={acting} onClick={() => void beginWorkspaceBulk("archive")}><Archive size={14} />归档</button><button disabled={acting} onClick={() => void beginWorkspaceBulk("unarchive")}><ArchiveRestore size={14} />恢复归档</button><button className="danger" disabled={acting} onClick={() => void beginWorkspaceBulk("delete")}><Trash2 size={14} />移除</button><button className="quiet" onClick={() => { setWorkspaceSelection(new Set()); setWorkspaceAnchorId(null); setScope("all"); }}>取消</button></div>}
        <div className="session-management-toolbar"><label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话、路径或线程 ID" />{query && <button aria-label="清除" onClick={() => setQuery("")}><X size={13} /></button>}</label><select value={source} onChange={(event) => setSource(event.target.value)}><option value="all">全部来源</option>{sourceFacets.map((item) => <option key={item.id} value={item.id}>{item.label}（{item.count}）</option>)}</select><select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="all">全部主脑</option>{providerFacets.map((item) => <option key={item.id} value={item.id}>{item.label}（{item.count}）</option>)}</select><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option><option value="running">执行中</option><option value="completed">已完成</option><option value="failed">失败</option><option value="archived">已归档</option></select>{section === "health" && <select value={health} onChange={(event) => setHealth(event.target.value)}><option value="all">全部健康状态</option><option value="healthy">正常</option><option value="missing-workspace">工作区失效</option><option value="inconsistent-index">索引不一致</option></select>}</div>
        {(nativeLoading || response?.warnings?.length) ? <div className="session-native-warnings">{nativeLoading && <span className="neutral"><LoaderCircle className="spin" size={12} />正在后台同步原生会话</span>}{(response?.warnings || []).map((warning) => <span key={warning}><CircleAlert size={12} />{warning}</span>)}</div> : null}
        {selectionCount > 0 && <div className="session-bulk-bar"><strong>已选择 {selectionCount} 项</strong>{selection.mode === "ids" && response && response.selectionTotal > selectionCount && allVisibleSelected && <button className="select-filter" onClick={() => setSelection({ mode: "filter", excluded: new Set(), total: response.selectionTotal })}>选择当前筛选下全部 {response.selectionTotal} 项</button>}<button disabled={acting} onClick={() => void beginBulk("pin")}><Pin size={14} />置顶</button><button disabled={acting} onClick={() => void beginBulk("unpin")}><PinOff size={14} />取消置顶</button><button disabled={acting} onClick={() => void beginBulk("archive")}><Archive size={14} />归档</button><button disabled={acting} onClick={() => void beginBulk("unarchive")}><ArchiveRestore size={14} />取消归档</button><button className="danger" disabled={acting} onClick={() => void beginBulk("delete")}><Trash2 size={14} />删除</button><button className="quiet" onClick={() => setSelection(EMPTY_SELECTION)}>取消</button></div>}
        <div className="session-inventory-table" tabIndex={0} aria-label="会话列表" aria-multiselectable="true" onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();
            setSelection({ mode: "ids", ids: new Set(visibleSelectable.map((item) => item.id)) });
            setSessionAnchorId(visibleSelectable[0]?.id || null);
          } else if (event.key === "Escape") {
            setSelection(EMPTY_SELECTION);
            setSessionAnchorId(null);
          }
        }}>
          <div className="session-inventory-head"><input type="checkbox" aria-label="选择当前页" disabled={!visibleSelectable.length} checked={allVisibleSelected} onChange={toggleVisible} /><span>会话</span><span>状态</span><span>活动</span></div>
          {loading && !response ? <div className="session-management-empty"><LoaderCircle className="spin" size={20} />正在读取会话</div> : response?.items.length ? response.items.map((item) => {
            const selectable = item.source === "workbench" && WORKBENCH_BULK_CAPABILITIES.some((capability) => item.capabilities.includes(capability));
            return <div className={`session-inventory-row ${focusedId === item.id ? "focused" : ""}`} key={item.id} data-selected={selectable ? isSelected(item.id) : undefined}>
              <label className="session-row-check"><input aria-label={`选择 ${item.title}`} type="checkbox" disabled={!selectable} checked={isSelected(item.id)} onChange={() => { if (selectable) { toggleItem(item.id); setSessionAnchorId(item.id); } }} /></label>
              <button type="button" className="session-row-content" aria-label={`${item.title}，${STATUS_LABELS[item.status] || item.status}`} onClick={(event) => {
                if (selectable && (event.ctrlKey || event.metaKey || event.shiftKey)) selectSessionItem(event, item.id);
                else setFocusedId(item.id);
              }}><span className="session-row-title"><ProviderIcon provider={item.provider} size={19} /><i><strong>{item.title}</strong><small>{item.kind === "workflow" ? "任务编排" : sourceLabel(item.source)}{item.linked ? " · 已联动" : ""}{item.pinned ? " · 已置顶" : ""}</small></i></span><span><i className={`session-health-badge health-${item.health}`}>{item.health === "healthy" ? <Check size={11} /> : <CircleAlert size={11} />}{HEALTH_LABELS[item.health] || item.health}</i><small>{item.archivedAt ? "已归档" : STATUS_LABELS[item.status] || item.status}</small></span><span className="session-row-time"><strong>{relativeTime(item.updatedAt)}</strong><small>{item.messageCount} 条记录</small></span></button>
            </div>;
          }) : <div className="session-management-empty"><History size={20} /><strong>没有匹配的会话</strong><span>调整工作区或筛选条件后重试。</span></div>}
          <footer className="session-pagination"><span>共 {response?.total || 0} 项</span><div><button disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}><ChevronLeft size={14} /></button><i>{page} / {totalPages}</i><button disabled={page >= totalPages || loading} onClick={() => setPage(page + 1)}><ChevronRight size={14} /></button></div></footer>
        </div>
        {section === "health" && <section className="session-health-actions"><div><ShieldCheck size={19} /><span><strong>一致性检查</strong><small>扫描失效工作区、孤立子 Agent、过期租约和联动残留。</small></span></div><button disabled={acting} onClick={() => void runRepair(false)}>{acting ? <LoaderCircle className="spin" size={14} /> : <HeartPulse size={14} />}运行检查</button><button disabled={acting} onClick={() => void runRepair(true)}>应用安全修复</button>{repair && <p>最近检查 {relativeTime(repair.scannedAt)} · 发现 {repair.issueCount} 项 · 已修复 {repair.repairedCount} 项</p>}</section>}
      </main>

      {focused && <aside className="session-detail-panel"><header><ProviderIcon provider={focused.provider} size={22} /><div><strong>{focused.title}</strong><span>{focused.resourceId}</span></div><button aria-label="关闭详情" onClick={() => setFocusedId("")}><X size={14} /></button></header><dl><div><dt>类型</dt><dd>{focused.kind === "workflow" ? "任务编排" : "普通会话"}</dd></div><div><dt>来源</dt><dd>{sourceLabel(focused.source)}{focused.linked ? " · 已联动" : ""}</dd></div><div><dt>工作区</dt><dd>{focused.workspaceName || "未绑定"}</dd></div><div><dt>路径</dt><dd>{focused.workspacePath || "-"}</dd></div><div><dt>原生线程</dt><dd>{focused.nativeThreadId || "未建立"}</dd></div><div><dt>记录</dt><dd>{focused.messageCount} 条</dd></div></dl>{focused.issues.length > 0 && <div className="session-detail-issues">{focused.issues.map((issue) => <p key={`${issue.code}:${issue.message}`}><CircleAlert size={13} /><span><strong>{HEALTH_LABELS[issue.code]}</strong>{issue.message}</span></p>)}</div>}<div className="session-detail-actions">{focused.capabilities.includes("open") && <button onClick={() => openItem(focused)}>{focused.kind === "workflow" ? <Workflow size={14} /> : <History size={14} />}打开</button>}{focused.source === "codex-official" && focused.capabilities.includes("resume") && <button disabled={acting} onClick={() => void adoptCodexThread(focused)}><History size={14} />接管继续</button>}{focused.capabilities.includes("rename") && <button disabled={acting} onClick={() => void renameItem(focused)}><Pencil size={14} />重命名</button>}{focused.source === "workbench" && focused.capabilities.includes("pin") && <button disabled={acting} onClick={() => void beginBulk("pin", focused.id)}><Pin size={14} />置顶</button>}{focused.source === "workbench" && focused.capabilities.includes("unpin") && <button disabled={acting} onClick={() => void beginBulk("unpin", focused.id)}><PinOff size={14} />取消置顶</button>}{focused.capabilities.includes("branch") && <button disabled={acting} onClick={() => void branchItem(focused)}><GitBranch size={14} />创建分支</button>}{(focused.capabilities.includes("archive") || focused.capabilities.includes("unarchive")) && <button disabled={acting} onClick={() => void toggleArchiveItem(focused)}>{focused.capabilities.includes("unarchive") ? <ArchiveRestore size={14} /> : <Archive size={14} />}{focused.capabilities.includes("unarchive") ? "恢复归档" : "归档"}</button>}{focused.kind === "session" && focused.capabilities.includes("export") && <button onClick={() => downloadSession(focused.resourceId, "markdown")}><FileText size={14} />Markdown</button>}{focused.kind === "session" && focused.capabilities.includes("export") && <button onClick={() => downloadSession(focused.resourceId, "json")}><FileJson size={14} />完整包</button>}{focused.capabilities.includes("delete") && <button className="danger" disabled={acting} onClick={() => void beginBulk("delete", focused.id)}><Trash2 size={14} />移入回收站</button>}{focused.capabilities.includes("delete-native") && <button className="danger" disabled={acting} onClick={() => void deleteNativeCodexThread(focused)}><Trash2 size={14} />永久删除</button>}{focused.source === "claude-native" && <p className="session-native-readonly">Claude 原生历史当前保持只读，工作台不会直接改写转录文件。</p>}</div></aside>}
    </div>}

    {section === "trash" && <div className="session-trash-list">{workspaceTrash.length > 0 && <section><header><FolderArchive size={16} /><div><strong>工作区恢复批次</strong><span>恢复时会重新加入工作区并恢复其中的普通会话。</span></div></header>{workspaceTrashSelection.size > 0 && <div className="workspace-trash-bulk-bar"><strong>已选择 {workspaceTrashSelection.size} 个恢复批次</strong><button disabled={acting} onClick={() => void bulkWorkspaceTrash("restore")}><ArchiveRestore size={14} />恢复</button><button className="danger" disabled={acting} onClick={() => void bulkWorkspaceTrash("purge")}><Trash2 size={14} />永久清理</button><button className="quiet" onClick={() => { setWorkspaceTrashSelection(new Set()); setWorkspaceTrashAnchorId(null); }}>取消</button></div>}{workspaceTrash.map((item) => {
      const selected = workspaceTrashSelection.has(item.id);
      return <article className={`workspace-trash-row ${selected ? "selected" : ""}`} key={item.id} onClick={(event) => selectWorkspaceTrash(event, item.id)} onContextMenu={(event) => { if (!selected) selectWorkspaceTrash(event, item.id); }}><button type="button" className="session-trash-check" aria-label={`选择 ${item.workspaceName}`} aria-pressed={selected} onClick={(event) => { event.stopPropagation(); selectWorkspaceTrash(event, item.id); }}>{selected ? <Check size={13} /> : <Folder size={16} />}</button><div><strong>{item.workspaceName}</strong><span title={item.workspacePath}>{item.workspacePath}</span><small>{item.sessionCount} 会话 · {item.workflowCount} 编排 · 原生历史 {item.nativeCount} 条保留</small>{item.error && <em>{item.error}</em>}</div><button disabled={acting} onClick={(event) => { event.stopPropagation(); void restoreWorkspace(item); }}><ArchiveRestore size={14} />恢复</button><button className="danger" disabled={acting} onClick={(event) => { event.stopPropagation(); void purgeWorkspace(item); }}><Trash2 size={14} />永久清理</button></article>;
    })}</section>}<section><header><History size={16} /><div><strong>单独删除的会话</strong><span>保留期结束前可以恢复完整工作台记录。</span></div></header>{trash.length ? trash.map((item) => <article key={item.id}><ProviderIcon provider={item.provider} size={20} /><div><strong>{item.title}</strong><span>{item.workspacePath || "临时任务"}</span><small>删除于 {relativeTime(item.deletedAt)} · 保留至 {new Date(item.expiresAt).toLocaleDateString("zh-CN")}</small>{item.error && <em>{item.error}</em>}</div><button disabled={acting} onClick={() => void restoreSession(item)}><ArchiveRestore size={14} />恢复</button><button className="danger" disabled={acting} onClick={() => void purgeSession(item)}><Trash2 size={14} />永久删除</button></article>) : <div className="session-management-empty compact"><Trash2 size={20} /><strong>没有单独删除的会话</strong></div>}</section></div>}

    {section === "preferences" && preferences && <div className="session-preferences"><section><header><ShieldCheck size={18} /><div><strong>诊断与修复</strong><span>只自动处理索引、租约等可重建状态。</span></div></header><label><span><strong>启动时快速检查</strong><small>不扫描完整消息正文。</small></span><input type="checkbox" checked={preferences.quickCheckOnStartup} onChange={(event) => setPreferences({ ...preferences, quickCheckOnStartup: event.target.checked })} /></label><label><span><strong>自动应用安全修复</strong><small>不会覆盖或删除原始对话。</small></span><input type="checkbox" checked={preferences.autoRepairSafeIssues} onChange={(event) => setPreferences({ ...preferences, autoRepairSafeIssues: event.target.checked })} /></label><label><span><strong>包含原生会话</strong><small>同步显示 Codex 官方与 Claude 原生会话。</small></span><input type="checkbox" checked={preferences.includeNativeSessions} onChange={(event) => setPreferences({ ...preferences, includeNativeSessions: event.target.checked })} /></label></section><section><header><Trash2 size={18} /><div><strong>保留与分页</strong><span>控制回收站周期和单页读取预算。</span></div></header><label><span><strong>回收站保留</strong><small>到期后允许后台永久清理。</small></span><select value={preferences.trashRetentionDays} onChange={(event) => setPreferences({ ...preferences, trashRetentionDays: Number(event.target.value) })}><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option><option value={365}>365 天</option></select></label><label><span><strong>每页会话数量</strong><small>较小分页可降低大型会话库的渲染压力。</small></span><select value={preferences.pageSize} onChange={(event) => setPreferences({ ...preferences, pageSize: Number(event.target.value) })}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label></section><button className="session-preferences-save" disabled={acting} onClick={() => void savePreferences()}>{acting ? <LoaderCircle className="spin" size={14} /> : <Settings2 size={14} />}保存设置</button></div>}

    {pending && <div className="session-operation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !acting) setPending(null); }}><section className="session-operation-dialog" role="dialog" aria-modal="true" aria-labelledby="session-operation-title"><header><div><strong id="session-operation-title">{operationTitle(pending)}</strong><span>执行前影响预览</span></div><button aria-label="关闭" disabled={acting} onClick={() => setPending(null)}><X size={15} /></button></header>{pending.preview.workspace && <div className="session-operation-workspace"><Folder size={18} /><span><strong>{pending.preview.workspace.name}</strong><small>{pending.preview.workspace.path}</small></span></div>}{pending.preview.workspaces && pending.preview.workspaces.length > 1 && <div className="session-operation-workspaces">{pending.preview.workspaces.slice(0, 6).map((workspace) => <span key={workspace.id}><Folder size={13} />{workspace.name}</span>)}</div>}<div className="session-operation-counts"><div><strong>{pending.preview.sessionCount}</strong><span>普通会话</span></div><div><strong>{pending.preview.workflowCount}</strong><span>任务编排</span></div>{pending.preview.delegatedTaskCount !== undefined && <div><strong>{pending.preview.delegatedTaskCount}</strong><span>子 Agent</span></div>}{pending.preview.nativeCount !== undefined && <div><strong>{pending.preview.nativeCount}</strong><span>原生历史</span></div>}</div>{pending.kind === "workspace" && pending.action === "delete" && <div className="session-preservation-note"><ShieldCheck size={16} /><span><strong>项目文件与原生线程不会删除</strong><small>这里只移除工作台导航和工作台自有记录；恢复前 Workflow 会暂时隐藏。</small></span></div>}{pending.preview.blockers.length > 0 && <div className="session-operation-blockers"><strong><CircleAlert size={14} />{pending.preview.blockerCount} 项暂时不能处理</strong>{pending.preview.blockers.map((item) => <p key={item.id}><span>{item.title}</span><small>{item.reason}</small></p>)}</div>}<footer><button disabled={acting} onClick={() => setPending(null)}>取消</button><button className={pending.action === "delete" ? "danger" : "primary"} disabled={acting || (pending.kind === "workspace" && pending.preview.blockerCount > 0) || (pending.kind === "bulk" && pending.preview.actionableCount === 0)} onClick={() => void confirmOperation()}>{acting ? <LoaderCircle className="spin" size={14} /> : pending.action === "delete" ? <Trash2 size={14} /> : <Check size={14} />}{pending.kind === "workspace" && pending.action === "delete" ? "移入回收站" : "确认处理"}</button></footer></section></div>}
  </section>;
}
