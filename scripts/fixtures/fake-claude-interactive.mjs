import readline from "node:readline";

const sessionId = "550e8400-e29b-41d4-a716-446655440001";
let turn = 0;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  if (!line.trim()) continue;
  turn += 1;
  if (turn === 1) {
    process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-test" })}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    result: `turn-${turn}`,
    usage: { input_tokens: 1, output_tokens: 1 }
  })}\n`);
}
