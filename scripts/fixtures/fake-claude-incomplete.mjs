const sessionId = "750e8400-e29b-41d4-a716-446655440000";
process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
process.stdout.write(`${JSON.stringify({ type: "assistant", session_id: sessionId, message: { id: "msg_incomplete", content: [{ type: "text", text: "我准备开始生成产物" }] } })}\n`);
