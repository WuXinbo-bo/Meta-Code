import type { InitializeResponse, McpServer, PromptResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { NormalizedEngineEvent } from "../../engines/types.js";
import type { AcpLaunchSpec } from "../types.js";
import { AcpEventNormalizer } from "./events.js";
import type { AcpClientServices } from "./services.js";
import { AcpStdioBackend } from "./stdioBackend.js";
import { ACP_SESSION_MODE_OPTION_ID, sessionControlOptions, updateSessionControlValue } from "./sessionControls.js";

export type AcpMainSessionInput = {
  workbenchSessionId: string;
  ownerUserId?: string;
  cwd: string;
  engineSessionId?: string | null;
  prompt: string;
  signal: AbortSignal;
  mcpServers?: McpServer[];
  configValues?: Record<string, string | boolean>;
  onEngineSessionId(sessionId: string): void | Promise<void>;
  onConfigOptions(options: SessionConfigOption[]): void | Promise<void>;
  onEvent(event: NormalizedEngineEvent): void | Promise<void>;
};

export type AcpMainSessionRuntimeOptions = {
  providerId: string;
  launch: AcpLaunchSpec | ((input: AcpMainSessionInput) => AcpLaunchSpec | Promise<AcpLaunchSpec>);
  services(input: AcpMainSessionInput): AcpClientServices;
  onInitialize?(response: InitializeResponse): void | Promise<void>;
  idleTransportMs?: number;
  maxOpenTransports?: number;
};

type RuntimeEntry = {
  cwd: string;
  backend: AcpStdioBackend;
  engineSessionId: string | null;
  configOptions: SessionConfigOption[];
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
};

/** Maintains one ACP transport per workbench task while keeping core state transport-neutral. */
export class AcpMainSessionRuntime {
  private readonly entries = new Map<string, RuntimeEntry>();

  constructor(private readonly options: AcpMainSessionRuntimeOptions) {}

  async run(input: AcpMainSessionInput): Promise<PromptResponse> {
    let entry = this.entries.get(input.workbenchSessionId);
    if (entry && entry.cwd !== input.cwd) {
      await entry.backend.close();
      this.entries.delete(input.workbenchSessionId);
      entry = undefined;
    }
    if (!entry) {
      await this.evictOldestIfNeeded();
      entry = {
        cwd: input.cwd,
        backend: new AcpStdioBackend(this.options.providerId, await this.resolveLaunch(input), this.options.services(input)),
        engineSessionId: null,
        configOptions: [],
        lastUsedAt: Date.now()
      };
      this.entries.set(input.workbenchSessionId, entry);
    }
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.lastUsedAt = Date.now();

    const initialization = await entry.backend.start(input.signal);
    await this.options.onInitialize?.(initialization);
    assertMcpCapabilities(input.mcpServers || [], initialization);
    const requestedSessionId = input.engineSessionId || entry.engineSessionId;
    const canResume = Boolean(initialization.agentCapabilities?.sessionCapabilities?.resume);
    const session = requestedSessionId && canResume
      ? await entry.backend.resumeSession(requestedSessionId, { cwd: input.cwd, mcpServers: input.mcpServers }, entry.configOptions)
      : await entry.backend.newSession({ cwd: input.cwd, mcpServers: input.mcpServers });
    entry.engineSessionId = session.sessionId;
    entry.configOptions = session.configOptions;
    await input.onEngineSessionId(session.sessionId);
    await input.onConfigOptions(session.configOptions);

    for (const [configId, value] of Object.entries(input.configValues || {})) {
      const option = entry.configOptions.find((item) => item.id === configId);
      if (!option || option.currentValue === value) continue;
      assertAcpConfigValue(option, value);
      entry.configOptions = await entry.backend.setSessionControl(session.sessionId, entry.configOptions, configId, value);
      await input.onConfigOptions(entry.configOptions);
    }

    const normalizer = new AcpEventNormalizer();
    let updateQueue = Promise.resolve();
    const enqueueUpdate = (notification: Parameters<AcpEventNormalizer["normalize"]>[0]) => {
      updateQueue = updateQueue.then(async () => {
        if (notification.update.sessionUpdate === "config_option_update") {
          entry!.configOptions = sessionControlOptions({ configOptions: notification.update.configOptions }, entry!.configOptions);
          await input.onConfigOptions(entry!.configOptions);
        }
        if (notification.update.sessionUpdate === "current_mode_update") {
          entry!.configOptions = updateSessionControlValue(entry!.configOptions, ACP_SESSION_MODE_OPTION_ID, notification.update.currentModeId);
          await input.onConfigOptions(entry!.configOptions);
        }
        const event = normalizer.normalize(notification);
        if (event) await input.onEvent(event);
      });
    };
    await input.onEvent({ type: "session.started", sessionId: session.sessionId, text: `${this.options.providerId} ACP 会话已连接`, rawType: "acp.session.started", category: "status", phase: "completed" });
    await input.onEvent({ type: "turn.started", sessionId: session.sessionId, text: "Agent 开始处理任务", rawType: "acp.turn.started", category: "status", phase: "running" });

    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const cancel = () => {
      void entry!.backend.cancel(session.sessionId).catch(() => undefined);
      rejectAbort(new Error("ACP 本轮请求已取消"));
    };
    input.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (input.signal.aborted) cancel();
      const pendingPrompt = entry.backend.prompt(session.sessionId, input.prompt, enqueueUpdate, input.signal);
      // Some third-party Agents acknowledge session/cancel late or not at all.
      // Do not let a non-cooperative process block pause/stop in the workbench.
      const response = await Promise.race([pendingPrompt, aborted]);
      await updateQueue;
      assertSuccessfulPrompt(response);
      await input.onEvent({ type: "turn.completed", sessionId: session.sessionId, text: "Agent 已完成本轮任务", rawType: `acp.stop.${response.stopReason}`, category: "status", phase: "completed", detail: response });
      return response;
    } catch (error) {
      await updateQueue;
      if (input.signal.aborted) {
        await entry.backend.close();
        this.entries.delete(input.workbenchSessionId);
      }
      if (!input.signal.aborted) {
        await input.onEvent({ type: "error", sessionId: session.sessionId, text: error instanceof Error ? error.message : String(error), rawType: "acp.transport.error", category: "error", phase: "failed" });
      }
      throw error;
    } finally {
      input.signal.removeEventListener("abort", cancel);
      normalizer.clear();
      if (this.entries.get(input.workbenchSessionId) === entry) this.armIdleClose(input.workbenchSessionId, entry);
    }
  }

  async setConfigOption(workbenchSessionId: string, configId: string, value: string | boolean) {
    const entry = this.requireEntry(workbenchSessionId);
    if (!entry.engineSessionId) throw new Error("ACP 会话尚未创建");
    const option = entry.configOptions.find((item) => item.id === configId);
    if (!option) throw new Error(`ACP 配置项不存在：${configId}`);
    assertAcpConfigValue(option, value);
    entry.configOptions = await entry.backend.setSessionControl(entry.engineSessionId, entry.configOptions, configId, value);
    return structuredClone(entry.configOptions);
  }

  configOptions(workbenchSessionId: string) {
    return structuredClone(this.entries.get(workbenchSessionId)?.configOptions || []);
  }

  async close(workbenchSessionId: string, closeRemote = false) {
    const entry = this.entries.get(workbenchSessionId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (closeRemote && entry.engineSessionId) await entry.backend.closeSession(entry.engineSessionId).catch(() => undefined);
    await entry.backend.close();
    this.entries.delete(workbenchSessionId);
  }

  async closeAll() {
    await Promise.all([...this.entries.keys()].map((sessionId) => this.close(sessionId)));
  }

  private requireEntry(workbenchSessionId: string) {
    const entry = this.entries.get(workbenchSessionId);
    if (!entry) throw new Error("ACP 工作台会话不存在");
    return entry;
  }

  private async resolveLaunch(input: AcpMainSessionInput) {
    return typeof this.options.launch === "function" ? this.options.launch(input) : this.options.launch;
  }

  private armIdleClose(workbenchSessionId: string, entry: RuntimeEntry) {
    const timeoutMs = Math.max(1_000, this.options.idleTransportMs ?? 10 * 60_000);
    entry.idleTimer = setTimeout(() => { void this.close(workbenchSessionId); }, timeoutMs);
    entry.idleTimer.unref();
  }

  private async evictOldestIfNeeded() {
    const limit = Math.max(1, this.options.maxOpenTransports ?? 8);
    if (this.entries.size < limit) return;
    const oldest = [...this.entries.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
    if (oldest) await this.close(oldest[0]);
  }
}

function assertSuccessfulPrompt(response: PromptResponse) {
  if (response.stopReason === "end_turn") return;
  if (response.stopReason === "refusal") throw new Error("ACP Agent 拒绝处理本轮请求，请检查账号、模型与权限配置");
  if (response.stopReason === "max_tokens") throw new Error("ACP Agent 已达到本轮输出上限，任务结果可能不完整");
  if (response.stopReason === "cancelled") throw new Error("ACP Agent 已取消本轮请求");
  throw new Error(`ACP Agent 以未知状态结束：${String(response.stopReason)}`);
}

export function assertAcpConfigValue(option: SessionConfigOption, value: string | boolean) {
  if (option.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`ACP 配置「${option.name}」必须是布尔值`);
    return;
  }
  if (typeof value !== "string") throw new Error(`ACP 配置「${option.name}」必须是选项值`);
  const values = option.options.flatMap((item) => "value" in item ? [item.value] : item.options.map((child) => child.value));
  if (!values.includes(value)) throw new Error(`ACP 配置「${option.name}」不支持值：${value}`);
}

function assertMcpCapabilities(servers: McpServer[], initialization: InitializeResponse) {
  const capabilities = initialization.agentCapabilities?.mcpCapabilities;
  for (const server of servers) {
    if ("type" in server && server.type === "http" && !capabilities?.http) throw new Error(`ACP Agent 不支持 HTTP MCP：${server.name}`);
    if ("type" in server && server.type === "sse" && !capabilities?.sse) throw new Error(`ACP Agent 不支持 SSE MCP：${server.name}`);
  }
}
