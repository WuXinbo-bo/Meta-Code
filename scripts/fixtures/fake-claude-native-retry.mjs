const sessionId = "550e8400-e29b-41d4-a716-446655440098";
const lines = [
  { type: "system", subtype: "init", session_id: sessionId, model: "claude-test" },
  { type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, error_status: 503, session_id: sessionId },
  { type: "result", subtype: "success", session_id: sessionId, result: "native retry recovered", usage: { input_tokens: 2, output_tokens: 3 } }
];
for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
