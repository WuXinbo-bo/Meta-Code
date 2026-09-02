import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpStdioBackend } from "../server/providers/acp/stdioBackend.ts";
import { RestrictedAcpClientServices } from "../server/providers/acp/services.ts";
import { ACP_SESSION_MODEL_OPTION_ID, ACP_SESSION_MODE_OPTION_ID } from "../server/providers/acp/sessionControls.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "workbench-acp-"));
await writeFile(path.join(root, "fixture.txt"), "file-ok\n", "utf8");
const fixture = fileURLToPath(new URL("./fixtures/acp-stdio-agent.mjs", import.meta.url));
const services = new RestrictedAcpClientServices({ roots: [root], allowWrite: true, allowTerminal: true, autoApprove: true, maxTerminalOutputBytes: 1024 });
const backend = new AcpStdioBackend("fixture-acp", { command: process.execPath, args: [fixture] }, services);

try {
  const initialized = await backend.start(AbortSignal.timeout(10_000));
  assert.equal(initialized.protocolVersion, 1);
  assert.equal(initialized.agentInfo?.name, "Workbench ACP Fixture");
  assert.deepEqual(backend.authMethods().map((item) => item.id), ["fixture-login"]);
  await backend.authenticate("fixture-login", AbortSignal.timeout(10_000));
  await assert.rejects(() => backend.authenticate("missing-login"), /不存在/);
  assert.ok(initialized.agentCapabilities?.sessionCapabilities?.resume);

  const session = await backend.newSession({ cwd: root });
  assert.match(session.sessionId, /^fixture-/);
  assert.deepEqual(session.configOptions.map((item) => [item.id, item.type]), [["thinking", "boolean"], [ACP_SESSION_MODEL_OPTION_ID, "select"], [ACP_SESSION_MODE_OPTION_ID, "select"]]);
  let controls = await backend.setSessionControl(session.sessionId, session.configOptions, ACP_SESSION_MODEL_OPTION_ID, "fixture-pro");
  assert.equal(controls.find((item) => item.id === ACP_SESSION_MODEL_OPTION_ID)?.currentValue, "fixture-pro");
  controls = await backend.setSessionControl(session.sessionId, controls, ACP_SESSION_MODE_OPTION_ID, "yolo");
  assert.equal(controls.find((item) => item.id === ACP_SESSION_MODE_OPTION_ID)?.currentValue, "yolo");
  controls = await backend.setSessionControl(session.sessionId, controls, "thinking", false);
  assert.equal(controls.find((item) => item.id === "thinking")?.currentValue, false);
  assert.ok(controls.some((item) => item.id === ACP_SESSION_MODEL_OPTION_ID));
  const updates = [];
  const response = await backend.prompt(session.sessionId, "run", (notification) => updates.push(notification), AbortSignal.timeout(10_000));
  assert.equal(response.stopReason, "end_turn");
  assert.deepEqual(updates.map((item) => item.update.sessionUpdate), ["plan", "tool_call", "agent_message_chunk", "agent_message_chunk"]);
  assert.equal(updates.at(-1).update.content.text, "terminal-ok");

  const listed = await backend.listSessions(root);
  assert.equal(listed.sessions.length, 1);
  await backend.closeSession(session.sessionId);
  assert.equal((await backend.listSessions(root)).sessions.length, 0);

  await assert.rejects(() => services.readTextFile({ sessionId: "x", path: path.resolve(root, "..", "outside.txt") }), /越过工作区边界/);
  const readOnly = new RestrictedAcpClientServices({ roots: [root], allowWrite: false, allowTerminal: false });
  await assert.rejects(() => readOnly.writeTextFile({ sessionId: "x", path: path.join(root, "blocked.txt"), content: "no" }), /只读模式/);
  await assert.rejects(() => readOnly.createTerminal({ sessionId: "x", command: process.execPath, args: [], cwd: root, env: [], outputByteLimit: 10 }), /未开放终端/);
  await readOnly.close();
} finally {
  await backend.close();
}

const cancellationServices = new RestrictedAcpClientServices({ roots: [root], allowWrite: false, allowTerminal: false });
const cancellationBackend = new AcpStdioBackend("fixture-acp-cancellation", {
  command: process.execPath,
  args: [fixture],
  env: { ACP_FIXTURE_SESSION_NEW_DELAY_MS: "60000" }
}, cancellationServices);
try {
  await cancellationBackend.start(AbortSignal.timeout(10_000));
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = cancellationBackend.newSession({ cwd: root }, controller.signal);
  setTimeout(() => controller.abort(new Error("test cancellation")), 50);
  await assert.rejects(() => pending, /cancel|abort|test cancellation/i);
  assert.ok(Date.now() - startedAt < 2_000, "ACP control cancellation should not wait for the Agent response");
} finally {
  await cancellationBackend.close();
}

const closeCancellationServices = new RestrictedAcpClientServices({ roots: [root], allowWrite: false, allowTerminal: false });
const closeCancellationBackend = new AcpStdioBackend("fixture-acp-close-cancellation", {
  command: process.execPath,
  args: [fixture],
  env: { ACP_FIXTURE_SESSION_CLOSE_DELAY_MS: "60000" }
}, closeCancellationServices);
try {
  await closeCancellationBackend.start(AbortSignal.timeout(10_000));
  const session = await closeCancellationBackend.newSession({ cwd: root });
  const startedAt = Date.now();
  await assert.rejects(() => closeCancellationBackend.closeSession(session.sessionId, AbortSignal.timeout(50)), /timeout|abort/i);
  assert.ok(Date.now() - startedAt < 2_000, "ACP session cleanup should not wait for an unresponsive Agent");
} finally {
  await closeCancellationBackend.close();
}

const noCloseServices = new RestrictedAcpClientServices({ roots: [root], allowWrite: false, allowTerminal: false });
const noCloseBackend = new AcpStdioBackend("fixture-acp-no-close", {
  command: process.execPath,
  args: [fixture],
  env: { ACP_FIXTURE_SESSION_CLOSE: "unsupported" }
}, noCloseServices);
try {
  const initialized = await noCloseBackend.start(AbortSignal.timeout(10_000));
  assert.equal(initialized.agentCapabilities?.sessionCapabilities?.close, undefined);
  const session = await noCloseBackend.newSession({ cwd: root });
  await noCloseBackend.closeSession(session.sessionId);
  assert.equal((await noCloseBackend.listSessions(root)).sessions.length, 1);
} finally {
  await noCloseBackend.close();
  await rm(root, { recursive: true, force: true });
}

console.log("ACP stdio initialize/session/model/mode/config/fs/terminal/update/cancellation/optional-close lifecycle passed");
