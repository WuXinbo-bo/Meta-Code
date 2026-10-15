import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import ts from "typescript";
import { canonicalActivity, normalizeCanonicalActivity } from "../server/activity/normalize.ts";
import { canonicalActivityFromEngineEvent } from "../server/activity/fromEngineEvent.ts";
import { codexActivityFromEvent, summarizeCodexEvent } from "../server/engines/codex/events.ts";
import { upsertWorkflowLog, workflowLog, workflowLogFromEngineEvent } from "../server/plugins/orchestration/logs.ts";
import { WorkflowRepository } from "../server/plugins/orchestration/repository.ts";
import { isEmptyAssistantMessage, normalizeActivityLogs, normalizeAgentStreamLog } from "../src/components/activityModel.ts";

const blankItem = { type: "item.completed", item: { id: "item_0", type: "agent_message", text: " " } };
assert.equal(codexActivityFromEvent(blankItem).summary.trim(), "", "SDK whitespace must not become the reply label");
assert.equal(summarizeCodexEvent(blankItem).trim(), "");
assert.equal(canonicalActivity({ id: "blank", rawType: "agent_message", provider: "codex", actor: { kind: "workflow" }, semanticType: "message", title: "Codex 回复", summary: "" }).summary, "");
assert.equal(normalizeCanonicalActivity({ semanticType: "status", title: "状态更新", summary: " " }).summary, "状态更新", "operational events retain useful fallback labels");
assert.equal(canonicalActivityFromEngineEvent({ type: "assistant", text: "" }, { provider: "claude", actor: { kind: "workflow" } }).summary, "");

const blankLog = workflowLogFromEngineEvent({ type: "assistant", sourceId: "item_0", text: "Codex 回复", payload: blankItem }, "planner");
assert.equal(blankLog.text.trim(), "", "raw SDK text is authoritative even for already-normalized fallback text");
assert.equal(blankLog.activity.summary.trim(), "");
const logs = [workflowLog("reasoning", "正在分析", "分析任务", "reasoning")];
const originalReasoning = JSON.stringify(logs[0]);
upsertWorkflowLog(logs, blankLog);
assert.equal(logs.length, 1, "new empty replies never enter workflow history");
assert.equal(JSON.stringify(logs[0]), originalReasoning, "empty stream markers do not settle visible reasoning");

for (const provider of ["codex", "claude"]) {
  upsertWorkflowLog(logs, workflowLogFromEngineEvent({ type: "assistant", sourceId: "reply-a", text: "已完成业务检查", phase: "running" }, provider));
  upsertWorkflowLog(logs, workflowLogFromEngineEvent({ type: "assistant", sourceId: "reply-b", text: "已完成业务检查" }, provider));
  upsertWorkflowLog(logs, workflowLogFromEngineEvent({ type: "assistant", sourceId: "reply-a", text: " ", phase: "completed" }, provider));
  const completed = logs.find((log) => log.id === `${provider}:reply-a`);
  assert.equal(completed.text, "已完成业务检查", "empty completion cannot erase streamed content");
  assert.equal(completed.activity.summary, "已完成业务检查");
  assert.equal(completed.activity.phase, "completed");
}
assert.equal(logs.filter((log) => log.kind === "message").length, 4, "distinct reply identities are retained even with identical prose");
upsertWorkflowLog(logs, workflowLogFromEngineEvent({ type: "tool.completed", sourceId: "tool", text: "", toolName: "MCP" }, "codex"));
upsertWorkflowLog(logs, workflowLogFromEngineEvent({ type: "status", sourceId: "reconnect", text: "Reconnecting... 1/5" }, "codex"));
assert.ok(logs.find((log) => log.id === "codex:tool"));
assert.ok(logs.find((log) => log.id === "codex:reconnect"));

const legacyEmpty = { ...blankLog, text: "Codex 回复", activity: { ...blankLog.activity, summary: "Codex 回复", detail: blankItem } };
assert.equal(normalizeAgentStreamLog(legacyEmpty).text, "", "old stored placeholders are recognized only from blank raw items");
const actualLabelReply = { ...legacyEmpty, id: "literal-label", activity: { ...legacyEmpty.activity, id: "literal-label", detail: { ...blankItem, item: { ...blankItem.item, text: "Codex 回复" } } } };
const unknownLegacy = { id: "legacy-without-evidence", kind: "message", title: "Agent 回复", text: "Codex 回复" };
const projected = normalizeActivityLogs([legacyEmpty, actualLabelReply, unknownLegacy, ...logs]);
assert.equal(projected.filter((log) => log.id === legacyEmpty.id).length, 0);
assert.equal(projected.find((log) => log.id === "literal-label").text, "Codex 回复", "a real reply matching a label must not be filtered");
assert.equal(projected.find((log) => log.id === "legacy-without-evidence").text, "Codex 回复", "unproven legacy content remains visible");
assert.equal(projected.filter((log) => log.kind === "message").length, 6);
assert.ok(projected.find((log) => log.id === "codex:tool"));
assert.ok(projected.find((log) => log.id === "codex:reconnect"));

const streamed = normalizeActivityLogs([
  { id: "stream", kind: "message", title: "Agent 回复", text: "第一阶段正文", createdAt: "2026-01-01T00:00:00Z", phase: "running" },
  { ...legacyEmpty, id: "stream", activity: { ...legacyEmpty.activity, id: "stream", occurredAt: "2026-01-01T00:00:01Z" } },
  { id: "stream", kind: "message", title: "Agent 回复", text: "最终正文", createdAt: "2026-01-01T00:00:02Z", phase: "completed", provider: "unknown" }
]);
assert.equal(streamed.at(-1).text, "最终正文");
const blankCompletion = normalizeActivityLogs([
  { ...legacyEmpty, text: "流式正文", activity: { ...legacyEmpty.activity, summary: "流式正文", phase: "running", detail: undefined, occurredAt: "2026-01-01T00:00:00Z" } },
  { ...legacyEmpty, activity: { ...legacyEmpty.activity, occurredAt: "2026-01-01T00:00:01Z" } }
]);
assert.equal(blankCompletion.length, 1);
assert.equal(blankCompletion[0].text, "流式正文");
assert.equal(blankCompletion[0].phase, "completed");

const db = new DatabaseSync(":memory:");
try {
  const repository = new WorkflowRepository(db);
  const workflow = repository.create({ id: "log-boundary", ownerUserId: "owner", workspaceId: "project", executionRoot: process.cwd(), workspaceRoot: process.cwd(), executionTarget: "workspace", prompt: "Review source", plannerEngine: "codex" });
  for (const stage of ["planner", "integration"]) {
    const append = (log) => stage === "planner" ? repository.appendPlannerLog(workflow.id, "owner", log) : repository.appendIntegrationLog(workflow.id, log);
    const read = () => repository.get(workflow.id, "owner");
    const originalRevision = read().revision;
    append(blankLog);
    assert.equal(read().revision, originalRevision, `${stage}: empty stream markers do not write or advance revision`);
    const content = workflowLogFromEngineEvent({ type: "assistant", sourceId: "preserved", text: "已确认真实业务成果", phase: "running" }, stage);
    append(content);
    const afterWrite = read().revision;
    append(content);
    assert.equal(read().revision, afterWrite, `${stage}: identical record replay does not cause another database write`);
    append(workflowLogFromEngineEvent({ type: "assistant", sourceId: "preserved", text: "", phase: "completed" }, stage));
    const persisted = read()[`${stage}Logs`];
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].text, "已确认真实业务成果");
    assert.equal(persisted[0].activity.summary, "已确认真实业务成果");
    assert.equal(persisted[0].activity.phase, "completed");
  }
} finally { db.close(); }

const appSource = await fs.readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const app = ts.createSourceFile("App.tsx", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["visibleConversationMessages", "claudeStatusSubtype", "completedReasoningMessage"];
const declarations = app.statements.filter((statement) => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text));
assert.equal(declarations.length, names.length);
const compiled = ts.transpileModule(declarations.map((statement) => statement.getText(app)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const visibleConversationMessages = vm.runInNewContext(`${compiled}\nvisibleConversationMessages;`, { isEmptyAssistantMessage });
const mainMessages = [
  { id: "blank-text", role: "assistant", text: " \n" },
  { id: "blank-payload", role: "assistant", text: "Codex 回复", payload: blankItem.item },
  { id: "blank-activity-detail", role: "assistant", text: "Codex 回复", activityDetail: blankItem },
  { id: "blank-canonical-detail", role: "assistant", text: "Codex 回复", activity: { summary: "Codex 回复", detail: blankItem } },
  { id: "actual-label", role: "assistant", text: "Codex 回复", payload: { ...blankItem.item, text: "Codex 回复" } },
  { id: "unproven-legacy", role: "assistant", text: "Codex 回复" },
  { id: "user", role: "user", text: " " },
  { id: "tool", role: "event", text: "", eventType: "mcp_tool_call" },
  { id: "handoff", role: "assistant", eventType: "task.context.handoff", text: "已完成项目验证" },
  { id: "real-reply", role: "assistant", text: "本轮修复并验证了业务实现" }
];
const originalMessages = JSON.stringify(mainMessages);
assert.deepEqual(Array.from(visibleConversationMessages(mainMessages, "completed"), (message) => message.id), ["actual-label", "unproven-legacy", "user", "tool", "handoff", "real-reply"]);
assert.equal(JSON.stringify(mainMessages), originalMessages, "main chat projection never modifies persisted history");
console.log("Workflow log content: empty SDK markers suppressed, historical evidence handled, real replies/tools/reconnect retained");
