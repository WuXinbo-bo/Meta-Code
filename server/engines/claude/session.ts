import { claudeNativeTerminalEnvironment } from "../nativeTerminalLaunch.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import readline from "node:readline";
import type { EngineUsage, NormalizedEngineEvent } from "../types.js";
import { claudeToolPermissionError, claudeToolResultFailed, validateClaudeResult, type ClaudeTurnActivity } from "./result.js";
import { registerProcessTree, terminateProcessTree } from "../../processTree.js";
import { WorkbenchTimeoutError } from "../../orchestration/timeouts.js";
import { ClaudeTransportError, claudeApiRetryExhaustsProcess, classifyClaudeFailure, CLAUDE_DEFAULT_RETRY_POLICY, type ClaudeRetryPolicy, type ClaudeRuntimeMode } from "./transport.js";
import { ClaudeBackgroundTasks, claudeUserInput, type ClaudeInputOrigin } from "./backgroundTasks.js";
import type { NativeDecision, NativePrompt } from "../nativeInteraction.js";

type Options = {
  credentialKind?: "api-key" | "auth-token";
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
  /** Explicit [] removes all built-in tools; allowedTools is only a permission list. */
  tools?: string[];
  /** Safe, tool-free snapshot answer: disable hooks, project settings and skills. */
  snapshotOnly?: boolean;
  additionalDirectories?: string[];
  includeSystemStatus?: boolean;
  agent?: string;
  agents?: Record<string, unknown>;
  forkSourceId?: string;
  onPermission?: (prompt: Omit<NativePrompt, "id" | "sessionId" | "provider" | "createdAt">, signal: AbortSignal) => Promise<NativeDecision>;
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
  inputOrigin?: ClaudeInputOrigin;
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

/** Native recursive worker entry points are disabled for bridge/workflow runs.
 * Standalone native mode passes disallowNativeAgents:false and keeps them. */
export const CLAUDE_NATIVE_AGENT_TOOLS = ["Task", "Agent", "Workflow"] as const;
export const CLAUDE_MAIN_DISALLOWED_TOOLS = CLAUDE_NATIVE_AGENT_TOOLS;
export const CLAUDE_PLANNER_DISALLOWED_TOOLS = [...CLAUDE_NATIVE_AGENT_TOOLS, "Write", "Edit", "NotebookEdit", "Bash"] as const;

export function buildClaudeSessionArgs(options: Pick<Options, "executableArgs" | "model" | "effort" | "sessionId" | "permissionMode" | "mcpConfigPath" | "disallowNativeAgents" | "disallowedTools" | "allowedTools" | "additionalDirectories" | "tools" | "snapshotOnly" | "agent" | "agents" | "forkSourceId" | "onPermission">, sessionId: string) {
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
  if (options.tools !== undefined) args.push("--tools", options.tools.join(","));
  if (options.snapshotOnly) args.push("--safe-mode", "--disable-slash-commands", "--setting-sources", "", "--strict-mcp-config");
  for (const directory of [...new Set(options.additionalDirectories || [])]) args.push("--add-dir", directory);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.onPermission) args.push("--permission-prompt-tool", "stdio");
  if (options.agent) args.push("--agent", options.agent);
  if (options.agents) args.push("--agents", JSON.stringify(options.agents));
  if (options.mcpConfigPath) args.push("--mcp-config", options.mcpConfigPath, "--strict-mcp-config");
  if (options.forkSourceId) args.push("--resume", options.forkSourceId, "--fork-session", "--session-id", sessionId);
  else if (options.sessionId) args.push("--resume", options.sessionId);
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
  private readonly backgroundTasks = new ClaudeBackgroundTasks();
  private readonly permissionRequests = new Map<string, AbortController>();

  constructor(private readonly options: Options) {
    this.sessionId = options.sessionId || crypto.randomUUID();
    const args = buildClaudeSessionArgs(options, this.sessionId);
    const env: NodeJS.ProcessEnv = { ...claudeNativeTerminalEnvironment(process.env, options.baseUrl || "", options.credentialKind === "auth-token" ? "" : options.apiKey || "", options.credentialKind === "auth-token" ? options.apiKey || "" : ""), CLAUDE_CONFIG_DIR: options.configDir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ANTHROPIC_MAX_RETRIES: "2" };
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

  send(text: string, origin?: ClaudeInputOrigin) {
    if (this.closed) throw this.closedError || new Error("Claude CLI 会话已关闭");
    const input = claudeUserInput(text, origin);
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
    for (const request of this.permissionRequests.values()) request.abort();
  }

  private armTimeout(_activity?: string) {
    if (!this.turnInFlight) return;
    if (this.outputTimer) clearTimeout(this.outputTimer);
    if (this.permissionRequests.size) { this.outputTimer = undefined; return; }
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
    for (const request of this.permissionRequests.values()) request.abort();
    this.waiters.splice(0).forEach((waiter) => waiter.reject(error));
  }

  private async readOutput() {
    const partial = new Map<string, string>(); const partialThinking = new Map<string, string>(); const toolNames = new Map<string, string>(); const toolInputs = new Map<string, unknown>(); const completedTools = new Set<string>(); let messageId = "";
    let activity: ClaudeTurnActivity = { assistantText: "", toolStarted: 0, toolCompleted: 0 };
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue; this.armTimeout();
      let item: any; try { item = JSON.parse(line); } catch { continue; }
      if (item.type === "control_request") { void this.handlePermission(item); continue; }
      if (item.type === "control_cancel_request") { this.permissionRequests.get(String(item.request_id))?.abort(); continue; }
      if (item.type === "control_response") continue;
      if (item.session_id) this.sessionId = String(item.session_id);
      // Child messages share this stream on recent CLI versions. Their tools
      // and replies belong to the child transcript, not the main-turn counters.
      if (["assistant", "user", "stream_event", "tool_progress"].includes(item.type)
        && (item.parent_tool_use_id || item.agent_id)) continue;
      if (item.type === "system" && item.subtype === "init") {
        await this.options.onEvent({ type: "session.started", rawType: "system.init", sessionId: this.sessionId, text: "Claude 会话已开始", payload: item });
        await this.options.onEvent({ type: "turn.started", rawType: "turn.started", text: "Working", payload: item });
      } else if (item.type === "system") {
        const subtype = String(item.subtype || "status");
        this.backgroundTasks.apply(item);
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
        const text = contentText(content); if (text) activity.assistantText = text;
        let partialText = "";
        for (const block of content) {
          if (block?.type === "thinking" && block.thinking && !partialThinking.has(sourceId)) await this.options.onEvent({ type: "reasoning", rawType: "assistant.thinking", sourceId: `${sourceId}:thinking`, text: String(block.thinking), payload: block });
          if (block?.type === "text" && block.text) { partialText += String(block.text); await this.options.onEvent({ type: "assistant", rawType: "assistant.text", sourceId, text: partialText, payload: item }); }
          if (block?.type === "tool_use") { const id = String(block.id || `${sourceId}:tool`); const name = String(block.name || "工具"); if (!toolNames.has(id)) activity.toolStarted += 1; toolNames.set(id, name); toolInputs.set(id, block.input || {}); await this.options.onEvent({ type: "tool.started", rawType: "assistant.tool_use", sourceId: id, toolName: name, text: JSON.stringify(block.input || {}), payload: block, detail: { input: block.input || {} } }); }
          if (block?.type && !["text", "thinking", "tool_use"].includes(String(block.type))) await this.options.onEvent({ type: "status", rawType: `assistant.${String(block.type)}`, sourceId: `${sourceId}:${String(block.type)}`, text: `Claude 返回未识别内容块：${String(block.type)}`, category: "unknown", phase: "started", detail: block });
        }
      } else if (item.type === "stream_event") {
        const event = item.event || {}; if (event.type === "message_start" && event.message?.id) messageId = String(event.message.id);
        const sourceId = String(messageId || item.parent_tool_use_id || item.uuid || this.sessionId);
        if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") { const next = `${partialThinking.get(sourceId) || ""}${event.delta.thinking || ""}`; partialThinking.set(sourceId, next); await this.options.onEvent({ type: "reasoning", rawType: "stream.thinking_delta", sourceId: `${sourceId}:thinking`, text: next, payload: item }); }
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") { const next = `${partial.get(sourceId) || ""}${event.delta.text || ""}`; partial.set(sourceId, next); activity.assistantText = next; await this.options.onEvent({ type: "assistant", rawType: "stream.text_delta", sourceId, text: next, payload: item }); }
      } else if (item.type === "user") {
        for (const block of Array.isArray(item.message?.content) ? item.message.content : []) if (block?.type === "tool_result") {
          const id = String(block.tool_use_id || crypto.randomUUID());
          if (!completedTools.has(id)) activity.toolCompleted += 1;
          completedTools.add(id);
          const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content || "");
          const permissionError = claudeToolPermissionError(block);
          const failed = claudeToolResultFailed(block);
          if (permissionError) activity.permissionError = permissionError;
          await this.options.onEvent({ type: permissionError ? "error" : "tool.completed", rawType: "user.tool_result", sourceId: id, toolName: toolNames.get(id) || "工具", text: permissionError ? `工具权限未授权：${permissionError}` : text, payload: { ...block, native_result: item.tool_use_result }, phase: permissionError ? "failed" : failed ? "failed" : "completed", detail: { input: toolInputs.get(id), output: text, result: block } });
        }
      } else if (item.type === "tool_progress" || item.type === "tool_use_summary") {
        const id = String(item.tool_use_id || item.uuid || crypto.randomUUID()); const name = String(item.tool_name || toolNames.get(id) || "工具"); if (item.tool_name) toolNames.set(id, name);
        const text = String(item.message || item.summary || "工具状态已更新");
        const permissionError = claudeToolPermissionError(item);
        const failed = claudeToolResultFailed(item);
        if (permissionError) activity.permissionError = permissionError;
        await this.options.onEvent({ type: permissionError ? "error" : item.type === "tool_progress" ? "tool.started" : "tool.completed", rawType: item.type, sourceId: id, toolName: name, text: permissionError ? `工具权限未授权：${permissionError}` : text, payload: item, phase: permissionError ? "failed" : item.type === "tool_progress" ? "running" : failed ? "failed" : "completed", detail: { input: toolInputs.get(id), output: text, result: item } });
      } else if (item.type === "rate_limit_event" || item.type === "auth_status") {
        await this.options.onEvent({ type: "status", sourceId: String(item.uuid || item.type), toolName: item.type, text: String(item.message || "Claude 状态已更新"), payload: item });
      } else if (item.type === "result") {
        const usage = usageFrom(item.usage);
        const waiting = item.subtype === "success" && !item.is_error && this.backgroundTasks.mustWait(item);
        const validation = waiting ? { valid: true, reason: undefined, retryable: undefined } : validateClaudeResult(item, usage, activity);
        if (!validation.valid) {
          const error = validation.reason || "Claude CLI 返回了不完整结果";
          await this.options.onEvent({ type: "error", text: error, payload: { ...item, workbench_validation_error: error, retryable: validation.retryable } });
          this.settle({ sessionId: this.sessionId, usage, failed: true, retryable: validation.retryable, error });
        } else {
          await this.options.onEvent({ type: waiting ? "status" : "turn.completed", rawType: waiting ? "result.background_wait" : "result", toolName: waiting ? "background_wait" : undefined, text: waiting ? `Claude 后台任务仍在运行（${this.backgroundTasks.activeCount} 项），等待结果` : String(item.result || "Claude 任务已完成"), usage, payload: item, phase: waiting ? "running" : "completed" });
          if (!waiting) this.settle({ sessionId: this.sessionId, usage, failed: false });
        }
        partial.clear(); toolNames.clear(); toolInputs.clear(); completedTools.clear(); messageId = "";
        activity = { assistantText: "", toolStarted: 0, toolCompleted: 0 };
      } else {
        const rawType = String(item.type || "unknown");
        await this.options.onEvent({ type: "status", rawType, sourceId: String(item.uuid || `unknown:${rawType}`), text: `Claude 返回未识别事件：${rawType}`, category: "unknown", phase: "started", detail: item });
      }
    }
  }

  private async handlePermission(item: any) {
    const id = String(item.request_id || ""); const request = item.request || {};
    if (!id || this.permissionRequests.has(id)) return;
    const pending = new AbortController(); this.permissionRequests.set(id, pending); this.armTimeout();
    try {
      if (request.subtype !== "can_use_tool") {
        this.child.stdin.write(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: id, error: "Unsupported native control request" } }) + "\n"); return;
      }
      const question = request.tool_name === "AskUserQuestion";
      const prompt: Omit<NativePrompt, "id" | "sessionId" | "provider" | "createdAt"> = question
        ? { kind: "question", title: "Claude 需要你的决定", detail: "回答将直接返回当前原生工具调用", questions: (request.input?.questions || []).map((q: any, index: number) => ({ id: String(index), header: q.header, question: q.question, multiSelect: q.multiSelect, options: q.options })) }
        : { kind: "approval", title: request.tool_name === "ExitPlanMode" ? "批准计划并继续执行" : `批准 ${request.tool_name || "工具"}`, detail: [request.decision_reason, JSON.stringify(request.input || {}, null, 2)].filter(Boolean).join("\n").slice(0, 24_000) };
      const answer = this.options.onPermission ? await this.options.onPermission(prompt, AbortSignal.any([this.options.signal, pending.signal])) : { decision: "decline" as const };
      if (pending.signal.aborted || this.closed) return;
      const allowed = question || answer.decision === "accept";
      const input = question ? { ...request.input, answers: Object.fromEntries((request.input.questions || []).map((q: any, index: number) => [q.question, answer.answers?.[String(index)]?.join(", ") || ""])) } : request.input || {};
      this.child.stdin.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response: allowed ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "用户拒绝了此次原生操作" } } }) + "\n");
    } catch {
      if (!pending.signal.aborted && !this.closed) this.child.stdin.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response: { behavior: "deny", message: "原生审批已取消" } } }) + "\n");
    } finally { this.permissionRequests.delete(id); this.armTimeout(); }
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
  if (options.sendPrompt !== false) handle.send(options.prompt, options.inputOrigin);
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
