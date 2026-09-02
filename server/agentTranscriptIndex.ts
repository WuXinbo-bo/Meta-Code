import fsp from "node:fs/promises";
import path from "node:path";

export type AgentTranscriptDescriptor = {
  file: string;
  parentThreadId: string;
  threadId: string;
  mtimeMs: number;
  size: number;
};

async function jsonlFiles(root: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) return jsonlFiles(full);
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [full] : [];
    }));
    return nested.flat();
  } catch {
    return [];
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function transcriptHeader(file: string): Promise<AgentTranscriptDescriptor | null> {
  const stat = await fsp.stat(file);
  const handle = await fsp.open(file, "r");
  try {
    const readSize = Math.min(stat.size, 128 * 1024);
    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, 0);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (stat.size > readSize) lines.pop();
    for (const line of lines) {
      if (!line.includes('"session_meta"')) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.type !== "session_meta") continue;
        const meta = recordOf(record.payload);
        const source = recordOf(meta?.source);
        const subagent = recordOf(source?.subagent);
        const spawn = recordOf(subagent?.thread_spawn);
        const parentThreadId = String(spawn?.parent_thread_id || meta?.parent_thread_id || "");
        const isSubagent = meta?.thread_source === "subagent" || Boolean(spawn);
        if (!isSubagent || !parentThreadId) return null;
        return {
          file,
          parentThreadId,
          threadId: String(meta?.id || meta?.session_id || path.basename(file, ".jsonl")),
          mtimeMs: stat.mtimeMs,
          size: stat.size
        };
      } catch {
        // Ignore a partially written metadata line and retry on the next refresh.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Indexes only the small session_meta header of Codex transcripts. Full JSONL
 * files are parsed later only for descendants of the requested parent thread.
 */
export class AgentTranscriptIndex {
  private readonly entries = new Map<string, AgentTranscriptDescriptor>();
  private readonly knownFiles = new Set<string>();
  private refreshPromise: Promise<void> | null = null;
  private refreshedAt = 0;
  private cacheLoaded = false;

  constructor(
    private readonly root: string,
    private readonly refreshTtlMs = 3_000,
    private readonly cacheFile?: string
  ) {}

  async related(parentThreadId: string): Promise<AgentTranscriptDescriptor[]> {
    await this.refresh();
    const relatedIds = new Set([parentThreadId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of this.entries.values()) {
        if (relatedIds.has(entry.parentThreadId) && !relatedIds.has(entry.threadId)) {
          relatedIds.add(entry.threadId);
          changed = true;
        }
      }
    }
    const related = [...this.entries.values()].filter((entry) => relatedIds.has(entry.parentThreadId));
    const current = await mapWithConcurrency(related, 16, async (entry) => {
      try {
        const stat = await fsp.stat(entry.file);
        entry.mtimeMs = stat.mtimeMs;
        entry.size = stat.size;
        return { file: entry.file, parentThreadId: entry.parentThreadId, threadId: entry.threadId, mtimeMs: entry.mtimeMs, size: entry.size };
      } catch {
        this.entries.delete(entry.file);
        return null;
      }
    });
    return current.filter((entry): entry is AgentTranscriptDescriptor => Boolean(entry));
  }

  private async refresh() {
    if (Date.now() - this.refreshedAt < this.refreshTtlMs) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshNow().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  private async refreshNow() {
    await this.loadCache();
    const files = await jsonlFiles(this.root);
    const seenAt = Date.now();
    const unseen = files.filter((file) => !this.knownFiles.has(file));
    const headers = await mapWithConcurrency(unseen, 24, async (file) => {
      try { return await transcriptHeader(file); }
      catch { return null; }
    });
    unseen.forEach((file) => this.knownFiles.add(file));
    for (const header of headers) if (header) this.entries.set(header.file, header);
    const liveFiles = new Set(files);
    let removed = false;
    for (const file of this.knownFiles) {
      if (liveFiles.has(file)) continue;
      this.knownFiles.delete(file);
      this.entries.delete(file);
      removed = true;
    }
    this.refreshedAt = seenAt;
    if (unseen.length || removed) await this.saveCache();
  }

  private async loadCache() {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    if (!this.cacheFile) return;
    try {
      const cached = JSON.parse(await fsp.readFile(this.cacheFile, "utf8")) as AgentTranscriptDescriptor[];
      if (!Array.isArray(cached)) return;
      const root = path.resolve(this.root);
      for (const entry of cached) {
        if (!entry || typeof entry.file !== "string" || typeof entry.parentThreadId !== "string" || typeof entry.threadId !== "string") continue;
        const file = path.resolve(entry.file);
        const relative = path.relative(root, file);
        if (!file.endsWith(".jsonl") || relative.startsWith("..") || path.isAbsolute(relative)) continue;
        const descriptor = { ...entry, file };
        this.knownFiles.add(file);
        this.entries.set(file, descriptor);
      }
    } catch {
      // Missing or invalid cache is rebuilt from transcript headers.
    }
  }

  private async saveCache() {
    if (!this.cacheFile) return;
    const temporary = `${this.cacheFile}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(path.dirname(this.cacheFile), { recursive: true });
      await fsp.writeFile(temporary, `${JSON.stringify([...this.entries.values()])}\n`, "utf8");
      await fsp.rename(temporary, this.cacheFile);
    } catch {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
