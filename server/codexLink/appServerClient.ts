import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { CodexLinkThread, CodexLinkThreadRead } from "./types.js";

type JsonObject = Record<string, unknown>;
export type CodexAppServerInbound =
  | { kind: "response"; id: number; result?: unknown; error?: unknown }
  | { kind: "notification"; method: string; params: JsonObject }
  | { kind: "request"; id: number; method: string; params: JsonObject }
  | { kind: "invalid" };
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function objectOf(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

export function classifyAppServerMessage(value: unknown): CodexAppServerInbound {
  const message = objectOf(value);
  const method = typeof message.method === "string" ? message.method : "";
  if (typeof message.id === "number" && method) return { kind: "request", id: message.id, method, params: objectOf(message.params) };
  if (method) return { kind: "notification", method, params: objectOf(message.params) };
  if (typeof message.id === "number") return { kind: "response", id: message.id, result: message.result, error: message.error };
  return { kind: "invalid" };
}

export function normalizeCodexThread(value: unknown, archived = false): CodexLinkThread {
  const thread = objectOf(value);
  const status = objectOf(thread.status);
  const gitInfo = objectOf(thread.gitInfo);
  const turns = Array.isArray(thread.turns) ? thread.turns : undefined;
  const historyMode = thread.historyMode === "legacy" || thread.historyMode === "paginated" ? thread.historyMode : "unknown";
  return {
    id: String(thread.id || ""),
    name: typeof thread.name === "string" && thread.name.trim() ? thread.name : null,
    preview: String(thread.preview || thread.name || ""),
    cwd: String(thread.cwd || gitInfo.cwd || ""),
    modelProvider: String(thread.modelProvider || ""),
    sourceKind: String(thread.sourceKind || thread.source || "unknown"),
    createdAt: Number(thread.createdAt || 0),
    updatedAt: Number(thread.updatedAt || thread.createdAt || 0),
    status: {
      type: String(status.type || "unknown"),
      ...(Array.isArray(status.activeFlags) ? { activeFlags: status.activeFlags.map(String) } : {})
    },
    forkedFromId: typeof thread.forkedFromId === "string" ? thread.forkedFromId : null,
    isPinned: Boolean(thread.isPinned),
    archived: Boolean(thread.archived ?? archived),
    ...(turns ? { turnCount: turns.length } : {}),
    historyMode,
    resumable: historyMode === "legacy" || historyMode === "paginated"
  };
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join("\n");
  const record = objectOf(value);
  return String(record.text || record.content || record.message || "");
}

function summarizeTurn(value: unknown) {
  const turn = objectOf(value);
  const items = Array.isArray(turn.items) ? turn.items.map(objectOf) : [];
  const userItem = items.find((item) => /user/i.test(String(item.type || "")));
  const assistantItems = items.filter((item) => /agentmessage|assistant/i.test(String(item.type || "")));
  return {
    id: String(turn.id || ""),
    status: String(turn.status || "unknown"),
    userText: textFromContent(userItem?.content || userItem?.text).slice(0, 1_200),
    assistantText: assistantItems.map((item) => textFromContent(item.content || item.text)).filter(Boolean).join("\n").slice(0, 2_400)
  };
}

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly executable: string,
    private readonly codexHome: string,
    private readonly onNotification?: (notification: { method: string; params: JsonObject; requestId?: number }) => void
  ) {}

  async listThreads(cwd: string, cursor?: string | null, archived = false) {
    const result = objectOf(await this.request("thread/list", {
      cursor: cursor || null,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived,
      sourceKinds: ["cli", "vscode", "appServer"],
      ...(cwd ? { cwd } : {})
    }));
    return {
      threads: (Array.isArray(result.data) ? result.data : []).map((thread) => normalizeCodexThread(thread, archived)).filter((thread) => thread.id),
      nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null
    };
  }

  async listAllThreads(maxPages = 5) {
    const threads = new Map<string, CodexLinkThread>();
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      for (let page = 0; page < maxPages; page += 1) {
        const result = await this.listThreads("", cursor, archived);
        for (const thread of result.threads) threads.set(thread.id, thread);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
    }
    return [...threads.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async readThread(threadId: string, includeTurns = true): Promise<CodexLinkThreadRead> {
    const summaryResult = objectOf(await this.request("thread/read", { threadId, includeTurns: false }));
    const summaryThread = objectOf(summaryResult.thread);
    const normalized = normalizeCodexThread(summaryThread);
    const compatibilityMessage = normalized.historyMode === "paginated"
      ? "该线程使用分页历史格式；当前摘要视图不加载完整历史，但仍可续接或创建分支。"
      : null;
    if (!includeTurns || normalized.historyMode === "paginated") {
      return { thread: normalized, totalTurnCount: 0, turns: [], limited: normalized.historyMode === "paginated", compatibilityMessage };
    }
    let result: JsonObject;
    try {
      result = objectOf(await this.request("thread/read", { threadId, includeTurns: true }));
    } catch (error) {
      if (/paginated_threads is not supported yet/i.test(error instanceof Error ? error.message : String(error))) {
        return { thread: { ...normalized, historyMode: "paginated", resumable: true }, totalTurnCount: 0, turns: [], limited: true, compatibilityMessage: "该线程使用分页历史格式；当前摘要视图不加载完整历史，但仍可续接或创建分支。" };
      }
      throw error;
    }
    const rawThread = objectOf(result.thread);
    const rawTurns = includeTurns && Array.isArray(rawThread.turns) ? rawThread.turns : [];
    return {
      thread: normalizeCodexThread(rawThread),
      totalTurnCount: rawTurns.length,
      turns: rawTurns.slice(-20).map(summarizeTurn),
      limited: false,
      compatibilityMessage: null
    };
  }

  async forkThread(threadId: string, lastTurnId?: string) {
    const result = objectOf(await this.request("thread/fork", {
      threadId,
      excludeTurns: true,
      ...(lastTurnId ? { lastTurnId } : {})
    }, 30_000));
    return normalizeCodexThread(result.thread);
  }

  async setThreadName(threadId: string, name: string) {
    await this.request("thread/name/set", { threadId, name }, 20_000);
  }

  async archiveThread(threadId: string) {
    await this.request("thread/archive", { threadId }, 30_000);
  }

  async unarchiveThread(threadId: string) {
    const result = objectOf(await this.request("thread/unarchive", { threadId }, 30_000));
    return normalizeCodexThread(result.thread);
  }

  async deleteThread(threadId: string) {
    await this.request("thread/delete", { threadId }, 30_000);
  }

  async health() {
    await this.ensureInitialized();
    return true;
  }

  close() {
    const process = this.process;
    this.process = null;
    this.initialization = null;
    if (process && !process.killed) process.kill();
    this.rejectPending(new Error("Codex App Server 已关闭"));
  }

  private async request(method: string, params: JsonObject, timeoutMs = 20_000): Promise<unknown> {
    await this.ensureInitialized();
    return this.sendRequest(method, params, timeoutMs);
  }

  private ensureInitialized() {
    if (this.initialization) return this.initialization;
    this.initialization = this.start().catch((error) => {
      this.close();
      throw error;
    });
    return this.initialization;
  }

  private async start() {
    const child = spawn(this.executable, ["app-server"], {
      cwd: this.codexHome,
      env: { ...process.env, CODEX_HOME: this.codexHome },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.process = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receive(line));
    child.stderr.resume();
    child.once("exit", (code, signal) => {
      if (this.process === child) this.process = null;
      this.initialization = null;
      this.rejectPending(new Error(`Codex App Server 已退出 (${code ?? signal ?? "unknown"})`));
    });
    child.once("error", (error) => this.rejectPending(error));
    await this.sendRequest("initialize", {
      clientInfo: {
        name: "meta_code_workbench",
        title: "Meta Code Workbench",
        version: "0.1.1"
      }
    }, 15_000);
    this.sendNotification("initialized", {});
  }

  private sendRequest(method: string, params: JsonObject, timeoutMs: number) {
    const id = ++this.requestId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendNotification(method: string, params: JsonObject) {
    this.write({ method, params });
  }

  private write(message: JsonObject) {
    if (!this.process?.stdin.writable) throw new Error("Codex App Server 尚未连接");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string) {
    let message: JsonObject;
    try {
      message = objectOf(JSON.parse(line));
    } catch {
      return;
    }
    const inbound = classifyAppServerMessage(message);
    if (inbound.kind === "notification" || inbound.kind === "request") {
      try { this.onNotification?.({ method: inbound.method, params: inbound.params, ...(inbound.kind === "request" ? { requestId: inbound.id } : {}) }); } catch { /* Consumer failures must not break the protocol reader. */ }
      return;
    }
    if (inbound.kind !== "response") return;
    const pending = this.pending.get(inbound.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(inbound.id);
    if (inbound.error) {
      const error = objectOf(inbound.error);
      pending.reject(new Error(String(error.message || "Codex App Server 请求失败")));
    } else {
      pending.resolve(inbound.result);
    }
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
