import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SESSION_MANAGEMENT_PREFERENCES,
  type SessionManagementPreferences,
  type SessionTrashItem,
  type WorkspaceTrashItem,
  type WorkspaceTrashSnapshot
} from "./types.js";

type TrashRow = {
  id: string;
  session_id: string;
  owner_user_id: string;
  title: string;
  provider: string;
  workspace_id: string | null;
  workspace_path: string | null;
  snapshot_path: string;
  batch_id: string | null;
  deleted_at: string;
  expires_at: string;
  status: "ready" | "restoring" | "failed";
  error: string | null;
};

function trashFromRow(row: TrashRow): SessionTrashItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerUserId: row.owner_user_id,
    title: row.title,
    provider: row.provider,
    workspaceId: row.workspace_id,
    workspacePath: row.workspace_path,
    snapshotPath: row.snapshot_path,
    batchId: row.batch_id,
    deletedAt: row.deleted_at,
    expiresAt: row.expires_at,
    status: row.status,
    error: row.error
  };
}

type WorkspaceTrashRow = {
  id: string;
  owner_user_id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_path: string;
  session_count: number;
  workflow_count: number;
  native_count: number;
  snapshot_json: string;
  deleted_at: string;
  expires_at: string;
  status: "ready" | "restoring" | "failed";
  error: string | null;
};

function workspaceTrashFromRow(row: WorkspaceTrashRow): WorkspaceTrashItem {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    workspacePath: row.workspace_path,
    sessionCount: row.session_count,
    workflowCount: row.workflow_count,
    nativeCount: row.native_count,
    snapshot: JSON.parse(row.snapshot_json) as WorkspaceTrashSnapshot,
    deletedAt: row.deleted_at,
    expiresAt: row.expires_at,
    status: row.status,
    error: row.error
  };
}

function normalizePreferences(value: unknown): SessionManagementPreferences {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<SessionManagementPreferences> : {};
  const retention = Number(input.trashRetentionDays);
  const pageSize = Number(input.pageSize);
  return {
    quickCheckOnStartup: input.quickCheckOnStartup !== false,
    autoRepairSafeIssues: input.autoRepairSafeIssues === true,
    includeNativeSessions: input.includeNativeSessions !== false,
    trashRetentionDays: Number.isSafeInteger(retention) ? Math.min(365, Math.max(1, retention)) : DEFAULT_SESSION_MANAGEMENT_PREFERENCES.trashRetentionDays,
    pageSize: [25, 50, 100].includes(pageSize) ? pageSize : DEFAULT_SESSION_MANAGEMENT_PREFERENCES.pageSize
  };
}

export class SessionManagementRepository {
  readonly db: DatabaseSync;

  constructor(runtimeDir: string) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    this.db = new DatabaseSync(path.join(runtimeDir, "session-management.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS session_trash (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        provider TEXT NOT NULL,
        workspace_id TEXT,
        workspace_path TEXT,
        snapshot_path TEXT NOT NULL,
        batch_id TEXT,
        deleted_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        error TEXT,
        UNIQUE(owner_user_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_trash_owner ON session_trash(owner_user_id, deleted_at DESC);
      CREATE TABLE IF NOT EXISTS workspace_trash (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        session_count INTEGER NOT NULL,
        workflow_count INTEGER NOT NULL,
        native_count INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        error TEXT,
        UNIQUE(owner_user_id, workspace_id)
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_trash_owner ON workspace_trash(owner_user_id, deleted_at DESC);
      CREATE TABLE IF NOT EXISTS session_management_preferences (
        owner_user_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_management_actions (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        session_id TEXT,
        action TEXT NOT NULL,
        success INTEGER NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_actions_owner ON session_management_actions(owner_user_id, created_at DESC);
    `);
    const trashColumns = this.db.prepare("PRAGMA table_info(session_trash)").all() as Array<{ name: string }>;
    if (!trashColumns.some((column) => column.name === "batch_id")) this.db.exec("ALTER TABLE session_trash ADD COLUMN batch_id TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_session_trash_batch ON session_trash(owner_user_id, batch_id)");
  }

  preferences(ownerUserId: string) {
    const row = this.db.prepare("SELECT json FROM session_management_preferences WHERE owner_user_id = ?").get(ownerUserId) as { json: string } | undefined;
    try { return normalizePreferences(row ? JSON.parse(row.json) : undefined); }
    catch { return { ...DEFAULT_SESSION_MANAGEMENT_PREFERENCES }; }
  }

  savePreferences(ownerUserId: string, value: unknown) {
    const preferences = normalizePreferences(value);
    this.db.prepare(`
      INSERT INTO session_management_preferences (owner_user_id, json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(owner_user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `).run(ownerUserId, JSON.stringify(preferences), new Date().toISOString());
    return preferences;
  }

  createTrash(input: Omit<SessionTrashItem, "id" | "status" | "error" | "batchId"> & { batchId?: string | null }) {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO session_trash (id, session_id, owner_user_id, title, provider, workspace_id, workspace_path, snapshot_path, batch_id, deleted_at, expires_at, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL)
      ON CONFLICT(owner_user_id, session_id) DO UPDATE SET
        title = excluded.title,
        provider = excluded.provider,
        workspace_id = excluded.workspace_id,
        workspace_path = excluded.workspace_path,
        snapshot_path = excluded.snapshot_path,
        batch_id = excluded.batch_id,
        deleted_at = excluded.deleted_at,
        expires_at = excluded.expires_at,
        status = 'ready',
        error = NULL
    `).run(id, input.sessionId, input.ownerUserId, input.title, input.provider, input.workspaceId, input.workspacePath, input.snapshotPath, input.batchId || null, input.deletedAt, input.expiresAt);
    return this.bySession(input.ownerUserId, input.sessionId)!;
  }

  listTrash(ownerUserId: string) {
    return (this.db.prepare("SELECT * FROM session_trash WHERE owner_user_id = ? AND batch_id IS NULL ORDER BY deleted_at DESC").all(ownerUserId) as unknown as TrashRow[]).map(trashFromRow);
  }

  listTrashByBatch(ownerUserId: string, batchId: string) {
    return (this.db.prepare("SELECT * FROM session_trash WHERE owner_user_id = ? AND batch_id = ? ORDER BY deleted_at DESC").all(ownerUserId, batchId) as unknown as TrashRow[]).map(trashFromRow);
  }

  getTrash(ownerUserId: string, id: string) {
    const row = this.db.prepare("SELECT * FROM session_trash WHERE owner_user_id = ? AND id = ?").get(ownerUserId, id) as unknown as TrashRow | undefined;
    return row ? trashFromRow(row) : null;
  }

  bySession(ownerUserId: string, sessionId: string) {
    const row = this.db.prepare("SELECT * FROM session_trash WHERE owner_user_id = ? AND session_id = ?").get(ownerUserId, sessionId) as unknown as TrashRow | undefined;
    return row ? trashFromRow(row) : null;
  }

  setTrashStatus(ownerUserId: string, id: string, status: SessionTrashItem["status"], error: string | null = null) {
    this.db.prepare("UPDATE session_trash SET status = ?, error = ? WHERE owner_user_id = ? AND id = ?").run(status, error, ownerUserId, id);
  }

  removeTrash(ownerUserId: string, id: string) {
    return this.db.prepare("DELETE FROM session_trash WHERE owner_user_id = ? AND id = ?").run(ownerUserId, id).changes > 0;
  }

  expiredTrash(at = new Date().toISOString()) {
    return (this.db.prepare("SELECT * FROM session_trash WHERE expires_at <= ? AND status = 'ready' AND batch_id IS NULL").all(at) as unknown as TrashRow[]).map(trashFromRow);
  }

  createWorkspaceTrash(input: Omit<WorkspaceTrashItem, "id" | "status" | "error">) {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO workspace_trash (id, owner_user_id, workspace_id, workspace_name, workspace_path, session_count, workflow_count, native_count, snapshot_json, deleted_at, expires_at, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL)
      ON CONFLICT(owner_user_id, workspace_id) DO UPDATE SET
        workspace_name = excluded.workspace_name,
        workspace_path = excluded.workspace_path,
        session_count = excluded.session_count,
        workflow_count = excluded.workflow_count,
        native_count = excluded.native_count,
        snapshot_json = excluded.snapshot_json,
        deleted_at = excluded.deleted_at,
        expires_at = excluded.expires_at,
        status = 'ready',
        error = NULL
    `).run(id, input.ownerUserId, input.workspaceId, input.workspaceName, input.workspacePath, input.sessionCount, input.workflowCount, input.nativeCount, JSON.stringify(input.snapshot), input.deletedAt, input.expiresAt);
    return this.workspaceTrashByWorkspace(input.ownerUserId, input.workspaceId)!;
  }

  listWorkspaceTrash(ownerUserId: string) {
    return (this.db.prepare("SELECT * FROM workspace_trash WHERE owner_user_id = ? ORDER BY deleted_at DESC").all(ownerUserId) as unknown as WorkspaceTrashRow[]).map(workspaceTrashFromRow);
  }

  getWorkspaceTrash(ownerUserId: string, id: string) {
    const row = this.db.prepare("SELECT * FROM workspace_trash WHERE owner_user_id = ? AND id = ?").get(ownerUserId, id) as unknown as WorkspaceTrashRow | undefined;
    return row ? workspaceTrashFromRow(row) : null;
  }

  workspaceTrashByWorkspace(ownerUserId: string, workspaceId: string) {
    const row = this.db.prepare("SELECT * FROM workspace_trash WHERE owner_user_id = ? AND workspace_id = ?").get(ownerUserId, workspaceId) as unknown as WorkspaceTrashRow | undefined;
    return row ? workspaceTrashFromRow(row) : null;
  }

  setWorkspaceTrashStatus(ownerUserId: string, id: string, status: WorkspaceTrashItem["status"], error: string | null = null) {
    this.db.prepare("UPDATE workspace_trash SET status = ?, error = ? WHERE owner_user_id = ? AND id = ?").run(status, error, ownerUserId, id);
  }

  updateWorkspaceTrashSnapshot(ownerUserId: string, id: string, snapshot: WorkspaceTrashSnapshot) {
    this.db.prepare("UPDATE workspace_trash SET snapshot_json = ?, session_count = ?, workflow_count = ? WHERE owner_user_id = ? AND id = ?")
      .run(JSON.stringify(snapshot), snapshot.sessionTrashIds.length, snapshot.workflowIds.length, ownerUserId, id);
  }

  removeWorkspaceTrash(ownerUserId: string, id: string) {
    return this.db.prepare("DELETE FROM workspace_trash WHERE owner_user_id = ? AND id = ?").run(ownerUserId, id).changes > 0;
  }

  expiredWorkspaceTrash(at = new Date().toISOString()) {
    return (this.db.prepare("SELECT * FROM workspace_trash WHERE expires_at <= ? AND status = 'ready'").all(at) as unknown as WorkspaceTrashRow[]).map(workspaceTrashFromRow);
  }

  log(ownerUserId: string, sessionId: string | null, action: string, success: boolean, detail: unknown = {}) {
    this.db.prepare("INSERT INTO session_management_actions (id, owner_user_id, session_id, action, success, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), ownerUserId, sessionId, action, success ? 1 : 0, JSON.stringify(detail), new Date().toISOString());
  }

  close() { this.db.close(); }
}
