import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import type { CodexLinkThread } from "../codexLink/types.js";
import type { SessionInventoryItem } from "./types.js";

type WorkspaceRef = { id: string; name: string; root: string };

function epochIso(value: unknown) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return new Date(0).toISOString();
  return new Date(numeric < 100_000_000_000 ? numeric * 1_000 : numeric).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  const item = record(value);
  return String(item.text || item.content || "");
}

async function claudeTranscriptFiles(root: string, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (results.length >= limit) break;
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "subagents") continue;
        results.push(...await claudeTranscriptFiles(file, limit - results.length));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) results.push(file);
    }
    return results;
  } catch { return []; }
}

async function claudeTranscriptSummary(file: string, knownThreadIds: Set<string>): Promise<SessionInventoryItem | null> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    const stat = await fsp.stat(file);
    handle = await fsp.open(file, "r");
    const readSize = Math.min(stat.size, 32 * 1024);
    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, 0);
    await handle.close();
    handle = null;
    const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
    const records: Record<string, unknown>[] = [];
    for (const line of lines) {
      try { records.push(record(JSON.parse(line))); } catch { /* Ignore a partial live line. */ }
      if (records.length >= 80) break;
    }
    if (!records.length) return null;
    const sessionId = String(records.find((item) => item.sessionId)?.sessionId || path.basename(file, ".jsonl"));
    if (!sessionId || knownThreadIds.has(sessionId)) return null;
    const cwd = String(records.find((item) => item.cwd)?.cwd || "");
    const userRecord = records.find((item) => item.type === "user" || record(item.message).role === "user");
    const title = contentText(record(userRecord?.message).content || userRecord?.content).trim().replace(/\s+/g, " ").slice(0, 120) || `Claude 会话 ${sessionId.slice(0, 8)}`;
    const createdAt = String(records.find((item) => item.timestamp)?.timestamp || stat.birthtime.toISOString());
    const updatedAt = stat.mtime.toISOString();
    const workspaceExists = cwd ? await fsp.stat(cwd).then((item) => item.isDirectory()).catch(() => false) : false;
    return {
      id: `claude-native:${sessionId}`,
      resourceId: sessionId,
      kind: "session",
      source: "claude-native",
      provider: "claude",
      title,
      workspaceId: null,
      workspaceName: cwd ? path.basename(cwd) : null,
      workspacePath: cwd || null,
      status: "read-only",
      createdAt,
      updatedAt,
      messageCount: records.filter((item) => ["user", "assistant"].includes(String(item.type || record(item.message).role))).length,
      usageTokens: 0,
      archivedAt: null,
      pinned: false,
      branchAnchorId: null,
      nativeThreadId: sessionId,
      linked: false,
      health: cwd && !workspaceExists ? "missing-workspace" : "healthy",
      issues: cwd && !workspaceExists ? [{ code: "missing-workspace", severity: "warning", message: "Claude 原生会话的工作目录已失效", repairable: false }] : [],
      capabilities: []
    };
  } catch { return null; }
  finally { await handle?.close().catch(() => undefined); }
}

export async function listClaudeNativeSessions(root: string, knownThreadIds: Set<string>, limit = 250) {
  const files = await claudeTranscriptFiles(path.join(root, "projects"), limit);
  const results: SessionInventoryItem[] = [];
  for (let index = 0; index < files.length; index += 8) {
    const chunk = await Promise.all(files.slice(index, index + 8).map((file) => claudeTranscriptSummary(file, knownThreadIds)));
    results.push(...chunk.filter((item): item is SessionInventoryItem => Boolean(item)));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return results.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function codexOfficialInventory(threads: CodexLinkThread[], workspaces: WorkspaceRef[], knownThreadIds: Set<string>, includeUnmatched = false) {
  const byPath = new Map(workspaces.map((workspace) => [path.resolve(workspace.root).toLowerCase(), workspace]));
  return threads.filter((thread) => {
    if (knownThreadIds.has(thread.id)) return false;
    if (includeUnmatched) return true;
    return Boolean(thread.cwd && byPath.has(path.resolve(thread.cwd).toLowerCase()));
  }).map((thread): SessionInventoryItem => {
    const workspace = thread.cwd ? byPath.get(path.resolve(thread.cwd).toLowerCase()) : undefined;
    const workspaceMissing = Boolean(thread.cwd && !fs.existsSync(thread.cwd));
    const active = thread.status.type === "active";
    return {
      id: `codex-official:${thread.id}`,
      resourceId: thread.id,
      kind: "session",
      source: "codex-official",
      provider: "codex",
      title: thread.name || thread.preview || `Codex 会话 ${thread.id.slice(0, 8)}`,
      workspaceId: workspace?.id || null,
      workspaceName: workspace?.name || (thread.cwd ? path.basename(thread.cwd) : null),
      workspacePath: thread.cwd || null,
      status: thread.archived ? "archived" : thread.status.type,
      createdAt: epochIso(thread.createdAt),
      updatedAt: epochIso(thread.updatedAt || thread.createdAt),
      messageCount: thread.turnCount || 0,
      usageTokens: 0,
      archivedAt: thread.archived ? epochIso(thread.updatedAt || thread.createdAt) : null,
      pinned: thread.isPinned,
      branchAnchorId: null,
      nativeThreadId: thread.id,
      linked: false,
      health: workspaceMissing ? "missing-workspace" : thread.status.type === "active" ? "running" : "healthy",
      issues: workspaceMissing ? [{ code: "missing-workspace", severity: "warning", message: "官方 Codex 会话的原始项目目录已经失效", repairable: false }] : [],
      capabilities: [
        "rename",
        ...(thread.archived ? ["unarchive"] as const : active ? [] : ["archive"] as const),
        ...(!active ? ["delete-native"] as const : []),
        ...(thread.resumable && !thread.archived && !active ? ["resume", "branch"] as const : [])
      ]
    };
  });
}
