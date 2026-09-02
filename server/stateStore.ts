import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type JsonRecord = object;
type SessionMessageRecord = JsonRecord & { id: string };
type SessionRecord = JsonRecord & { id: string; revision?: number; updatedAt?: string; messages?: SessionMessageRecord[] };
type DelegatedTaskRecord = JsonRecord & { id: string; updatedAt?: string; parentSessionId?: string };
type NamedRecord = JsonRecord & { id: string };
type SkillFolderRecord = NamedRecord & { ownerUserId?: string };
type SkillOrganizationRecord = NamedRecord & { ownerUserId?: string; skillName?: string };
type CapabilityProfileRecord = NamedRecord & { ownerUserId?: string; updatedAt?: string };
type ProviderConnectionRecord = NamedRecord & { ownerUserId?: string; providerId?: string; updatedAt?: string };

export type PersistedWorkbenchState = {
  settings: JsonRecord;
  workspaces: NamedRecord[];
  sessions: SessionRecord[];
  delegatedTasks: DelegatedTaskRecord[];
  mcpServers: NamedRecord[];
  skillFolders: SkillFolderRecord[];
  skillOrganizations: SkillOrganizationRecord[];
  capabilityProfiles: CapabilityProfileRecord[];
  providerConnections: ProviderConnectionRecord[];
  delegationProtocolVersion?: number;
};

export type StateChanges = {
  settings: boolean;
  workspaceIds: string[];
  sessionIds: string[];
  delegatedTaskIds: string[];
  delegatedParentSessionIds: string[];
  mcpServerIds: string[];
  skillFolderIds: string[];
  skillOrganizationIds: string[];
  capabilityProfileIds: string[];
  providerConnectionIds: string[];
  deletedWorkspaceIds: string[];
  deletedSessionIds: string[];
  deletedDelegatedTaskIds: string[];
  deletedMcpServerIds: string[];
  deletedSkillFolderIds: string[];
  deletedSkillOrganizationIds: string[];
  deletedCapabilityProfileIds: string[];
  deletedProviderConnectionIds: string[];
  workspaceOwnerUserIds: string[];
  mcpServerOwnerUserIds: string[];
  skillOwnerUserIds: string[];
  providerConnectionOwnerUserIds: string[];
};

type CacheEntry = { marker: string; json: string };
type MessageCacheEntry = { position: number; snapshot: Record<string, unknown>; json: string };

function sessionMarker(item: SessionRecord, position: number) {
  // Session revisions are advanced whenever persisted session state changes.
  // Keeping message bodies out of the marker avoids serializing multi-megabyte
  // histories merely to discover that another session was unchanged.
  return `${position}:${item.revision || 0}:${item.updatedAt || ""}`;
}

function sessionMetadataJson(item: SessionRecord) {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === "messages" || key === "toJSON") continue;
    metadata[key] = value;
  }
  return JSON.stringify(metadata);
}

function messageSnapshot(item: SessionMessageRecord) {
  return Object.fromEntries(Object.entries(item).filter(([key]) => key !== "toJSON"));
}

function messageSnapshotEquals(entry: MessageCacheEntry, item: SessionMessageRecord, position: number) {
  if (entry.position !== position) return false;
  const current = messageSnapshot(item);
  const keys = Object.keys(current);
  const previousKeys = Object.keys(entry.snapshot);
  return keys.length === previousKeys.length && keys.every((key) => entry.snapshot[key] === current[key]);
}

export class WorkbenchStateStore {
  readonly db: DatabaseSync;
  readonly file: string;
  private cache = {
    settings: "",
    workspaces: new Map<string, CacheEntry>(),
    sessions: new Map<string, CacheEntry>(),
    sessionMessages: new Map<string, Map<string, MessageCacheEntry>>(),
    delegatedTasks: new Map<string, CacheEntry>(),
    mcpServers: new Map<string, CacheEntry>(),
    skillFolders: new Map<string, CacheEntry>(),
    skillOrganizations: new Map<string, CacheEntry>(),
    capabilityProfiles: new Map<string, CacheEntry>(),
    providerConnections: new Map<string, CacheEntry>()
  };

  constructor(runtimeDir: string) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    this.file = path.join(runtimeDir, "workbench-state.db");
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS state_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, position INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, position INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_messages (session_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (session_id, id), FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS delegated_tasks (id TEXT PRIMARY KEY, position INTEGER NOT NULL, updated_at TEXT NOT NULL, parent_session_id TEXT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, position INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skill_folders (id TEXT PRIMARY KEY, position INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skill_organizations (id TEXT PRIMARY KEY, position INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capability_profiles (id TEXT PRIMARY KEY, position INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_connections (id TEXT PRIMARY KEY, position INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_delegated_parent ON delegated_tasks(parent_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_messages_position ON session_messages(session_id, position);
    `);
  }

  hasState() {
    return Boolean(this.db.prepare("SELECT 1 FROM settings WHERE id = 1").get());
  }

  load(): PersistedWorkbenchState | null {
    const settingsRow = this.db.prepare("SELECT json FROM settings WHERE id = 1").get() as { json: string } | undefined;
    if (!settingsRow) return null;
    const read = <T extends JsonRecord>(table: string) => (this.db.prepare(`SELECT json FROM ${table} ORDER BY position ASC`).all() as Array<{ json: string }>).map((row) => JSON.parse(row.json) as T);
    const settings = JSON.parse(settingsRow.json) as JsonRecord;
    const workspaces = read<NamedRecord>("workspaces");
    const messageRows = this.db.prepare("SELECT session_id, json FROM session_messages ORDER BY session_id, position").all() as Array<{ session_id: string; json: string }>;
    const messagesBySession = new Map<string, SessionMessageRecord[]>();
    for (const row of messageRows) {
      const messages = messagesBySession.get(row.session_id) || [];
      messages.push(JSON.parse(row.json) as SessionMessageRecord);
      messagesBySession.set(row.session_id, messages);
    }
    const legacySessionIds = new Set<string>();
    const sessions = read<SessionRecord>("sessions").map((session) => {
      const legacyMessages = Array.isArray(session.messages) ? session.messages : [];
      const normalizedMessages = messagesBySession.get(session.id);
      if (Array.isArray(session.messages)) legacySessionIds.add(session.id);
      return { ...session, messages: normalizedMessages || legacyMessages };
    });
    if (legacySessionIds.size) this.migrateLegacySessionStorage(sessions, legacySessionIds);
    const delegatedTasks = read<DelegatedTaskRecord>("delegated_tasks");
    const mcpServers = read<NamedRecord>("mcp_servers");
    const skillFolders = read<SkillFolderRecord>("skill_folders");
    const skillOrganizations = read<SkillOrganizationRecord>("skill_organizations");
    const capabilityProfiles = read<CapabilityProfileRecord>("capability_profiles");
    const providerConnections = read<ProviderConnectionRecord>("provider_connections");
    const protocolRow = this.db.prepare("SELECT value FROM state_meta WHERE key = 'delegationProtocolVersion'").get() as { value: string } | undefined;
    this.rebuildCache({ settings, workspaces, sessions, delegatedTasks, mcpServers, skillFolders, skillOrganizations, capabilityProfiles, providerConnections });
    return { settings, workspaces, sessions, delegatedTasks, mcpServers, skillFolders, skillOrganizations, capabilityProfiles, providerConnections, delegationProtocolVersion: Number(protocolRow?.value || 2) };
  }

  save(state: PersistedWorkbenchState): StateChanges {
    const changes: StateChanges = {
      settings: false, workspaceIds: [], sessionIds: [], delegatedTaskIds: [], delegatedParentSessionIds: [], mcpServerIds: [], skillFolderIds: [], skillOrganizationIds: [], capabilityProfileIds: [], providerConnectionIds: [],
      deletedWorkspaceIds: [], deletedSessionIds: [], deletedDelegatedTaskIds: [], deletedMcpServerIds: [], deletedSkillFolderIds: [], deletedSkillOrganizationIds: [], deletedCapabilityProfileIds: [], deletedProviderConnectionIds: [],
      workspaceOwnerUserIds: [], mcpServerOwnerUserIds: [], skillOwnerUserIds: [], providerConnectionOwnerUserIds: []
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const settingsJson = JSON.stringify(state.settings);
      if (settingsJson !== this.cache.settings) {
        this.db.prepare("INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(settingsJson);
        this.cache.settings = settingsJson;
        changes.settings = true;
      }
      this.syncRows("workspaces", state.workspaces, this.cache.workspaces, changes.workspaceIds, changes.deletedWorkspaceIds, (item, position) => `${position}:${JSON.stringify(item)}`,
        "INSERT INTO workspaces (id, position, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, json = excluded.json",
        undefined,
        (item) => { const owner = String((item as NamedRecord & { ownerUserId?: unknown }).ownerUserId || ""); if (owner) changes.workspaceOwnerUserIds.push(owner); });
      this.syncSessions(state.sessions, changes.sessionIds, changes.deletedSessionIds);
      this.syncRows("delegated_tasks", state.delegatedTasks, this.cache.delegatedTasks, changes.delegatedTaskIds, changes.deletedDelegatedTaskIds, (item, position) => `${position}:${item.updatedAt || ""}:${JSON.stringify(item)}`,
        "INSERT INTO delegated_tasks (id, position, updated_at, parent_session_id, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at, parent_session_id = excluded.parent_session_id, json = excluded.json",
        (item, position, json) => [item.id, position, item.updatedAt || "", item.parentSessionId || null, json],
        (item) => { if (item.parentSessionId) changes.delegatedParentSessionIds.push(item.parentSessionId); });
      this.syncRows("mcp_servers", state.mcpServers, this.cache.mcpServers, changes.mcpServerIds, changes.deletedMcpServerIds, (item, position) => `${position}:${JSON.stringify(item)}`,
        "INSERT INTO mcp_servers (id, position, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, json = excluded.json",
        undefined,
        (item) => { const owner = String((item as NamedRecord & { ownerUserId?: unknown }).ownerUserId || ""); if (owner) changes.mcpServerOwnerUserIds.push(owner); });
      this.syncRows("skill_folders", state.skillFolders, this.cache.skillFolders, changes.skillFolderIds, changes.deletedSkillFolderIds, (item, position) => `${position}:${JSON.stringify(item)}`,
        "INSERT INTO skill_folders (id, position, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, json = excluded.json",
        undefined,
        (item) => { if (item.ownerUserId) changes.skillOwnerUserIds.push(item.ownerUserId); });
      this.syncRows("skill_organizations", state.skillOrganizations, this.cache.skillOrganizations, changes.skillOrganizationIds, changes.deletedSkillOrganizationIds, (item, position) => `${position}:${JSON.stringify(item)}`,
        "INSERT INTO skill_organizations (id, position, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, json = excluded.json",
        undefined,
        (item) => { if (item.ownerUserId) changes.skillOwnerUserIds.push(item.ownerUserId); });
      this.syncRows("capability_profiles", state.capabilityProfiles || [], this.cache.capabilityProfiles, changes.capabilityProfileIds, changes.deletedCapabilityProfileIds, (item, position) => `${position}:${item.updatedAt || ""}:${JSON.stringify(item)}`,
        "INSERT INTO capability_profiles (id, position, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, json = excluded.json",
        undefined,
        (item) => { if (item.ownerUserId) changes.skillOwnerUserIds.push(item.ownerUserId); });
      this.syncRows("provider_connections", state.providerConnections || [], this.cache.providerConnections, changes.providerConnectionIds, changes.deletedProviderConnectionIds, (item, position) => `${position}:${item.updatedAt || ""}:${JSON.stringify(item)}`,
        "INSERT INTO provider_connections (id, position, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, json = excluded.json",
        undefined,
        (item) => { if (item.ownerUserId) changes.providerConnectionOwnerUserIds.push(item.ownerUserId); });
      this.db.prepare("INSERT INTO state_meta (key, value) VALUES ('delegationProtocolVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(state.delegationProtocolVersion || 2));
      this.db.exec("COMMIT");
      changes.delegatedParentSessionIds = [...new Set(changes.delegatedParentSessionIds)];
      return changes;
    } catch (error) {
      // SQLite may roll back automatically for errors such as SQLITE_FULL.
      // A second rollback must never hide the original persistence failure.
      try { this.db.exec("ROLLBACK"); } catch { /* The transaction already ended. */ }
      if (this.hasState()) this.load();
      else this.resetCache();
      throw error;
    }
  }

  checkpoint() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close() {
    this.db.close();
  }

  private syncRows<T extends NamedRecord>(
    table: string,
    items: T[],
    cache: Map<string, CacheEntry>,
    changed: string[],
    deleted: string[],
    markerFor: (item: T, position: number) => string,
    sql: string,
    valuesFor: (item: T, position: number, json: string) => unknown[] = (item, position, json) => [item.id, position, json],
    onChanged?: (item: T) => void
  ) {
    const present = new Set(items.map((item) => item.id));
    const statement = this.db.prepare(sql);
    items.forEach((item, position) => {
      const marker = markerFor(item, position);
      const existing = cache.get(item.id);
      if (existing?.marker === marker) return;
      const json = JSON.stringify(item);
      statement.run(...valuesFor(item, position, json) as never[]);
      cache.set(item.id, { marker, json });
      changed.push(item.id);
      onChanged?.(item);
    });
    for (const id of [...cache.keys()]) {
      if (present.has(id)) continue;
      if (table === "delegated_tasks") {
        const json = cache.get(id)?.json;
        if (json) {
          const parentSessionId = (JSON.parse(json) as DelegatedTaskRecord).parentSessionId;
          if (parentSessionId) onChanged?.({ id, parentSessionId } as unknown as T);
        }
      }
      this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      cache.delete(id);
      deleted.push(id);
    }
  }

  private syncSessions(items: SessionRecord[], changed: string[], deleted: string[]) {
    const present = new Set(items.map((item) => item.id));
    const statement = this.db.prepare("INSERT INTO sessions (id, position, revision, updated_at, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, revision = excluded.revision, updated_at = excluded.updated_at, json = excluded.json");
    items.forEach((item, position) => {
      const marker = sessionMarker(item, position);
      const existing = this.cache.sessions.get(item.id);
      if (existing?.marker === marker) return;
      const json = sessionMetadataJson(item);
      statement.run(item.id, position, item.revision || 0, item.updatedAt || "", json);
      this.cache.sessions.set(item.id, { marker, json });
      this.syncSessionMessages(item.id, item.messages || []);
      changed.push(item.id);
    });
    for (const id of [...this.cache.sessions.keys()]) {
      if (present.has(id)) continue;
      this.db.prepare("DELETE FROM session_messages WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      this.cache.sessions.delete(id);
      this.cache.sessionMessages.delete(id);
      deleted.push(id);
    }
  }

  private syncSessionMessages(sessionId: string, messages: SessionMessageRecord[]) {
    const cache = this.cache.sessionMessages.get(sessionId) || new Map<string, MessageCacheEntry>();
    const present = new Set(messages.map((message) => message.id));
    const statement = this.db.prepare("INSERT INTO session_messages (session_id, id, position, json) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, id) DO UPDATE SET position = excluded.position, json = excluded.json");
    messages.forEach((message, position) => {
      const existing = cache.get(message.id);
      if (existing && messageSnapshotEquals(existing, message, position)) return;
      const snapshot = messageSnapshot(message);
      const json = JSON.stringify(snapshot);
      statement.run(sessionId, message.id, position, json);
      cache.set(message.id, { position, snapshot, json });
    });
    for (const id of [...cache.keys()]) {
      if (present.has(id)) continue;
      this.db.prepare("DELETE FROM session_messages WHERE session_id = ? AND id = ?").run(sessionId, id);
      cache.delete(id);
    }
    this.cache.sessionMessages.set(sessionId, cache);
  }

  private migrateLegacySessionStorage(sessions: SessionRecord[], legacySessionIds: Set<string>) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updateSession = this.db.prepare("UPDATE sessions SET json = ? WHERE id = ?");
      const insertMessage = this.db.prepare("INSERT INTO session_messages (session_id, id, position, json) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, id) DO UPDATE SET position = excluded.position, json = excluded.json");
      for (const session of sessions) {
        if (!legacySessionIds.has(session.id)) continue;
        updateSession.run(sessionMetadataJson(session), session.id);
        (session.messages || []).forEach((message, position) => insertMessage.run(session.id, message.id, position, JSON.stringify(messageSnapshot(message))));
      }
      this.db.exec("COMMIT");
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private rebuildCache(state: Omit<PersistedWorkbenchState, "delegationProtocolVersion">) {
    this.resetCache();
    this.cache.settings = JSON.stringify(state.settings);
    state.workspaces.forEach((item, position) => this.cache.workspaces.set(item.id, { marker: `${position}:${JSON.stringify(item)}`, json: JSON.stringify(item) }));
    state.sessions.forEach((item, position) => {
      const json = sessionMetadataJson(item);
      this.cache.sessions.set(item.id, { marker: sessionMarker(item, position), json });
      const messages = new Map<string, MessageCacheEntry>();
      (item.messages || []).forEach((message, messagePosition) => {
        const snapshot = messageSnapshot(message);
        messages.set(message.id, { position: messagePosition, snapshot, json: JSON.stringify(snapshot) });
      });
      this.cache.sessionMessages.set(item.id, messages);
    });
    state.delegatedTasks.forEach((item, position) => this.cache.delegatedTasks.set(item.id, { marker: `${position}:${item.updatedAt || ""}:${JSON.stringify(item)}`, json: JSON.stringify(item) }));
    state.mcpServers.forEach((item, position) => this.cache.mcpServers.set(item.id, { marker: `${position}:${JSON.stringify(item)}`, json: JSON.stringify(item) }));
    state.skillFolders.forEach((item, position) => this.cache.skillFolders.set(item.id, { marker: `${position}:${JSON.stringify(item)}`, json: JSON.stringify(item) }));
    state.skillOrganizations.forEach((item, position) => this.cache.skillOrganizations.set(item.id, { marker: `${position}:${JSON.stringify(item)}`, json: JSON.stringify(item) }));
    (state.capabilityProfiles || []).forEach((item, position) => this.cache.capabilityProfiles.set(item.id, { marker: `${position}:${item.updatedAt || ""}:${JSON.stringify(item)}`, json: JSON.stringify(item) }));
    (state.providerConnections || []).forEach((item, position) => this.cache.providerConnections.set(item.id, { marker: `${position}:${item.updatedAt || ""}:${JSON.stringify(item)}`, json: JSON.stringify(item) }));
  }

  private resetCache() {
    this.cache.settings = "";
    this.cache.workspaces.clear();
    this.cache.sessions.clear();
    this.cache.sessionMessages.clear();
    this.cache.delegatedTasks.clear();
    this.cache.mcpServers.clear();
    this.cache.skillFolders.clear();
    this.cache.skillOrganizations.clear();
    this.cache.capabilityProfiles.clear();
    this.cache.providerConnections.clear();
  }
}
