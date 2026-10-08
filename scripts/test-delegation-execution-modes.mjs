import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { buildClaudeProcessArgs } from "../server/engines/claude/process.ts";
import { createDelegationExecution } from "../server/plugins/collaboration/execution.ts";

const source = await readFile(new URL("../server/index.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("server/index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const functionNames = ["threadOptions", "delegatedThreadOptions", "upsertDelegatedTask", "upsertCodexBridgeMessage", "upsertClaudeBridgeMessage", "runCodexBridgeTask", "runClaudeBridgeTask"];
const constantNames = ["CLAUDE_WORKFLOW_READ_TOOLS", "CLAUDE_WORKFLOW_READ_ONLY_DISALLOWED_TOOLS"];
const definitions = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && functionNames.includes(node.name?.text)) definitions.set(node.name.text, node.getText(parsed));
  if (ts.isVariableDeclaration(node) && constantNames.includes(node.name.getText(parsed))) definitions.set(node.name.getText(parsed), `const ${node.getText(parsed)};`);
  ts.forEachChild(node, visit);
}
visit(parsed);
for (const name of [...functionNames, ...constantNames]) assert.ok(definitions.has(name), `missing mode contract symbol ${name}`);
const executable = ts.transpileModule([...definitions.values()].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
const emptyUsage = () => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });

// Run actual bridge bodies, permission option builders and persistence upserts.
// Only the native transport and infrastructure ports are replaced; the tests
// never boot a server, open user state, launch a CLI, or call a remote API.
function harness(provider, { transientFailure = false } = {}) {
  const parent = { id: "parent", engineSessionId: "parent-thread", ownerUserId: "fixture-user", status: "running", messages: [], revision: 0 };
  const state = {
    sessions: [parent], delegatedTasks: [],
    settings: { model: "fixture-codex", reasoningEffort: "high", sandboxMode: "workspace-write", approvalPolicy: "on-request", networkAccess: false, webSearch: "cached", claude: { model: "fixture-claude", effort: "high", baseUrl: "", apiKey: "" } }
  };
  const workspace = { id: "workspace", root: path.resolve("fixture-workspace") };
  const active = new Map();
  const captures = [];
  let sequence = 0;
  const transport = options => {
    captures.push({ provider, prompt: options.prompt, ...(provider === "claude" ? { options, args: buildClaudeProcessArgs(options, "fixture-session") } : {}) });
    if (transientFailure && captures.length === 1) throw new Error("fetch failed: isolated transient fixture");
  };
  const context = vm.createContext({
    AbortController, Error, console,
    state, activeDelegationTasks: active, TERMINAL_DELEGATED_STATUSES: new Set(["completed", "failed", "interrupted"]),
    isWorkbenchDelegationEnabled: () => true,
    executionWorkspaceForSession: () => workspace,
    assertExecutionCwd: (_workspace, cwd) => cwd,
    emptyUsage, uid: prefix => `${prefix}-${++sequence}`,
    nativeProviderHome: id => path.join(workspace.root, "fixture-config", id),
    delegatedSkillContextBlock: () => "",
    saveState: async () => {}, flushStateSave: async () => {}, scheduleStateSave: () => {},
    publishAgentChanged: () => {}, publishSessionChanged: () => {}, compactStoredMessage: () => {},
    agentIdentityFor: (agent, parentId) => ({ key: `${parentId}:${agent.provider}:${agent.id}`, providerId: agent.provider, agentId: agent.id }),
    agentIdentityKey: (id, agentId) => `${id}:${agentId}`,
    messageBySourceId: (session, id) => session.messages.find(message => message.sourceId === id),
    settleSupersededReasoning: () => {}, trimAgentLogs: () => {}, newestAgentLogs: logs => logs,
    timeoutReason: () => undefined, addUsage: usage => usage, usageTotal: usage => usage.output_tokens,
    summarizeCodexEvent: () => "fixture completed", codexAgentLogFromEvent: () => undefined,
    claudeAgentLogFromEvent: () => ({ id: "fixture-log", kind: "message", title: "回复", text: "fixture completed" }),
    buildCodex: () => ({ startThread: options => { captures.at(-1).options = plain(options); return { id: "fixture-thread" }; } }),
    runCodexSessionTurn: async options => {
      transport(options);
      options.createThread();
      await options.onThreadId("fixture-thread");
      await options.onEvent({ type: "item.completed", item: { type: "agent_message" } });
      await options.onEvent({ type: "turn.completed", usage: emptyUsage() });
      return { threadId: "fixture-thread" };
    },
    getClaudeRuntime: async () => ({ available: true, path: "fixture-claude-cli" }),
    resolveClaudeCommand: () => ({ executable: "fixture-cli", args: ["fixture-wrapper"] }),
    workspaceMcpConfigPath: async () => path.join(workspace.root, "fixture-mcp.json"),
    runClaude: async options => {
      transport(options);
      await options.onEvent({ type: "assistant", text: "fixture completed", usage: emptyUsage() });
      return { sessionId: "fixture-session", finalText: "fixture completed", usage: emptyUsage() };
    }
  });
  vm.runInContext(`${executable}\nthis.functions = { ${functionNames.join(", ")} };`, context, { filename: "server/index.ts:delegation-mode-contract" });
  return { parent, state, workspace, active, captures, functions: context.functions, run: provider === "codex" ? context.functions.runCodexBridgeTask : context.functions.runClaudeBridgeTask };
}
function flagValues(args, flag) {
  const start = args.indexOf(flag);
  if (start < 0) return [];
  const end = args.findIndex((value, index) => index > start && value.startsWith("--"));
  return args.slice(start + 1, end < 0 ? undefined : end);
}
function assertTransportMode(capture, expected, cwd) {
  const readOnly = expected !== "implementation";
  if (readOnly) {
    assert.match(capture.prompt, /不得修改任何文件/);
    assert.doesNotMatch(capture.prompt, /直接在当前工作区检查、修改代码|你可以在当前工作区修改文件/);
  } else assert.match(capture.prompt, /修改代码|修改文件/);
  if (capture.provider === "codex") {
    assert.equal(capture.options.sandboxMode, readOnly ? "read-only" : "danger-full-access");
    assert.equal(capture.options.approvalPolicy, "never", "unattended workers cannot inherit an interactive policy");
    assert.equal(capture.options.workingDirectory, cwd);
    assert.equal(capture.options.skipGitRepoCheck, true);
    assert.equal(capture.options.model, "fixture-codex");
    assert.equal(capture.options.modelReasoningEffort, "high");
    assert.equal(capture.options.networkAccessEnabled, false);
    assert.equal(capture.options.webSearchMode, "cached");
  } else {
    assert.equal(capture.options.cwd, cwd);
    assert.equal(flagValues(capture.args, "--permission-mode")[0], readOnly ? "plan" : "bypassPermissions");
    const disallowed = flagValues(capture.args, "--disallowedTools");
    for (const tool of ["Task", "Agent"]) assert.ok(disallowed.includes(tool));
    for (const tool of ["Write", "Edit", "NotebookEdit", "Bash"]) assert.equal(disallowed.includes(tool), readOnly, tool);
    if (readOnly) {
      assert.deepEqual(flagValues(capture.args, "--allowedTools"), ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
      assert.ok(!flagValues(capture.args, "--allowedTools").some(tool => tool.includes("mcp__")), "read mode must not broadly auto-approve workspace MCP writes");
    } else {
      assert.equal(capture.options.allowedTools, undefined);
      assert.equal(capture.options.disallowedTools, undefined);
    }
  }
}
for (const provider of ["codex", "claude"]) {
  for (const mode of [undefined, "analysis", "review", "implementation", "invalid-fixture-mode"]) {
    const h = harness(provider);
    const expected = ["analysis", "review", "implementation"].includes(mode) ? mode : provider === "codex" ? "implementation" : "analysis";
    const cwd = path.join(h.workspace.root, "nested-scope");
    const input = { parentTaskId: "parent", taskId: "worker", cwd, prompt: "Inspect the isolated fixture", acceptance: ["return evidence"], ...(mode === undefined ? {} : { mode }) };
    const result = await h.run(input);
    assert.equal(result.status, "completed");
    assert.equal(h.captures.length, 1);
    assertTransportMode(h.captures[0], expected, cwd);
    assert.match(h.captures[0].prompt, /return evidence/);
    const persisted = h.state.delegatedTasks.find(task => task.id === "worker");
    assert.equal(persisted.mode, expected, "mode was lost from durable task state");
    assert.equal(persisted.status, "completed");
    const message = h.parent.messages.find(item => item.sourceId === `${provider}-worker:worker`);
    assert.equal(message.payload.mode, expected, "mode was lost from the UI/history projection");
    assert.equal(message.payload.provider, provider);
    assert.equal(h.active.size, 0);
  }
}
console.log("Codex and Claude actual bridge runners preserve default/analysis/review/implementation mode in permissions, prompts, durable tasks and history");

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
for (const provider of ["codex", "claude"]) {
  for (const mode of ["analysis", "review"]) {
    const h = harness(provider, { transientFailure: true });
    const task = { id: "worker", parentSessionId: "parent", provider, mode, cwd: h.workspace.root, task: "Inspect fixture only", nickname: "Read-only retry", status: "queued", acceptance: ["no file changes"], usage: emptyUsage(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    h.state.delegatedTasks.push(task);
    const coordinator = createDelegationExecution({
      getState: () => h.state, isWorkbenchDelegationEnabled: () => true,
      activeDelegationTasks: h.active,
      runtimeBindingForProvider: async id => ({ providerId: id, adapterId: "fixture" }),
      agentAdapterRegistry: { execute: input => h.run(input) },
      upsertDelegatedTask: h.functions.upsertDelegatedTask,
      saveState: async () => {}, appendMessage: (session, input) => session.messages.push(input)
    });
    try {
      await coordinator.launch(task);
      await waitFor(() => h.state.delegatedTasks.some(item => item.retryOf === "worker" && item.status === "completed"), `${provider} ${mode} retry did not complete`);
      const retry = h.state.delegatedTasks.find(item => item.retryOf === "worker");
      assert.equal(retry.mode, mode);
      assert.equal(h.captures.length, 2, "retry must execute once after the failed attempt");
      assertTransportMode(h.captures[1], mode, h.workspace.root);
      const message = h.parent.messages.find(item => item.sourceId === `${provider}-worker:${retry.id}`);
      assert.equal(message.payload.mode, mode);
      assert.equal(message.payload.nickname, "Read-only retry");
      assert.equal(h.active.size, 0);
    } finally { await coordinator.stop(); }
  }
}
console.log("Persisted analysis/review modes survive the real retry scheduler and cannot acquire implementation permissions after a transient failure");
