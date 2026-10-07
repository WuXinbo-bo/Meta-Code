import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

// Load the real UI through Vite so branding assets resolve exactly as in the app.
const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
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
assert.match(live, /git diff/, "latest command remains visible in the open segment");
assert.match(live, /git status/, "completed commands remain visible while a later activity streams");
assert.match(live, /file.ts/, "completed file activity remains visible in the open segment");
const resumed = render({ status: "running", logs: [...logs, log(8, "message", "完成检查")] });
assert.doesNotMatch(resumed, /activity-live-current/, "a reply closes the previous rotating segment");
assert.equal((resumed.match(/运行 1 个命令/g) || []).length, 2);
const consecutive = render({ status: "running", logs: [...logs.slice(0, 4), log(9, "command", "first current"), { ...log(10, "command", "second current"), phase: "running" }] });
assert.match(consecutive, /运行 2 个命令/, "same-turn completed and running tools stay in one collapsed group");
assert.match(consecutive, /phase-running/, "the current grouped tool remains visibly active");
const lifecycle = { id: "lifecycle", createdAt: "2026-09-17T00:01:00.000Z", kind: "status", category: "status", phase: "running", title: "正在运行", text: "子 Agent 正在工作" };
assert.match(render({ status: "running", logs: [lifecycle] }), /子 Agent 正在工作/, "a single live lifecycle event remains visible");
assert.match(render({ status: "completed", logs: [{ ...lifecycle, phase: "completed", title: "已完成", text: "子 Agent 已完成" }] }), /子 Agent 已完成/, "a single completed lifecycle event remains visible");
assert.doesNotMatch(render({ status: "completed", logs: [{ ...lifecycle, phase: "completed" }] }), /没有匹配的活动/, "lifecycle-only logs are not reported as a filter miss");
assert.match(render({ showProvider: true }), /assistant-reply-heading/);
assert.match(render({ logs: [], loading: true }), /正在读取活动日志/);
assert.doesNotMatch(render({ logs: [], loading: true }), /尚无活动日志/);
assert.match(render({ loading: true, error: "连接中断" }), /第一条回复/, "a refresh failure preserves existing transcript");
assert.match(render({ logs: [log(1, "unknown", "future event")] }), /未识别|unknown|future event/, "unknown events remain accessible");
assert.match(render({ logs: [log(1, "error", "failed command")] }), /failed command/);
const failedTool = render({ logs: [{ ...log(1, "command", "failed validation"), phase: "failed", detail: { command: "npm test", output: "Validation failed" } }] });
assert.match(failedTool, /activity-summary-group[^>]*open=""|open=""[^>]*activity-summary-group/, "a failed tool is not hidden inside a completed summary");
assert.match(failedTool, /Validation failed/, "failed tool details are initially visible");
const reply = renderToStaticMarkup(React.createElement(AssistantReply, { text: "**正文**", avatar: "Agent", actions: React.createElement("button", null, "复制") }));
assert.match(reply, /<strong>正文<\/strong>/);
assert.match(reply, /复制/);
console.log("Agent conversation: chronological grouping, shared replies, live transitions and loading states passed");
