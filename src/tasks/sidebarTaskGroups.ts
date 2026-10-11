export const ACTIVE_SIDEBAR_TASK_STATUSES = new Set(["planning", "running", "paused", "queued", "integrating"]);

type TaskRecord = {
  kind: "chat" | "workflow";
  task: {
    id: string;
    title: string;
    status: string;
    updatedAt: string;
    createdAt?: string;
    workspaceId: string;
    taskContextId?: string | null;
    pinned?: boolean;
    folderId?: string | null;
    archivedAt?: string | null;
  };
};

export type SidebarTaskGroup<T extends TaskRecord> = {
  key: string;
  records: T[];
  pinned: boolean;
  mixedFolders: boolean;
  title: string;
};

export type GroupedSidebarTask<T extends TaskRecord> = T & { group: SidebarTaskGroup<T> };

/** Group presentation only: each operation still addresses one original execution record. */
export function groupSidebarTasks<T extends TaskRecord>(items: T[]): Array<GroupedSidebarTask<T>> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    // Archived executions remain individually accessible in the archive list.
    const key = !item.task.archivedAt && item.task.taskContextId
      ? `context:${item.task.taskContextId}`
      : `${item.kind}:${item.task.id}`;
    const records = groups.get(key) || [];
    records.push(item);
    groups.set(key, records);
  }
  return [...groups].map(([key, records]) => {
    const ordered = [...records].sort((left, right) =>
      Number(ACTIVE_SIDEBAR_TASK_STATUSES.has(right.task.status)) - Number(ACTIVE_SIDEBAR_TASK_STATUSES.has(left.task.status))
      || Date.parse(right.task.updatedAt) - Date.parse(left.task.updatedAt));
    return {
      ...ordered[0],
      group: {
        key,
        records,
        title: (records.find((item) => item.kind === "chat" && item.task.title.trim().length > 0 && item.task.title.trim().length <= 64 && !/^(?:新任务|新对话)$/u.test(item.task.title.trim())) || [...records].filter((item) => item.kind === "workflow").sort((a, b) => Date.parse(a.task.createdAt || a.task.updatedAt) - Date.parse(b.task.createdAt || b.task.updatedAt))[0] || ordered[0]).task.title,
        pinned: records.some((item) => Boolean(item.task.pinned)),
        mixedFolders: new Set(records.map((item) => `${item.task.workspaceId}:${item.task.folderId || ""}`)).size > 1
      }
    };
  }).sort((left, right) => Number(right.group.pinned) - Number(left.group.pinned)
    || Date.parse(right.task.updatedAt) - Date.parse(left.task.updatedAt));
}

export function sidebarTaskIsSelected<T extends TaskRecord>(item: T & { group?: SidebarTaskGroup<T> }, chatId: string, workflowId: string): boolean {
  return (item.group?.records || [item]).some((record) => record.kind === "chat"
    ? record.task.id === chatId
    : record.task.id === workflowId);
}

export function sidebarTaskIsPinned<T extends TaskRecord>(item: T & { group?: SidebarTaskGroup<T> }): boolean {
  return item.group?.pinned ?? Boolean(item.task.pinned);
}

export function sidebarTaskPinnedRecords<T extends TaskRecord>(item: T & { group?: SidebarTaskGroup<T> }): T[] {
  return (item.group?.records || [item]).filter((record) => Boolean(record.task.pinned));
}
