const sessionId = "550e8400-e29b-41d4-a716-446655440099";
const toolName = "mcp__workbench-workflow-plan__workflow_read_plan";
const denial = `Claude requested permissions to use ${toolName}, but you haven't granted it yet.`;
const lines = [
  { type: "system", subtype: "init", session_id: sessionId, model: "claude-test" },
  { type: "assistant", session_id: sessionId, message: { id: "msg_permission", content: [{ type: "tool_use", id: "tool_permission", name: toolName, input: {} }] } },
  { type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: "tool_permission", is_error: true, content: denial }] } },
  { type: "result", subtype: "success", session_id: sessionId, result: "I am blocked on permissions.", usage: { input_tokens: 10, output_tokens: 4 } }
];

for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
