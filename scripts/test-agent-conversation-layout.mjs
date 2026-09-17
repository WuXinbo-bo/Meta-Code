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
assert.match(live, /git diff/, "latest command rotates in the open segment");
assert.doesNotMatch(live, /git status/, "earlier current-segment commands do not crowd the live preview");
const resumed = render({ status: "running", logs: [...logs, log(8, "message", "完成检查")] });
assert.doesNotMatch(resumed, /activity-live-current/, "a reply closes the previous rotating segment");
assert.equal((resumed.match(/运行 1 个命令/g) || []).length, 2);
assert.match(render({ showProvider: true }), /assistant-reply-heading/);
assert.match(render({ logs: [], loading: true }), /正在读取活动日志/);
assert.doesNotMatch(render({ logs: [], loading: true }), /尚无活动日志/);
assert.match(render({ loading: true, error: "连接中断" }), /第一条回复/, "a refresh failure preserves existing transcript");
assert.match(render({ logs: [log(1, "unknown", "future event")] }), /未识别|unknown|future event/, "unknown events remain accessible");
assert.match(render({ logs: [log(1, "error", "failed command")] }), /failed command/);
const reply = renderToStaticMarkup(React.createElement(AssistantReply, { text: "**正文**", avatar: "Agent", actions: React.createElement("button", null, "复制") }));
assert.match(reply, /<strong>正文<\/strong>/);
assert.match(reply, /复制/);
console.log("Agent conversation: chronological grouping, shared replies, live transitions and loading states passed");
