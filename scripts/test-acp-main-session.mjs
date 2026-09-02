import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpMainSessionRuntime } from "../server/providers/acp/mainSession.ts";
import { RestrictedAcpClientServices } from "../server/providers/acp/services.ts";
import { acpMcpServers } from "../server/providers/acp/mcp.ts";
import { ACP_SESSION_MODEL_OPTION_ID, ACP_SESSION_MODE_OPTION_ID } from "../server/providers/acp/sessionControls.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "workbench-acp-main-"));
await writeFile(path.join(root, "fixture.txt"), "file-ok\n", "utf8");
const fixture = fileURLToPath(new URL("./fixtures/acp-stdio-agent.mjs", import.meta.url));
const runtime = new AcpMainSessionRuntime({
  providerId: "fixture-acp",
  launch: { command: process.execPath, args: [fixture] },
  services: () => new RestrictedAcpClientServices({ roots: [root], allowWrite: true, allowTerminal: true, autoApprove: true })
});

try {
  let engineSessionId = null;
  let options = [];
  const events = [];
  const run = () => runtime.run({
    workbenchSessionId: "workbench-1",
    cwd: root,
    engineSessionId,
    prompt: "run",
    signal: AbortSignal.timeout(10_000),
    configValues: { thinking: false, [ACP_SESSION_MODEL_OPTION_ID]: "fixture-pro", [ACP_SESSION_MODE_OPTION_ID]: "yolo" },
    onEngineSessionId: (value) => { engineSessionId = value; },
    onConfigOptions: (value) => { options = value; },
    onEvent: (event) => { events.push(event); }
  });
  const first = await run();
  assert.equal(first.stopReason, "end_turn");
  assert.match(engineSessionId, /^fixture-/);
  assert.equal(options.find((item) => item.id === "thinking")?.currentValue, false);
  assert.equal(options.find((item) => item.id === ACP_SESSION_MODEL_OPTION_ID)?.currentValue, "fixture-pro");
  assert.equal(options.find((item) => item.id === ACP_SESSION_MODE_OPTION_ID)?.currentValue, "yolo");
  assert.ok(events.some((event) => event.type === "assistant" && event.text === "file-ok|terminal-ok"));
  assert.ok(events.some((event) => event.type === "tool.completed" && event.category === "read"));
  assert.equal((await run()).stopReason, "end_turn");
  assert.equal(runtime.configOptions("workbench-1").find((item) => item.id === ACP_SESSION_MODEL_OPTION_ID)?.category, "model");
  await assert.rejects(() => runtime.setConfigOption("workbench-1", ACP_SESSION_MODEL_OPTION_ID, "not-a-model"), /不支持值/);

  for (const [prompt, expected] of [["refuse", /拒绝处理/], ["max-tokens", /输出上限/]]) {
    const terminalEvents = [];
    await assert.rejects(() => runtime.run({
      workbenchSessionId: `workbench-${prompt}`, cwd: root, prompt, signal: AbortSignal.timeout(10_000),
      onEngineSessionId: () => undefined, onConfigOptions: () => undefined, onEvent: (event) => { terminalEvents.push(event); }
    }), expected);
    assert.equal(terminalEvents.some((event) => event.type === "turn.completed"), false);
    assert.equal(terminalEvents.some((event) => event.type === "error"), true);
  }

  const controller = new AbortController();
  const cancelled = runtime.run({
    workbenchSessionId: "workbench-1", cwd: root, engineSessionId, prompt: "slow", signal: controller.signal,
    onEngineSessionId: (value) => { engineSessionId = value; }, onConfigOptions: () => undefined, onEvent: () => undefined
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(cancelled);

  await assert.rejects(() => runtime.run({
    workbenchSessionId: "workbench-crash", cwd: root, prompt: "crash", signal: AbortSignal.timeout(10_000),
    onEngineSessionId: () => undefined, onConfigOptions: () => undefined, onEvent: () => undefined
  }), /ACP Agent 已退出|连接中断/);

  const limitedRuntime = new AcpMainSessionRuntime({
    providerId: "fixture-limited",
    launch: { command: process.execPath, args: [fixture] },
    maxOpenTransports: 1,
    services: () => new RestrictedAcpClientServices({ roots: [root], allowWrite: true, allowTerminal: true, autoApprove: true })
  });
  const runLimited = (workbenchSessionId, mcpServers = []) => limitedRuntime.run({
    workbenchSessionId, cwd: root, prompt: "run", signal: AbortSignal.timeout(10_000), mcpServers,
    onEngineSessionId: () => undefined, onConfigOptions: () => undefined, onEvent: () => undefined
  });
  await runLimited("limited-1");
  await runLimited("limited-2");
  assert.deepEqual(limitedRuntime.configOptions("limited-1"), []);
  await assert.rejects(() => runLimited("limited-http", acpMcpServers([{ name: "remote", transport: "http", url: "https://example.com/mcp" }])), /不支持 HTTP MCP/);
  await limitedRuntime.closeAll();
} finally {
  await runtime.closeAll();
  await rm(root, { recursive: true, force: true });
}

console.log("ACP main-session lifecycle, resume, config and canonical events passed");
