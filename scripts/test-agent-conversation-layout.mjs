import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

// Load the real UI through Vite so branding assets resolve exactly as in the app.
const server = await createServer({ server: { middlewareMode: true }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
let AgentConversation, AssistantReply;
try {
  ({ AgentConversation } = await server.ssrLoadModule("/src/components/AgentConversation.tsx"));
  ({ AssistantReply } = await server.ssrLoadModule("/src/components/AssistantReply.tsx"));
} finally {
  await server.close();
}

globalThis.React = React;
const log = (id, category, text) => ({ id: String(id), createdAt: `2026-09-17T00:00:${String(id).padStart(2, "0")}.000Z`, kind: category === "message" ? "message" : category === "error" ? "error" : "tool", category, phase: "completed", text, title: category });
const logs = [log(1, "message", "第一条回复"), log(2, "command", "npm test"), log(3, "command", "npm build"), log(4, "message", "第二条回复"), log(5, "command", "git status"), log(6, "file", "file.ts"), log(7, "command", "git diff")];
const render = (props) => renderToStaticMarkup(React.createElement(AgentConversation, { logs, status: "completed", provider: "codex", showProvider: false, ...props }));

for (const provider of ["codex", "claude", "gemini", "codebuddy"]) {
  const html = render({ provider });
  assert.equal((html.match(/assistant-reply/g) || []).length, 2, `${provider}: shared reply rows`);
  assert.doesNotMatch(html, /assistant-reply-heading|agent-chat-message/, `${provider}: no repeated identity heading`);
  assert.ok(html.indexOf("第一条回复") < html.indexOf("运行 2 个命令"));
  assert.ok(html.indexOf("运行 2 个命令") < html.indexOf("第二条回复"));
  assert.equal((html.match(/运行 1 个命令/g) || []).length, 2, "commands separated by files are not moved across each other");
  assert.doesNotMatch(html, /npm test|npm build|git status/, "completed command previews are hidden until expanded");
}
const live = render({ status: "running" });
assert.match(live, /运行 2 个命令/, "historical commands remain visible during a later segment");
assert.ok(live.indexOf("运行 2 个命令") < live.indexOf("第二条回复"));
assert.doesNotMatch(live, /git diff|git status|file\.ts/, "normal tool bodies remain collapsed while activity streams");
assert.equal((live.match(/运行 1 个命令/g) || []).length, 2, "single commands retain separate chronological disclosures");
assert.match(live, /修改 1 项文件/, "completed file activity retains its collapsed disclosure");
assert.match(live, /agent-work-progress__spinner/, "existing logs retain a working indicator at the tail");
assert.doesNotMatch(render(), /agent-work-progress/, "completed transcripts do not keep a working animation");
const resumed = render({ status: "running", logs: [...logs, log(8, "message", "完成检查")] });
assert.doesNotMatch(resumed, /activity-live-current/, "a reply closes the previous rotating segment");
assert.equal((resumed.match(/运行 1 个命令/g) || []).length, 2);
const consecutive = render({ status: "running", logs: [...logs.slice(0, 4), log(9, "command", "first current"), { ...log(10, "command", "second current"), phase: "running" }] });
assert.match(consecutive, /运行 2 个命令/, "same-turn completed and running tools stay in one collapsed group");
assert.match(consecutive, /phase-running/, "the current grouped tool remains visibly active");
const lifecycle = { id: "lifecycle", createdAt: "2026-09-17T00:01:00.000Z", kind: "status", category: "status", phase: "running", title: "正在运行", text: "子 Agent 正在工作" };
assert.match(render({ status: "running", logs: [lifecycle] }), /子 Agent 正在工作/, "a single live lifecycle event remains visible");
const bootLifecycle = [
  { ...lifecycle, id: "created", phase: "completed", title: "任务状态", text: "Codex 会话已创建" },
  { ...lifecycle, id: "started", title: "运行轮次", text: "开始运行" }
];
assert.doesNotMatch(render({ status: "running", logs: bootLifecycle }), /会话已创建|开始运行|暂无可展示的活动/, "routine bootstrap acknowledgements stay out of the default transcript");
assert.match(render({ status: "running", logs: bootLifecycle }), /智能体正在工作/, "bootstrap-only activity still has clear progress feedback");
assert.match(render({ status: "completed", logs: [{ ...lifecycle, phase: "completed", title: "已完成", text: "子 Agent 已完成" }] }), /子 Agent 已完成/, "a single completed lifecycle event remains visible");
assert.doesNotMatch(render({ status: "completed", logs: [{ ...lifecycle, phase: "completed" }] }), /没有匹配的活动/, "lifecycle-only logs are not reported as a filter miss");
assert.match(render({ showProvider: true }), /assistant-reply-heading/);
assert.match(render({ logs: [], loading: true }), /正在读取活动日志/);
assert.doesNotMatch(render({ logs: [], loading: true }), /尚无活动日志/);
assert.match(render({ loading: true, error: "连接中断" }), /第一条回复/, "a refresh failure preserves existing transcript");
assert.match(render({ logs: [log(1, "unknown", "future event")] }), /未识别|unknown|future event/, "unknown events remain accessible");
assert.match(render({ logs: [log(1, "error", "failed command")] }), /failed command/);
const failedTool = render({ logs: [{ ...log(1, "command", "failed validation"), phase: "failed", detail: { command: "npm test", output: "Validation failed" } }] });
assert.match(failedTool, /运行 1 个命令/, "failed executions retain the same compact command disclosure");
assert.doesNotMatch(failedTool, /<details[^>]*open=""/, "failed command groups are initially collapsed");
assert.doesNotMatch(failedTool, /Validation failed|npm test/, "failed output remains available only after manual expansion");
for (const status of ["running", "completed", "failed"]) {
  for (const category of ["command", "file", "read", "search", "tool", "mcp", "unknown", "error"]) {
    const failed = render({ status, logs: [{ ...log(1, category, "failure summary"), phase: "failed", detail: { output: "failure output" } }] });
    assert.doesNotMatch(failed, /<details[^>]*open=""/, `${category}: ${status} does not auto-reveal a failed entry`);
    assert.doesNotMatch(failed, /failure output/, `${category}: ${status} keeps failure detail collapsed`);
  }
}
const planLog = { ...log(1, "todo", "更新计划"), phase: "running", detail: { items: [{ text: "执行计划检查", completed: false }] } };
assert.match(render({ status: "running", logs: [planLog] }), /agent-plan-view/, "plan tool updates retain their shared plan presentation");
assert.doesNotMatch(render({ status: "running", logs: [planLog] }), /<details[^>]*open=""/, "plan tool updates also default collapsed");
const reply = renderToStaticMarkup(React.createElement(AssistantReply, { text: "**正文**", avatar: "Agent", actions: React.createElement("button", null, "复制") }));
assert.match(reply, /<strong>正文<\/strong>/);
assert.match(reply, /复制/);
console.log("Agent conversation: chronological grouping, shared replies, live transitions and loading states passed");
