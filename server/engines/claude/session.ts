import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import readline from "node:readline";
import type { EngineUsage, NormalizedEngineEvent } from "../types.js";
import { claudeToolPermissionError, validateClaudeResult, type ClaudeTurnActivity } from "./result.js";
import { registerProcessTree, terminateProcessTree } from "../../processTree.js";
import { WorkbenchTimeoutError } from "../../orchestration/timeouts.js";
import { ClaudeTransportError, claudeApiRetryExhaustsProcess, classifyClaudeFailure, CLAUDE_DEFAULT_RETRY_POLICY, type ClaudeRetryPolicy, type ClaudeRuntimeMode } from "./transport.js";

type Options = {
  executable: string; executableArgs?: string[]; cwd: string; sessionId?: string | null;
  model?: string; baseUrl?: string; apiKey?: string; configDir: string;
  mcpConfigPath?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  outputTimeoutMs?: number;
  bridgeUrl?: string; bridgeToken?: string;
  claudeWorkerBridgeUrl?: string; claudeWorkerBridgeToken?: string; parentTaskId?: string;
  agentBridgeUrl?: string; agentBridgeToken?: string;
  disallowNativeAgents?: boolean;
  disallowedTools?: string[];
  allowedTools?: string[];
  additionalDirectories?: string[];
  includeSystemStatus?: boolean;
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  signal: AbortSignal; onEvent: (event: NormalizedEngineEvent) => Promise<void> | void;
  ownerId?: string;
};
export type ClaudeSessionTurnResult = { sessionId: string; usage: EngineUsage; failed: boolean; retryable?: boolean; transportFailure?: boolean; error?: string };
type TurnResult = ClaudeSessionTurnResult;
type Waiter = { resolve: (result: TurnResult) => void; reject: (error: unknown) => void };

export type ClaudeSessionTurnOptions = {
  createHandle: (sessionId?: string | null) => Promise<ClaudeSessionHandle>;
  handle?: ClaudeSessionHandle | null;
  sessionId?: string | null;
  prompt: string;
  sendPrompt?: boolean;
  recoveryAttempts?: number;
  signal: AbortSignal;
  onSessionId?: (sessionId: string) => Promise<void> | void;
  onRecovery?: (event: { attempt: number; maxAttempts: number; reason: string; transport: boolean }) => Promise<void> | void;
  transportRecoveryPrompt?: (reason: string) => string;
  incompleteRecoveryPrompt?: (reason: string) => string;
  keepAlive?: boolean;
  mode?: ClaudeRuntimeMode;
  retryPolicy?: Partial<ClaudeRetryPolicy>;
};

export type ClaudeSessionTurnOutcome = {
  handle: ClaudeSessionHandle;
  result: ClaudeSessionTurnResult;
};

export const CLAUDE_MAIN_DISALLOWED_TOOLS = ["Task", "Agent"] as const;
export const CLAUDE_PLANNER_DISALLOWED_TOOLS = ["Task", "Agent", "Write", "Edit", "NotebookEdit", "Bash"] as const;

export function buildClaudeSessionArgs(options: Pick<Options, "executableArgs" | "model" | "effort" | "sessionId" | "permissionMode" | "mcpConfigPath" | "disallowNativeAgents" | "disallowedTools" | "allowedTools" | "additionalDirectories">, sessionId: string) {
  const args = [
    ...(options.executableArgs || []),
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--include-partial-messages",
    "--include-hook-events",
    "--permission-mode", options.permissionMode
  ];
  const disallowedTools = [...new Set([
    ...(options.disallowNativeAgents !== false ? CLAUDE_MAIN_DISALLOWED_TOOLS : []),
    ...(options.disallowedTools || [])
  ])];
  if (disallowedTools.length) args.push("--disallowedTools", ...disallowedTools);
  const allowedTools = [...new Set(options.allowedTools || [])];
  if (allowedTools.length) args.push("--allowedTools", ...allowedTools);
  for (const directory of [...new Set(options.additionalDirectories || [])]) args.push("--add-dir", directory);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.mcpConfigPath) args.push("--mcp-config", options.mcpConfigPath, "--strict-mcp-config");
  if (options.sessionId) args.push("--resume", options.sessionId);
  else args.push("--session-id", sessionId);
  return args;
}

const emptyUsage = (): EngineUsage => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
const usageFrom = (value: any): EngineUsage => ({
  input_tokens: Number(value?.input_tokens || 0),
  cached_input_tokens: Number(value?.cache_read_input_tokens || 0) + Number(value?.cache_creation_input_tokens || 0),
  output_tokens: Number(value?.output_tokens || 0), reasoning_output_tokens: 0
});
const contentText = (content: any[]) => content.filter((item) => item?.type === "text").map((item) => String(item.text || "")).join("\n");

// Claude emits these high-frequency bookkeeping events while a turn is running.
// They do not carry user-actionable information and should not become history
// messages (the UI already has a live running indicator for this purpose).
const HIDDEN_SYSTEM_SUBTYPES = new Set(["thinking_tokens", "status"]);

function systemStatusText(item: any, subtype: string) {
  if (item.message) return String(item.message);
  if (subtype === "compact_boundary") return "上下文已压缩";
  if (subtype === "api_retry") {
    const attempt = Number(item.attempt || 0);
    const maximum = Number(item.max_retries || 0);
    const status = Number(item.error_status || 0);
    return `Claude API 请求失败，正在重试${attempt ? `（${attempt}${maximum ? `/${maximum}` : ""}）` : ""}${status ? ` · HTTP ${status}` : ""}`;
  }
  return "Claude 状态已更新";
}

export class ClaudeSessionHandle {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiters: Waiter[] = [];
  private readonly results: TurnResult[] = [];
  private closedError: unknown = null;
  private outputTimer?: NodeJS.Timeout;
  private turnInFlight = false;
  private sessionId: string;

  constructor(private readonly options: Options) {
    this.sessionId = options.sessionId || crypto.randomUUID();
    const args = buildClaudeSessionArgs(options, this.sessionId);
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: options.configDir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ANTHROPIC_MAX_RETRIES: "2" };
    if (options.baseUrl) env.ANTHROPIC_BASE_URL = options.baseUrl.replace(/\/+$/, "");
    if (options.apiKey) env.ANTHROPIC_API_KEY = options.apiKey;
    if (options.bridgeUrl) env.CLAUDE_CODEX_BRIDGE_URL = options.bridgeUrl;
    if (options.bridgeToken) env.CLAUDE_CODEX_BRIDGE_TOKEN = options.bridgeToken;
    if (options.claudeWorkerBridgeUrl) env.CLAUDE_WORKER_BRIDGE_URL = options.claudeWorkerBridgeUrl;
    if (options.claudeWorkerBridgeToken) env.CLAUDE_WORKER_BRIDGE_TOKEN = options.claudeWorkerBridgeToken;
    if (options.agentBridgeUrl) env.WORKBENCH_AGENT_BRIDGE_URL = options.agentBridgeUrl;
    if (options.agentBridgeToken) env.WORKBENCH_AGENT_BRIDGE_TOKEN = options.agentBridgeToken;
    if (options.parentTaskId) env.CLAUDE_WORKBENCH_PARENT_TASK_ID = options.parentTaskId;
    env.CLAUDE_WORKER_DEPTH = "0";
    this.child = spawn(options.executable, args, { cwd: options.cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", shell: process.platform === "win32" && /\.cmd$/i.test(options.executable) });
    registerProcessTree(options.ownerId || this.sessionId, this.child);
    void this.readOutput().catch((error) => this.fail(error));
    this.child.stderr.on("data", (chunk) => this.armTimeout(String(chunk)));
    this.child.once("error", (error) => this.fail(error));
    this.child.once("close", (code) => this.fail(this.options.signal.aborted
      ? new DOMException("Claude CLI 任务已中断", "AbortError")
      : new Error(`Claude CLI 意外退出，代码 ${code ?? "unknown"}`)));
    options.signal.addEventListener("abort", () => { terminateProcessTree(this.child); this.fail(options.signal.reason || new DOMException("Claude CLI 任务已中断", "AbortError")); }, { once: true });
  }

  get closed() { return Boolean(this.closedError) || this.child.exitCode !== null; }
  get currentSessionId() { return this.sessionId; }

  send(text: string) {
    if (this.closed) throw this.closedError || new Error("Claude CLI 会话已关闭");
    const input = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
    this.child.stdin.write(`${JSON.stringify(input)}\n`, "utf8");
    this.turnInFlight = true;
    this.armTimeout();
  }

  nextTurn() {
    if (this.results.length) return Promise.resolve(this.results.shift()!);
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise<TurnResult>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  close() {
    this.turnInFlight = false;
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.child.stdin.end();
    terminateProcessTree(this.child);
  }

  private armTimeout(_activity?: string) {
    if (!this.turnInFlight) return;
    if (this.outputTimer) clearTimeout(this.outputTimer);
    if (!this.options.outputTimeoutMs || this.options.outputTimeoutMs <= 0) {
      this.outputTimer = undefined;
      return;
    }
    this.outputTimer = setTimeout(() => {
      const error = new WorkbenchTimeoutError("inactivity", `Claude CLI 已连续 ${Math.ceil(this.options.outputTimeoutMs! / 1_000)} 秒没有输出，任务已停止。`);
      terminateProcessTree(this.child); this.fail(error);
    }, this.options.outputTimeoutMs);
  }

  private settle(result: TurnResult) {
    this.turnInFlight = false;
    if (this.outputTimer) clearTimeout(this.outputTimer);
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(result); else this.results.push(result);
  }

  private fail(error: unknown) {
    if (this.closedError) return;
    this.closedError = error;
    this.turnInFlight = false;
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.waiters.splice(0).forEach((waiter) => waiter.reject(error));
  }

  private async readOutput() {
    const partial = new Map<string, string>(); const toolNames = new Map<string, string>(); const toolInputs = new Map<string, unknown>(); const completedTools = new Set<string>(); let messageId = "";
    let activity: ClaudeTurnActivity = { assistantText: "", toolStarted: 0, toolCompleted: 0 };
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue; this.armTimeout();
      let item: any; try { item = JSON.parse(line); } catch { continue; }
      if (item.session_id) this.sessionId = String(item.session_id);
      if (item.type === "system" && item.subtype === "init") {
        await this.options.onEvent({ type: "session.started", rawType: "system.init", sessionId: this.sessionId, text: "Claude 会话已开始", payload: item });
        await this.options.onEvent({ type: "turn.started", rawType: "turn.started", text: "Working", payload: item });
      } else if (item.type === "system") {
        const subtype = String(item.subtype || "status");
        if (HIDDEN_SYSTEM_SUBTYPES.has(subtype) && !(this.options.includeSystemStatus && subtype !== "thinking_tokens")) continue;
        const sourceId = subtype === "api_retry" ? "system:api_retry" : String(item.uuid || `system:${subtype}`);
        await this.options.onEvent({ type: "status", rawType: `system.${subtype}`, sourceId, toolName: subtype, text: systemStatusText(item, subtype), payload: item });
        if (subtype === "api_retry" && (classifyClaudeFailure(item.message || item.error || item.result, item.error_status) === "permanent")) {
          const error = String(item.message || item.error || item.result || "Claude 认证或账户不可用");
          this.settle({ sessionId: this.sessionId, usage: emptyUsage(), failed: true, retryable: false, transportFailure: false, error });
          terminateProcessTree(this.child);
          return;
        }
        if (subtype === "api_retry" && claudeApiRetryExhaustsProcess(item)) {
          const error = new ClaudeTransportError("Claude 当前连接连续失败，必须重建进程并刷新通道", this.sessionId);
          this.settle({ sessionId: this.sessionId, usage: emptyUsage(), failed: true, retryable: true, transportFailure: true, error: error.message });
          terminateProcessTree(this.child);
          return;
        }
      } else if (item.type === "assistant") {
        const message = item.message || {}; const sourceId = String(message.id || item.uuid || crypto.randomUUID()); const content = Array.isArray(message.content) ? message.content : [];
        const text = contentText(content); if (text) { activity.assistantText = text; await this.options.onEvent({ type: "assistant", rawType: "assistant.text", sourceId, text, payload: item }); }
        for (const block of content) {
          if (block?.type === "thinking" && block.thinking) await this.options.onEvent({ type: "reasoning", rawType: "assistant.thinking", sourceId: `${sourceId}:thinking`, text: String(block.thinking), payload: block });
          if (block?.type === "tool_use") { const id = String(block.id || `${sourceId}:tool`); const name = String(block.name || "工具"); if (!toolNames.has(id)) activity.toolStarted += 1; toolNames.set(id, name); toolInputs.set(id, block.input || {}); await this.options.onEvent({ type: "tool.started", rawType: "assistant.tool_use", sourceId: id, toolName: name, text: JSON.stringify(block.input || {}), payload: block, detail: { input: block.input || {} } }); }
          if (block?.type && !["text", "thinking", "tool_use"].includes(String(block.type))) await this.options.onEvent({ type: "status", rawType: `assistant.${String(block.type)}`, sourceId: `${sourceId}:${String(block.type)}`, text: `Claude 返回未识别内容块：${String(block.type)}`, category: "unknown", phase: "started", detail: block });
        }
      } else if (item.type === "stream_event") {
        const event = item.event || {}; if (event.type === "message_start" && event.message?.id) messageId = String(event.message.id);
        const sourceId = String(messageId || item.parent_tool_use_id || item.uuid || this.sessionId);
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") { const next = `${partial.get(sourceId) || ""}${event.delta.text || ""}`; partial.set(sourceId, next); activity.assistantText = next; await this.options.onEvent({ type: "assistant", rawType: "stream.text_delta", sourceId, text: next, payload: item }); }
      } else if (item.type === "user") {
        for (const block of Array.isArray(item.message?.content) ? item.message.content : []) if (block?.type === "tool_result") {
          const id = String(block.tool_use_id || crypto.randomUUID());
          if (!completedTools.has(id)) activity.toolCompleted += 1;
          completedTools.add(id);
          const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content || "");
          const permissionError = claudeToolPermissionError(block);
          if (permissionError) activity.permissionError = permissionError;
          await this.options.onEvent({ type: permissionError ? "error" : "tool.completed", rawType: "user.tool_result", sourceId: id, toolName: toolNames.get(id) || "工具", text: permissionError ? `工具权限未授权：${permissionError}` : text, payload: block, detail: { input: toolInputs.get(id), output: text, result: block } });
        }
      } else if (item.type === "tool_progress" || item.type === "tool_use_summary") {
        const id = String(item.tool_use_id || item.uuid || crypto.randomUUID()); const name = String(item.tool_name || toolNames.get(id) || "工具"); if (item.tool_name) toolNames.set(id, name);
        const text = String(item.message || item.summary || "工具状态已更新");
        const permissionError = claudeToolPermissionError(item);
        if (permissionError) activity.permissionError = permissionError;
        await this.options.onEvent({ type: permissionError ? "error" : item.type === "tool_progress" ? "tool.started" : "tool.completed", rawType: item.type, sourceId: id, toolName: name, text: permissionError ? `工具权限未授权：${permissionError}` : text, payload: item, detail: { input: toolInputs.get(id), output: text, result: item } });
      } else if (item.type === "rate_limit_event" || item.type === "auth_status") {
        await this.options.onEvent({ type: "status", sourceId: String(item.uuid || item.type), toolName: item.type, text: String(item.message || "Claude 状态已更新"), payload: item });
      } else if (item.type === "result") {
        const usage = usageFrom(item.usage);
        const validation = validateClaudeResult(item, usage, activity);
        if (!validation.valid) {
          const error = validation.reason || "Claude CLI 返回了不完整结果";
          await this.options.onEvent({ type: "error", text: error, payload: { ...item, workbench_validation_error: error, retryable: validation.retryable } });
          this.settle({ sessionId: this.sessionId, usage, failed: true, retryable: validation.retryable, error });
        } else {
          await this.options.onEvent({ type: "turn.completed", rawType: "result", text: String(item.result || "Claude 任务已完成"), usage, payload: item });
          this.settle({ sessionId: this.sessionId, usage, failed: false });
        }
        partial.clear(); toolNames.clear(); toolInputs.clear(); completedTools.clear(); messageId = "";
        activity = { assistantText: "", toolStarted: 0, toolCompleted: 0 };
      } else {
        const rawType = String(item.type || "unknown");
        await this.options.onEvent({ type: "status", rawType, sourceId: String(item.uuid || `unknown:${rawType}`), text: `Claude 返回未识别事件：${rawType}`, category: "unknown", phase: "started", detail: item });
      }
    }
  }
}

const defaultTransportRecoveryPrompt = (reason: string) => [
  "上一条传输连接中断，工作台已使用最新连接配置重建 Claude 进程。",
  `连接异常：${reason}。`,
  "请从当前会话断点继续未完成的任务；先核对已有工具结果和文件，不要重复已经完成的修改。",
  "完成剩余工作并交付最终结果。"
].join("\n");

const defaultIncompleteRecoveryPrompt = (reason: string) => [
  "上一轮返回被工作台判定为不完整，任务尚未结束。",
  `原因：${reason}。`,
  "请沿用当前上下文继续实际执行未完成工作。不要只回复收到、现在开始或稍后执行；完成工具调用并交付真实结果后再结束本轮。"
].join("\n");

/** Shared recovery state machine for normal chat and workflow Claude turns. */
export async function runClaudeSessionTurn(options: ClaudeSessionTurnOptions): Promise<ClaudeSessionTurnOutcome> {
  const policy = { ...CLAUDE_DEFAULT_RETRY_POLICY, ...options.retryPolicy };
  const maximum = Math.max(0, options.recoveryAttempts ?? policy.maxRecoveries);
  let handle = options.handle && !options.handle.closed
    ? options.handle
    : await options.createHandle(options.sessionId);
  let sessionId = options.sessionId || null;
  const persistSessionId = async (value?: string | null) => {
    if (!value || value === sessionId) return;
    sessionId = value;
    await options.onSessionId?.(value);
  };
  await persistSessionId(handle.currentSessionId);
  if (options.sendPrompt !== false) handle.send(options.prompt);
  try {
    for (let attempt = 0; ; attempt += 1) {
      let result: ClaudeSessionTurnResult;
      try {
        result = await handle.nextTurn();
      } catch (error) {
        if (options.signal.aborted || attempt >= maximum) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        await persistSessionId(handle.currentSessionId);
        handle.close();
        handle = await options.createHandle(sessionId);
        await persistSessionId(handle.currentSessionId);
        await options.onRecovery?.({ attempt: attempt + 1, maxAttempts: maximum, reason, transport: true });
        handle.send((options.transportRecoveryPrompt || defaultTransportRecoveryPrompt)(reason));
        continue;
      }
      await persistSessionId(result.sessionId);
      if (!result.failed || options.signal.aborted || attempt >= maximum || !result.retryable || classifyClaudeFailure(result.error) === "permanent") {
        return { handle, result };
      }
      const reason = result.error || "Claude 未形成可验证的完整结果";
      if (result.transportFailure) {
        handle.close();
        handle = await options.createHandle(result.sessionId || sessionId);
        await persistSessionId(handle.currentSessionId);
      }
      await options.onRecovery?.({ attempt: attempt + 1, maxAttempts: maximum, reason, transport: Boolean(result.transportFailure) });
      handle.send(result.transportFailure
        ? (options.transportRecoveryPrompt || defaultTransportRecoveryPrompt)(reason)
        : (options.incompleteRecoveryPrompt || defaultIncompleteRecoveryPrompt)(reason));
    }
  } finally {
    if (!options.keepAlive) handle.close();
  }
}
