const sessionId = "550e8400-e29b-41d4-a716-446655440004";
const lines = [
  { type: "system", subtype: "init", session_id: sessionId, model: "claude-test" },
  { type: "assistant", session_id: sessionId, message: { id: "msg_failure", content: [
    { type: "tool_use", id: "tool_structured_failure", name: "Bash", input: { command: "false" } },
    { type: "tool_use", id: "tool_text_error", name: "Bash", input: { command: "echo Error: exit code 7" } }
  ] } },
  { type: "user", session_id: sessionId, message: { content: [
    { type: "tool_result", tool_use_id: "tool_structured_failure", is_error: true, content: "command failed" },
    // Text that looks like an error is still successful when the provider says
    // is_error=false; output alone must never infer a command failure.
    { type: "tool_result", tool_use_id: "tool_text_error", is_error: false, content: "Error: exit code 7" }
  ] } },
  { type: "assistant", session_id: sessionId, message: { id: "msg_after_failure", content: [{ type: "text", text: "继续完成后续检查" }] } },
  { type: "result", subtype: "success", session_id: sessionId, result: "完成", stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 8 }, modelUsage: { "claude-test": { inputTokens: 12, outputTokens: 8 } } }
];
for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
