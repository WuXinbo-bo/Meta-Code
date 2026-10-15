import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let received;
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  response.writeHead(400, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify({ error: "fixture rejection" }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();

const child = spawn(process.execPath, [
  path.join(root, "scripts", "delegate-agent.mjs"),
  "--provider", "codex",
  "--task", "fixture task",
  "--mode", "write",
  "--capabilities", "workspace-write,terminal,network"
], {
  cwd: root,
  env: {
    ...process.env,
    WORKBENCH_AGENT_BRIDGE_URL: `http://127.0.0.1:${address.port}/delegate`,
    WORKBENCH_AGENT_BRIDGE_TOKEN: "fixture-token",
    WORKBENCH_PARENT_TASK_ID: "fixture-parent"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const exitCode = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error("delegation bridge did not exit")); }, 10_000);
  child.once("error", reject);
  child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
});
async function stdinRequest(input) {
  const process = spawn(child.spawnfile, [path.join(root, "scripts", "delegate-agent.mjs"), "--stdin"], {
    cwd: root, env: { ...globalThis.process.env, WORKBENCH_AGENT_BRIDGE_URL: `http://127.0.0.1:${address.port}/delegate`, WORKBENCH_AGENT_BRIDGE_TOKEN: "fixture-token", WORKBENCH_PARENT_TASK_ID: "fixture-parent" }, stdio: ["pipe", "pipe", "pipe"]
  });
  let error = ""; process.stderr.on("data", (chunk) => { error += chunk; });
  process.stdout.resume(); process.stdin.on("error", () => {});
  const exited = new Promise((resolve) => process.once("exit", resolve));
  const timer = setTimeout(() => process.kill(), 10_000);
  process.stdin.end(input);
  try { return { code: await exited, error }; } finally { clearTimeout(timer); }
}


assert.equal(exitCode, 1);
assert.equal(stdout, "");
assert.match(stderr, /fixture rejection/);
assert.doesNotMatch(stderr, /Assertion failed|UV_HANDLE_CLOSING/);
assert.equal(received.mode, "implementation");
assert.deepEqual(received.capabilityRequirements, ["workspace-write", "terminal", "network"]);

try {
  const stdin = await stdinRequest(JSON.stringify({ providerId: "claude", prompt: "stdin research", mode: "analysis" }));
  assert.equal(stdin.code, 1); assert.match(stdin.error, /fixture rejection/);
  assert.equal(received.providerId, "claude"); assert.equal(received.prompt, "stdin research");
  const invalid = await stdinRequest("{malformed");
  assert.equal(invalid.code, 2); assert.match(invalid.error, /JSON|Unexpected|Expected/);
  const oversized = await stdinRequest("x".repeat(1024 * 1024 + 1));
  assert.equal(oversized.code, 2); assert.match(oversized.error, /1 MB|1MB|过大/);
} finally { await new Promise((resolve) => server.close(resolve)); }
console.log("delegation bridge stdin, legacy CLI compatibility and graceful failure passed");
