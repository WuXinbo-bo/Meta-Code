import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import readline from "node:readline";
import type { EngineUsage, NormalizedEngineEvent } from "../types.js";
import { claudeToolPermissionError, validateClaudeResult, type ClaudeTurnActivity } from "./result.js";
import { registerProcessTree, terminateProcessTree } from "../../processTree.js";
import { WorkbenchTimeoutError } from "../../orchestration/timeouts.js";
import { CLAUDE_PROCESS_RECONNECT_ATTEMPTS, ClaudeTransportError, claudeApiRetryExhaustsProcess, classifyClaudeFailure, type ClaudeConnectionSettings } from "./transport.js";

const HIDDEN_SYSTEM_SUBTYPES = new Set(["thinking_tokens", "status"]);

function systemStatusText(item: any, subtype: string) {
  if (item.message) return String(item.message);
  if (subtype === "compact_boundary") return "上下文已压缩";
  if (subtype.startsWith("hook")) return "Hook 状态已更新";
  if (subtype === "api_retry") {
    const attempt = Number(item.attempt || 0);
    const maximum = Number(item.max_retries || 0);
    const status = Number(item.error_status || 0);
    return `Claude API 请求失败，正在重试${attempt ? `（${attempt}${maximum ? `/${maximum}` : ""}）` : ""}${status ? ` · HTTP ${status}` : ""}`;
  }
  return "Claude 状态已更新";
}

export type ClaudeRunOptions = {
  executable: string;
  executableArgs?: string[];
  cwd: string;
  prompt: string;
  sessionId?: string | null;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  baseUrl?: string;
  apiKey?: string;
  configDir: string;
  mcpConfigPath?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  signal: AbortSignal;
  onEvent: (event: NormalizedEngineEvent) => Promise<void> | void;
  ownerId?: string;
  outputTimeoutMs?: number;
  resolveConnection?: () => ClaudeConnectionSettings | Promise<ClaudeConnectionSettings>;
  processReconnectAttempts?: number;
  nativeRetryOnly?: boolean;
};

export type ClaudeRunResult = { sessionId: string; usage: EngineUsage; process: ChildProcessWithoutNullStreams; finalText: string };

const emptyUsage = (): EngineUsage => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });

function usageFrom(value: any): EngineUsage {
  return {
    input_tokens: Number(value?.input_tokens || 0),
    cached_input_tokens: Number(value?.cache_read_input_tokens || 0) + Number(value?.cache_creation_input_tokens || 0),
    output_tokens: Number(value?.output_tokens || 0),
    reasoning_output_tokens: 0
  };
}

function textFromContent(content: any[]) {
  return content.filter((item) => item?.type === "text").map((item) => String(item.text || "")).join("\n");
}

export function buildClaudeProcessArgs(options: Pick<ClaudeRunOptions, "executableArgs" | "model" | "effort" | "sessionId" | "permissionMode" | "mcpConfigPath" | "allowedTools" | "disallowedTools">, requestedSessionId: string) {
  const args = [...(options.executableArgs || []), "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", options.permissionMode];
  const disallowedTools = [...new Set(["Task", "Agent", ...(options.disallowedTools || [])])];
  if (disallowedTools.length) args.push("--disallowedTools", ...disallowedTools);
  const allowedTools = [...new Set(options.allowedTools || [])];
  if (allowedTools.length) args.push("--allowedTools", ...allowedTools);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.mcpConfigPath) args.push("--mcp-config", options.mcpConfigPath, "--strict-mcp-config");
  if (options.sessionId) args.push("--resume", options.sessionId);
  else args.push("--session-id", requestedSessionId);
  return args;
}

async function runClaudeProcess(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const requestedSessionId = options.sessionId || crypto.randomUUID();
  const args = buildClaudeProcessArgs(options, requestedSessionId);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: options.configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ANTHROPIC_MAX_RETRIES: "2"
  };
  // This runner is used for an isolated worker context. Never let a worker
  // inherit either delegation bridge, even when the server token came from
  // the host environment.
  delete env.CLAUDE_WORKER_BRIDGE_URL;
  delete env.CLAUDE_WORKER_BRIDGE_TOKEN;
  delete env.CLAUDE_WORKBENCH_PARENT_TASK_ID;
  delete env.CLAUDE_CODEX_BRIDGE_URL;
  delete env.CLAUDE_CODEX_BRIDGE_TOKEN;
  delete env.WORKBENCH_AGENT_BRIDGE_URL;
  delete env.WORKBENCH_AGENT_BRIDGE_TOKEN;
  env.CLAUDE_WORKER_DEPTH = "1";
  if (options.baseUrl) env.ANTHROPIC_BASE_URL = options.baseUrl.replace(/\/+$/, "");
  if (options.apiKey) env.ANTHROPIC_API_KEY = options.apiKey;

  const child = spawn(options.executable, args, { cwd: options.cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", shell: process.platform === "win32" && /\.cmd$/i.test(options.executable) });
  registerProcessTree(options.ownerId || requestedSessionId, child);
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
    terminateProcessTree(child);
  });
  child.stdin.end(options.prompt, "utf8");
  let sessionId = requestedSessionId;
  let usage = emptyUsage();
  let stderr = "";
  let structuredError = false;
  let structuredErrorMessage = "";
  let completed = false;
  let finalText = "";
  let outputTimedOut = false;
  let transportFailed = false;
  const partialText = new Map<string, string>();
  const partialThinking = new Map<string, string>();
  const toolNames = new Map<string, string>();
  const toolInputs = new Map<string, unknown>();
  let currentMessageId = "";
  const completedTools = new Set<string>();
  const activity: ClaudeTurnActivity = { assistantText: "", toolStarted: 0, toolCompleted: 0 };

  let outputTimer: NodeJS.Timeout | undefined;
  const touchOutputTimer = () => {
    if (!options.outputTimeoutMs || options.outputTimeoutMs <= 0) return;
    if (outputTimer) clearTimeout(outputTimer);
    outputTimer = setTimeout(() => {
      outputTimedOut = true;
      terminateProcessTree(child);
    }, options.outputTimeoutMs);
  };
  touchOutputTimer();
  const abort = () => terminateProcessTree(child);
  options.signal.addEventListener("abort", abort, { once: true });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_000); });

  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const closePromise = new Promise<number | null>((resolve) => child.once("close", (code) => {
    lines.close();
    resolve(code);
  }));
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      touchOutputTimer();
      let item: any;
      try { item = JSON.parse(line); } catch { continue; }
      if (item.session_id) sessionId = String(item.session_id);
      if (item.type === "system" && item.subtype === "init") {
        await options.onEvent({ type: "session.started", sessionId, text: "Claude 会话已开始", payload: item });
        await options.onEvent({ type: "turn.started", text: "Working", payload: item });
      } else if (item.type === "system") {
        const subtype = String(item.subtype || "status");
        if (HIDDEN_SYSTEM_SUBTYPES.has(subtype)) continue;
        const sourceId = subtype === "api_retry" ? "system:api_retry" : String(item.uuid || `system:${subtype}`);
        await options.onEvent({ type: "status", sourceId, toolName: subtype, text: systemStatusText(item, subtype), payload: item });
        if (subtype === "api_retry" && classifyClaudeFailure(item.message || item.error || item.result, item.error_status) === "permanent") {
          structuredError = true;
          structuredErrorMessage = String(item.message || item.error || item.result || "Claude 认证或账户不可用");
          terminateProcessTree(child);
          break;
        }
        if (!options.nativeRetryOnly && subtype === "api_retry" && claudeApiRetryExhaustsProcess(item)) {
          transportFailed = true;
          terminateProcessTree(child);
          break;
        }
      } else if (item.type === "assistant") {
        const message = item.message || {};
        const sourceId = String(message.id || item.uuid || crypto.randomUUID());
        const content = Array.isArray(message.content) ? message.content : [];
        const text = textFromContent(content);
        if (text) activity.assistantText = text;
        let partialAssistantText = "";
        for (const block of content) {
          if (block?.type === "thinking" && block.thinking && !partialThinking.has(sourceId)) await options.onEvent({ type: "reasoning", rawType: "assistant.thinking", sourceId: `${sourceId}:thinking`, text: String(block.thinking), payload: block });
          if (block?.type === "text" && block.text) {
            partialAssistantText += String(block.text);
            await options.onEvent({ type: "assistant", rawType: "assistant.text", sourceId, text: partialAssistantText, payload: item });
          }
          if (block?.type === "tool_use") {
            const toolId = String(block.id || `${sourceId}:tool`);
            const toolName = String(block.name || "工具");
            if (!toolNames.has(toolId)) activity.toolStarted += 1;
            toolNames.set(toolId, toolName);
            toolInputs.set(toolId, block.input || {});
            await options.onEvent({ type: "tool.started", rawType: "assistant.tool_use", sourceId: toolId, toolName, text: JSON.stringify(block.input || {}), payload: block, detail: { input: block.input || {} } });
          }
        }
        usage = usageFrom(message.usage || item.usage);
      } else if (item.type === "stream_event") {
        const event = item.event || {};
        if (event.type === "message_start" && event.message?.id) currentMessageId = String(event.message.id);
        const sourceId = String(currentMessageId || item.parent_tool_use_id || item.uuid || sessionId);
        if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
          const next = `${partialThinking.get(sourceId) || ""}${event.delta.thinking || ""}`;
          partialThinking.set(sourceId, next);
          await options.onEvent({ type: "reasoning", rawType: "stream.thinking_delta", sourceId: `${sourceId}:thinking`, text: next, payload: item });
        }
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const next = `${partialText.get(sourceId) || ""}${event.delta.text || ""}`;
          partialText.set(sourceId, next);
          activity.assistantText = next;
          await options.onEvent({ type: "assistant", rawType: "stream.text_delta", sourceId, text: next, payload: item });
        }
      } else if (item.type === "user") {
        const content = Array.isArray(item.message?.content) ? item.message.content : [];
        for (const block of content) {
          if (block?.type === "tool_result") {
            const toolId = String(block.tool_use_id || crypto.randomUUID());
            if (!completedTools.has(toolId)) activity.toolCompleted += 1;
            completedTools.add(toolId);
            const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content || "");
            const permissionError = claudeToolPermissionError(block);
            if (permissionError) activity.permissionError = permissionError;
            await options.onEvent({ type: permissionError ? "error" : "tool.completed", rawType: "user.tool_result", sourceId: toolId, toolName: toolNames.get(toolId) || "工具", text: permissionError ? `工具权限未授权：${permissionError}` : text, payload: block, detail: { input: toolInputs.get(toolId), output: text, result: block } });
          }
        }
      } else if (item.type === "tool_progress") {
        const toolId = String(item.tool_use_id || item.uuid || crypto.randomUUID());
        const toolName = String(item.tool_name || toolNames.get(toolId) || "工具");
        if (item.tool_name) toolNames.set(toolId, toolName);
        await options.onEvent({ type: "tool.started", rawType: "tool_progress", sourceId: toolId, toolName, text: String(item.message || item.summary || "工具正在执行"), payload: item, detail: { input: toolInputs.get(toolId) } });
      } else if (item.type === "tool_use_summary") {
        const toolId = String(item.tool_use_id || item.uuid || crypto.randomUUID());
        const text = String(item.summary || item.message || "工具执行完成");
        const permissionError = claudeToolPermissionError(item);
        if (permissionError) activity.permissionError = permissionError;
        await options.onEvent({ type: permissionError ? "error" : "tool.completed", rawType: "tool_use_summary", sourceId: toolId, toolName: String(item.tool_name || toolNames.get(toolId) || "工具"), text: permissionError ? `工具权限未授权：${permissionError}` : text, payload: item, detail: { input: toolInputs.get(toolId), output: text, result: item } });
      } else if (item.type === "rate_limit_event" || item.type === "auth_status") {
        await options.onEvent({ type: "status", sourceId: String(item.uuid || item.type), toolName: item.type, text: String(item.message || (item.type === "rate_limit_event" ? "调用频率状态已更新" : "认证状态已更新")), payload: item });
      } else if (item.type === "result") {
        usage = usageFrom(item.usage);
        finalText = String(item.result || activity.assistantText || "").trim();
        const validation = validateClaudeResult(item, usage, activity);
        if (!validation.valid) {
          structuredError = true;
          structuredErrorMessage = validation.reason || String(item.result || item.error || stderr || "Claude CLI 运行失败");
          await options.onEvent({ type: "error", text: structuredErrorMessage, payload: { ...item, workbench_validation_error: structuredErrorMessage, retryable: validation.retryable } });
        }
        else {
          completed = true;
          await options.onEvent({ type: "turn.completed", rawType: "result", text: String(item.result || "Claude 任务已完成"), usage, payload: item });
        }
      } else {
        const rawType = String(item.type || "unknown");
        await options.onEvent({ type: "status", rawType, sourceId: String(item.uuid || `unknown:${rawType}`), text: `Claude 返回未识别事件：${rawType}`, category: "unknown", phase: "started", detail: item });
      }
    }
  } finally {
    if (outputTimer) clearTimeout(outputTimer);
    options.signal.removeEventListener("abort", abort);
  }

  const exitCode = child.exitCode !== null ? child.exitCode : await closePromise;
  if (options.signal.aborted) throw new DOMException("Claude CLI 任务已中断", "AbortError");
  if (transportFailed) throw new ClaudeTransportError("Claude 当前连接连续失败，旧进程已停止", sessionId);
  if (spawnError) throw spawnError;
  if (outputTimedOut && !options.signal.aborted) throw new WorkbenchTimeoutError("inactivity", `Claude CLI 已连续 ${Math.ceil((options.outputTimeoutMs || 0) / 1_000)} 秒没有输出，任务已停止。`);
  if (structuredError) throw new Error(structuredErrorMessage || stderr.trim() || "Claude CLI 运行失败");
  if (exitCode && !options.signal.aborted) throw new Error(stderr.trim() || `Claude CLI 退出，代码 ${exitCode}`);
  if (!completed) throw new Error("Claude CLI 未返回任务完成事件，不能把不完整输出标记为已完成");
  return { sessionId, usage, process: child, finalText: finalText || activity.assistantText.trim() };
}

export async function runClaude(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const reconnectAttempts = Math.max(0, options.processReconnectAttempts ?? CLAUDE_PROCESS_RECONNECT_ATTEMPTS);
  let sessionId = options.sessionId || null;
  let prompt = options.prompt;
  let lastError: unknown;

  for (let attempt = 0; attempt <= reconnectAttempts; attempt += 1) {
    const latest = options.resolveConnection ? await options.resolveConnection() : {};
    try {
      return await runClaudeProcess({
        ...options,
        ...latest,
        sessionId,
        prompt
      });
    } catch (error) {
      lastError = error;
      if (!(error instanceof ClaudeTransportError) || attempt >= reconnectAttempts || options.signal.aborted) throw error;
      sessionId = error.sessionId || sessionId;
      const reconnectNumber = attempt + 1;
      await options.onEvent({
        type: "status",
        sourceId: `system:process_reconnect:${reconnectNumber}`,
        toolName: "process_reconnect",
        text: `Claude 连接已失效，正在刷新通道并重建进程（${reconnectNumber}/${reconnectAttempts}）`,
        payload: { reconnectNumber, reconnectAttempts, sessionId }
      });
      prompt = [
        "上一条传输连接中断，工作台已重建 Claude 进程。",
        "请从当前会话断点继续未完成的任务；先核对已有工具结果和文件，不要重复已经完成的修改。",
        "完成剩余工作并正常交付最终结果。"
      ].join("\n");
    }
  }
  throw lastError;
}
