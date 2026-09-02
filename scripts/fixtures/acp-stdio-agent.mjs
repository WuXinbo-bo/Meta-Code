import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const sessions = new Map();
let sequence = 0;

const supportsSessionClose = process.env.ACP_FIXTURE_SESSION_CLOSE !== "unsupported";
let app = agent({ name: "workbench-acp-fixture" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: "Workbench ACP Fixture", version: "1.0.0" },
    authMethods: [{ id: "fixture-login", name: "Fixture Login", description: "Test ACP authentication" }],
    agentCapabilities: {
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
      sessionCapabilities: { list: {}, delete: {}, resume: {}, ...(supportsSessionClose ? { close: {} } : {}), additionalDirectories: {} }
    }
  }))
  .onRequest(methods.agent.authenticate, ({ params }) => {
    if (params.methodId !== "fixture-login") throw new Error("unknown login");
    return {};
  })
  .onRequest(methods.agent.session.new, async ({ params }) => {
    const delayMs = Number(process.env.ACP_FIXTURE_SESSION_NEW_DELAY_MS || 0);
    if (Number.isFinite(delayMs) && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const sessionId = `fixture-${++sequence}`;
    sessions.set(sessionId, { sessionId, cwd: params.cwd, title: "Fixture session", modelId: "fixture-auto", modeId: "default", updatedAt: new Date().toISOString() });
    return {
      sessionId,
      models: {
        currentModelId: "fixture-auto",
        availableModels: [
          { modelId: "fixture-auto", name: "Fixture Auto" },
          { modelId: "fixture-pro", name: "Fixture Pro" }
        ]
      },
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "yolo", name: "YOLO" }
        ]
      },
      configOptions: [
        { id: "thinking", name: "Thinking", category: "thought_level", type: "boolean", currentValue: true }
      ]
    };
  })
  .onRequest(methods.agent.session.resume, ({ params }) => {
    if (!sessions.has(params.sessionId)) sessions.set(params.sessionId, { sessionId: params.sessionId, cwd: params.cwd, updatedAt: new Date().toISOString() });
    return { configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "fixture-model", options: [{ value: "fixture-model", name: "Fixture Model" }] }] };
  })
  .onRequest(methods.agent.session.list, () => ({ sessions: [...sessions.values()] }))
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => ({ configOptions: [{ id: params.configId, name: params.configId, type: typeof params.value === "boolean" ? "boolean" : "select", currentValue: params.value, ...(typeof params.value === "string" ? { options: [{ value: params.value, name: params.value }] } : {}) }] }))
  .onRequest(methods.agent.session.setMode, ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (session) session.modeId = params.modeId;
    return {};
  })
  .onRequest("session/set_model", (params) => params, ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (session) session.modelId = params.modelId;
    return {};
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const promptText = params.prompt.map((item) => item.type === "text" ? item.text : "").join("\n");
    if (promptText === "crash") process.exit(17);
    if (promptText === "slow") await new Promise((resolve) => setTimeout(resolve, 60_000));
    if (promptText === "refuse") return { stopReason: "refusal" };
    if (promptText === "max-tokens") return { stopReason: "max_tokens" };
    const session = sessions.get(params.sessionId);
    const file = await client.request(methods.client.fs.readTextFile, { sessionId: params.sessionId, path: `${session.cwd}/fixture.txt` });
    const terminal = await client.request(methods.client.terminal.create, { sessionId: params.sessionId, command: process.execPath, args: ["-e", "process.stdout.write('terminal-ok')"], cwd: session.cwd, outputByteLimit: 64 });
    await client.request(methods.client.terminal.waitForExit, { sessionId: params.sessionId, terminalId: terminal.terminalId });
    const output = await client.request(methods.client.terminal.output, { sessionId: params.sessionId, terminalId: terminal.terminalId });
    await client.request(methods.client.terminal.release, { sessionId: params.sessionId, terminalId: terminal.terminalId });
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "plan", entries: [{ content: "Read fixture", priority: "high", status: "completed" }] }
    });
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "fixture-read", title: "Read fixture", kind: "read", status: "completed", rawOutput: file.content }
    });
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", messageId: "fixture-answer", content: { type: "text", text: `${file.content.trim()}|` } }
    });
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", messageId: "fixture-answer", content: { type: "text", text: output.output } }
    });
    return { stopReason: "end_turn" };
  })
  .onRequest(methods.agent.session.delete, ({ params }) => { sessions.delete(params.sessionId); return {}; })
  .onNotification(methods.agent.session.cancel, () => undefined);

if (supportsSessionClose) {
  app = app.onRequest(methods.agent.session.close, async ({ params }) => {
    const delayMs = Number(process.env.ACP_FIXTURE_SESSION_CLOSE_DELAY_MS || 0);
    if (Number.isFinite(delayMs) && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    sessions.delete(params.sessionId);
    return {};
  });
}

const connection = app.connect(ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin)
));
await connection.closed;
