import readline from "node:readline";

const sessionId = "550e8400-e29b-41d4-a716-446655440003";
let turn = 0;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  if (!line.trim()) continue;
  turn += 1;
  if (turn === 1) process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-test" })}\n`);
  process.stdout.write(`${JSON.stringify(turn === 1 ? {
    type: "result", subtype: "success", session_id: sessionId,
    result: "收到。我现在开始继续执行。", usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}
  } : {
    type: "result", subtype: "success", session_id: sessionId,
    result: "已完成实际任务并给出结论。", stop_reason: "end_turn",
    usage: { input_tokens: 8, output_tokens: 4 }, modelUsage: { "claude-test": { inputTokens: 8, outputTokens: 4 } }
  })}\n`);
}
