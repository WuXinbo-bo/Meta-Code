import type { Codex, ThreadOptions } from "@openai/codex-sdk";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentAdapterRegistry } from "../../agents/registry.js";
import { resolveClaudeCommand } from "../../engines/claude/runtime.js";
import { CLAUDE_PLANNER_DISALLOWED_TOOLS, ClaudeSessionHandle, runClaudeSessionTurn } from "../../engines/claude/session.js";
import { classifyClaudeFailure } from "../../engines/claude/transport.js";
import { codexActivityFromEvent, codexTurnFailure, consumeCodexTurnEvents, isCodexReconnectMessage, runCodexSessionTurn, summarizeCodexEvent } from "../../engines/codex/events.js";
import type { EngineRuntimeStatus, NormalizedEngineEvent } from "../../engines/types.js";
import type { WorkbenchEventHub } from "../../eventHub.js";
import { ManagedSkillManager, type SkillPromptContext } from "../../managedSkillManager.js";
import type { WorkbenchMcpServer } from "../../mcpConfig.js";
import { timeoutReason } from "../../orchestration/timeouts.js";
import { isPathInside } from "../../pathBoundary.js";
import { WorkflowNodeOutcomeError, WorkflowNodeStageRetryError } from "../../plugins/orchestration/errors.js";
import { workflowAuthorizedWriteScopes } from "../../plugins/orchestration/scheduler.js";
import type { RuntimeExecutionIdentity } from "../../runtime/types.js";
import type { ExecutionMode, McpServer, Session, Settings, SkillPolicies, State, Workspace } from "../../workbench/types.js";
import type { WorkspaceTreeIndex } from "../../workspaceTreeIndex.js";
import { codexWorkflowPlannerToolInstructions, codexWorkflowResultToolInstructions } from "./controlTools.js";
import { captureWorkspaceSnapshot, changedWorkspaceFiles, filesOutsideWriteScope, runVerificationCommands } from "./enforcement.js";
import { parseWorkflowNodeResult, workflowCodexContextStrategy, workflowFailureCategory, workflowNodeResultGateIssues, workflowResultArtifactPaths } from "./execution.js";
import { upsertWorkflowLog, workflowLog, workflowLogFromEngineEvent, type WorkflowLogContext } from "./logs.js";
import { commitWorkflowNodeResultTransaction, openWorkflowNodeResultTransaction, readWorkflowNodeResultTransaction, reopenWorkflowNodeResultTransaction, validateWorkflowNodeResultTransaction, type WorkflowNodeResultContract } from "./nodeResultTransactions.js";
import { plannerTurnPrompt, planSystemPrompt, resolveWorkflowProvider, workflowNodeContractDigest, type WorkflowProviderCapabilities } from "./plan.js";
import { readWorkflowPlanTransaction } from "./plannerTransactions.js";
import { WorkflowRepository } from "./repository.js";
import { WORKFLOW_ROLE_SKILLS } from "./roles.js";
import type { WorkflowStateFiles } from "./stateFiles.js";
import type { WorkflowRecord } from "./types.js";
import { DEFAULT_WORKFLOW_MAX_CONCURRENT_AGENTS, type WorkflowEngine, type WorkflowNodeAttemptRecord, type WorkflowNodeLog, type WorkflowNodePhase, type WorkflowNodeRecord, type WorkflowNodeResult, type WorkflowPlan, type WorkflowPlanningMode } from "./types.js";

export type WorkflowPlannerRunner = (workflow: WorkflowRecord, workspace: Workspace, skillNames: string[], mcpServerNames: string[], skillContext: string, providerCapabilities: WorkflowProviderCapabilities, signalController: AbortController, transactionPath: string, onActivity: (event: NormalizedEngineEvent) => void, planningMode?: WorkflowPlanningMode, previousPlan?: WorkflowPlan | null) => Promise<{ plan: WorkflowPlan; engineSessionId: string | null; noChange: boolean; note: string | null; finalText: string; }>;
export type WorkflowWorkerRunner = (workflowId: string, ownerUserId: string, nodeId: string, controller: AbortController, attempt: WorkflowNodeAttemptRecord, runnerId: string) => Promise<WorkflowNodeResult>;

export type OrchestrationRuntimePorts = {
  agentAdapterRegistry: Pick<AgentAdapterRegistry, "list" | "descriptor"> & { workflowPlannerRunner: (id: string) => WorkflowPlannerRunner | undefined; workflowWorkerRunner: (id: string) => WorkflowWorkerRunner | undefined };
  providerReadiness: (providerId: string, ownerUserId: string, workspace?: Workspace) => Promise<{ ready: boolean; issues: Array<{ message: string }> }>;
  workspaceById: (id: string, ownerUserId?: string | undefined) => Workspace | undefined;
  workflowRepository: WorkflowRepository;
  workflowStateFiles: WorkflowStateFiles;
  eventHub: WorkbenchEventHub;
  managedSkillManager: ManagedSkillManager;
  skillFileIndex: (skill: SkillPromptContext) => string;
  autoSkillCandidateBlock: (skill: SkillPromptContext, index: number) => string;
  workflowPlannerMcpConfigPath: (workspace: Workspace, transactionPath: string) => Promise<string>;
  getClaudeRuntime: (force?: boolean, allowStale?: boolean) => Promise<EngineRuntimeStatus>;
  nativeProviderHome: (providerId: "codex" | "claude", ownerUserId: string) => string;
  CLAUDE_WORKFLOW_READ_TOOLS: readonly ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
  WORKFLOW_PLANNER_RECOVERY_ATTEMPTS: 2;
  workflowPlannerToolServer: (transactionPath: string) => WorkbenchMcpServer;
  assertCodexWorkflowControlPlane: (server: WorkbenchMcpServer, cwd: string, kind: "planner" | "result") => Promise<void>;
  threadOptions: (workspace: Workspace, settings: Settings) => ThreadOptions;
  buildCodex: (settings: Settings, parentSession?: Session | undefined, disableNativeAgents?: boolean, workspace?: Workspace | undefined, selectedMcpNames?: string[] | undefined, additionalMcpServers?: WorkbenchMcpServer[], codexHomeOverride?: string | undefined) => Codex;
  promptWithAgents: (text: string, requestedPolicies?: unknown, legacySkillNames?: unknown, legacyAgentMode?: unknown, explicitSkillNames?: unknown, nativeContext?: { engine: string; workspaceRoot: string; } | undefined) => string;
  workspaceAgentConfig: (workspace: Workspace, providedDefaults?: SkillPolicies | undefined) => { skillPolicies: SkillPolicies; capabilityProfileId: string | null; skillOverrides: SkillPolicies; executionMode: ExecutionMode; };
  runtimeDirectory: string;
  workflowNodeResultToolServer: (transactionPath: string) => WorkbenchMcpServer;
  delegatedThreadOptions: (workspace: Workspace, settings: Settings) => ThreadOptions;
  workflowNodeMcpConfigPath: (workspace: Workspace, names: string[], additionalServers?: WorkbenchMcpServer[]) => Promise<string>;
  createWorkflowClaudeHandle: (options: { cwd: string; sessionId?: string | null | undefined; mcpConfigPath?: string | undefined; permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions"; allowedTools?: string[] | undefined; disallowedTools?: string[] | undefined; additionalDirectories?: string[] | undefined; includeSystemStatus?: boolean | undefined; signal: AbortSignal; ownerId: string; onEvent: (event: NormalizedEngineEvent) => void | Promise<void>; }) => Promise<ClaudeSessionHandle>;
  claudeMcpAllowedTools: (servers: WorkbenchMcpServer[]) => string[];
  CLAUDE_WORKFLOW_READ_ONLY_DISALLOWED_TOOLS: readonly ["Write", "Edit", "NotebookEdit", "Bash"];
  mcpServersForNode: (workspace: Workspace, names: string[]) => McpServer[];
  runtimeBindingForProvider: (providerId: string) => Promise<RuntimeExecutionIdentity>;
  activeWorkflowIntegrations: Map<string, AbortController>;
  workspaceTreeIndex: WorkspaceTreeIndex;
  getState: () => Pick<State, "settings">;
};

export function createOrchestrationRuntime(ports: OrchestrationRuntimePorts) {
  const { agentAdapterRegistry, providerReadiness, workspaceById, workflowRepository, workflowStateFiles, eventHub, managedSkillManager, skillFileIndex, autoSkillCandidateBlock, workflowPlannerMcpConfigPath, getClaudeRuntime, nativeProviderHome, CLAUDE_WORKFLOW_READ_TOOLS, WORKFLOW_PLANNER_RECOVERY_ATTEMPTS, workflowPlannerToolServer, assertCodexWorkflowControlPlane, threadOptions, buildCodex, promptWithAgents, workspaceAgentConfig, runtimeDirectory: pluginRuntimeDirectory, workflowNodeResultToolServer, delegatedThreadOptions, workflowNodeMcpConfigPath, createWorkflowClaudeHandle, claudeMcpAllowedTools, CLAUDE_WORKFLOW_READ_ONLY_DISALLOWED_TOOLS, mcpServersForNode, runtimeBindingForProvider, activeWorkflowIntegrations, workspaceTreeIndex, getState } = ports;
function workflowPlannerRecoveryPrompt(reason: string) {
  return [
    "上一轮规划没有形成可提交的终态，但隔离规划事务仍然保留。",
    `中断原因：${reason || "规划回合未完整结束"}。`,
    "先调用 workflow_read_plan 读取当前草稿，只继续未完成部分。大型计划使用 workflow_apply_operations 每批写入 2 至 4 个节点，不要重新生成已经写入的内容。",
    "完成依赖、自审和修正后调用 workflow_validate_draft；通过后必须调用 workflow_commit_candidate。自然语言只需简短说明，不要输出机器 JSON。"
  ].join("\n");
}

function retryableWorkflowPlannerFailure(message: string) {
  const text = message.toLowerCase();
  if (classifyClaudeFailure(message) === "permanent") return false;
  return [
    "stream disconnected", "connection reset", "connection refused", "socket hang up", "fetch failed",
    "econnreset", "econnrefused", "eai_again", "etimedout", "service unavailable", "bad gateway",
    "gateway timeout", "http 524", "rate limit", "too many requests", "concurrency limit", "max token",
    "token 上限", "不完整结果", "没有通过 workflow_commit_candidate", "missing completion", "工作台正在关闭"
  ].some((marker) => text.includes(marker.toLowerCase()));
}

function workflowPlannerFailureMessage(error: unknown, controller: AbortController) {
  const timedOut = timeoutReason(controller.signal);
  if (timedOut) return timedOut.message;
  const message = error instanceof Error ? error.message : String(error);
  if (controller.signal.aborted && /operation was aborted|aborterror|aborted/i.test(message)) {
    const reason = controller.signal.reason;
    if (reason instanceof Error && reason.message) return reason.message;
    return "规划运行已中止";
  }
  return message;
}

function workflowPlannerRequestKey(workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>, mode: WorkflowPlanningMode, note: string | null, previousPlan: WorkflowPlan | null) {
  return crypto.createHash("sha256").update(JSON.stringify({
    workflowId: workflow.id,
    mode,
    originalPrompt: workflow.originalPrompt,
    note: note || "",
    basePlanVersion: workflow.activePlanVersion,
    previousPlan: previousPlan || null
  })).digest("hex");
}

async function currentWorkflowProviderCapabilities(ownerUserId: string, workspace?: Workspace): Promise<WorkflowProviderCapabilities> {
  const descriptors = agentAdapterRegistry.list();
  const entries = await Promise.all(descriptors.map(async (descriptor) => {
    const readiness = await providerReadiness(descriptor.id, ownerUserId, workspace);
    return [descriptor.id, {
      displayName: descriptor.shortName,
      available: readiness.ready && descriptor.capabilities.workflow.worker && Boolean(agentAdapterRegistry.workflowWorkerRunner(descriptor.id)),
      workspaceRead: descriptor.capabilities.workspace.read,
      workspaceWrite: descriptor.capabilities.workspace.write
    }] as const;
  }));
  const providers = Object.fromEntries(entries);
  const available = entries.filter(([, provider]) => provider.available);
  const read = providers.claude?.available ? "claude" : available.find(([, provider]) => provider.workspaceRead)?.[0] || "claude";
  const write = providers.codex?.available ? "codex" : available.find(([, provider]) => provider.workspaceWrite)?.[0] || read;
  return { providers, defaults: { read, write } };
}

async function assertWorkflowExecutionReady(workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>, ownerUserId: string) {
  const workspace = workspaceById(workflow.workspaceId, ownerUserId);
  if (!workspace) throw new Error("工作区不存在");
  const capabilities = await currentWorkflowProviderCapabilities(ownerUserId, workspace);
  for (const node of workflow.nodes) {
    if (["completed", "skipped", "canceled"].includes(node.status)) continue;
    const providerId = resolveWorkflowProvider(node.provider, node.workspaceAccess, capabilities);
    const provider = capabilities.providers[providerId];
    if (!provider?.available) throw new Error(`节点「${node.title}」需要的 Agent「${provider?.displayName || providerId}」尚未连接或不可用`);
    if (node.workspaceAccess === "write" && !provider.workspaceWrite) throw new Error(`节点「${node.title}」需要写入工作区，但 Agent「${provider.displayName}」未声明写入能力`);
    if (node.workspaceAccess === "read" && !provider.workspaceRead) throw new Error(`节点「${node.title}」需要读取工作区，但 Agent「${provider.displayName}」未声明读取能力`);
  }
}

function workflowExecutionProvider(node: Pick<WorkflowNodeRecord, "provider" | "workspaceAccess">) {
  const preferred = node.workspaceAccess === "write" ? "codex" : "claude";
  const fallback = agentAdapterRegistry.list().find((descriptor) =>
    descriptor.capabilities.workflow.worker &&
    (node.workspaceAccess !== "write" || descriptor.capabilities.workspace.write) &&
    Boolean(agentAdapterRegistry.workflowWorkerRunner(descriptor.id))
  )?.id;
  const provider = node.provider === "auto"
    ? (agentAdapterRegistry.workflowWorkerRunner(preferred) ? preferred : fallback || preferred)
    : node.provider;
  if (!agentAdapterRegistry.workflowWorkerRunner(provider)) throw new Error(`Provider「${provider}」尚未绑定工作流节点 Runner`);
  return provider;
}

function syncWorkflowProtocolFiles(workflowId: string, ownerUserId: string) {
  const workflow = workflowRepository.get(workflowId, ownerUserId);
  if (!workflow || !workflow.workDirectory) return workflow;
  workflowStateFiles.sync(workflow);
  return workflow;
}

function appendWorkflowProtocolEvent(workflowId: string, ownerUserId: string, type: string, payload?: unknown, nodeId?: string, attempt?: number) {
  const workflow = workflowRepository.get(workflowId, ownerUserId);
  if (!workflow || !workflow.workDirectory) return;
  workflowStateFiles.appendEvent(workflow, { type, payload, nodeId, attempt });
}

function workflowEvent(workflowId: string, type: string, ownerUserId: string, workspaceId: string, revision: number, nodeId?: string) {
  const payload = { workflowId, workspaceId, revision, eventType: type, ...(nodeId ? { nodeId } : {}) };
  eventHub.publish(type, payload, [ownerUserId]);
  eventHub.publish("workflow.changed", payload, [ownerUserId]);
}

function workflowTextFromOpenAI(payload: any) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (Array.isArray(payload?.output) ? payload.output : []).flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
    .map((item: any) => String(item?.text || item?.output_text || "")).filter(Boolean).join("\n");
}

function plannerSkillContext(workspace: Workspace, policies: SkillPolicies) {
  const contexts = managedSkillManager.listPublic()
    .filter((skill) => !skill.builtIn && (policies[skill.name] === "always" || policies[skill.name] === "auto"))
    .map((skill) => {
      try { return { skill: managedSkillManager.promptContext(skill.name), policy: policies[skill.name] as "always" | "auto" }; }
      catch { return null; }
    })
    .filter((item): item is { skill: SkillPromptContext; policy: "always" | "auto" } => Boolean(item));
  const maxInstructions = 14_000;
  const maxTotalContext = 36_000;
  let totalLength = 0;
  return contexts.map(({ skill, policy }, index) => policy === "always"
    ? [
      `必须遵守的工作区 Skill ${index + 1}：${skill.name}`,
      skill.instructions.length > maxInstructions ? `${skill.instructions.slice(0, maxInstructions)}\n[正文已截断；如需细节，继续从入口文件读取]` : skill.instructions,
      `入口和指示库根目录：${skill.root}`,
      `可用指示库文件索引：\n${skillFileIndex(skill)}`,
      "规划节点必须继承该 Skill 的阶段顺序、产物要求和验收规则；只读取与当前任务相关的参考文件。"
    ].join("\n")
    : autoSkillCandidateBlock(skill, index)
  ).map((block) => {
    if (totalLength >= maxTotalContext) return "";
    const remaining = maxTotalContext - totalLength;
    const value = block.length > remaining ? `${block.slice(0, Math.max(0, remaining - 80))}\n[规划上下文已达到总预算；请按入口文件索引按需读取]` : block;
    totalLength += value.length;
    return value;
  }).filter(Boolean).join("\n\n");
}

function validateClaudePlannerPreflight() {
  const baseUrl = getState().settings.claude.baseUrl.trim();
  if (!baseUrl) throw new Error("Claude Base URL 未配置");
  try {
    const parsed = new URL(baseUrl);
    if (!/^https?:$/i.test(parsed.protocol)) throw new Error("协议必须是 HTTP 或 HTTPS");
  } catch (error) {
    throw new Error(`Claude Base URL 无效：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!getState().settings.claude.model.trim()) throw new Error("Claude 模型未配置");
}

async function runBuiltinWorkflowPlan(workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>, workspace: Workspace, skillNames: string[], mcpServerNames: string[], skillContext: string, providerCapabilities: WorkflowProviderCapabilities, signalController: AbortController, transactionPath: string, onActivity: (event: NormalizedEngineEvent) => void, planningMode: WorkflowPlanningMode = "initial", previousPlan: WorkflowPlan | null = null) {
  const engine = workflow.plannerEngine;
  const system = planSystemPrompt(skillNames, mcpServerNames, skillContext, workflow.maxConcurrentAgents || DEFAULT_WORKFLOW_MAX_CONCURRENT_AGENTS, providerCapabilities);
  const plannerPrompt = plannerTurnPrompt(system, workflow.originalPrompt, { mode: planningMode, reviewNote: workflow.reviewNote, previousPlan, workspaceRoot: workspace.root });
  const sessionId = workflow.plannerSessionId || `workflow-planner:${workflow.id}`;
  let engineSessionId = workflow.plannerEngineSessionId;
  let plannerMcpConfigFile = "";
  try {
  if (engine === "claude") {
    let output = "";
    const plannerEvent = (event: NormalizedEngineEvent) => { if (event.type === "assistant" && event.text) output = event.text; onActivity(event); };
    plannerMcpConfigFile = await workflowPlannerMcpConfigPath(workspace, transactionPath);
    const createPlannerHandle = async (resumeSessionId?: string | null) => {
      const runtime = await getClaudeRuntime();
      if (!runtime.available) throw new Error("Claude CLI 不可用，请先在配置中检测或安装");
      const command = resolveClaudeCommand(runtime.path);
      return new ClaudeSessionHandle({
        executable: command.executable, executableArgs: command.args, cwd: workflow.workDirectory || workspace.root,
        sessionId: resumeSessionId, model: getState().settings.claude.model, effort: getState().settings.claude.effort,
        baseUrl: getState().settings.claude.baseUrl, apiKey: getState().settings.claude.apiKey, configDir: nativeProviderHome("claude", workflow.ownerUserId),
        mcpConfigPath: plannerMcpConfigFile, permissionMode: "default", disallowNativeAgents: true,
        disallowedTools: [...CLAUDE_PLANNER_DISALLOWED_TOOLS],
        allowedTools: [...CLAUDE_WORKFLOW_READ_TOOLS, "mcp__workbench-workflow-plan__*"],
        includeSystemStatus: true,
        additionalDirectories: skillNames.map((name) => managedSkillManager.promptContext(name).root),
        signal: signalController.signal, ownerId: sessionId, onEvent: plannerEvent
      });
    };
    let prompt = plannerPrompt;
    for (let recoveryAttempt = 0; recoveryAttempt <= WORKFLOW_PLANNER_RECOVERY_ATTEMPTS; recoveryAttempt += 1) {
      const turn = await runClaudeSessionTurn({
        createHandle: createPlannerHandle,
        sessionId: engineSessionId,
        prompt,
        recoveryAttempts: 2,
        mode: "planner",
        signal: signalController.signal,
        onSessionId: (id) => {
          engineSessionId = id;
          workflowRepository.setPlannerSession(workflow.id, workflow.ownerUserId, sessionId, id);
        },
        onRecovery: ({ attempt, maxAttempts, reason, transport }) => onActivity({
          type: "status",
          sourceId: `planner-runtime-recovery:${attempt}`,
          text: transport
            ? `Claude 规划连接已刷新并恢复原会话（${attempt}/${maxAttempts}）：${reason}`
            : `Claude 规划回合不完整，正在原会话续跑（${attempt}/${maxAttempts}）：${reason}`
        }),
        transportRecoveryPrompt: workflowPlannerRecoveryPrompt,
        incompleteRecoveryPrompt: workflowPlannerRecoveryPrompt
      });
      const result = turn.result;
      engineSessionId = result.sessionId;
      const transaction = readWorkflowPlanTransaction(transactionPath);
      if (["committed", "no_change"].includes(transaction.status)) break;
      if (!result.failed) {
        if (recoveryAttempt >= WORKFLOW_PLANNER_RECOVERY_ATTEMPTS) throw new Error("规划 Agent 已结束，但没有通过 workflow_commit_candidate 提交候选计划");
        prompt = workflowPlannerRecoveryPrompt("规划回合已结束，但事务尚未提交");
      } else {
        const reason = result.error || "Claude 规划 Agent 未完成";
        if (!result.retryable || recoveryAttempt >= WORKFLOW_PLANNER_RECOVERY_ATTEMPTS) throw new Error(reason);
        prompt = workflowPlannerRecoveryPrompt(reason);
      }
      onActivity({ type: "status", sourceId: `planner-recovery:${recoveryAttempt + 1}`, text: `规划通道未完整结束，正在从事务草稿自动续跑（${recoveryAttempt + 1}/${WORKFLOW_PLANNER_RECOVERY_ATTEMPTS}）` });
    }
    const transaction = readWorkflowPlanTransaction(transactionPath);
    if (transaction.status === "no_change") return { plan: transaction.draftPlan, engineSessionId, noChange: true, note: transaction.note, finalText: output };
    if (transaction.status !== "committed") throw new Error("规划 Agent 已结束，但没有通过 workflow_commit_candidate 提交候选计划");
    return { plan: transaction.draftPlan, engineSessionId, noChange: false, note: transaction.note, finalText: output };
  }
  if (!getState().settings.apiKey) throw new Error("请先配置 Codex / OpenAI API Key");
  const plannerDirectory = path.dirname(transactionPath);
  const plannerServer = workflowPlannerToolServer(transactionPath);
  await assertCodexWorkflowControlPlane(plannerServer, plannerDirectory, "planner");
  const plannerThreadOptions = { ...threadOptions({ ...workspace, root: plannerDirectory }, getState().settings), workingDirectory: plannerDirectory, sandboxMode: "workspace-write" as const, approvalPolicy: "never" as const, networkAccessEnabled: false };
  let output = "";
  let plannerToolAuthorizationError = "";
  const codexPlannerInstructions = codexWorkflowPlannerToolInstructions();
  let prompt = `${plannerPrompt}\n\n${codexPlannerInstructions}`;
  for (let recoveryAttempt = 0; recoveryAttempt <= WORKFLOW_PLANNER_RECOVERY_ATTEMPTS; recoveryAttempt += 1) {
    const codex = buildCodex(getState().settings, undefined, true, workspace, undefined, [plannerServer]);
    const terminal = await runCodexSessionTurn({
      createThread: (threadId) => threadId ? codex.resumeThread(threadId, plannerThreadOptions) : codex.startThread(plannerThreadOptions),
      threadId: engineSessionId,
      prompt,
      signal: signalController.signal,
      missingCompletionMessage: "Codex stream missing completion",
      terminalReason: "Codex 规划已到达终态",
      onThreadId: (threadId) => {
        engineSessionId = threadId;
        workflowRepository.setPlannerSession(workflow.id, workflow.ownerUserId, sessionId, threadId);
      },
      onEvent: (event) => {
        const text = summarizeCodexEvent(event);
        if (/user cancelled MCP tool call|MCP tool call.*cancelled|MCP 工具.*取消/i.test(text)) plannerToolAuthorizationError = text;
        if (event.type === "item.completed" && event.item.type === "agent_message") output = text;
        const normalized = normalizedCodexWorkflowEvent(event, text);
        if (normalized) onActivity(normalized);
      },
      isDurableResultCommitted: () => { try { return ["committed", "no_change"].includes(readWorkflowPlanTransaction(transactionPath).status); } catch { return false; } },
    });
    engineSessionId = terminal.threadId || engineSessionId;
    const transaction = readWorkflowPlanTransaction(transactionPath);
    if (["committed", "no_change"].includes(transaction.status)) break;
    const reason = terminal.failure || "规划回合已结束，但事务尚未提交";
    const recoverable = !terminal.failed || retryableWorkflowPlannerFailure(reason);
    if (!recoverable || recoveryAttempt >= WORKFLOW_PLANNER_RECOVERY_ATTEMPTS) throw new Error(reason || "Codex 规划 Agent 执行失败");
    prompt = `${workflowPlannerRecoveryPrompt(reason)}\n\n${codexPlannerInstructions}`;
    onActivity({ type: "status", sourceId: `planner-recovery:${recoveryAttempt + 1}`, text: `规划通道未完整结束，正在从事务草稿自动续跑（${recoveryAttempt + 1}/${WORKFLOW_PLANNER_RECOVERY_ATTEMPTS}）` });
  }
  if (plannerToolAuthorizationError) throw new Error(`规划工具被 Codex 执行权限策略拒绝：${plannerToolAuthorizationError}`);
  const transaction = readWorkflowPlanTransaction(transactionPath);
  if (transaction.status === "no_change") return { plan: transaction.draftPlan, engineSessionId, noChange: true, note: transaction.note, finalText: output };
  if (transaction.status !== "committed") throw new Error("规划 Agent 已结束，但没有通过 workflow_commit_candidate 提交候选计划");
  return { plan: transaction.draftPlan, engineSessionId, noChange: false, note: transaction.note, finalText: output };
  } finally {
    if (plannerMcpConfigFile) await fsp.rm(plannerMcpConfigFile, { force: true }).catch(() => undefined);
  }
}

function requestWorkflowPlan(...args: Parameters<WorkflowPlannerRunner>): ReturnType<WorkflowPlannerRunner> {
  const engine = args[0].plannerEngine;
  const runner = agentAdapterRegistry.workflowPlannerRunner(engine);
  if (!runner) throw new Error(`Provider「${engine}」尚未绑定工作流规划 Runner`);
  return runner(...args);
}

function normalizedCodexWorkflowEvent(event: any, text: string): NormalizedEngineEvent | null {
  const presentation = codexActivityFromEvent(event);
  const item = event?.item || {};
  const itemId = String(item.id || event?.item_id || event?.thread_id || event?.type || "codex");
  const metadata = { category: presentation.category, phase: presentation.phase, detail: presentation.detail };
  if (event?.type === "thread.started") return { type: "session.started", sourceId: `thread:${event.thread_id || itemId}`, text: text || "Codex 会话已开始", payload: event, ...metadata };
  if (event?.type === "turn.started") return { type: "turn.started", sourceId: "turn", text: text || "Codex 开始运行", payload: event, ...metadata };
  if (event?.type === "turn.completed") return { type: "turn.completed", sourceId: "turn", text: text || "Codex 任务已完成", payload: event, ...metadata };
  if (event?.type === "error" && isCodexReconnectMessage(text)) return { type: "status", sourceId: `reconnect:${itemId}`, text: text || "Codex 正在重连", payload: event, ...metadata };
  if (event?.type === "turn.failed" || event?.type === "error") return { type: "error", sourceId: `error:${itemId}`, text: text || "Codex 执行失败", payload: event, ...metadata };
  if (presentation.rawType === "context_compaction") return { type: "status", rawType: presentation.rawType, sourceId: itemId, text, payload: event, ...metadata };
  if (!String(event?.type || "").startsWith("item.")) return text ? { type: "status", sourceId: itemId, text, payload: event, ...metadata } : null;
  if (item.type === "agent_message") return { type: "assistant", sourceId: itemId, text, payload: event, ...metadata };
  if (item.type === "reasoning") return { type: "reasoning", sourceId: itemId, text: text || "Codex 正在分析任务", payload: event, ...metadata };
  const toolName = String(item.type || "工具");
  return { type: event.type === "item.completed" ? "tool.completed" : "tool.started", sourceId: itemId, toolName, text: text || `${toolName}${event.type === "item.completed" ? "已完成" : "正在执行"}`, payload: event, ...metadata };
}

function markCodexTransientLogsRecovered(logs: WorkflowNodeLog[]) {
  for (const log of logs) {
    if (log.category === "status" && log.phase === "running" && /连接异常|重连|stream|socket|fetch failed/i.test(log.text)) {
      log.kind = "status";
      log.title = "连接已恢复";
      log.text = "连接已恢复，任务继续执行";
      log.phase = "completed";
    }
  }
}

function verifiedWorkflowNodeResults(workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>) {
  let snapshot = workflowStateFiles.results(workflow);
  if (!snapshot) snapshot = workflowStateFiles.syncResults(workflow);
  const verified = new Map<string, WorkflowNodeResult>();
  for (const node of workflow.nodes) {
    if (node.status !== "completed") continue;
    const entry = snapshot.nodes[node.id];
    if (!entry?.result) continue;
    const digest = workflowResultDigest(entry.result);
    const expected = node.resultDigest || entry.resultDigest;
    if (expected && digest !== expected) throw new Error(`节点「${node.title}」的 results.json 哈希不一致，已停止消费该结果`);
    verified.set(node.id, entry.result);
  }
  return verified;
}

function workflowNodeTaskContract(workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>, node: WorkflowNodeRecord) {
  const verifiedResults = verifiedWorkflowNodeResults(workflow);
  const nodeById = new Map(workflow.nodes.map((item) => [item.id, item]));
  const ancestorIds = new Set<string>();
  const pendingAncestors = [...node.dependsOn];
  while (pendingAncestors.length) {
    const ancestorId = pendingAncestors.pop()!;
    if (ancestorIds.has(ancestorId)) continue;
    ancestorIds.add(ancestorId);
    const ancestor = nodeById.get(ancestorId);
    if (ancestor) pendingAncestors.push(...ancestor.dependsOn);
  }
  const upstream = workflow.nodes.filter((item) => node.dependsOn.includes(item.id) && verifiedResults.has(item.id)).map((item) => {
    const result = verifiedResults.get(item.id)!;
    return {
      nodeId: item.id, title: item.title, outcome: result.outcome, humanSummary: result.humanSummary,
      outputs: result.outputs, decisions: result.decisions, handoff: result.handoff,
      warnings: result.warnings, unresolved: result.unresolved, machineResultPath: result.machineResultPath
    };
  });
  const ancestorContracts = workflow.nodes.filter((item) => ancestorIds.has(item.id)).map((item) => ({
    nodeId: item.id,
    title: item.title,
    objective: item.objective,
    constraints: item.constraints,
    acceptance: item.acceptance,
    deliverables: item.deliverables
  }));
  const downstreamConsumers = workflow.nodes.filter((item) => item.dependsOn.includes(node.id)).map((item) => ({ id: item.id, title: item.title, requiredArtifacts: item.requiredArtifacts }));
  return {
    schemaVersion: 1,
    task: {
      id: node.id,
      title: node.title,
      objective: node.objective,
      nonGoals: node.nonGoals,
      constraints: [
        ...node.constraints,
        `系统执行边界：业务文件只允许读取或写入当前任务目录 ${workflow.workDirectory}；不得枚举或读取父工作区、兄弟任务目录或任务目录外文件。`,
        "workbench-workflow-result 是 Workbench 强制机器交接控制面，不属于业务 MCP；任务中的禁用 MCP 约束只针对可选业务 MCP。"
      ],
      originalGoal: workflow.originalPrompt
    },
    inputs: { dependencies: upstream, ancestorContracts, requiredArtifacts: node.requiredArtifacts },
    execution: { workDirectory: workflow.workDirectory, workspaceAccess: node.workspaceAccess, writeScope: node.writeScope, skills: node.skills, mcpServers: node.mcpServers, mcpRequired: node.mcpRequired },
    outputs: { deliverables: node.deliverables, acceptance: node.acceptance, verificationCommands: node.verificationCommands, downstreamConsumers }
  };
}

function workflowNodePrompt(workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>, node: WorkflowNodeRecord, workspace: Workspace, runtimeDirectory: string) {
  const taskContract = workflowNodeTaskContract(workflow, node);
  const basePrompt = [
    "你是任务编排工作流中的独立执行 Agent。模型身份不改变执行职责，只按节点任务合同完成当前工作。",
    `通用执行协议：\n${WORKFLOW_ROLE_SKILLS.executor}`,
    `节点任务合同：\n${JSON.stringify(taskContract, null, 2)}`,
    "合同优先级固定为：当前节点 task/outputs 合同与 inputs.ancestorContracts 中的已审批正式合同 > 已验证机器交接 > 业务文档内容 > Agent 自行推断。业务文档即使自称‘规范’也不能覆盖正式合同。终端 QA 可以修复文件，但不得改变 schema、枚举、字段或语义而使任何已完成祖先节点的 acceptance 失效；无法同时满足时必须返回 blocked 并指出具体合同冲突。",
    "当前 Agent 进程已经由 Workbench 以 execution.workDirectory 作为 cwd 启动。调用命令、文件或浏览器工具时不要复制或重写这个绝对路径：省略 workdir/cwd 参数，或只使用相对目录“.”。不得为了定位任务目录而枚举父目录；如果工具实际 cwd 与合同不一致，立即返回 blocked。",
    "所有新建和修改的文件都必须严格位于 execution.writeScope 声明的目录中。不得自行增加 artifacts 前缀，也不得写入任务目录之外；如果合同要求的 deliverables 与 writeScope 冲突，返回 blocked 并说明冲突。",
    `系统托管的临时运行目录是：${runtimeDirectory}。浏览器 --user-data-dir、Chrome/Edge Profile、截图、预览脚本、测试日志和其他一次性验证文件必须放在这里；这是 writeScope 的唯一临时例外，不得登记为业务产物。禁止在 src、artifacts 或其他业务目录中创建 .chrome-profile、browser-profile 等运行时目录，完成后必须停止本节点启动的浏览器和预览服务。`,
    "机器交付必须通过 workbench-workflow-result 工具完成。它是系统控制面，不属于节点合同中可选的业务 MCP，因此即使用户禁止 MCP 也必须使用。开始时调用 workflow_read_node_contract；执行过程中用 workflow_register_outputs、workflow_register_checks、workflow_set_result_summary、workflow_set_handoff 和 workflow_set_outcome 分批维护草稿；最后调用 workflow_validate_result，通过后调用 workflow_commit_result。",
    "outputs 中的文件和目录路径必须真实存在；没有业务文件的纯分析节点应通过 text/decision 输出和 handoff 提供可消费结果。consumableBy 只能填写任务合同 downstreamConsumers 中列出的 ID，没有下游时使用空数组。checks 只能登记真实执行情况。缺少输入或权限时调用 workflow_report_blocked。",
    "自然语言最终回复只面向用户，简短总结本节点工作即可。不要在聊天回复中输出机器 JSON；聊天文本不再作为机器交付和完成依据。只有 workflow_commit_result 成功才代表候选机器结果已封存，正式完成状态仍由 Workbench 验收决定。",
    "提交前必须调用 workflow_read_result_draft 复核完整草稿，按通用执行协议完成六项固定自审并调用 workflow_self_review_result。已明确属于 downstreamConsumers 的后续验证写入 warnings 或 handoff，不得放入 unresolved 或据此降低当前节点 outcome。自审后立即校验和提交；若再次修改草稿，必须重新自审。",
    node.attempt > 1 && node.summary ? `这是第 ${node.attempt} 次纠正执行。保留并复用已经真实存在的业务产物，只针对上次验收问题补充或修正，不要无条件从头重做。上次结果反馈：\n${JSON.stringify({ outcome: node.summary.outcome, humanSummary: node.summary.humanSummary, warnings: node.summary.warnings, unresolved: node.summary.unresolved, outputs: node.summary.outputs }, null, 2)}` : ""
  ].filter(Boolean).join("\n\n");
  return promptWithAgents(
    basePrompt,
    workspaceAgentConfig(workspace).skillPolicies,
    undefined,
    undefined,
    node.skills,
    { engine: workflowExecutionProvider(node), workspaceRoot: workflow.workDirectory }
  );
}

function workflowResultPath(workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>, workspace: Workspace, reportedPath: string, mustExist: boolean) {
  const raw = reportedPath.trim();
  if (!raw) throw new Error("执行结果包含空文件路径");
  const workflowRoot = path.resolve(workflow.workDirectory);
  const candidates = path.isAbsolute(raw) ? [path.resolve(raw)] : [path.resolve(workflow.workDirectory, raw), path.resolve(workspace.root, raw)];
  const resolved = mustExist
    ? candidates.find((candidate) => isPathInside(workflowRoot, candidate) && fs.existsSync(candidate))
    : candidates.find((candidate) => isPathInside(workflowRoot, candidate));
  if (!resolved) throw new Error(`执行结果路径越出任务目录：${raw}`);
  if (mustExist && !fs.existsSync(resolved)) throw new Error(`Agent 声明的产物不存在：${raw}`);
  return { absolute: resolved, relative: path.relative(workflowRoot, resolved).replaceAll("\\", "/") || "." };
}

function verifyWorkflowNodeResult(
  workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>,
  node: WorkflowNodeRecord,
  workspace: Workspace,
  result: WorkflowNodeResult,
  changedFiles: string[],
  outsideWriteScope: string[]
): { result: WorkflowNodeResult; records: Array<{ path: string; kind: string; hash: string | null; summary: string }> } {
  const normalized: WorkflowNodeResult = { ...result, changedFiles: [...new Set(changedFiles)] };
  if (result.outcome !== "completed") return { result: normalized, records: [] };

  const issues: string[] = [];
  const downstreamNodeIds = new Set(workflow.nodes.filter((item) => item.dependsOn.includes(node.id)).map((item) => item.id));
  issues.push(...workflowNodeResultGateIssues(result, { downstreamNodeIds: [...downstreamNodeIds], deliverables: node.deliverables }));

  const paths = workflowResultArtifactPaths(result);
  const verified: Array<{ absolute: string; relative: string }> = [];
  const normalizedByPath = new Map<string, string>();
  for (const reportedPath of paths) {
    try {
      const item = workflowResultPath(workflow, workspace, reportedPath, true);
      verified.push(item);
      normalizedByPath.set(reportedPath, item.relative);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (outsideWriteScope.length) issues.push(`检测到越出 writeScope 的文件修改：${outsideWriteScope.join(", ")}`);

  const outputs = result.outputs.map((output) => ({ ...output, path: output.path ? normalizedByPath.get(output.path) || output.path : null }));
  const records = verified.map(({ absolute, relative }) => {
    const stat = fs.statSync(absolute);
    const hash = stat.isFile() && stat.size <= 25 * 1024 * 1024 ? crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") : null;
    return { path: relative, kind: stat.isDirectory() ? "directory" : "file", hash, summary: result.humanSummary.slice(0, 500) };
  });
  if (!issues.length) return { result: { ...normalized, outputs }, records };
  return {
    result: {
      ...normalized,
      outcome: outsideWriteScope.length ? "failed" : "partial",
      outputs,
      warnings: outsideWriteScope.length ? [...normalized.warnings, "越界文件未自动回滚，请人工检查工作区状态。"] : normalized.warnings,
      unresolved: [...new Set([...normalized.unresolved, ...issues])]
    },
    records
  };
}

function workflowFailureResult(message: string, outcome: "blocked" | "failed" = "failed"): WorkflowNodeResult {
  return {
    outcome,
    humanSummary: outcome === "blocked" ? "节点因执行条件不足而阻塞。" : "节点未能完成执行。",
    outputs: [],
    changedFiles: [],
    checks: [],
    decisions: [],
    handoff: { facts: [], constraints: [], nextAgentInstructions: [] },
    warnings: [],
    unresolved: [message],
    machineResultPath: null
  };
}


function persistWorkflowNodeResult(workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>, node: WorkflowNodeRecord, workspace: Workspace, result: WorkflowNodeResult) {
  // Machine state belongs to the orchestration plugin runtime. Keep a stable
  // URI in the contract so agents never need to inspect a hidden workspace
  // directory or receive a machine-specific absolute path.
  void workspace;
  void node;
  return { ...result, machineResultPath: `plugin://orchestration/runs/${workflow.id}/results.json` };
}

const WORKFLOW_PHASE_ORDER: WorkflowNodePhase[] = ["claimed", "result_draft_started", "agent_running", "agent_output_received", "result_parsed", "result_candidate_committed", "verification_completed", "result_verified", "result_committed", "completed"];

function workflowPhaseAtLeast(current: WorkflowNodePhase, expected: WorkflowNodePhase) {
  return WORKFLOW_PHASE_ORDER.indexOf(current) >= WORKFLOW_PHASE_ORDER.indexOf(expected);
}

function atomicWriteWorkflowCheckpoint(target: string, content: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, target);
}

function writeSnapshotCheckpoint(target: string, snapshot: Map<string, string>) {
  atomicWriteWorkflowCheckpoint(target, JSON.stringify([...snapshot.entries()]));
}

function readSnapshotCheckpoint(target: string) {
  const entries = JSON.parse(fs.readFileSync(target, "utf8")) as Array<[string, string]>;
  return new Map(entries);
}

function workflowResultDigest(result: WorkflowNodeResult) {
  return crypto.createHash("sha256").update(JSON.stringify({ outputs: result.outputs, decisions: result.decisions, handoff: result.handoff, checks: result.checks })).digest("hex");
}

async function runBuiltinWorkflowNode(workflowId: string, ownerUserId: string, nodeId: string, controller: AbortController, attempt: WorkflowNodeAttemptRecord, runnerId: string) {
  const workflow = workflowRepository.get(workflowId, ownerUserId);
  if (!workflow) throw new Error("工作流不存在");
  const current = workflow.nodes.find((item) => item.id === nodeId); if (!current) throw new Error("工作流节点不存在");
  const workspace = workspaceById(workflow.workspaceId, workflow.ownerUserId); if (!workspace) throw new Error("工作区不存在");
  attempt = { ...attempt, checkpointDirectory: workflowStateFiles.checkpointDirectory(workflow, attempt.checkpointDirectory) };
  fs.mkdirSync(attempt.checkpointDirectory, { recursive: true });
  const beforeSnapshotPath = path.join(attempt.checkpointDirectory, "before-snapshot.json");
  const rawOutputPath = path.join(attempt.checkpointDirectory, "raw-output.txt");
  const resultTransactionPath = path.join(attempt.checkpointDirectory, "result-transaction.json");
  const runtimeDirectory = path.join(pluginRuntimeDirectory, "node-runtime", crypto.createHash("sha256").update(`${workflowId}:${current.planVersion}:${nodeId}:${attempt.attempt}`).digest("hex"));
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const leaseUntil = () => new Date(Date.now() + 60_000).toISOString();
  const renewLease = () => workflowRepository.renewNodeLease(current.recordId, attempt.id, runnerId, leaseUntil());
  let beforeSnapshot: Map<string, string>;
  let structured: WorkflowNodeResult;
  let systemDerivedResult = false;
  let preserveBusinessArtifacts = false;
  const executionRunId = `node-run-${crypto.randomUUID()}`;
  const logContext: WorkflowLogContext = { attempt: attempt.attempt, runId: executionRunId, contextId: attempt.engineThreadId };
  const attemptLog = (kind: WorkflowNodeLog["kind"], title: string, text: string, id?: string, context: WorkflowLogContext = {}) => workflowLog(kind, title, text, id, { ...logContext, ...context });
  // Engine streams can emit many partial assistant/tool-progress events per second.
  // Coalesce only the database refresh; durable protocol events and terminal states
  // remain immediate so reconnect/recovery never observes stale execution state.
  let nodePersistTimer: NodeJS.Timeout | null = null;
  let nodePersistPending = false;
  const persistNodeState = (immediate = false) => {
    if (immediate) {
      if (nodePersistTimer) clearTimeout(nodePersistTimer);
      nodePersistTimer = null;
      nodePersistPending = false;
      workflowRepository.updateNode(current);
      renewLease();
      return;
    }
    if (nodePersistPending) return;
    nodePersistPending = true;
    nodePersistTimer = setTimeout(() => {
      nodePersistTimer = null;
      nodePersistPending = false;
      workflowRepository.updateNode(current);
      renewLease();
    }, 250);
  };
  const flushNodeState = () => persistNodeState(true);

  const taskContract = workflowNodeTaskContract(workflow, current);
  const resultContract: WorkflowNodeResultContract = {
    schemaVersion: 1,
    workflowId,
    planVersion: current.planVersion,
    nodeRecordId: current.recordId,
    nodeId,
    attemptId: attempt.id,
    attempt: attempt.attempt,
    contractDigest: workflowNodeContractDigest(current),
    idempotencyKey: current.idempotencyKey || `${workflowId}:${current.planVersion}:${nodeId}:${attempt.attempt}`,
    taskContract,
    downstreamNodeIds: workflow.nodes.filter((item) => item.dependsOn.includes(nodeId)).map((item) => item.id),
    requireSelfReview: true
  };
  const { resumed: resultTransactionResumed } = openWorkflowNodeResultTransaction(resultTransactionPath, resultContract);
  if (!workflowPhaseAtLeast(attempt.phase, "agent_running")) attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { phase: "result_draft_started", leaseExpiresAt: leaseUntil() });

  const resultFromTransactionOrLegacy = async (finalText: string, engineError?: unknown) => {
    let transactionError: unknown;
    try {
      let transaction = readWorkflowNodeResultTransaction(resultTransactionPath);
      if (transaction.status !== "committed") {
        const validation = validateWorkflowNodeResultTransaction(resultTransactionPath);
        if (validation.valid) transaction = commitWorkflowNodeResultTransaction(resultTransactionPath);
        else throw new Error(validation.errors.join("；") || "机器结果草稿未完成");
      }
      current.logs.push(attemptLog("status", resultTransactionResumed ? "恢复机器交接" : "机器交接已提交", `结果事务 ${transaction.transactionId}`));
      workflowRepository.updateNode(current);
      return transaction.draftResult;
    } catch (error) { transactionError = error; }
    if (finalText.trim()) {
      try {
        const legacy = parseWorkflowNodeResult(finalText);
        current.logs.push(attemptLog("status", "兼容旧版机器交接", "结果事务不可用，已从旧版最终回复恢复结构化结果"));
        workflowRepository.updateNode(current);
        return legacy;
      } catch { /* New agents no longer return machine JSON in chat. */ }
    }
    systemDerivedResult = true;
    const reasons = [
      `机器结果事务未完成：${transactionError instanceof Error ? transactionError.message : String(transactionError)}`,
      engineError ? `Agent 结束异常：${engineError instanceof Error ? engineError.message : String(engineError)}` : "Agent 没有提交可验证的机器结果"
    ];
    return {
      ...workflowFailureResult(reasons.join("；"), "failed"),
      outcome: "partial" as const,
      humanSummary: "业务执行已经结束，但机器交接不完整；Workbench 将保留并核对真实文件，不虚构缺失结论。"
    };
  };

  const repairResultTransaction = async (initialReasons: string[]) => {
    let reasons = initialReasons;
    const maximumRepairs = 2;
    while (attempt.resultRepairCount < maximumRepairs) {
      reopenWorkflowNodeResultTransaction(resultTransactionPath, reasons);
      const repairNumber = attempt.resultRepairCount + 1;
      current.logs.push(attemptLog("status", "自动修复机器交接", `第 ${repairNumber}/${maximumRepairs} 次，仅修正结果合同，不重新执行业务任务`));
      workflowRepository.updateNode(current);
      const repairPrompt = [
        "你正在修复当前节点已经完成的机器交接，不得重新执行业务任务、修改业务文件、启动子 Agent 或扩大任务范围。",
        "先调用 workflow_read_node_contract 和 workflow_read_result_draft，保留已有真实输出、检查、决策和 handoff，只修正下列门禁问题：",
        reasons.map((reason) => `- ${reason}`).join("\n"),
        "文件类 output 必须引用真实存在的路径；没有文件的逻辑结论改用 text 或 decision。consumableBy 只能引用合同中的下游节点。",
        "修正完成后重新执行六项 workflow_self_review_result，再调用 workflow_validate_result；只有校验 valid=true 后才能 workflow_commit_result。",
        "最终自然语言回复只需简述修正内容，不要输出机器 JSON。"
      ].join("\n\n");
      const resultServer = workflowNodeResultToolServer(resultTransactionPath);
      try {
        if (workflowExecutionProvider(current) === "codex") {
          await assertCodexWorkflowControlPlane(resultServer, workflow.workDirectory, "result");
          const codex = buildCodex(getState().settings, undefined, true, workspace, [], [resultServer]);
          const workflowWorkspace = { ...workspace, root: workflow.workDirectory };
          const repairOptions = { ...delegatedThreadOptions(workflowWorkspace, getState().settings), sandboxMode: "read-only" as const };
          const terminal = await runCodexSessionTurn({
            createThread: () => codex.startThread(repairOptions),
            prompt: `${repairPrompt}\n\n${codexWorkflowResultToolInstructions()}`,
            signal: controller.signal,
            missingCompletionMessage: "Codex 未完成机器交接修复",
            terminalReason: "Codex 机器交接修复已到达终态",
            onEvent: (event) => {
              const text = summarizeCodexEvent(event);
              const normalized = normalizedCodexWorkflowEvent(event, text);
              if (normalized) { if (normalized.type === "turn.completed") markCodexTransientLogsRecovered(current.logs); upsertWorkflowLog(current.logs, workflowLogFromEngineEvent(normalized, `codex:${executionRunId}:repair:${repairNumber}`, { ...logContext, contextId: event.type === "thread.started" ? event.thread_id : null })); }
              workflowRepository.updateNode(current); renewLease();
            },
            isDurableResultCommitted: () => { try { return readWorkflowNodeResultTransaction(resultTransactionPath).status === "committed"; } catch { return false; } },
          });
          if (terminal.forcedByDurableResult) current.logs.push(attemptLog("status", "服务器接管终态", "机器结果已提交，但 Codex 事件流未及时关闭；Workbench 已结束等待并继续验收"));
          const failure = codexTurnFailure(terminal, terminal.lastError, "Codex 未完成机器交接修复");
          if (failure) throw new Error(failure);
        } else {
          const repairMcpConfig = await workflowNodeMcpConfigPath(workspace, [], [resultServer]);
          const repairTurn = await runClaudeSessionTurn({
            createHandle: (resumeSessionId) => createWorkflowClaudeHandle({
              cwd: workflow.workDirectory, sessionId: resumeSessionId, mcpConfigPath: repairMcpConfig, permissionMode: "plan",
              allowedTools: [...CLAUDE_WORKFLOW_READ_TOOLS, ...claudeMcpAllowedTools([resultServer])],
              disallowedTools: [...CLAUDE_WORKFLOW_READ_ONLY_DISALLOWED_TOOLS], signal: controller.signal,
              ownerId: `${workflowId}:${nodeId}:result-repair`,
              onEvent: (event) => { if (event.text) upsertWorkflowLog(current.logs, workflowLogFromEngineEvent(event, `claude:${executionRunId}:repair:${repairNumber}`, logContext)); workflowRepository.updateNode(current); renewLease(); }
            }),
            prompt: repairPrompt, recoveryAttempts: 2, signal: controller.signal
          });
          if (repairTurn.result.failed) throw new Error(repairTurn.result.error || "Claude 未完成机器交接修复");
        }
      } catch (error) {
        reasons = [`结果修复 Agent 异常：${error instanceof Error ? error.message : String(error)}`];
      }
      attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { resultRepairCount: repairNumber, leaseExpiresAt: leaseUntil() });
      try {
        let transaction = readWorkflowNodeResultTransaction(resultTransactionPath);
        if (transaction.status === "committed") {
          current.logs.push(attemptLog("status", "机器交接修复完成", `结果事务 ${transaction.transactionId} 已重新封存`));
          workflowRepository.updateNode(current);
          return transaction.draftResult;
        }
        const validation = validateWorkflowNodeResultTransaction(resultTransactionPath);
        if (validation.valid) {
          transaction = commitWorkflowNodeResultTransaction(resultTransactionPath);
          current.logs.push(attemptLog("status", "机器交接修复完成", `结果事务 ${transaction.transactionId} 已重新封存`));
          workflowRepository.updateNode(current);
          return transaction.draftResult;
        }
        reasons = validation.errors;
      } catch (error) {
        reasons = [error instanceof Error ? error.message : String(error)];
      }
    }
    throw new Error(`机器交接自动修复未通过：${reasons.join("；")}`);
  };

  if (!workflowPhaseAtLeast(attempt.phase, "agent_output_received") && !workflowPhaseAtLeast(attempt.phase, "result_parsed")) {
    try {
      beforeSnapshot = await captureWorkspaceSnapshot(workflow.workDirectory);
      writeSnapshotCheckpoint(beforeSnapshotPath, beforeSnapshot);
      if (attempt.snapshotRetryCount) attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { snapshotRetryCount: 0, leaseExpiresAt: leaseUntil() });
    } catch (error) {
      const detail = `执行前工作区快照失败：${error instanceof Error ? error.message : String(error)}`;
      const snapshotRetryCount = attempt.snapshotRetryCount + 1;
      attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { snapshotRetryCount, leaseExpiresAt: leaseUntil() });
      current.logs.push(attemptLog("error", "工作区快照暂时失败", `${detail}；${snapshotRetryCount <= 2 ? "将只重试快照阶段" : "已停止自动重试"}`));
      workflowRepository.updateNode(current);
      if (snapshotRetryCount <= 2) throw new WorkflowNodeStageRetryError("snapshot", detail);
      throw new WorkflowNodeOutcomeError(persistWorkflowNodeResult(workflow, current, workspace, workflowFailureResult(detail)), false);
    }
    attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { phase: "agent_running", leaseExpiresAt: leaseUntil() });
    const prompt = workflowNodePrompt(workflow, current, workspace, runtimeDirectory); let finalText = "";
    if (current.summary) {
      current.summary = null;
      current.logs.push(attemptLog("status", "开始新的执行尝试", "上一尝试结果仅保留在历史记录中，不参与本次终态判断"));
    }
    current.logs.push(attemptLog("status", "开始执行", `${current.provider === "auto" ? "自动选择" : current.provider} · 第 ${current.attempt} 次尝试`));
    workflowRepository.updateNode(current);
    const resolvedMcpServers = mcpServersForNode(workspace, current.mcpServers);
    if (current.mcpRequired && resolvedMcpServers.length !== current.mcpServers.length) {
      structured = workflowFailureResult(`节点必需的 MCP 当前不可用：${current.mcpServers.join(", ")}`, "blocked");
      attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { phase: "result_parsed", parsedResult: structured, leaseExpiresAt: leaseUntil() });
    } else {
      let engineError: unknown;
      try {
        if (workflowExecutionProvider(current) === "codex") {
          const resultServer = workflowNodeResultToolServer(resultTransactionPath);
          await assertCodexWorkflowControlPlane(resultServer, workflow.workDirectory, "result");
          const codex = buildCodex(getState().settings, undefined, true, workspace, current.mcpServers, [resultServer]);
          const workflowWorkspace = { ...workspace, root: workflow.workDirectory };
          const threadOptions = { ...delegatedThreadOptions(workflowWorkspace, getState().settings), sandboxMode: current.workspaceAccess === "write" ? "danger-full-access" as const : "read-only" as const };
          const previousThreadId = current.engineThreadId;
          const contextStrategy = workflowCodexContextStrategy(current);
          current.contextRecoveryMode = contextStrategy.mode;
          current.contextRecoveryCount = contextStrategy.recoveryCount;
          if (contextStrategy.mode === "resumed") {
            current.logs.push(attemptLog("status", "恢复原上下文", `继续 Codex Thread ${contextStrategy.threadId}；保留原会话记录并核对已有文件与检查点`, undefined, { contextId: contextStrategy.threadId }));
          } else if (previousThreadId) {
            current.engineThreadId = null;
            current.logs.push(attemptLog("status", "降级到新上下文", "原 Codex Thread 已完成有限恢复尝试；创建干净上下文并从持久化任务合同、文件和检查点继续"));
          }
          workflowRepository.updateNode(current);
          attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { engineThreadId: current.engineThreadId, contextRecoveryCount: current.contextRecoveryCount, contextRecoveryMode: current.contextRecoveryMode, leaseExpiresAt: leaseUntil() });
          const recoveryPrompt = contextStrategy.mode === "resumed"
            ? `这是连接中断后的恢复回合。延续本 Thread 中已经完成的工作，先检查工作区已有文件和节点结果事务；不要重复已验证步骤，也不要把上一次准备执行但未完成的动作视为已完成。\n\n${prompt}`
            : prompt;
          const terminal = await runCodexSessionTurn({
            createThread: (threadId) => threadId ? codex.resumeThread(threadId, threadOptions) : codex.startThread(threadOptions),
            threadId: contextStrategy.threadId,
            prompt: `${recoveryPrompt}\n\n${codexWorkflowResultToolInstructions()}`,
            signal: controller.signal,
            missingCompletionMessage: "Codex 节点未返回完成状态",
            terminalReason: "Codex 节点已到达终态",
            onThreadId: (threadId) => {
              current.engineThreadId = threadId;
              attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { engineThreadId: threadId, contextRecoveryCount: current.contextRecoveryCount, contextRecoveryMode: current.contextRecoveryMode, leaseExpiresAt: leaseUntil() });
              workflowRepository.updateNode(current); renewLease();
            },
            onEvent: (event) => {
              const text = summarizeCodexEvent(event);
              if (event.type === "thread.started") {
              current.engineThreadId = event.thread_id;
              }
              if (event.type === "item.completed" && event.item.type === "agent_message") finalText = text;
              const normalized = event.type === "thread.started" && contextStrategy.mode === "resumed"
                ? { type: "status" as const, sourceId: `thread-resumed:${event.thread_id}`, text: "原上下文已恢复", payload: event }
                : normalizedCodexWorkflowEvent(event, text);
              if (normalized) { if (normalized.type === "turn.completed") markCodexTransientLogsRecovered(current.logs); upsertWorkflowLog(current.logs, workflowLogFromEngineEvent(normalized, `codex:${executionRunId}:main`, { ...logContext, contextId: current.engineThreadId })); }
              if (normalized) appendWorkflowProtocolEvent(workflowId, ownerUserId, "node.engine_event", { type: normalized.type, sourceId: normalized.sourceId, toolName: normalized.toolName, text: normalized.text }, nodeId, current.attempt);
              workflowRepository.updateNode(current); renewLease();
            },
            isDurableResultCommitted: () => { try { return readWorkflowNodeResultTransaction(resultTransactionPath).status === "committed"; } catch { return false; } },
          });
          if (terminal.forcedByDurableResult) {
            current.logs.push(attemptLog("status", "服务器接管终态", "机器结果已提交，但 Codex 事件流未及时关闭；Workbench 已结束等待并继续系统验收"));
            workflowRepository.updateNode(current);
          }
          const failure = codexTurnFailure(terminal, terminal.lastError, "Codex 节点未返回完成状态");
          if (failure) throw new Error(failure);
        } else {
          const resultServer = workflowNodeResultToolServer(resultTransactionPath);
          const nodeMcpConfig = await workflowNodeMcpConfigPath(workspace, current.mcpServers, [resultServer]);
          const claudeTurn = await runClaudeSessionTurn({
            createHandle: (resumeSessionId) => createWorkflowClaudeHandle({
              cwd: workflow.workDirectory, sessionId: resumeSessionId, mcpConfigPath: nodeMcpConfig,
              permissionMode: current.workspaceAccess === "write" ? "bypassPermissions" : "plan",
              allowedTools: current.workspaceAccess === "read" ? [...CLAUDE_WORKFLOW_READ_TOOLS, ...claudeMcpAllowedTools([...resolvedMcpServers, resultServer])] : undefined,
              disallowedTools: current.workspaceAccess === "read" ? [...CLAUDE_WORKFLOW_READ_ONLY_DISALLOWED_TOOLS] : undefined,
              signal: controller.signal, ownerId: `${workflowId}:${nodeId}`,
              onEvent: (event) => {
                if (event.type === "assistant") finalText = event.text;
                if (event.text) upsertWorkflowLog(current.logs, workflowLogFromEngineEvent(event, `claude:${executionRunId}:main`, { ...logContext, contextId: current.engineThreadId }));
                if (event.text) appendWorkflowProtocolEvent(workflowId, ownerUserId, "node.engine_event", { type: event.type, sourceId: event.sourceId, toolName: event.toolName, text: event.text }, nodeId, current.attempt);
                workflowRepository.updateNode(current); renewLease();
              }
            }),
            sessionId: current.engineThreadId,
            prompt,
            recoveryAttempts: 2,
            mode: "worker",
            signal: controller.signal,
            onSessionId: (id) => {
              current.engineThreadId = id;
              current.contextRecoveryMode = attempt.engineThreadId ? "resumed" : "fresh";
              attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { engineThreadId: id, contextRecoveryCount: current.contextRecoveryCount, contextRecoveryMode: current.contextRecoveryMode, leaseExpiresAt: leaseUntil() });
              workflowRepository.updateNode(current);
            },
            onRecovery: ({ attempt: reconnectAttempt, maxAttempts, reason, transport }) => {
              current.contextRecoveryCount += 1;
              current.contextRecoveryMode = "resumed";
              attempt = workflowRepository.checkpointNodeAttempt(attempt.id, {
                engineThreadId: current.engineThreadId,
                contextRecoveryCount: current.contextRecoveryCount,
                contextRecoveryMode: current.contextRecoveryMode,
                leaseExpiresAt: leaseUntil()
              });
              current.logs.push(attemptLog("status", transport ? "Claude 连接恢复" : "Claude 上下文续跑", `沿用原会话自动恢复（${reconnectAttempt}/${maxAttempts}）：${reason}`));
              workflowRepository.updateNode(current); renewLease();
            }
          });
          if (claudeTurn.result.failed) throw new Error(claudeTurn.result.error || "Claude 节点未返回完整结果");
        }
      } catch (error) {
        engineError = error;
        if (!(controller.signal.aborted && !timeoutReason(controller.signal))) {
          current.logs.push(attemptLog("error", "Agent 结束异常", error instanceof Error ? error.message : String(error)));
        }
        workflowRepository.updateNode(current);
      }
      if (engineError) {
        let committedResultAvailable = false;
        try {
          let transaction = readWorkflowNodeResultTransaction(resultTransactionPath);
          if (transaction.status === "editing") {
            const validation = validateWorkflowNodeResultTransaction(resultTransactionPath);
            if (validation.valid) transaction = commitWorkflowNodeResultTransaction(resultTransactionPath);
          }
          committedResultAvailable = transaction.status === "validated" || transaction.status === "committed";
          if (committedResultAvailable) {
            current.logs.push(attemptLog("status", "服务器接管机器交接", "Agent 连接中断，但完整结果草稿已由 Workbench 校验并封存"));
            workflowRepository.updateNode(current);
          }
        } catch { /* The engine error remains authoritative when no durable result exists. */ }
        if (!committedResultAvailable) throw engineError;
      }
      try {
        atomicWriteWorkflowCheckpoint(rawOutputPath, finalText);
        attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { phase: "agent_output_received", rawOutput: finalText, leaseExpiresAt: leaseUntil() });
        structured = await resultFromTransactionOrLegacy(finalText, engineError);
        attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { phase: "result_candidate_committed", parsedResult: structured, leaseExpiresAt: leaseUntil() });
      } catch (error) {
        if (engineError) throw engineError;
        throw error;
      }
    }
  } else {
    beforeSnapshot = readSnapshotCheckpoint(beforeSnapshotPath);
    if (attempt.parsedResult) structured = attempt.parsedResult;
    else {
      const raw = attempt.rawOutput ?? (fs.existsSync(rawOutputPath) ? fs.readFileSync(rawOutputPath, "utf8") : "");
      structured = await resultFromTransactionOrLegacy(raw);
      attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { phase: "result_candidate_committed", parsedResult: structured, leaseExpiresAt: leaseUntil() });
    }
  }

  if (structured.outcome !== "completed" && attempt.resultRepairCount < 2 && fs.existsSync(resultTransactionPath)) {
    try {
      const transaction = readWorkflowNodeResultTransaction(resultTransactionPath);
      if (transaction.status !== "committed") {
        const validation = validateWorkflowNodeResultTransaction(resultTransactionPath);
        const reasons = validation.errors.length ? validation.errors : structured.unresolved;
        structured = await repairResultTransaction(reasons);
        systemDerivedResult = false;
        attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { phase: "result_candidate_committed", parsedResult: structured, leaseExpiresAt: leaseUntil() });
      }
    } catch (error) {
      current.logs.push(attemptLog("error", "机器交接修复未完成", error instanceof Error ? error.message : String(error)));
      workflowRepository.updateNode(current);
    }
  }

  if (!workflowPhaseAtLeast(attempt.phase, "verification_completed")) {
    if (structured.outcome === "completed" && current.verificationCommands.length) {
      current.logs.push(attemptLog("status", "开始系统验收", `${current.verificationCommands.length} 条受控命令`));
      workflowRepository.updateNode(current);
      const systemChecks = await runVerificationCommands(current.verificationCommands, workflow.workDirectory, controller.signal, `workflow:${workflowId}:${nodeId}:verify`);
      const verificationRunCount = attempt.verificationRunCount + 1;
      for (const check of systemChecks) current.logs.push(attemptLog(check.status === "failed" ? "error" : "status", `系统验收 · ${check.status}`, check.command || check.name));
      current.logs = current.logs.slice(-300); workflowRepository.updateNode(current);
      if (systemChecks.some((check) => check.status === "failed") && verificationRunCount < 2) {
        attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { phase: "result_parsed", parsedResult: structured, verificationRunCount, leaseExpiresAt: leaseUntil() });
        throw new WorkflowNodeStageRetryError("verification", "系统验收未通过，将只重跑验收命令，不重新执行 Agent");
      }
      structured = { ...structured, checks: [...structured.checks, ...systemChecks] };
      attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { verificationRunCount, leaseExpiresAt: leaseUntil() });
    }
    attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { phase: "verification_completed", parsedResult: structured, leaseExpiresAt: leaseUntil() });
  } else structured = attempt.parsedResult || structured;

  let resultToPersist: WorkflowNodeResult;
  let records: Array<{ path: string; kind: string; hash: string | null; summary: string }> = [];
  if (workflowPhaseAtLeast(attempt.phase, "result_verified") && attempt.verifiedResult) {
    resultToPersist = attempt.verifiedResult;
    if (!workflowPhaseAtLeast(attempt.phase, "result_committed")) records = verifyWorkflowNodeResult(workflow, current, workspace, resultToPersist, resultToPersist.changedFiles, []).records;
  }
  else {
    let afterSnapshot = beforeSnapshot;
    try { afterSnapshot = await captureWorkspaceSnapshot(workflow.workDirectory); }
    catch (error) {
      const detail = `执行后工作区快照失败：${error instanceof Error ? error.message : String(error)}`;
      const snapshotRetryCount = attempt.snapshotRetryCount + 1;
      attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { phase: "verification_completed", parsedResult: structured, snapshotRetryCount, leaseExpiresAt: leaseUntil() });
      current.logs.push(attemptLog("error", "工作区快照暂时失败", `${detail}；已保留机器结果，${snapshotRetryCount <= 2 ? "将只重试快照与文件验收" : "已停止自动重试"}`));
      workflowRepository.updateNode(current);
      if (snapshotRetryCount <= 2) throw new WorkflowNodeStageRetryError("snapshot", detail);
      preserveBusinessArtifacts = true;
      structured = { ...structured, outcome: "partial", unresolved: [...structured.unresolved, detail] };
    }
    const observedChangedFiles = changedWorkspaceFiles(beforeSnapshot, afterSnapshot);
    const currentStartedAt = Date.parse(current.startedAt || "");
    const overlappingWriterScopes = (workflowRepository.get(workflowId, ownerUserId)?.nodes || [])
      .filter((item) => item.id !== current.id && item.workspaceAccess === "write" && item.startedAt && (!item.finishedAt || !Number.isFinite(currentStartedAt) || Date.parse(item.finishedAt) >= currentStartedAt))
      .flatMap((item) => workflowAuthorizedWriteScopes(item.writeScope));
    const concurrentWriterChanges = overlappingWriterScopes.length ? new Set(observedChangedFiles.filter((file) => filesOutsideWriteScope([file], overlappingWriterScopes, workflow.workDirectory, workflow.workDirectory).length === 0)) : new Set<string>();
    const actualChangedFiles = observedChangedFiles.filter((file) => !concurrentWriterChanges.has(file));
    if (systemDerivedResult && actualChangedFiles.length) {
      preserveBusinessArtifacts = true;
      structured = {
        ...structured,
        outputs: actualChangedFiles.map((file, index) => ({ id: `system-observed-${index + 1}`, type: "file" as const, path: file, mediaType: null, description: "Workbench 检测到的真实文件变更；Agent 未完成语义登记", consumableBy: [] })),
        warnings: [...structured.warnings, "这些输出由文件快照推导，只证明文件发生变化，不代表业务验收通过。"]
      };
    }
    const authorizedWriteScopes = workflowAuthorizedWriteScopes(current.writeScope);
    const outsideWriteScope = current.workspaceAccess === "write" ? filesOutsideWriteScope(actualChangedFiles, authorizedWriteScopes, workflow.workDirectory, workflow.workDirectory) : actualChangedFiles;
    const writeManifestPath = path.join(attempt.checkpointDirectory, "write-manifest.json");
    if (!fs.existsSync(writeManifestPath)) atomicWriteWorkflowCheckpoint(writeManifestPath, JSON.stringify({ schemaVersion: 1, workflowId, nodeId, attempt: attempt.attempt, capturedAt: new Date().toISOString(), changedFiles: actualChangedFiles, concurrentWriterChanges: [...concurrentWriterChanges], outsideWriteScope }, null, 2));
    let verified = verifyWorkflowNodeResult(workflow, current, workspace, structured, actualChangedFiles, outsideWriteScope);
    if (verified.result.outcome === "partial" && !outsideWriteScope.length && attempt.resultRepairCount < 2 && fs.existsSync(resultTransactionPath)) {
      try {
        structured = await repairResultTransaction(verified.result.unresolved);
        verified = verifyWorkflowNodeResult(workflow, current, workspace, structured, actualChangedFiles, outsideWriteScope);
      } catch (error) {
        current.logs.push(attemptLog("error", "终态交接修复未完成", error instanceof Error ? error.message : String(error)));
        workflowRepository.updateNode(current);
      }
    }
    resultToPersist = verified.result; records = verified.records;
    attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { phase: "result_verified", verifiedResult: resultToPersist, leaseExpiresAt: leaseUntil() });
  }
  const digest = workflowResultDigest(resultToPersist);
  if (!workflowPhaseAtLeast(attempt.phase, "result_committed")) {
    try { workflowRepository.replaceNodeArtifacts(workflow.id, current.recordId, records, current.attempt, digest); }
    catch (error) { resultToPersist = { ...resultToPersist, outcome: "partial", unresolved: [...resultToPersist.unresolved, `产物索引持久化失败：${error instanceof Error ? error.message : String(error)}`] }; }
  }
  const persisted = persistWorkflowNodeResult(workflow, current, workspace, resultToPersist);
  attempt = workflowRepository.checkpointNodeAttempt(attempt.id, { phase: "result_committed", verifiedResult: persisted, leaseExpiresAt: leaseUntil() });
  current.summary = persisted;
  workflowRepository.updateNode(current);
  syncWorkflowProtocolFiles(workflowId, ownerUserId);
  appendWorkflowProtocolEvent(workflowId, ownerUserId, "node.result_committed", { outcome: persisted.outcome, resultDigest: workflowResultDigest(persisted) }, nodeId, current.attempt);
  if (persisted.outcome !== "completed") throw new WorkflowNodeOutcomeError(persisted, !preserveBusinessArtifacts);
  return persisted;
}

function executeWorkflowNode(...args: Parameters<WorkflowWorkerRunner>): ReturnType<WorkflowWorkerRunner> {
  const workflow = workflowRepository.get(args[0], args[1]);
  const node = workflow?.nodes.find((item) => item.id === args[2]);
  if (!workflow || !node) throw new Error("工作流节点不存在");
  const provider = workflowExecutionProvider(node);
  const runner = agentAdapterRegistry.workflowWorkerRunner(provider);
  if (!runner) throw new Error(`Provider「${provider}」尚未绑定工作流节点 Runner`);
  return runner(...args);
}

async function runWorkflowTextAgent(
  engine: WorkflowEngine,
  prompt: string,
  workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>,
  workspace: Workspace,
  controller: AbortController,
  ownerId: string,
  onEvent: (event: NormalizedEngineEvent) => void
) {
  let finalText = "";
  if (engine === "claude") {
    const turn = await runClaudeSessionTurn({
      createHandle: (sessionId) => createWorkflowClaudeHandle({
        cwd: workflow.workDirectory, sessionId, permissionMode: "default",
        allowedTools: [...CLAUDE_WORKFLOW_READ_TOOLS], disallowedTools: [...CLAUDE_WORKFLOW_READ_ONLY_DISALLOWED_TOOLS],
        signal: controller.signal, ownerId,
        onEvent: (event) => { if (event.type === "assistant") finalText = event.text; onEvent(event); }
      }),
      prompt, recoveryAttempts: 2, mode: "validator", signal: controller.signal
    });
    if (turn.result.failed) throw new Error(turn.result.error || "Claude 工作流 Agent 未返回完整结果");
    return finalText;
  }
  if (!getState().settings.apiKey) throw new Error("请先配置 Codex / OpenAI API Key");
  const codex = buildCodex(getState().settings, undefined, true);
  const workflowWorkspace = { ...workspace, root: workflow.workDirectory };
  const thread = codex.startThread({ ...threadOptions(workflowWorkspace, getState().settings), sandboxMode: "read-only", approvalPolicy: "never" });
  const streamController = new AbortController();
  const { events } = await thread.runStreamed(prompt, { signal: AbortSignal.any([controller.signal, streamController.signal]) });
  const terminal = await consumeCodexTurnEvents(events, (event) => {
    const text = summarizeCodexEvent(event);
    if (event.type === "item.completed" && event.item.type === "agent_message") finalText = text;
    const normalized = normalizedCodexWorkflowEvent(event, text);
    if (normalized) onEvent(normalized);
  }, { onTerminal: () => streamController.abort(new Error("Codex 工作流 Agent 已到达终态")) });
  const failure = codexTurnFailure(terminal, terminal.lastError, "Codex 工作流 Agent 未返回完成状态");
  if (failure) throw new Error(failure);
  return finalText;
}

function workflowResultContractPrompt() {
  return [
    "最终回复只能包含一个 JSON 对象，不要 Markdown 或额外说明。",
    '{"outcome":"completed|partial|blocked|failed","humanSummary":"面向用户的摘要","outputs":[{"id":"稳定输出ID","type":"file|directory|document|data|code|text|decision|other","path":null,"mediaType":null,"description":"用途与内容","consumableBy":[]}],"changedFiles":[],"checks":[{"name":"检查名称","command":null,"status":"passed|failed|not_run","exitCode":null,"evidence":"可复核证据"}],"decisions":[{"key":"决策键","value":"决策值","reason":"决策理由"}],"handoff":{"facts":[],"constraints":[],"nextAgentInstructions":[]},"warnings":[],"unresolved":[]}',
    "只登记真实存在的产物和实际检查；不得把计划、猜测或未执行动作描述为已完成。"
  ].join("\n");
}

function integrationSource(workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>) {
  const verifiedResults = verifiedWorkflowNodeResults(workflow);
  return workflow.nodes.map((node) => {
    const result = verifiedResults.get(node.id);
    return ({
    id: node.id,
    title: node.title,
    objective: node.objective,
    required: node.required,
    dependsOn: node.dependsOn,
    acceptance: node.acceptance,
    outcome: result?.outcome || node.status,
    humanSummary: result?.humanSummary || "",
    outputs: result?.outputs || [],
    changedFiles: result?.changedFiles || [],
    checks: result?.checks || [],
    decisions: result?.decisions || [],
    handoff: result?.handoff || { facts: [], constraints: [], nextAgentInstructions: [] },
    warnings: result?.warnings || [],
    unresolved: result?.unresolved || [],
    machineResultPath: result?.machineResultPath || null
  });
  });
}

function workflowIntegratorPrompt(workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>) {
  return [
    "你是任务编排工作流的最终 Integrator Agent。你不是执行节点，不得启动子 Agent，也不得修改工作区文件。",
    "这是非交互式后台整合任务：不要进入 Plan Mode，不要写计划文件，不要调用 ExitPlanMode；读取必要信息后直接返回最终 JSON。",
    `整合协议：\n${WORKFLOW_ROLE_SKILLS.integrator}`,
    `原始用户目标：\n${workflow.originalPrompt}`,
    `已审批计划：\n${JSON.stringify(workflow.plan, null, 2)}`,
    `已验证节点结果：\n${JSON.stringify(integrationSource(workflow), null, 2)}`,
    "请综合所有节点成果形成一份自洽、去重、无冲突的最终答复。outputs 必须优先引用计划 finalDelivery 指定且已由生产节点创建的用户文件；也可以引用其他已存在节点产物或使用 path=null 的 text/decision 输出，但不得宣称创建新文件。",
    "必须检查原始目标覆盖情况、跨节点矛盾、缺失结果和未解决风险。存在实质缺口时返回 partial/blocked/failed，不得返回 completed。",
    workflowResultContractPrompt()
  ].join("\n\n");
}

function workflowValidatorPrompt(workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>, candidate: WorkflowNodeResult) {
  return [
    "你是任务编排工作流的独立 Validator Agent。你只能审查，不得修改文件、重写计划或启动子 Agent。",
    "这是非交互式后台验收任务：不要进入 Plan Mode，不要写计划文件，不要调用 ExitPlanMode；完成只读审查后直接返回最终 JSON。",
    `验收协议：\n${WORKFLOW_ROLE_SKILLS.validator}`,
    `原始用户目标：\n${workflow.originalPrompt}`,
    `已审批计划：\n${JSON.stringify(workflow.plan, null, 2)}`,
    `节点结果：\n${JSON.stringify(integrationSource(workflow), null, 2)}`,
    `Integrator 候选结果：\n${JSON.stringify(candidate, null, 2)}`,
    "用户任务中的“禁止 MCP”只约束可选业务 MCP。workbench-workflow-result 与 workbench-workflow-plan 是 Workbench 系统控制面，用于机器交接和规划事务，不属于业务 MCP；不得因这些控制面工具调用判定业务约束违规。",
    "系统已经完成任务目录边界、writeScope、文件存在性和节点结果事务校验。优先复用上面的结构化结果与 checks；除非节点结果明确报告边界异常，否则不要扫描插件内部事件文件、Codex/Claude 会话日志或父工作区来重新推断执行轨迹。",
    "如确需读取产物，最多执行一次合并的只读验收命令，并在一次命令中完成所需文件检查；不要重复读取已通过的文件或执行同义检查。",
    "逐项检查目标覆盖、必需节点、真实产物、检查证据、跨节点一致性和未解决事项。全部通过才返回 outcome=completed；否则返回 failed，并在 unresolved 中列出可操作原因。",
    "你的 outputs 和 changedFiles 必须为空；checks 用于记录本次最终验收依据。",
    workflowResultContractPrompt()
  ].join("\n\n");
}

function systemValidateIntegratedResult(workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>, workspace: Workspace, result: WorkflowNodeResult) {
  const issues: string[] = [];
  if (result.outcome !== "completed") issues.push(...(result.unresolved.length ? result.unresolved : ["Integrator 未报告完整完成"]));
  if (result.unresolved.length) issues.push(...result.unresolved);
  const failedChecks = result.checks.filter((check) => check.status === "failed");
  if (failedChecks.length) issues.push(`整合结果包含失败检查：${failedChecks.map((check) => check.name).join(", ")}`);
  for (const output of result.outputs) {
    if (["file", "directory", "document", "data", "code"].includes(output.type) && !output.path) issues.push(`最终产物 ${output.id} 缺少路径`);
    if (output.path) {
      try { workflowResultPath(workflow, workspace, output.path, true); }
      catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
    }
  }
  const delivery = workflow.plan?.finalDelivery;
  if (delivery?.required) {
    const producer = workflow.nodes.find((node) => node.id === delivery.producerNodeId);
    if (!producer || producer.status !== "completed" || !producer.summary) issues.push(`最终交付生产节点未完成：${delivery.producerNodeId || "未指定"}`);
    const producerPaths = producer?.summary ? workflowResultArtifactPaths(producer.summary).map((reported) => {
      try { return workflowResultPath(workflow, workspace, reported, true).absolute.toLowerCase(); } catch { return ""; }
    }) : [];
    const verifyDeliveryFile = (reportedPath: string, label: string) => {
      try {
        const artifact = workflowResultPath(workflow, workspace, reportedPath, true);
        const stat = fs.statSync(artifact.absolute);
        if (!stat.isFile()) issues.push(`${label}不是文件：${reportedPath}`);
        else if (stat.size === 0) issues.push(`${label}为空：${reportedPath}`);
        if (!producerPaths.includes(artifact.absolute.toLowerCase())) issues.push(`生产节点没有登记${label}：${reportedPath}`);
      } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
    };
    if (!delivery.primary) issues.push("最终交付主文件未声明");
    else verifyDeliveryFile(delivery.primary, "最终交付主文件");
    for (const additional of delivery.additional) verifyDeliveryFile(additional, "最终附加文件");
  }
  return [...new Set(issues)];
}

function mergeFinalDeliveryOutputs(workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>, result: WorkflowNodeResult) {
  const delivery = workflow.plan?.finalDelivery;
  if (!delivery?.required || !delivery.producerNodeId) return result;
  const producer = workflow.nodes.find((node) => node.id === delivery.producerNodeId);
  if (!producer?.summary) return result;
  const expected = new Set([delivery.primary, ...delivery.additional].filter((item): item is string => Boolean(item)).map((item) => item.replaceAll("\\", "/").toLowerCase()));
  const deliveryOutputs = producer.summary.outputs.filter((output) => output.path && [...expected].some((item) => {
    const reported = output.path!.replaceAll("\\", "/").toLowerCase();
    return reported === item || reported.endsWith(`/${item}`);
  }));
  const byId = new Map(result.outputs.map((output) => [output.id, output]));
  for (const output of deliveryOutputs) byId.set(output.id, output);
  return { ...result, outputs: [...byId.values()] };
}

function persistWorkflowFinalResult(workflow: NonNullable<ReturnType<WorkflowRepository["get"]>>, workspace: Workspace, result: WorkflowNodeResult) {
  void workspace;
  return { ...result, machineResultPath: `plugin://orchestration/runs/${workflow.id}/results.json` };
}

async function integrateWorkflow(workflowId: string, ownerUserId: string) {
  let workflow = workflowRepository.get(workflowId, ownerUserId);
  if (!workflow) throw new Error("工作流不存在");
  const workspace = workspaceById(workflow.workspaceId, ownerUserId);
  if (!workspace) throw new Error("工作区不存在");
  const integrationBinding = await runtimeBindingForProvider(workflow.plannerEngine);
  const integrationRuntime = workflowRepository.beginIntegration(workflowId, integrationBinding);
  workflow = workflowRepository.get(workflowId, ownerUserId)!;
  if (integrationRuntime.changed) workflowRepository.appendIntegrationLog(workflowId, workflowLog("status", "运行时已更新", "最终验收的运行时或能力已变化，已放弃旧的中间结果并从一致状态重新执行"));
  workflowStateFiles.sync(workflow);
  workflowStateFiles.appendEvent(workflow, { type: "integration.started", attempt: workflow.integrationAttempt });
  const controller = new AbortController();
  activeWorkflowIntegrations.set(workflowId, controller);
  const appendEvent = (phase: "Integrator" | "Validator") => (event: NormalizedEngineEvent) => {
    if (!event.text) return;
    const log = workflowLogFromEngineEvent(event, `${phase.toLowerCase()}:${event.sourceId || event.type}`);
    workflowRepository.appendIntegrationLog(workflowId, { ...log, title: `${phase} · ${log.title}` });
    appendWorkflowProtocolEvent(workflowId, ownerUserId, "integration.engine_event", { phase, type: event.type, sourceId: event.sourceId, toolName: event.toolName, text: event.text });
  };
  const runStage = async (label: string, action: () => Promise<string>) => {
    let lastError: unknown;
    for (let stageAttempt = 1; stageAttempt <= 3; stageAttempt += 1) {
      try { return await action(); }
      catch (error) {
        lastError = error;
        const category = workflowFailureCategory(error);
        if (category !== "transient" || stageAttempt >= 3 || controller.signal.aborted) throw error;
        workflowRepository.appendIntegrationLog(workflowId, workflowLog("error", `${label} 暂时失败`, `第 ${stageAttempt}/3 次：${error instanceof Error ? error.message : String(error)}`));
        await new Promise((resolve) => setTimeout(resolve, Math.min(4_000, 500 * (2 ** stageAttempt))));
      }
    }
    throw lastError;
  };
  try {
    let candidate = workflow.integratorResult;
    if (!candidate || !workflow.integrationPhase || workflow.integrationPhase === "started") {
      workflowRepository.appendIntegrationLog(workflowId, workflowLog("status", "开始最终整合", `由 ${workflow.plannerEngine === "claude" ? "Claude" : "Codex"} Integrator 综合节点成果`));
      const integratorWorkflow = workflow;
      const integratorText = await runStage("Integrator", () => runWorkflowTextAgent(integratorWorkflow.plannerEngine, workflowIntegratorPrompt(integratorWorkflow), integratorWorkflow, workspace, controller, `workflow:${workflowId}:integrator`, appendEvent("Integrator")));
      candidate = mergeFinalDeliveryOutputs(workflow, parseWorkflowNodeResult(integratorText));
      workflowRepository.checkpointIntegration(workflowId, "integrator_completed", { integratorResult: candidate, validatorResult: null });
      workflow = workflowRepository.get(workflowId, ownerUserId)!;
      workflowStateFiles.sync(workflow);
      workflowStateFiles.appendEvent(workflow, { type: "integration.integrator_completed", payload: { outcome: candidate.outcome } });
    } else {
      candidate = mergeFinalDeliveryOutputs(workflow, candidate);
      workflowRepository.appendIntegrationLog(workflowId, workflowLog("status", "恢复最终整合", "已复用持久化的 Integrator 候选结果"));
    }
    const systemIssues = systemValidateIntegratedResult(workflow, workspace, candidate);
    let validation = workflow.validatorResult;
    if (!validation || workflow.integrationPhase !== "validator_completed") {
      workflowRepository.appendIntegrationLog(workflowId, workflowLog("status", "开始最终验收", "Validator 正在独立检查目标覆盖、产物和跨节点一致性"));
      const validatorWorkflow = workflow;
      const validatorCandidate = candidate;
      const validatorText = await runStage("Validator", () => runWorkflowTextAgent(validatorWorkflow.plannerEngine, workflowValidatorPrompt(validatorWorkflow, validatorCandidate), validatorWorkflow, workspace, controller, `workflow:${workflowId}:validator`, appendEvent("Validator")));
      validation = parseWorkflowNodeResult(validatorText);
      workflowRepository.checkpointIntegration(workflowId, "validator_completed", { validatorResult: validation });
      const validated = workflowRepository.get(workflowId, ownerUserId)!;
      workflowStateFiles.sync(validated);
      workflowStateFiles.appendEvent(validated, { type: "integration.validator_completed", payload: { outcome: validation.outcome } });
    } else workflowRepository.appendIntegrationLog(workflowId, workflowLog("status", "恢复最终验收", "已复用持久化的 Validator 结果，仅继续系统提交"));
    const validatorPassed = validation.outcome === "completed" && !validation.unresolved.length && !validation.checks.some((check) => check.status === "failed");
    const unresolved = [...new Set([...candidate.unresolved, ...systemIssues, ...(validatorPassed ? [] : validation.unresolved.length ? validation.unresolved : ["Validator 未通过最终验收"])])];
    const nodeChangedFiles = workflow.nodes.flatMap((node) => node.summary?.changedFiles || []);
    const nodeChecks = workflow.nodes.flatMap((node) => node.summary?.checks || []);
    const nodeWarnings = workflow.nodes.flatMap((node) => node.summary?.warnings || []);
    const nodeUnresolved = workflow.nodes.flatMap((node) => node.summary?.unresolved || []);
    const finalResult: WorkflowNodeResult = {
      ...candidate,
      outcome: systemIssues.length || !validatorPassed || nodeUnresolved.length ? "partial" : "completed",
      changedFiles: [...new Set([...nodeChangedFiles, ...candidate.changedFiles])],
      checks: [...nodeChecks, ...candidate.checks, ...validation.checks, { name: "最终验收 Agent", command: null, status: systemIssues.length || !validatorPassed ? "failed" : "passed", exitCode: null, evidence: validation.humanSummary }],
      warnings: [...new Set([...nodeWarnings, ...candidate.warnings, ...validation.warnings])],
      unresolved: [...new Set([...nodeUnresolved, ...unresolved])]
    };
    const persisted = persistWorkflowFinalResult(workflow, workspace, finalResult);
    workflowRepository.checkpointIntegration(workflowId, "result_committed", { integratorResult: candidate, validatorResult: validation });
    const status = persisted.outcome === "completed" ? "completed" : "needs_review";
    workflowRepository.appendIntegrationLog(workflowId, workflowLog(status === "completed" ? "status" : "error", status === "completed" ? "最终验收通过" : "最终验收未通过", persisted.humanSummary));
    workflowRepository.finishIntegration(workflowId, status, persisted);
    const done = workflowRepository.get(workflowId, ownerUserId)!;
    workflowStateFiles.sync(done);
    workflowStateFiles.appendEvent(done, { type: status === "completed" ? "workflow.completed" : "workflow.needs_review", payload: { outcome: persisted.outcome } });
    workflowEvent(workflowId, status === "completed" ? "workflow.completed" : "workflow.needs_review", ownerUserId, workspace.id, done.revision);
  } catch (error) {
    const controlState = workflowRepository.get(workflowId, ownerUserId)?.status;
    if (controlState === "paused" || controlState === "canceled") return;
    let failed = workflowFailureResult(error instanceof Error ? error.message : String(error));
    try { failed = persistWorkflowFinalResult(workflow, workspace, failed); }
    catch (persistenceError) { failed.unresolved.push(`最终结果文件持久化失败：${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`); }
    workflowRepository.appendIntegrationLog(workflowId, workflowLog("error", "最终整合失败", failed.unresolved.join("；")));
    workflowRepository.finishIntegration(workflowId, "needs_review", failed);
    const current = workflowRepository.get(workflowId, ownerUserId)!;
    workflowStateFiles.sync(current);
    workflowStateFiles.appendEvent(current, { type: "integration.failed", payload: { error: failed.unresolved.join("；") } });
    workflowEvent(workflowId, "workflow.needs_review", ownerUserId, workspace.id, current.revision);
  } finally {
    if (activeWorkflowIntegrations.get(workflowId) === controller) activeWorkflowIntegrations.delete(workflowId);
    workspaceTreeIndex.invalidate(workspace.root, path.relative(workspace.root, workflow.workDirectory));
  }
}

  return { retryableWorkflowPlannerFailure, workflowPlannerFailureMessage, workflowPlannerRequestKey, currentWorkflowProviderCapabilities, assertWorkflowExecutionReady, syncWorkflowProtocolFiles, appendWorkflowProtocolEvent, workflowEvent, plannerSkillContext, runBuiltinWorkflowPlan, requestWorkflowPlan, workflowResultPath, workflowResultDigest, runBuiltinWorkflowNode, executeWorkflowNode, integrateWorkflow };
}
