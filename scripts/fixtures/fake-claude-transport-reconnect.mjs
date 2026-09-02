const sessionId = "550e8400-e29b-41d4-a716-446655440099";
const resumed = process.argv.includes("--resume");
const baseUrl = process.env.ANTHROPIC_BASE_URL || "";

process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-test" })}\n`);
if (!resumed || baseUrl.includes("stale")) {
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, error_status: 503, session_id: sessionId })}\n`);
  setInterval(() => undefined, 1_000);
} else {
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: sessionId, result: `reconnected:${baseUrl}`, usage: { input_tokens: 2, output_tokens: 2 } })}\n`);
}
