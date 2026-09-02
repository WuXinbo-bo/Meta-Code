import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveWorkbenchPaths } from "../dist-server/appPaths.js";
import { resolveClaudeCommand } from "../dist-server/engines/claude/runtime.js";
import { runClaude } from "../dist-server/engines/claude/process.js";
import { CliRuntimeManager } from "../dist-server/runtime/manager.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = resolveWorkbenchPaths(root);
const runtimeManager = new CliRuntimeManager(root, paths.runtimesDir);
const runtime = await runtimeManager.detect("claude", "", "managed");
assert.equal(runtime.available, true, runtime.message);
const command = resolveClaudeCommand(runtime.path);
const configDir = await mkdtemp(path.join(os.tmpdir(), "metacode-claude-real-"));
const server = http.createServer((req, res) => {
  if (!req.url?.startsWith("/v1/messages")) {
    res.writeHead(404).end();
    return;
  }
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const events = [
      ["message_start", { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "MOCK_OK" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
      ["message_stop", { type: "message_stop" }]
    ];
    for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
const events = [];
try {
  let result;
  try { result = await runClaude({
    executable: command.executable,
    executableArgs: command.args,
    cwd: root,
    prompt: "Reply with OK",
    model: "claude-test",
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: "test-key",
    configDir,
    permissionMode: "bypassPermissions",
    signal: controller.signal,
    onEvent: (event) => events.push(event)
  }); } catch (error) {
    console.error(JSON.stringify(events, null, 2));
    throw error;
  }
  assert.ok(result.sessionId);
  assert.ok(events.some((event) => event.type === "assistant" && event.text.includes("MOCK_OK")));
  assert.ok(events.some((event) => event.type === "turn.completed"));
  console.log(`Real Claude CLI protocol OK: ${result.sessionId}`);
} finally {
  clearTimeout(timeout);
  server.close();
  await rm(configDir, { recursive: true, force: true });
}
