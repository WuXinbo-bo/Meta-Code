import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { resolveWorkbenchPaths } from "../dist-server/appPaths.js";
import { SecretVault } from "../dist-server/secretVault.js";
import { CliRuntimeManager } from "../dist-server/runtime/manager.js";
import { redactTaskText } from "../dist-server/tasks/context.js";

// Opt-in live-model test: use configured native adapters/credentials without
// changing the user's running service, account profiles or source workspace.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userPaths = resolveWorkbenchPaths(projectRoot);
const currentDb = new DatabaseSync(path.join(userPaths.dataDir, "workbench-state.db"), { readOnly: true });
const settings = JSON.parse(currentDb.prepare("SELECT json FROM settings WHERE id=1").get().json);
const profiles = currentDb.prepare("SELECT json FROM provider_connections").all().map((row) => JSON.parse(row.json));
currentDb.close();
const userSecrets = new SecretVault(userPaths.secretsFile).load();
assert.ok(userSecrets.codexApiKey && userSecrets.claudeApiKey, "Configure Codex and Claude connections before running this opt-in live test");
const manager = new CliRuntimeManager(projectRoot, userPaths.runtimesDir);
manager.configure(settings.runtime);
const runtimes = Object.fromEntries(await Promise.all(["codex", "claude"].map(async (id) => [id, await manager.detect(id)])));
for (const id of ["codex", "claude"]) assert.ok(runtimes[id].available, `${id}: ${runtimes[id].message}`);

const artifactsRoot = process.env.METACODE_NATIVE_TEST_ROOT || path.join(userPaths.dataDir, "test-artifacts");
await fs.mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
const testRoot = await fs.mkdtemp(path.join(artifactsRoot, "workflow-native-"));
const dataRoot = path.join(testRoot, "data");
await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
await fs.chmod(testRoot, 0o700);
const testSettings = structuredClone(settings);
testSettings.apiKey = "";
testSettings.claude.apiKey = "";
testSettings.reasoningEffort = "low";
testSettings.claude.effort = "low";
for (const id of ["codex", "claude"]) testSettings.runtime.selections[id] = { mode: "custom", systemPath: "", customPath: runtimes[id].path };
await fs.writeFile(path.join(dataRoot, "state.json"), JSON.stringify({ settings: testSettings, workspaces: [], sessions: [], delegatedTasks: [], mcpServers: [], skillFolders: [], skillOrganizations: [], capabilityProfiles: [], providerConnections: profiles.filter((profile) => ["codex", "claude"].includes(profile.providerId)).map((profile) => ({ ...profile, ownerUserId: "legacy-unassigned", apiKey: "", secretEnv: {} })), delegationProtocolVersion: 2 }), { mode: 0o600 });
new SecretVault(path.join(dataRoot, "credentials", "secrets.dat")).save({ codexApiKey: userSecrets.codexApiKey, claudeApiKey: userSecrets.claudeApiKey, mcp: {}, providerConnections: userSecrets.providerConnections });
const apiToken = crypto.randomBytes(32).toString("hex");
const port = await new Promise((resolve, reject) => {
  const reservation = net.createServer();
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", () => { const selected = reservation.address().port; reservation.close((error) => error ? reject(error) : resolve(selected)); });
});
const child = spawn(process.execPath, [path.join(projectRoot, "dist-server", "index.js")], {
  cwd: projectRoot, shell: false, windowsHide: true,
  env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`, PORT: String(port), METACODE_HOME: dataRoot, WORKSPACE_ROOT: testRoot, METACODE_API_TOKEN: apiToken },
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
child.stdout.on("data", (chunk) => { output = `${output}${redactTaskText(String(chunk))}`.slice(-50_000); });
child.stderr.on("data", (chunk) => { output = `${output}${redactTaskText(String(chunk))}`.slice(-50_000); });
const deadlineMs = Number(process.env.METACODE_NATIVE_TEST_TIMEOUT_MS || 30 * 60_000);
const report = { schemaVersion: 1, liveModels: true, startedAt: new Date().toISOString(), runtimes: Object.fromEntries(Object.entries(runtimes).map(([id, runtime]) => [id, { version: runtime.version, source: runtime.source }])), models: { codex: testSettings.model, claude: testSettings.claude.model }, tests: [] };
let baseUrl;
const until = async (condition, timeout, label) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test backend exited (${child.exitCode}): ${output.slice(-4000)}`);
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Timed out: ${label}`);
};
const request = async (route, body, method = "POST") => {
  const response = await fetch(`${baseUrl}${route}`, { method, headers: { "Content-Type": "application/json", "X-MetaCode-Api-Token": apiToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${route}: ${redactTaskText(JSON.stringify(value))}`);
  return value;
};
const summarize = (workflow) => ({ id: workflow.id, status: workflow.status, revision: workflow.revision, executionTarget: workflow.executionTarget, executionRoot: workflow.executionRoot, plannerTools: workflow.plannerLogs.filter((log) => log.kind === "tool").length, nodes: workflow.nodes.map((node) => ({ id: node.id, provider: node.provider, status: node.status, attempt: node.attempt, error: redactTaskText(node.error || ""), outcome: node.summary?.outcome, tools: node.logs.filter((log) => log.kind === "tool").length })), finalOutcome: workflow.finalResult?.outcome });
const toolShapes = (workflow) => [...new Map([...workflow.plannerLogs, ...workflow.nodes.flatMap((node) => node.logs)].filter((log) => log.kind === "tool").map((log) => {
  const shape = { title: log.title, detailKeys: log.detail ? Object.keys(log.detail).sort() : [], server: log.detail?.server, tool: log.detail?.tool };
  return [JSON.stringify(shape), shape];
})).values()];
const projectEntries = async (root) => {
  const entries = [];
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      entries.push(path.relative(root, file));
      if (entry.isDirectory()) await visit(file);
    }
  };
  await visit(root);
  return entries.sort();
};
const stopBackend = async () => {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 10_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  // Native CLIs can retain authentication/environment material in their own
  // temporary profiles (for example Codex shell snapshots). This independent
  // profile is an execution credential, never part of retained test evidence.
  await Promise.all(["credentials", "profiles"].map((directory) => fs.rm(path.join(dataRoot, directory), { recursive: true, force: true })));
};
const checkRetainedSecrets = async () => {
  const values = [...new Set([userSecrets.codexApiKey, userSecrets.claudeApiKey, ...Object.values(userSecrets.providerConnections || {}).flatMap((profile) => [profile.apiKey, ...Object.values(profile.secretEnv || {})])].filter((value) => typeof value === "string" && value.length >= 8))].map((value) => Buffer.from(value));
  const leaks = [];
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(file);
        if (values.some((value) => bytes.includes(value))) {
          leaks.push(path.relative(testRoot, file));
          // Never retain an accidentally generated plaintext credential file.
          await fs.rm(file, { force: true });
        }
      }
    }
  };
  await visit(testRoot);
  assert.deepEqual(leaks, [], "The independent live test must retain no plaintext credentials");
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  void stopBackend().then(checkRetainedSecrets).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
});
async function runProject(plannerEngine) {
  const worker = plannerEngine;
  const reviewer = plannerEngine === "codex" ? "claude" : "codex";
  const root = path.join(testRoot, `${plannerEngine}-project`);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "test"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "native-workflow-fixture", private: true, type: "module", scripts: { test: "node --test" } }));
  await fs.writeFile(path.join(root, "src", "math.js"), "export const sum = (left, right) => left - right;\n");
  await fs.writeFile(path.join(root, "test", "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../src/math.js';\ntest('adds positive and negative numbers', () => { assert.equal(sum(3, 4), 7); assert.equal(sum(-2, 5), 3); });\ntest('handles zero boundaries', () => { assert.equal(sum(0, 5), 5); assert.equal(sum(0, 0), 0); });\n");
  await fs.writeFile(path.join(root, "README.md"), "# Existing project\nRepair the sum implementation in place.\n");
  const originalEntries = await projectEntries(root);
  const workspace = await request("/api/workspaces", { root });
  const prompt = `维护当前已有的微型 JavaScript 项目，不创建新项目目录或任何额外任务目录。严格只需两个节点：1) 必须由 ${worker} 执行实现节点，修复 src/math.js 中 sum 错误，使 test/math.test.mjs 的正负数相加测试通过；仅允许写 src/math.js，执行 node --test 验证。2) 必须由 ${reviewer} 执行依赖于实现节点的只读审查节点，读取实际文件并执行 node --test 核验，不写任何业务文件。用户交付就是原项目中已修复的代码和验证结果，不需要单独报告文件，finalDelivery.required=false。不要扩展需求，不需要 Skill 或业务 MCP。规划节点 ID 分别是 implement、verify，两个节点均 required=true。`;
  // Start with an ordinary task, then enter orchestration in the same task.
  // Session creation itself never calls a model or changes project files.
  const hostConversation = await request("/api/sessions", { workspaceId: workspace.id, scopeKind: "workspace", engine: worker, title: `${plannerEngine} existing-project maintenance` });
  const sourceContext = await request(`/api/task-contexts/lookup?sessionId=${hostConversation.id}`, undefined, "GET");
  let workflow = await request("/api/workflows", { workspaceId: workspace.id, plannerEngine, prompt, hostSessionId: hostConversation.id, taskContextId: sourceContext.id });
  assert.equal(workflow.taskContextId, sourceContext.id, "Chat and orchestration must retain one task identity");
  assert.equal(workflow.executionTarget, "workspace");
  assert.equal(workflow.executionRoot, await fs.realpath(root));
  assert.deepEqual(await projectEntries(root), originalEntries, "Workflow creation must not add any business/protocol directory or file");
  await request(`/api/workflows/${workflow.id}/plan`, { mode: "initial" });
  let lastStatus = "";
  workflow = await until(async () => {
    const current = await request(`/api/workflows/${workflow.id}`, undefined, "GET");
    const signature = `${current.status}:${current.nodes.map((node) => `${node.id}=${node.status}`).join(",")}`;
    if (signature !== lastStatus) { console.log(`${plannerEngine}: ${signature}`); lastStatus = signature; }
    if (["failed", "needs_review", "canceled"].includes(current.status)) throw new Error(`Planning failed: ${redactTaskText(JSON.stringify(summarize(current)))}`);
    return current.status === "awaiting_approval" ? current : null;
  }, deadlineMs, `${plannerEngine} live planning`);
  assert.equal(workflow.originalPrompt, prompt, "Only the raw user goal belongs in originalPrompt");
  assert.equal(workflow.plan.nodes.length, 2, "The real planner must preserve the two-task acceptance contract");
  assert.equal(workflow.plan.nodes.find((node) => node.id === "implement")?.provider, worker);
  assert.equal(workflow.plan.nodes.find((node) => node.id === "verify")?.provider, reviewer);
  const initialPlannerToolRejections = workflow.plannerLogs.filter((log) => log.kind === "tool" && (log.detail?.status === "failed" || log.detail?.result?.is_error === true)).length;
  await request(`/api/workflows/${workflow.id}/approve`, { revision: workflow.revision });
  const originalPlanVersion = workflow.activePlanVersion;
  workflow = await until(async () => {
    const current = await request(`/api/workflows/${workflow.id}`, undefined, "GET");
    if (["failed", "needs_review", "canceled"].includes(current.status)) throw new Error(`Execution failed: ${redactTaskText(JSON.stringify(summarize(current)))}`);
    return current.nodes.some((node) => node.id === "implement" && node.status === "running") ? current : null;
  }, deadlineMs, `${plannerEngine} implementation starts`);
  const question = plannerEngine === "codex";
  const maintenance = await request(`/api/workflows/${workflow.id}/plan`, {
    source: "maintenance", mode: "refine", intent: question ? "question" : "adjust",
    note: question
      ? "只回答：当前已完成什么、还剩什么？这是只读问题，不得修改或重新提交任务图，不得更改业务文件，请使用 workflow_no_change 结束。"
      : "保留 implement 的全部合同字段和已经验证的成果，绝不重跑或修改 implement。只修改 verify 的 objective，在原来的只读测试核查之后，额外读取 test/math.test.mjs 中已有的零值边界测试，核查 sum(0, 5)===5 与 sum(0, 0)===0，并运行原合同已批准的 node --test；不改变 verify 的其他字段，不新增命令、节点或产物，不写任何业务文件，仍然 finalDelivery.required=false。请提交新的候选计划等待我审批。"
  });
  assert.equal(maintenance.queuedUntilCheckpoint, true, "A running task amendment must wait for a safe checkpoint");
  assert.equal(maintenance.workflow.pauseMode, "checkpoint");
  if (!question) {
    workflow = await until(async () => {
      const current = await request(`/api/workflows/${workflow.id}`, undefined, "GET");
      if (["failed", "needs_review", "canceled"].includes(current.status)) throw new Error(`Adjustment failed: ${redactTaskText(JSON.stringify(summarize(current)))}`);
      if (current.plannerLogs.some((log) => log.kind === "error" && log.title === "规划维护失败")) throw new Error("Live adjustment failed; inspect planner logs");
      return current.status === "awaiting_approval" && current.activePlanVersion > originalPlanVersion ? current : null;
    }, deadlineMs, `${plannerEngine} checkpoint adjustment approval`);
    assert.equal(workflow.plan.nodes.length, 2);
    assert.ok(workflow.plan.nodes.find((node) => node.id === "verify")?.objective.includes("0"));
    const approved = await request(`/api/workflows/${workflow.id}/approve`, { revision: workflow.revision });
    const implement = approved.nodes.find((node) => node.id === "implement");
    assert.equal(implement.status, "completed", "Unchanged implementation must be reused after a local review adjustment");
    assert.ok(implement.logs.some((log) => log.title === "复用已验证结果"));
  }
  const executionProgress = async () => {
    const current = await request(`/api/workflows/${workflow.id}`, undefined, "GET");
    const signature = `${current.status}:${current.nodes.map((node) => `${node.id}=${node.status}`).join(",")}`;
    if (signature !== lastStatus) { console.log(`${plannerEngine}: ${signature}`); lastStatus = signature; }
    if (["failed", "needs_review", "canceled"].includes(current.status)) throw new Error(`Execution failed: ${redactTaskText(JSON.stringify(summarize(current)))}`);
    return current;
  };
  workflow = await until(async () => {
    const current = await executionProgress();
    return ["integrating", "completed"].includes(current.status) ? current : null;
  }, deadlineMs, `${plannerEngine} native workers`);
  if (workflow.status !== "completed") workflow = await until(async () => {
    const current = await executionProgress();
    return current.status === "completed" ? current : null;
  }, deadlineMs, `${plannerEngine} final integration`);
  if (question) {
    assert.equal(workflow.activePlanVersion, originalPlanVersion, "A question must retain the approved graph version");
    assert.ok(workflow.plannerLogs.some((log) => log.kind === "message" && log.title === "计划未修改"), "The real planner must answer without replacing the graph");
    assert.ok(!workflow.plannerLogs.some((log) => log.kind === "error" && log.title === "规划维护失败"));
  }
  assert.ok(workflow.nodes.every((node) => node.status === "completed" && node.summary?.outcome === "completed"));
  const reviewNode = workflow.nodes.find((node) => node.id === "verify");
  assert.equal(reviewNode.workspaceAccess, "read");
  assert.ok(reviewNode.logs.some((log) => log.title === "开始只读系统验收"), "The host must execute approved review commands while the native reviewer retains read-only permissions");
  assert.ok(reviewNode.summary.checks.some((check) => check.command === "node --test" && check.status === "passed" && check.exitCode === 0), "Native review must retain actual host verification evidence");
  assert.deepEqual(await projectEntries(root), originalEntries, "Execution must not create task/protocol directories or files anywhere in the project");
  const context = await request(`/api/task-contexts/lookup?workflowId=${workflow.id}`, undefined, "GET");
  assert.equal(context.id, sourceContext.id);
  const conversation = await request(`/api/task-contexts/${context.id}/conversation`, { workflowId: workflow.id, engine: reviewer });
  const effective = await request(`/api/sessions/${conversation.id}`, undefined, "GET");
  assert.equal(effective.executionRoot, await fs.realpath(root));
  assert.equal(effective.taskContextId, context.id);
  assert.ok(effective.messages.some((message) => message.eventType === "task.context.handoff"));
  await request(`/api/sessions/${conversation.id}/run`, { prompt: "请继续当前任务，只读检查 src/math.js 和 test/math.test.mjs，执行 node --test，确认编排成果仍然有效，简短回答结果。不得修改或创建任何文件目录，不调用子 Agent。" });
  const continued = await until(async () => {
    const current = await request(`/api/sessions/${conversation.id}`, undefined, "GET");
    if (["failed", "interrupted", "stopped"].includes(current.status) || current.lastError) throw new Error(`Continuation failed: ${redactTaskText(current.lastError || current.status)}`);
    return current.status === "completed" && current.messages.some((message) => message.role === "assistant") ? current : null;
  }, deadlineMs, `${plannerEngine} native conversation continuation`);
  assert.equal(continued.taskContextId, context.id);
  assert.equal(continued.executionRoot, await fs.realpath(root));
  assert.deepEqual(await projectEntries(root), originalEntries);
  const result = { plannerEngine, worker, reviewer, projectRoot: root, ...summarize(workflow), toolShapes: toolShapes(workflow), initialPlannerToolRejections, contextId: context.id, hostConversationId: hostConversation.id, conversationId: conversation.id, checkpoint: question ? "question-without-graph-change" : "adjustment-with-implementation-reuse", readOnlyReviewerHostVerification: true, nativeConversationContinuation: true, noExtraProjectDirectory: true, completedAt: new Date().toISOString() };
  report.tests.push(result);
  await fs.writeFile(path.join(testRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`${plannerEngine}: real planning, reciprocal native workers, final integration and conversation handoff passed`);
}
async function runPureReadOnlyProject() {
  const root = path.join(testRoot, "claude-pure-readonly-project");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "README.md"), "# Native read-only fixture\nThe application computes sums. No edits or command execution are required.\n");
  await fs.writeFile(path.join(root, "math.js"), "export const sum = (left, right) => left + right;\n");
  const originalEntries = await projectEntries(root);
  const originalBytes = new Map(await Promise.all(originalEntries.map(async (entry) => [entry, await fs.readFile(path.join(root, entry))])));
  const workspace = await request("/api/workspaces", { root });
  let workflow = await request("/api/workflows", {
    workspaceId: workspace.id, plannerEngine: "claude",
    prompt: "对当前已有项目做一次纯只读说明，不执行命令，不编辑或创建任何文件目录。严格只规划一个节点 inspect，provider=claude、workspaceAccess=read、verificationCommands=[]、writeScope=[]、deliverables=[]、required=true。节点读取 README.md 与 math.js，说明 sum 如何工作即可。读取或静态分析是非命令检查，其checks.command=null、checks.exitCode=null，只记录真实阅读证据。不存在验收命令，不需要文件产物，finalDelivery.required=false。不添加 Skill、MCP 或其他节点。"
  });
  await request(`/api/workflows/${workflow.id}/plan`, { mode: "initial" });
  workflow = await until(async () => {
    const current = await request(`/api/workflows/${workflow.id}`, undefined, "GET");
    if (["failed", "needs_review", "canceled"].includes(current.status)) throw new Error(`Pure read-only planning failed: ${redactTaskText(JSON.stringify(summarize(current)))}`);
    return current.status === "awaiting_approval" ? current : null;
  }, deadlineMs, "Claude pure read-only planning");
  assert.equal(workflow.plan.nodes.length, 1);
  assert.equal(workflow.plan.nodes[0].id, "inspect");
  assert.equal(workflow.plan.nodes[0].provider, "claude");
  assert.equal(workflow.plan.nodes[0].workspaceAccess, "read");
  assert.deepEqual(workflow.plan.nodes[0].verificationCommands, []);
  await request(`/api/workflows/${workflow.id}/approve`, { revision: workflow.revision });
  workflow = await until(async () => {
    const current = await request(`/api/workflows/${workflow.id}`, undefined, "GET");
    if (["failed", "needs_review", "canceled"].includes(current.status)) throw new Error(`Pure read-only execution failed: ${redactTaskText(JSON.stringify(summarize(current)))}`);
    return current.status === "completed" ? current : null;
  }, deadlineMs, "Claude pure read-only execution/integration");
  const node = workflow.nodes[0];
  assert.equal(node.summary?.outcome, "completed");
  assert.ok(node.summary.humanSummary);
  assert.ok(!node.logs.some((log) => ["开始只读系统验收", "开始系统验收"].includes(log.title)), "A pure reading task must not manufacture verification commands");
  assert.ok(!node.logs.some((log) => log.kind === "tool" && /^(?:Bash|command_execution)/.test(log.title)), "A pure reading task must not execute shell commands");
  assert.deepEqual(await projectEntries(root), originalEntries);
  for (const [entry, bytes] of originalBytes) assert.deepEqual(await fs.readFile(path.join(root, entry)), bytes);
  report.tests.push({ testCase: "claude-pure-readonly-no-commands", plannerEngine: "claude", worker: "claude", projectRoot: root, ...summarize(workflow), toolShapes: toolShapes(workflow), pureReadOnlyNoCommands: true, nonCommandChecksUseNullFields: node.summary.checks.every((check) => check.command === null && check.exitCode === null), noExtraProjectDirectory: true, projectBytesUnchanged: true, completedAt: new Date().toISOString() });
  await fs.writeFile(path.join(testRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log("claude: pure read-only planning/execution without commands passed");
}
async function runPausedExternalChangeProject() {
  const root = path.join(testRoot, "claude-pause-external-change-project");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "README.md"), "# Existing project\nCorrect the arithmetic implementation in place.\n");
  await fs.writeFile(path.join(root, "math.js"), "export const sum = (left, right) => left - right;\n");
  const originalEntries = await projectEntries(root);
  const workspace = await request("/api/workspaces", { root });
  let workflow = await request("/api/workflows", {
    workspaceId: workspace.id, plannerEngine: "claude",
    prompt: "维护当前已有项目，不创建任何目录，严格两个节点。节点 implement 必须由 claude 实现，workspaceAccess=write，仅 writeScope=[math.js]，把 sum(left,right) 修成加法；必须把 math.js 登记成 required 文件产物，并将 changedFiles 登记为 math.js。节点 verify 必须由 codex 执行、dependsOn=[implement]、workspaceAccess=read，读取 math.js 核查加法实现即可。两个节点均 verificationCommands=[]，不运行命令、不写报告文件。用户成果就是 math.js，finalDelivery.required=false。不添加其他节点、Skill或业务MCP。"
  });
  await request(`/api/workflows/${workflow.id}/plan`, { mode: "initial" });
  workflow = await until(async () => {
    const current = await request(`/api/workflows/${workflow.id}`, undefined, "GET");
    if (["failed", "needs_review", "canceled"].includes(current.status)) throw new Error(`External-change planning failed: ${redactTaskText(JSON.stringify(summarize(current)))}`);
    return current.status === "awaiting_approval" ? current : null;
  }, deadlineMs, "External-change live planning");
  assert.equal(workflow.plan.nodes.length, 2);
  assert.equal(workflow.plan.nodes.find((node) => node.id === "implement")?.provider, "claude");
  assert.equal(workflow.plan.nodes.find((node) => node.id === "verify")?.provider, "codex");
  await request(`/api/workflows/${workflow.id}/approve`, { revision: workflow.revision });
  workflow = await until(async () => {
    const current = await request(`/api/workflows/${workflow.id}`, undefined, "GET");
    if (["failed", "needs_review", "canceled"].includes(current.status)) throw new Error(`External-change implementation failed: ${redactTaskText(JSON.stringify(summarize(current)))}`);
    return current.nodes.find((node) => node.id === "implement")?.status === "running" ? current : null;
  }, deadlineMs, "External-change implementation begins");
  const pause = await request(`/api/workflows/${workflow.id}/pause`, {});
  assert.equal(pause.pauseMode, "checkpoint");
  workflow = await until(async () => {
    const current = await request(`/api/workflows/${workflow.id}`, undefined, "GET");
    const implement = current.nodes.find((node) => node.id === "implement");
    if (["failed", "needs_review", "canceled"].includes(current.status)) throw new Error(`External-change checkpoint failed: ${redactTaskText(JSON.stringify(summarize(current)))}`);
    return current.status === "paused" && implement?.status === "completed" ? current : null;
  }, deadlineMs, "External-change checkpoint drains");
  const completedImplement = workflow.nodes.find((node) => node.id === "implement");
  assert.ok(completedImplement.summary.fileIntegrity, "A genuine completed upstream must have file evidence before testing the resume gate");
  assert.equal(workflow.nodes.find((node) => node.id === "verify").status, "pending");
  const externalBytes = "export const sum = (left, right) => left * right; // External edit after checkpoint\n";
  await fs.writeFile(path.join(root, "math.js"), externalBytes);
  await until(async () => {
    try { return await request(`/api/workflows/${workflow.id}/resume`, {}); }
    catch (error) { if (String(error).includes("工作流仍在安全暂停中")) return null; throw error; }
  }, 10_000, "Native checkpoint worker release before resume");
  workflow = await until(async () => {
    const current = await request(`/api/workflows/${workflow.id}`, undefined, "GET");
    if (["failed", "completed", "canceled"].includes(current.status)) throw new Error(`External-change gate reached unexpected state: ${current.status}`);
    return current.status === "needs_review" ? current : null;
  }, 30_000, "Paused external output edit is rejected before downstream dispatch");
  const stale = workflow.nodes.find((node) => node.id === "implement");
  const downstream = workflow.nodes.find((node) => node.id === "verify");
  assert.equal(stale.status, "blocked");
  assert.ok(stale.staleReason);
  assert.ok(stale.logs.some((log) => log.title === "恢复前文件证据已过期"));
  assert.equal(downstream.attempt, 0, "A stale upstream must be rejected before any native downstream worker starts");
  assert.ok(!downstream.logs.some((log) => log.title === "开始执行"));
  assert.equal(await fs.readFile(path.join(root, "math.js"), "utf8"), externalBytes, "Resume must preserve the external project edit");
  assert.deepEqual(await projectEntries(root), originalEntries);
  report.tests.push({ testCase: "native-paused-external-output-change", testOutcome: "passed", plannerEngine: "claude", worker: "claude", reviewer: "codex", projectRoot: root, ...summarize(workflow), expectedStatus: "needs_review", staleUpstreamBlocked: true, downstreamNeverStarted: true, externalBytesPreserved: true, noExtraProjectDirectory: true, completedAt: new Date().toISOString() });
  await fs.writeFile(path.join(testRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log("claude: native checkpoint plus external-edit resume gate passed (expected needs_review)");
}
try {
  const address = await until(() => output.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1], 30_000, "test backend startup");
  baseUrl = `http://127.0.0.1:${address}`;
  await request("/api/bootstrap", undefined, "GET");
  console.log(`Real native test artifacts: ${testRoot}`);
  for (const engine of ["codex", "claude"]) {
    try { await runProject(engine); }
    catch (error) { report.tests.push({ plannerEngine: engine, status: "failed", error: redactTaskText(error instanceof Error ? error.message : String(error)), failedAt: new Date().toISOString() }); console.error(`${engine}: ${redactTaskText(error instanceof Error ? error.message : String(error))}`); }
  }
  try { await runPureReadOnlyProject(); }
  catch (error) { report.tests.push({ testCase: "claude-pure-readonly-no-commands", plannerEngine: "claude", status: "failed", error: redactTaskText(error instanceof Error ? error.message : String(error)), failedAt: new Date().toISOString() }); console.error(`claude-pure-readonly: ${redactTaskText(error instanceof Error ? error.message : String(error))}`); }
  try { await runPausedExternalChangeProject(); }
  catch (error) { report.tests.push({ testCase: "native-paused-external-output-change", plannerEngine: "claude", status: "failed", error: redactTaskText(error instanceof Error ? error.message : String(error)), failedAt: new Date().toISOString() }); console.error(`native-paused-external-change: ${redactTaskText(error instanceof Error ? error.message : String(error))}`); }
  report.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(testRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  assert.equal(report.tests.filter((test) => test.status === "failed").length, 0, `Live-model tests failed; inspect ${path.join(testRoot, "report.json")}`);
} finally {
  // Test project/results remain inspectable; copied credentials never remain
  // in the retained artifact directory after the test process finishes.
  await stopBackend();
  await checkRetainedSecrets();
}
