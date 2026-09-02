const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const lines = [
  { type: "system", subtype: "init", session_id: sessionId, model: "claude-test" },
  { type: "system", subtype: "status", status: "requesting", uuid: "noise-status", session_id: sessionId },
  { type: "system", subtype: "thinking_tokens", estimated_tokens: 50, uuid: "noise-thinking", session_id: sessionId },
  { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, error_status: 503, uuid: "useful-retry", session_id: sessionId },
  { type: "assistant", session_id: sessionId, message: { id: "msg_test", content: [{ type: "text", text: "测试回复" }, { type: "tool_use", id: "tool_test", name: "Bash", input: { command: "echo ok" } }] } },
  { type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: "tool_test", content: "ok" }] } },
  { type: "result", subtype: "success", session_id: sessionId, result: "done", usage: { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 5 } }
];
for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
