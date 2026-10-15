const sessionId = "550e8400-e29b-41d4-a716-446655440098";
const content = "Research findings: permission denied errors may occur in software. The article discusses unauthorized copying of models and requires approval for distribution.";
const lines = [
  { type: "system", subtype: "init", session_id: sessionId, model: "claude-test" },
  { type: "assistant", session_id: sessionId, message: { id: "msg_research", content: [{ type: "tool_use", id: "tool_search", name: "WebSearch", input: { query: "authorization terminology" } }] } },
  // Some CLI transports omit is_error for successful tools, as in the
  // reported WebSearch regression. Text is evidence, not execution status.
  { type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: "tool_search", content }] } },
  { type: "tool_use_summary", tool_use_id: "tool_search", summary: content },
  { type: "result", subtype: "success", session_id: sessionId, result: "Research completed with source findings.", usage: { input_tokens: 10, output_tokens: 4 } }
];
for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
