const sessionId = "550e8400-e29b-41d4-a716-446655440002";
process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-test" })}\n`);
process.stdout.write(`${JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: sessionId,
  result: "收到。我现在开始执行审查并生成结果。",
  stop_reason: null,
  usage: { input_tokens: 0, output_tokens: 0 },
  modelUsage: {}
})}\n`);
