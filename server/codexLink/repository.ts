import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodexLinkBinding, CodexLinkLease } from "./types.js";

type BindingRow = {
  id: string;
  owner_user_id: string;
  workspace_id: string;
  session_id: string;
  thread_id: string;
  access_mode: "resume" | "readOnly";
  thread_name: string | null;
  thread_preview: string;
  previous_thread_id: string | null;
  compatibility_message: string | null;
  created_at: string;
  updated_at: string;
};

type LeaseRow = {
  owner_user_id: string;
  workspace_id: string;
  session_id: string;
  thread_id: string;
  holder: string;
  acquired_at: string;
  expires_at: string;
};

function bindingFromRow(row: BindingRow): CodexLinkBinding {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    threadId: row.thread_id,
    accessMode: row.access_mode,
    threadName: row.thread_name,
    threadPreview: row.thread_preview,
    previousThreadId: row.previous_thread_id,
    compatibilityMessage: row.compatibility_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function leaseFromRow(row: LeaseRow): CodexLinkLease {
  return {
    ownerUserId: row.owner_user_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    threadId: row.thread_id,
    holder: row.holder,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at
  };
}

export class CodexLinkRepository {
  readonly db: DatabaseSync;

  constructor(runtimeDir: string) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    this.db = new DatabaseSync(path.join(runtimeDir, "codex-link.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS codex_link_bindings (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        access_mode TEXT NOT NULL DEFAULT 'readOnly',
        thread_name TEXT,
        thread_preview TEXT NOT NULL DEFAULT '',
        previous_thread_id TEXT,
        compatibility_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_user_id, session_id),
        UNIQUE(owner_user_id, thread_id)
      );
      CREATE INDEX IF NOT EXISTS idx_codex_link_workspace
        ON codex_link_bindings(owner_user_id, workspace_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS codex_link_leases (
        thread_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        holder TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_codex_link_lease_owner
        ON codex_link_leases(owner_user_id, workspace_id, expires_at);
    `);
    const bindingColumns = new Set((this.db.prepare("PRAGMA table_info(codex_link_bindings)").all() as unknown as Array<{ name: string }>).map((column) => column.name));
    const migrations = [
      ["access_mode", "TEXT NOT NULL DEFAULT 'readOnly'"],
      ["thread_name", "TEXT"],
      ["thread_preview", "TEXT NOT NULL DEFAULT ''"],
      ["previous_thread_id", "TEXT"],
      ["compatibility_message", "TEXT"]
    ] as const;
    for (const [name, definition] of migrations) {
      if (!bindingColumns.has(name)) this.db.exec(`ALTER TABLE codex_link_bindings ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec("PRAGMA user_version = 1");
  }

  list(ownerUserId: string, workspaceId: string) {
    const rows = this.db.prepare(`
      SELECT * FROM codex_link_bindings
      WHERE owner_user_id = ? AND workspace_id = ?
      ORDER BY updated_at DESC
    `).all(ownerUserId, workspaceId) as unknown as BindingRow[];
    return rows.map(bindingFromRow);
  }

  listAll(ownerUserId: string) {
    const rows = this.db.prepare("SELECT * FROM codex_link_bindings WHERE owner_user_id = ? ORDER BY updated_at DESC").all(ownerUserId) as unknown as BindingRow[];
    return rows.map(bindingFromRow);
  }

  findBySession(ownerUserId: string, sessionId: string) {
    const row = this.db.prepare("SELECT * FROM codex_link_bindings WHERE owner_user_id = ? AND session_id = ?").get(ownerUserId, sessionId) as unknown as BindingRow | undefined;
    return row ? bindingFromRow(row) : null;
  }

  get(ownerUserId: string, bindingId: string) {
    const row = this.db.prepare("SELECT * FROM codex_link_bindings WHERE owner_user_id = ? AND id = ?").get(ownerUserId, bindingId) as unknown as BindingRow | undefined;
    return row ? bindingFromRow(row) : null;
  }

  bind(input: Omit<CodexLinkBinding, "id" | "createdAt" | "updatedAt">) {
    const now = new Date().toISOString();
    const existing = this.db.prepare(`
      SELECT * FROM codex_link_bindings WHERE owner_user_id = ? AND session_id = ?
    `).get(input.ownerUserId, input.sessionId) as unknown as BindingRow | undefined;
    const id = existing?.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO codex_link_bindings (id, owner_user_id, workspace_id, session_id, thread_id, access_mode, thread_name, thread_preview, previous_thread_id, compatibility_message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_user_id, session_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        thread_id = excluded.thread_id,
        access_mode = excluded.access_mode,
        thread_name = excluded.thread_name,
        thread_preview = excluded.thread_preview,
        previous_thread_id = excluded.previous_thread_id,
        compatibility_message = excluded.compatibility_message,
        updated_at = excluded.updated_at
    `).run(id, input.ownerUserId, input.workspaceId, input.sessionId, input.threadId, input.accessMode, input.threadName, input.threadPreview, existing?.previous_thread_id || input.previousThreadId, input.compatibilityMessage, existing?.created_at || now, now);
    return bindingFromRow(this.db.prepare("SELECT * FROM codex_link_bindings WHERE id = ?").get(id) as unknown as BindingRow);
  }

  unbind(ownerUserId: string, bindingId: string) {
    const binding = this.get(ownerUserId, bindingId);
    if (!binding) return null;
    this.db.prepare("DELETE FROM codex_link_bindings WHERE id = ? AND owner_user_id = ?").run(bindingId, ownerUserId);
    return binding;
  }

  releaseSessionLeases(ownerUserId: string, sessionId: string) {
    return this.db.prepare("DELETE FROM codex_link_leases WHERE owner_user_id = ? AND session_id = ?").run(ownerUserId, sessionId).changes;
  }

  cleanupExpiredLeases(at = new Date().toISOString()) {
    return this.db.prepare("DELETE FROM codex_link_leases WHERE expires_at <= ?").run(at).changes;
  }

  acquireLease(input: { ownerUserId: string; workspaceId: string; sessionId: string; threadId: string; holder: string; ttlMs: number }) {
    const now = new Date();
    const acquiredAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM codex_link_leases WHERE expires_at <= ?").run(acquiredAt);
      const existing = this.db.prepare("SELECT * FROM codex_link_leases WHERE thread_id = ?").get(input.threadId) as unknown as LeaseRow | undefined;
      if (existing && (existing.owner_user_id !== input.ownerUserId || existing.holder !== input.holder)) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db.prepare(`
        INSERT INTO codex_link_leases (thread_id, owner_user_id, workspace_id, session_id, holder, acquired_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          owner_user_id = excluded.owner_user_id,
          workspace_id = excluded.workspace_id,
          session_id = excluded.session_id,
          holder = excluded.holder,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at
      `).run(input.threadId, input.ownerUserId, input.workspaceId, input.sessionId, input.holder, acquiredAt, expiresAt);
      const lease = this.db.prepare("SELECT * FROM codex_link_leases WHERE thread_id = ?").get(input.threadId) as unknown as LeaseRow;
      this.db.exec("COMMIT");
      return leaseFromRow(lease);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  releaseLease(ownerUserId: string, threadId: string, holder: string) {
    return this.db.prepare("DELETE FROM codex_link_leases WHERE owner_user_id = ? AND thread_id = ? AND holder = ?").run(ownerUserId, threadId, holder).changes > 0;
  }

  close() {
    this.db.close();
  }
}
