import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { agentPlanSnapshot, formatAgentDuration, normalizeActivityLogs, normalizeAgentStreamLog, agentStreamVersion, summarizeAgentTurn } from "../src/components/activityModel.ts";

const legacy = normalizeAgentStreamLog({ id: "legacy", kind: "message" }, 4);
assert.equal(legacy.text, "Agent 回复");
assert.equal(legacy.title, "Agent 回复");
assert.equal(legacy.createdAt, new Date(4).toISOString());

const malformed = normalizeAgentStreamLog(null, 2);
assert.equal(malformed.id, "legacy-agent-log-2");
assert.equal(malformed.kind, "status");
assert.equal(malformed.text, "状态更新");

const normalized = normalizeActivityLogs([
  { id: "later", createdAt: "2026-01-02T00:00:00.000Z", kind: "tool", title: "Bash", text: "echo ok", category: "command", phase: "completed" },
  { id: "earlier", createdAt: "2026-01-01T00:00:00.000Z", kind: "message", title: "回复", text: "完成" },
  { id: "later", createdAt: "2026-01-03T00:00:00.000Z", kind: "tool", title: "Bash", text: "echo updated", category: "command", phase: "completed" },
  { id: "missing-fields" }
]);
assert.equal(normalized.length, 3);
assert.equal(normalized.find((log) => log.id === "later")?.text, "echo updated");
assert.ok(normalized.every((log) => typeof log.text === "string" && typeof log.createdAt === "string"));
assert.match(agentStreamVersion([{ id: "x", kind: "message" }]), /^1\|x\|/);

const codexPlan = agentPlanSnapshot(normalizeActivityLogs([{
  id: "codex-plan", createdAt: "2026-01-03T00:00:00.000Z", kind: "tool", title: "计划更新", text: "1/2 项已完成", category: "todo", detail: { items: [{ text: "检查结构", completed: true }, { text: "执行测试", completed: false }] }
}])[0], "codex");
assert.equal(codexPlan?.completed, 1);
assert.equal(codexPlan?.items[1].status, "pending");

const claudePlan = agentPlanSnapshot(normalizeActivityLogs([{
  id: "claude-plan", createdAt: "2026-01-03T00:00:00.000Z", kind: "tool", title: "TodoWrite", text: "更新计划", category: "todo", detail: { input: { todos: [{ content: "调整界面", status: "in_progress" }, { content: "回归测试", status: "pending" }] } }
}])[0], "claude");
assert.equal(claudePlan?.total, 2);
assert.equal(claudePlan?.items[0].status, "in_progress");

const timedTurn = summarizeAgentTurn([
  { id: "start", createdAt: "2026-01-01T00:00:00.000Z", kind: "tool", title: "执行命令", text: "npm test", category: "command", phase: "running" },
  { id: "pause", createdAt: "2026-01-01T00:01:00.000Z", kind: "status", title: "已暂停", text: "等待继续", category: "status", phase: "completed" },
  { id: "resume", createdAt: "2026-01-01T00:03:00.000Z", kind: "status", title: "继续执行", text: "已恢复", category: "status", phase: "running" },
  { id: "done", createdAt: "2026-01-01T00:04:00.000Z", kind: "result", title: "执行完成", text: "通过", category: "result", phase: "completed" }
], "completed", Date.parse("2026-01-01T00:10:00.000Z"));
assert.equal(timedTurn.state, "completed");
assert.equal(timedTurn.activeDurationMs, 120_000);
assert.equal(timedTurn.counts.command, 1);
assert.equal(formatAgentDuration(timedTurn.activeDurationMs), "2分钟");
const historicalTurn = summarizeAgentTurn([
  { id: "old", createdAt: "2026-01-01T00:00:00.000Z", kind: "tool", title: "执行命令", text: "long task", category: "command", phase: "running" }
], "running", Date.parse("2026-01-01T01:00:00.000Z"));
assert.equal(historicalTurn.state, "historical");
assert.equal(historicalTurn.activeDurationMs, 0);

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const fileTree = await readFile(new URL("../src/components/WorkspaceFileTree.tsx", import.meta.url), "utf8");
const workflow = await readFile(new URL("../src/workflow/WorkflowWorkbench.tsx", import.meta.url), "utf8");
const conversation = await readFile(new URL("../src/components/AgentConversation.tsx", import.meta.url), "utf8");
const timeline = await readFile(new URL("../src/components/ActivityTimeline.tsx", import.meta.url), "utf8");
const entry = await readFile(new URL("../src/components/AgentActivityEntry.tsx", import.meta.url), "utf8");
const renderer = await readFile(new URL("../src/components/ActivityRenderer.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const conversationStyles = await readFile(new URL("../src/design/conversation.css", import.meta.url), "utf8");
const planView = await readFile(new URL("../src/components/AgentPlanView.tsx", import.meta.url), "utf8");
const capabilityControl = await readFile(new URL("../src/chat/CapabilityProfileControl.tsx", import.meta.url), "utf8");
const runtimeControl = await readFile(new URL("../src/chat/ComposerRuntimeControl.tsx", import.meta.url), "utf8");
const pendingTurnTray = await readFile(new URL("../src/chat/PendingTurnTray.tsx", import.meta.url), "utf8");
const settingsNavigation = await readFile(new URL("../src/settings/SettingsNavigation.tsx", import.meta.url), "utf8");
const sessionManagement = await readFile(new URL("../src/session-management/SessionManagementView.tsx", import.meta.url), "utf8");
const realtimeCoordinator = await readFile(new URL("../src/realtimeCoordinator.ts", import.meta.url), "utf8");
const providerConnectionControl = await readFile(new URL("../src/settings/ProviderConnectionControl.tsx", import.meta.url), "utf8");
const controlPlane = await readFile(new URL("../server/providers/controlPlane.ts", import.meta.url), "utf8");
const server = await readFile(new URL("../server/index.ts", import.meta.url), "utf8");
assert.doesNotMatch(app, /import\s+\{\s*ActivityTimeline\s*\}/);
assert.doesNotMatch(workflow, /import\s+\{\s*ActivityTimeline\s*\}/);
assert.match(app, /<AgentConversation/);
assert.match(app, /showProvider=\{false\}/);
assert.doesNotMatch(app, /message-agent-heading/);
assert.match(app, /message\.role !== "user" && <div className="avatar"><Bot size=\{17\}/);
assert.match(app, /<ProviderIcon provider=\{provider\} icon=\{providerControl\?\.identity\.icon\} accent=\{providerControl\?\.identity\.accent\} size=\{18\}/);
assert.match(entry, /<ProviderIcon provider=\{provider\} icon=\{providerIcon\} accent=\{providerAccent\} size=\{18\}/);
assert.match(entry, /\{preview\.available && <span><i>\+\{preview\.additions\}<\/i><b>-\{preview\.deletions\}<\/b><\/span>\}/);
assert.match(conversation, /providerIcon=\{providerIcon\}/);
assert.match(app, /subagentStatusLabel\(agent\.status\)/);
assert.match(app, /<CapabilityProfileControl/);
assert.doesNotMatch(app, /capability-resource-tabs/);
assert.doesNotMatch(app, /扩展全设自动|扩展全设手动|关闭全部扩展/);
assert.match(app, /<ComposerRuntimeControl/);
assert.match(app, /<PendingTurnTray/);
assert.match(app, /item\.mode !== "steer" && item\.status !== "steering"/);
assert.match(app, /const pendingGuidance = activeSession\.pendingInputs\.find/);
assert.match(app, /await promotePendingInput\(pendingGuidance\.id\)/);
assert.match(app, /touch-actions-open/);
assert.match(app, /document\.addEventListener\("pointerdown", dismissTouchActions, true\)/);
assert.match(conversationStyles, /\.message\.touch-actions-open \.message-actions/);
assert.match(conversationStyles, /margin-bottom: 0/);
assert.match(capabilityControl, /activeLabel/);
assert.doesNotMatch(capabilityControl, /Skill \$\{/);
assert.match(runtimeControl, /\["native", "collaborative"\]/);
assert.match(runtimeControl, /aria-label="模型"/);
assert.match(runtimeControl, /aria-label="思考强度"/);
assert.match(pendingTurnTray, /立即引导/);
assert.match(pendingTurnTray, /立即运行/);
assert.match(pendingTurnTray, /onEdit/);
assert.match(pendingTurnTray, /onRemove/);
assert.doesNotMatch(app, /taskRuntimeLabel/);
assert.doesNotMatch(app, /if \(providerTab === "claude"\) return/);
assert.doesNotMatch(app, /settings-ai-subnav/);
assert.match(app, /settings-shell/);
assert.doesNotMatch(app, /agentMarketOpen/);
assert.match(settingsNavigation, /label: "Agent"/);
assert.doesNotMatch(sessionManagement, /<button[^>]*className=\{`session-inventory-row[\s\S]*?<input[^>]*type="checkbox"/);
assert.match(sessionManagement, /className="session-row-content"/);
assert.match(settingsNavigation, /label: "总览"/);
assert.match(settingsNavigation, /label: "Provider"/);
assert.match(settingsNavigation, /label: "Agent 市场"/);
assert.match(settingsNavigation, /label: "运行环境"/);
assert.match(app, /<AgentMarketSettings/);
assert.match(app, /aiSettingsPage === "market"/);
assert.match(app, /<InstalledProviderConnections/);
assert.match(app, /settings-provider-config-grid/);
assert.match(app, /<SettingsNavigation/);
assert.match(app, /value=\{form\.defaultEngine\}/);
assert.match(app, /control \? control\.operations\.setDefault/);
assert.match(app, /disabled=\{busy \|\| !selectedAvailable\}/);
assert.match(controlPlane, /setDefault: Boolean\(input\.operations\?\.setDefault\) && capabilities\.sessions\.create && status === "ready" && !input\.updating/);
assert.match(server, /normalizeProviderId\(req\.body\.engine \|\| state\.settings\.defaultEngine\)/);
assert.match(server, /if \(!providerControl\.operations\.setDefault\)/);
assert.match(realtimeCoordinator, /"provider-control\.changed"/);
assert.match(app, /"agent-market\.changed", "provider-control\.changed"/);
assert.match(app, /bootstrapRefreshTimer/);
assert.match(app, /navigationRefreshTimer/);
assert.match(providerConnectionControl, /subscribe\("provider-control\.changed"/);
assert.match(app, /<WorkspaceFileTree/);
assert.match(fileTree, /className="tree-row-main"/);
assert.doesNotMatch(fileTree, /tree-row-actions"><span role="button"/);
assert.match(app, /aria-label="编辑 AGENTS\.md"/);
assert.match(workflow, /<AgentConversation/);
assert.match(conversation, /<ActivityTimeline/);
assert.match(conversation, /showProvider/);
assert.doesNotMatch(timeline, /<AgentTurnSummary/);
assert.doesNotMatch(timeline, /ProviderIcon/);
assert.doesNotMatch(timeline, /formatAgentDuration/);
assert.match(timeline, /<AgentPlanView/);
assert.match(timeline, /<ActivityRenderer/);
assert.doesNotMatch(timeline, /<AgentActivityEntry/);
assert.match(renderer, /GenericActivityRenderer/);
assert.match(renderer, /unknown: GenericActivityRenderer/);
assert.match(timeline, /activityGroupLabel/);
assert.match(timeline, /open && <div className="agent-stream-cluster-items">/);
assert.match(timeline, /className="activity-timeline single-layer"/);
assert.match(timeline, /title: "思考", text: "", detail: undefined/);
assert.match(entry, /agent-thinking-line settled/);
assert.doesNotMatch(entry, /agent-reasoning-content/);
assert.match(styles, /\.agent-chat-message \{[^}]*border: 0;[^}]*background: transparent;/);
assert.match(conversationStyles, /\.activity-timeline\.single-layer/);
assert.doesNotMatch(conversationStyles, /category-command \.agent-stream-copy small[^}]*display:\s*none/);
assert.match(conversationStyles, /\.activity-timeline\.single-layer \.agent-stream-event > summary,[\s\S]*grid-template-columns:\s*18px minmax\(0, 1fr\) 12px/);
assert.match(conversationStyles, /\.activity-timeline\.single-layer \.agent-stream-event > summary time,[\s\S]*display:\s*none/);
assert.match(planView, /agent-plan-progress/);
assert.match(app, /useAgentOutputFollow\(/);
assert.match(app, /logs=\{selectedAgent \? selectedAgentLogs : logs\.map\(eventActivityLog\)\}/);
assert.match(workflow, /useAgentOutputFollow\(/);
assert.doesNotMatch(app, /\?\.text\.length/);

console.log("Unified agent stream normalization and renderer ownership OK");
