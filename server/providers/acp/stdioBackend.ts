import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type ClientContext,
  type InitializeResponse,
  type ListSessionsResponse,
  type McpServer,
  type NewSessionResponse,
  type PromptResponse,
  type SetSessionConfigOptionResponse,
  type SessionConfigOption,
  type SessionNotification
} from "@agentclientprotocol/sdk";
import type { AcpLaunchSpec } from "../types.js";
import type { AcpClientServices } from "./services.js";
import {
  ACP_SESSION_MODEL_OPTION_ID,
  ACP_SESSION_MODE_OPTION_ID,
  sessionControlOptions,
  updateSessionControlValue,
  type AcpExtendedSessionResponse
} from "./sessionControls.js";

export type AcpSessionSetup = {
  cwd: string;
  additionalDirectories?: string[];
  mcpServers?: McpServer[];
};

export type AcpSessionState = {
  sessionId: string;
  configOptions: SessionConfigOption[];
};

export class AcpStdioBackend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientConnection | null = null;
  private context: ClientContext | null = null;
  private initialization: InitializeResponse | null = null;
  private transportFailure: Error | null = null;
  private readonly updates = new Map<string, Set<(notification: SessionNotification) => void>>();

  constructor(readonly providerId: string, private readonly launch: AcpLaunchSpec, private readonly services: AcpClientServices) {}

  async start(signal?: AbortSignal) {
    if (this.context && this.initialization) return this.initialization;
    this.transportFailure = null;
    const child = spawn(this.launch.command, this.launch.args || [], {
      env: { ...process.env, ...(this.launch.env || {}) },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    const stderr: string[] = [];
    child.stderr.on("data", (chunk) => { stderr.push(String(chunk)); if (stderr.length > 40) stderr.shift(); });
    const application = client({ name: `workbench:${this.providerId}` })
      .onNotification(methods.client.session.update, ({ params }) => {
        for (const listener of this.updates.get(params.sessionId) || []) listener(params);
      })
      .onRequest(methods.client.session.requestPermission, ({ params, signal: requestSignal }) => this.services.requestPermission(params, requestSignal))
      .onRequest(methods.client.fs.readTextFile, ({ params }) => this.services.readTextFile(params))
      .onRequest(methods.client.fs.writeTextFile, async ({ params }) => { await this.services.writeTextFile(params); return {}; })
      .onRequest(methods.client.terminal.create, ({ params }) => this.services.createTerminal(params))
      .onRequest(methods.client.terminal.output, ({ params }) => this.services.terminalOutput(params))
      .onRequest(methods.client.terminal.waitForExit, ({ params }) => this.services.waitForTerminalExit(params))
      .onRequest(methods.client.terminal.kill, async ({ params }) => { await this.services.killTerminal(params); return {}; })
      .onRequest(methods.client.terminal.release, async ({ params }) => { await this.services.releaseTerminal(params); return {}; });
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    );
    const connection = application.connect(stream);
    this.connection = connection;
    this.context = connection.agent;
    const disconnect = (error: Error) => {
      this.transportFailure = error;
      connection.close(error);
      if (this.child === child) {
        this.child = null;
        this.connection = null;
        this.context = null;
        this.initialization = null;
      }
    };
    child.once("exit", (code) => disconnect(new Error(`ACP Agent 已退出（${code ?? "unknown"}）：${stderr.join("").trim()}`)));
    child.once("error", (error) => disconnect(error));
    let initialization: InitializeResponse;
    try {
      initialization = await abortableRequest(connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "Meta Code", version: process.env.METACODE_APP_VERSION || process.env.npm_package_version || "development" },
        clientCapabilities: {
          fs: { readTextFile: this.services.capabilities.readTextFile, writeTextFile: this.services.capabilities.writeTextFile },
          terminal: this.services.capabilities.terminal,
          session: { configOptions: { boolean: {} } }
        }
      }, { cancellationSignal: signal }), signal);
    } catch (error) {
      await this.close();
      throw error;
    }
    if (initialization.protocolVersion !== PROTOCOL_VERSION) {
      await this.close();
      throw new Error(`ACP 协议版本不兼容：Agent=${initialization.protocolVersion}，Workbench=${PROTOCOL_VERSION}`);
    }
    this.initialization = initialization;
    return initialization;
  }

  get initializeResponse() { return this.initialization; }

  async newSession(setup: AcpSessionSetup, signal?: AbortSignal): Promise<AcpSessionState> {
    const response = await abortableRequest(this.requireContext().request(methods.agent.session.new, {
      cwd: setup.cwd,
      additionalDirectories: setup.additionalDirectories,
      mcpServers: setup.mcpServers || []
    }, { cancellationSignal: signal }), signal);
    return sessionState(response);
  }

  authMethods() {
    return structuredClone(this.initialization?.authMethods || []);
  }

  async authenticate(methodId: string, signal?: AbortSignal) {
    const method = this.initialization?.authMethods?.find((item) => item.id === methodId);
    if (!method) throw new Error(`ACP 登录方式不存在：${methodId}`);
    if ("type" in method && method.type === "terminal") throw new Error("该登录方式需要交互式终端，当前工作台尚未启用");
    return abortableRequest(this.requireContext().request(methods.agent.authenticate, { methodId }, { cancellationSignal: signal }), signal);
  }

  async resumeSession(sessionId: string, setup: AcpSessionSetup, previousOptions: SessionConfigOption[] = []): Promise<AcpSessionState> {
    const response = await this.requireContext().request(methods.agent.session.resume, {
      sessionId,
      cwd: setup.cwd,
      additionalDirectories: setup.additionalDirectories,
      mcpServers: setup.mcpServers || []
    });
    return sessionState({ ...response, sessionId }, previousOptions);
  }

  async listSessions(cwd?: string, cursor?: string): Promise<ListSessionsResponse> {
    return this.requireContext().request(methods.agent.session.list, { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) });
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean, signal?: AbortSignal): Promise<SetSessionConfigOptionResponse> {
    return abortableRequest(this.requireContext().request(methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      value,
      ...(typeof value === "boolean" ? { type: "boolean" as const } : {})
    }, { cancellationSignal: signal }), signal);
  }

  async setSessionControl(sessionId: string, currentOptions: SessionConfigOption[], configId: string, value: string | boolean, signal?: AbortSignal) {
    if (configId === ACP_SESSION_MODEL_OPTION_ID) {
      if (typeof value !== "string") throw new Error("ACP 模型值无效");
      await abortableRequest(this.requireContext().request("session/set_model", { sessionId, modelId: value }, { cancellationSignal: signal }), signal);
      return updateSessionControlValue(currentOptions, configId, value);
    }
    if (configId === ACP_SESSION_MODE_OPTION_ID) {
      if (typeof value !== "string") throw new Error("ACP 模式值无效");
      await abortableRequest(this.requireContext().request(methods.agent.session.setMode, { sessionId, modeId: value }, { cancellationSignal: signal }), signal);
      return updateSessionControlValue(currentOptions, configId, value);
    }
    const response = await this.setConfigOption(sessionId, configId, value, signal);
    return sessionControlOptions({ configOptions: response.configOptions }, currentOptions);
  }

  async prompt(sessionId: string, text: string, onUpdate: (notification: SessionNotification) => void, signal?: AbortSignal): Promise<PromptResponse> {
    const listeners = this.updates.get(sessionId) || new Set();
    listeners.add(onUpdate);
    this.updates.set(sessionId, listeners);
    try {
      try {
        return await this.requireContext().request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text }]
        }, { cancellationSignal: signal });
      } catch (error) {
        throw this.transportFailure || new Error(`ACP Provider「${this.providerId}」连接中断：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      listeners.delete(onUpdate);
      if (!listeners.size) this.updates.delete(sessionId);
    }
  }

  async cancel(sessionId: string) {
    await this.requireContext().notify(methods.agent.session.cancel, { sessionId });
  }

  async closeSession(sessionId: string, signal?: AbortSignal) {
    if (!this.initialization?.agentCapabilities?.sessionCapabilities?.close) {
      this.updates.delete(sessionId);
      return;
    }
    await abortableRequest(this.requireContext().request(methods.agent.session.close, { sessionId }, { cancellationSignal: signal }), signal);
    this.updates.delete(sessionId);
  }

  async deleteSession(sessionId: string) {
    await this.requireContext().request(methods.agent.session.delete, { sessionId });
    this.updates.delete(sessionId);
  }

  async close() {
    const child = this.child;
    this.connection?.close();
    this.connection = null;
    this.context = null;
    this.initialization = null;
    this.updates.clear();
    await this.services.close();
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    }
    this.child = null;
  }

  private requireContext() {
    if (!this.context) throw new Error(`ACP Provider「${this.providerId}」尚未启动`);
    return this.context;
  }
}

function sessionState(response: NewSessionResponse | AcpExtendedSessionResponse, previousOptions: SessionConfigOption[] = []): AcpSessionState {
  if (!response.sessionId) throw new Error("ACP Agent 未返回会话 ID");
  return { sessionId: response.sessionId, configOptions: sessionControlOptions(response, previousOptions) };
}

async function abortableRequest<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request;
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("ACP 请求已取消");
  let rejectAborted: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onAbort = () => rejectAborted?.(signal.reason instanceof Error ? signal.reason : new Error("ACP 请求已取消"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([request, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
