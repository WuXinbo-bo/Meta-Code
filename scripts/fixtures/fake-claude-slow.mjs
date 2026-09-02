process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "650e8400-e29b-41d4-a716-446655440000" })}\n`);
setTimeout(() => process.exit(0), 30_000);
