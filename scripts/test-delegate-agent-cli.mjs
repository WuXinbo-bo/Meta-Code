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
await new Promise((resolve) => server.close(resolve));

assert.equal(exitCode, 1);
assert.equal(stdout, "");
assert.match(stderr, /fixture rejection/);
assert.doesNotMatch(stderr, /Assertion failed|UV_HANDLE_CLOSING/);
assert.equal(received.mode, "implementation");
assert.deepEqual(received.capabilityRequirements, ["workspace-write", "terminal", "network"]);

console.log("delegation bridge CLI compatibility and graceful failure passed");
