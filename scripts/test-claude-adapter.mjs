import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildClaudeProcessArgs, runClaude } from "../dist-server/engines/claude/process.js";
import { buildClaudeSessionArgs, ClaudeSessionHandle, runClaudeSessionTurn } from "../dist-server/engines/claude/session.js";
import { claudeToolPermissionError, validateClaudeResult } from "../dist-server/engines/claude/result.js";
import { compactClaudeQuestionPayload, isClaudeQuestionTool } from "../dist-server/engines/claude/questions.js";
import { codexActivityFromEvent, codexTurnFailure, isCodexReconnectMessage, recordCodexTurnTerminalState } from "../dist-server/engines/codex/events.js";
import { classifyClaudeFailure, claudeRetryAllowed } from "../dist-server/engines/claude/transport.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexCommandActivity = codexActivityFromEvent({ type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "npm run build", aggregated_output: "ok", exit_code: 0, status: "completed" } });
assert.deepEqual({
  id: codexCommandActivity.id,
  category: codexCommandActivity.category,
  phase: codexCommandActivity.phase,
  title: codexCommandActivity.title,
  summary: codexCommandActivity.summary,
  detail: codexCommandActivity.detail
}, {
  id: "cmd-1", category: "command", phase: "completed", title: "执行命令", summary: "npm run build",
  detail: { command: "npm run build", status: "completed", exitCode: 0, output: "ok" }
});
const codexMcpActivity = codexActivityFromEvent({ type: "item.started", item: { id: "mcp-1", type: "mcp_tool_call", server: "files", tool: "read", arguments: { path: "README.md" }, status: "in_progress" } });
assert.equal(codexMcpActivity.category, "mcp");
assert.equal(codexMcpActivity.phase, "started");
console.log("Codex structured activity adapter OK");
assert.equal(classifyClaudeFailure("insufficient balance"), "permanent");
assert.equal(classifyClaudeFailure("request failed", 403), "permanent");
assert.equal(classifyClaudeFailure("stream disconnected", 503), "transient");
assert.equal(classifyClaudeFailure("MCP schema validation failed"), "protocol");
assert.equal(claudeRetryAllowed("insufficient balance"), false);
assert.equal(claudeRetryAllowed("gateway timeout", 504), true);
console.log("Claude failure classification and retry policy OK");
let codexTerminalState = { completed: false, failed: false };
codexTerminalState = recordCodexTurnTerminalState(codexTerminalState, "error");
codexTerminalState = recordCodexTurnTerminalState(codexTerminalState, "turn.completed");
assert.deepEqual(codexTerminalState, { completed: true, failed: false });
assert.equal(codexTurnFailure(codexTerminalState, "Reconnecting... 1/5", "missing completion"), "");
assert.deepEqual(recordCodexTurnTerminalState({ completed: false, failed: false }, "turn.failed"), { completed: false, failed: true });
assert.equal(codexTurnFailure({ completed: false, failed: true }, "terminal failure", "missing completion"), "terminal failure");
assert.equal(codexTurnFailure({ completed: false, failed: false }, "", "missing completion"), "missing completion");
assert.equal(isCodexReconnectMessage("Reconnecting... 1/5 (stream disconnected)"), true);
assert.equal(isCodexReconnectMessage("failed after retries exhausted"), false);
console.log("Codex delegated-wait terminal guard OK");
assert.equal(isClaudeQuestionTool("AskUserQuestion"), true);
assert.equal(isClaudeQuestionTool("Bash"), false);
assert.deepEqual(compactClaudeQuestionPayload({
  type: "tool_use",
  id: "question-1",
  name: "AskUserQuestion",
  input: {
    questions: [{
      header: "输出格式",
      question: "希望 Skill 输出什么格式？",
      multiSelect: true,
      options: [{ label: "Markdown", description: "生成 Markdown 文档" }]
    }]
  }
}), {
  type: "tool_use",
  name: "AskUserQuestion",
  id: "question-1",
  tool_use_id: undefined,
  questions: [{
    header: "输出格式",
    question: "希望 Skill 输出什么格式？",
    multiSelect: true,
    options: [{ label: "Markdown", description: "生成 Markdown 文档" }]
  }],
  workbench_compacted: true
});
console.log("Claude structured question preservation OK");
const mainArgs = buildClaudeSessionArgs({
  executableArgs: [],
  model: "claude-test",
  effort: "high",
  sessionId: null,
  permissionMode: "bypassPermissions"
}, "main-session-test");
const disallowedIndex = mainArgs.indexOf("--disallowedTools");
assert.ok(disallowedIndex >= 0);
assert.deepEqual(mainArgs.slice(disallowedIndex + 1, disallowedIndex + 3), ["Task", "Agent"]);
assert.ok(!mainArgs.slice(disallowedIndex + 1, disallowedIndex + 3).includes("Bash"));

const standaloneArgs = buildClaudeSessionArgs({
  executableArgs: [],
  model: "claude-test",
  effort: "high",
  sessionId: null,
  permissionMode: "bypassPermissions",
  disallowNativeAgents: false
}, "standalone-session-test");
assert.ok(!standaloneArgs.includes("--disallowedTools"));

const mcpArgs = buildClaudeSessionArgs({
  executableArgs: [],
  model: "claude-test",
  effort: "high",
  sessionId: null,
  permissionMode: "bypassPermissions",
  mcpConfigPath: "C:\\runtime\\workspace-mcp.json"
}, "mcp-session-test");
const mcpConfigIndex = mcpArgs.indexOf("--mcp-config");
assert.ok(mcpConfigIndex >= 0);
assert.equal(mcpArgs[mcpConfigIndex + 1], "C:\\runtime\\workspace-mcp.json");
assert.ok(mcpArgs.includes("--strict-mcp-config"));

const plannerArgs = buildClaudeSessionArgs({
  executableArgs: [],
  model: "claude-test",
  effort: "high",
  sessionId: null,
  permissionMode: "default",
  disallowedTools: ["Task", "Agent", "Write", "Edit", "NotebookEdit", "Bash"],
  allowedTools: ["Read", "Glob", "Grep", "mcp__workbench-workflow-plan__*"],
  additionalDirectories: ["C:\\skills\\research"]
}, "planner-session-test");
const plannerDisallowedIndex = plannerArgs.indexOf("--disallowedTools");
assert.ok(plannerDisallowedIndex >= 0);
assert.deepEqual(plannerArgs.slice(plannerDisallowedIndex + 1, plannerDisallowedIndex + 7), ["Task", "Agent", "Write", "Edit", "NotebookEdit", "Bash"]);
assert.equal(plannerArgs[plannerArgs.indexOf("--permission-mode") + 1], "default");
const plannerAllowedIndex = plannerArgs.indexOf("--allowedTools");
assert.ok(plannerAllowedIndex >= 0);
assert.deepEqual(plannerArgs.slice(plannerAllowedIndex + 1, plannerAllowedIndex + 5), ["Read", "Glob", "Grep", "mcp__workbench-workflow-plan__*"]);
assert.equal(plannerArgs[plannerArgs.indexOf("--add-dir") + 1], "C:\\skills\\research");

const readExecutorArgs = buildClaudeProcessArgs({
  executableArgs: [],
  model: "claude-test",
  effort: "high",
  sessionId: null,
  permissionMode: "plan",
  mcpConfigPath: "C:\\runtime\\node-mcp.json",
  allowedTools: ["Read", "Glob", "Grep", "mcp__research__*"],
  disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"]
}, "read-executor-test");
assert.ok(readExecutorArgs.includes("--strict-mcp-config"));
assert.ok(readExecutorArgs.includes("mcp__research__*"));
assert.ok(readExecutorArgs.includes("Write"));
assert.ok(readExecutorArgs.includes("Bash"));
console.log("Claude workflow role permission arguments OK");

const events = [];
const result = await runClaude({
  executable: process.execPath,
  executableArgs: [path.join(root, "scripts", "fixtures", "fake-claude.mjs")],
  cwd: root,
  prompt: "test",
  model: "claude-test",
  configDir: path.join(root, ".runtime", "claude-adapter-test"),
  permissionMode: "bypassPermissions",
  signal: new AbortController().signal,
  onEvent: (event) => events.push(event)
});

assert.equal(result.sessionId, "550e8400-e29b-41d4-a716-446655440000");
assert.equal(result.usage.input_tokens, 12);
assert.equal(result.usage.cached_input_tokens, 3);
assert.equal(result.usage.output_tokens, 5);
assert.equal(result.finalText, "done", "应采用 Claude result 事件中的权威最终文本，而不是最后一个 assistant 流式片段");
assert.ok(events.some((event) => event.type === "assistant" && event.text === "测试回复"));
assert.ok(events.some((event) => event.type === "tool.started" && event.toolName === "Bash"));
assert.ok(events.some((event) => event.type === "tool.completed" && event.text === "ok"));
const completedTool = events.find((event) => event.type === "tool.completed" && event.sourceId === "tool_test");
assert.deepEqual(completedTool?.detail?.input, { command: "echo ok" });
assert.equal(completedTool?.detail?.output, "ok");
assert.ok(events.some((event) => event.type === "turn.completed"));
assert.ok(!events.some((event) => event.type === "status" && ["status", "thinking_tokens"].includes(event.toolName)));
assert.ok(events.some((event) => event.type === "status" && event.toolName === "api_retry"));
assert.ok(events.some((event) => event.sourceId === "system:api_retry" && event.text.includes("HTTP 503")));
console.log(`Claude adapter OK: ${events.length} normalized events`);

const reconnectEvents = [];
let connectionRead = 0;
const reconnected = await runClaude({
  executable: process.execPath,
  executableArgs: [path.join(root, "scripts", "fixtures", "fake-claude-transport-reconnect.mjs")],
  cwd: root,
  prompt: "transport reconnect",
  baseUrl: "https://stale.example.test",
  configDir: path.join(root, ".runtime", "claude-adapter-test"),
  permissionMode: "bypassPermissions",
  signal: new AbortController().signal,
  resolveConnection: () => ({ baseUrl: connectionRead++ === 0 ? "https://stale.example.test" : "https://fresh.example.test" }),
  onEvent: (event) => reconnectEvents.push(event)
});
assert.equal(reconnected.sessionId, "550e8400-e29b-41d4-a716-446655440099");
assert.equal(reconnected.finalText, "reconnected:https://fresh.example.test");
assert.ok(reconnectEvents.some((event) => event.toolName === "process_reconnect"));
console.log("Claude stale-process transport reconnect OK");

const nativeRetryEvents = [];
const nativeRetryResult = await runClaude({
  executable: process.execPath,
  executableArgs: [path.join(root, "scripts", "fixtures", "fake-claude-native-retry.mjs")],
  cwd: root,
  prompt: "native retry only",
  configDir: path.join(root, ".runtime", "claude-adapter-test"),
  permissionMode: "bypassPermissions",
  nativeRetryOnly: true,
  processReconnectAttempts: 0,
  signal: new AbortController().signal,
  onEvent: (event) => nativeRetryEvents.push(event)
});
assert.equal(nativeRetryResult.finalText, "native retry recovered");
assert.ok(nativeRetryEvents.some((event) => event.toolName === "api_retry"));
assert.ok(!nativeRetryEvents.some((event) => event.toolName === "process_reconnect"));
console.log("Claude native-only retry policy OK");

const sessionEvents = [];
const sessionHandle = new ClaudeSessionHandle({
  executable: process.execPath,
  executableArgs: [path.join(root, "scripts", "fixtures", "fake-claude.mjs")],
  cwd: root,
  model: "claude-test",
  configDir: path.join(root, ".runtime", "claude-session-test"),
  permissionMode: "bypassPermissions",
  signal: new AbortController().signal,
  onEvent: (event) => sessionEvents.push(event)
});
const sessionResult = await sessionHandle.nextTurn();
assert.equal(sessionResult.sessionId, "550e8400-e29b-41d4-a716-446655440000");
assert.ok(!sessionEvents.some((event) => event.type === "status" && ["status", "thinking_tokens"].includes(event.toolName)));
assert.ok(sessionEvents.some((event) => event.type === "status" && event.toolName === "api_retry"));
assert.ok(sessionEvents.some((event) => event.sourceId === "system:api_retry" && event.text.includes("HTTP 503")));
assert.deepEqual(sessionEvents.find((event) => event.type === "tool.completed")?.detail?.input, { command: "echo ok" });
console.log(`Claude session noise filter OK: ${sessionEvents.length} normalized events`);

const permissionSessionEvents = [];
const permissionSessionHandle = new ClaudeSessionHandle({
  executable: process.execPath,
  executableArgs: [path.join(root, "scripts", "fixtures", "fake-claude-permission-denied.mjs")],
  cwd: root,
  model: "claude-test",
  configDir: path.join(root, ".runtime", "claude-session-test"),
  permissionMode: "default",
  allowedTools: ["mcp__workbench-workflow-plan__*"],
  signal: new AbortController().signal,
  onEvent: (event) => permissionSessionEvents.push(event)
});
const permissionSessionResult = await permissionSessionHandle.nextTurn();
assert.equal(permissionSessionResult.failed, true);
assert.equal(permissionSessionResult.retryable, false);
assert.match(permissionSessionResult.error, /工具权限未授权/);
assert.ok(permissionSessionEvents.some((event) => event.type === "error" && event.sourceId === "tool_permission"));
assert.ok(!permissionSessionEvents.some((event) => event.type === "tool.completed" && event.sourceId === "tool_permission"));
permissionSessionHandle.close();
console.log("Claude planner-session permission denial classification OK");

const sharedSessionIds = [];
const sharedRecoveries = [];
const sharedPrompts = [];
const sharedEmptyUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
let sharedHandleNumber = 0;
const sharedTurn = await runClaudeSessionTurn({
  createHandle: async (resumeSessionId) => {
    sharedHandleNumber += 1;
    const id = resumeSessionId || "shared-session-1";
    return {
      closed: false,
      currentSessionId: id,
      send: (prompt) => sharedPrompts.push(prompt),
      close() { this.closed = true; },
      nextTurn: async () => sharedHandleNumber === 1
        ? { sessionId: id, usage: sharedEmptyUsage, failed: true, retryable: true, transportFailure: true, error: "transport down" }
        : { sessionId: id, usage: sharedEmptyUsage, failed: false }
    };
  },
  prompt: "shared initial prompt",
  recoveryAttempts: 2,
  signal: new AbortController().signal,
  onSessionId: (id) => sharedSessionIds.push(id),
  onRecovery: (event) => sharedRecoveries.push(event)
});
assert.equal(sharedTurn.result.failed, false);
assert.equal(sharedHandleNumber, 2);
assert.deepEqual(sharedSessionIds, ["shared-session-1"]);
assert.equal(sharedRecoveries.length, 1);
assert.equal(sharedRecoveries[0].transport, true);
assert.equal(sharedPrompts.length, 2);
assert.match(sharedPrompts[1], /断点继续/);
console.log("Claude shared session runner reconnect and immediate session persistence OK");

const interactiveHandle = new ClaudeSessionHandle({
  executable: process.execPath,
  executableArgs: [path.join(root, "scripts", "fixtures", "fake-claude-interactive.mjs")],
  cwd: root,
  model: "claude-test",
  configDir: path.join(root, ".runtime", "claude-session-test"),
  permissionMode: "bypassPermissions",
  outputTimeoutMs: 500,
  signal: new AbortController().signal,
  onEvent: () => undefined
});
interactiveHandle.send("first turn");
await interactiveHandle.nextTurn();
await new Promise((resolve) => setTimeout(resolve, 700));
interactiveHandle.send("review after delegated wait");
const resumedResult = await interactiveHandle.nextTurn();
assert.equal(resumedResult.sessionId, "550e8400-e29b-41d4-a716-446655440001");
interactiveHandle.close();
console.log("Claude idle delegated-wait timeout guard OK");

const emptyUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
assert.equal(validateClaudeResult({ subtype: "success", stop_reason: "tool_use", result: "working", usage: { input_tokens: 2 } }, { ...emptyUsage, input_tokens: 2 }, { assistantText: "working", toolStarted: 0, toolCompleted: 0 }).valid, false);
assert.equal(validateClaudeResult({ subtype: "success", result: "收到。我现在开始执行。", usage: {}, modelUsage: {} }, emptyUsage, { assistantText: "收到。我现在开始执行。", toolStarted: 0, toolCompleted: 0 }).retryable, true);
const permissionMessage = "Claude requested permissions to use mcp__workbench-workflow-plan__workflow_read_plan, but you haven't granted it yet.";
assert.equal(claudeToolPermissionError({ content: permissionMessage }), permissionMessage);
const permissionValidation = validateClaudeResult({ subtype: "success", result: "blocked", usage: { input_tokens: 1 } }, { ...emptyUsage, input_tokens: 1 }, { assistantText: "blocked", toolStarted: 1, toolCompleted: 1, permissionError: permissionMessage });
assert.equal(permissionValidation.valid, false);
assert.equal(permissionValidation.retryable, false);
assert.match(permissionValidation.reason, /工具权限未授权/);
const maxTokenValidation = validateClaudeResult({ subtype: "success", stop_reason: "max_tokens", result: "部分规划", usage: { input_tokens: 1, output_tokens: 10 } }, { ...emptyUsage, input_tokens: 1, output_tokens: 10 }, { assistantText: "部分规划", toolStarted: 0, toolCompleted: 0 });
assert.equal(maxTokenValidation.valid, false);
assert.equal(maxTokenValidation.retryable, true);
console.log("Claude false-success protocol guards OK");

const permissionEvents = [];
await assert.rejects(runClaude({
  executable: process.execPath,
  executableArgs: [path.join(root, "scripts", "fixtures", "fake-claude-permission-denied.mjs")],
  cwd: root,
  prompt: "read plan",
  configDir: path.join(root, ".runtime", "claude-adapter-test"),
  permissionMode: "default",
  allowedTools: ["mcp__workbench-workflow-plan__*"],
  signal: new AbortController().signal,
  onEvent: (event) => permissionEvents.push(event)
}), /工具权限未授权/);
assert.ok(permissionEvents.some((event) => event.type === "error" && event.text.includes("权限未授权")));
assert.ok(!permissionEvents.some((event) => event.type === "tool.completed" && event.sourceId === "tool_permission"));
assert.ok(!permissionEvents.some((event) => event.type === "turn.completed"));
console.log("Claude permission denial classification OK");

await assert.rejects(runClaude({
  executable: process.execPath,
  executableArgs: [path.join(root, "scripts", "fixtures", "fake-claude-false-success.mjs")],
  cwd: root,
  prompt: "must really finish",
  configDir: path.join(root, ".runtime", "claude-adapter-test"),
  permissionMode: "bypassPermissions",
  signal: new AbortController().signal,
  onEvent: () => undefined
}), /零 Token|实际未执行/);

const retryHandle = new ClaudeSessionHandle({
  executable: process.execPath,
  executableArgs: [path.join(root, "scripts", "fixtures", "fake-claude-retry.mjs")],
  cwd: root,
  configDir: path.join(root, ".runtime", "claude-session-test"),
  permissionMode: "bypassPermissions",
  signal: new AbortController().signal,
  onEvent: () => undefined
});
retryHandle.send("first attempt");
const incompleteTurn = await retryHandle.nextTurn();
assert.equal(incompleteTurn.failed, true);
assert.equal(incompleteTurn.retryable, true);
retryHandle.send("automatic recovery");
const recoveredTurn = await retryHandle.nextTurn();
assert.equal(recoveredTurn.failed, false);
retryHandle.close();
console.log("Claude automatic recovery transport OK");

await assert.rejects(runClaude({
  executable: process.execPath,
  executableArgs: [path.join(root, "scripts", "fixtures", "fake-claude-incomplete.mjs")],
  cwd: root,
  prompt: "incomplete",
  configDir: path.join(root, ".runtime", "claude-adapter-test"),
  permissionMode: "bypassPermissions",
  signal: new AbortController().signal,
  onEvent: () => undefined
}), /未返回任务完成事件/);
console.log("Claude incomplete output guard OK");

const concurrent = await Promise.all([1, 2].map(() => runClaude({
  executable: process.execPath,
  executableArgs: [path.join(root, "scripts", "fixtures", "fake-claude.mjs")],
  cwd: root,
  prompt: "parallel",
  configDir: path.join(root, ".runtime", "claude-adapter-test"),
  permissionMode: "bypassPermissions",
  signal: new AbortController().signal,
  onEvent: () => undefined
})));
assert.equal(concurrent.length, 2);

const controller = new AbortController();
setTimeout(() => controller.abort(), 100);
await assert.rejects(runClaude({
  executable: process.execPath,
  executableArgs: [path.join(root, "scripts", "fixtures", "fake-claude-slow.mjs")],
  cwd: root,
  prompt: "pause",
  configDir: path.join(root, ".runtime", "claude-adapter-test"),
  permissionMode: "bypassPermissions",
  signal: controller.signal,
  onEvent: () => undefined
}), (error) => error?.name === "AbortError");
console.log("Claude concurrency and abort OK");

const unavailableCli = path.join(root, ".runtime", "missing-claude-cli.exe");
await assert.rejects(runClaude({
  executable: unavailableCli,
  cwd: root,
  prompt: "startup failure",
  configDir: path.join(root, ".runtime", "claude-adapter-test"),
  permissionMode: "bypassPermissions",
  signal: new AbortController().signal,
  onEvent: () => undefined
}), /ENOENT|not found/i);

const unavailableHandle = new ClaudeSessionHandle({
  executable: unavailableCli,
  cwd: root,
  configDir: path.join(root, ".runtime", "claude-session-test"),
  permissionMode: "bypassPermissions",
  signal: new AbortController().signal,
  onEvent: () => undefined
});
await assert.rejects(unavailableHandle.nextTurn(), /ENOENT|not found/i);
console.log("Claude child-process startup failure guard OK");
