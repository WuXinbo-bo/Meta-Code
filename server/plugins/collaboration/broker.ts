import crypto from "node:crypto";
import path from "node:path";
import type { Usage } from "@openai/codex-sdk";
import { normalizeProviderId, type AgentProviderId, type DelegationMode } from "../../agents/types.js";
import type { AgentAdapterRegistry } from "../../agents/registry.js";
import type { State, Session, Workspace, DelegatedTask } from "../../workbench/types.js";
import { delegationIdempotency } from "../../orchestration/contracts.js";

export type AgentBridgeRequest = {
  taskId?: string;
  parentTaskId?: string;
  nickname?: string;
  cwd?: string;
  prompt?: string;
  acceptance?: string[];
  mode?: DelegationMode;
  depth?: number;
  idempotencyKey?: string;
  capabilityRequirements?: string[];
  adapterOptions?: Record<string, unknown>;
};

export type DelegationBrokerPorts = {
  getState: () => Pick<State, "sessions" | "delegatedTasks">;
  agentAdapterRegistry: Pick<AgentAdapterRegistry, "requireDescriptor" | "requireCapabilities">;
  isWorkbenchDelegationEnabled: (session: Pick<Session, "id">) => boolean;
  executionWorkspaceForSession: (session: Session) => Workspace | undefined;
  assertExecutionCwd: (workspace: Workspace, cwd: string) => string;
  activeDelegationTasks: Map<string, { parentTaskId: string; providerId: string; controller: AbortController }>;
  upsertDelegatedTask: (task: Omit<DelegatedTask, "createdAt">) => void;
  saveState: () => Promise<void>;
  launchDelegatedExecution: (task: DelegatedTask) => void;
};
function delegationFingerprint(input: AgentBridgeRequest, provider: AgentProviderId, parentTaskId: string, cwd: string, prompt: string) {
  const acceptance = Array.isArray(input.acceptance) ? input.acceptance.map(String).map((item) => item.trim()).filter(Boolean) : [];
  const mode = input.mode === "analysis" || input.mode === "review" || input.mode === "implementation"
    ? input.mode
    : provider === "claude" ? "analysis" : "implementation";
  return crypto.createHash("sha256").update(JSON.stringify({ provider, parentTaskId, cwd: path.resolve(cwd), prompt, acceptance, mode })).digest("hex");
}

const MAX_DELEGATED_TASKS_PER_PARENT = 5;
const MAX_DELEGATED_TASKS_GLOBAL = 20;
const OPEN_DELEGATED_STATUSES = new Set(["queued", "running"]);
const emptyUsage = (): Usage => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
export function createDelegationBroker(ports: DelegationBrokerPorts) {
  const { getState, agentAdapterRegistry, isWorkbenchDelegationEnabled, executionWorkspaceForSession, assertExecutionCwd, activeDelegationTasks, upsertDelegatedTask, saveState, launchDelegatedExecution } = ports;
  let tail = Promise.resolve();
async function queueDelegatedTask(input: AgentBridgeRequest, requestedProvider: AgentProviderId) {
  if (Number(input.depth || 0) >= 1) throw new Error("子 Agent 不允许递归委派");
  const provider = normalizeProviderId(requestedProvider);
  const descriptor = agentAdapterRegistry.requireDescriptor(provider);
  if (!descriptor.capabilities.delegation.worker) throw new Error(`${descriptor.displayName} 不支持工作台委派`);
  const capabilityRequirements = agentAdapterRegistry.requireCapabilities(provider, input.capabilityRequirements);
  input = { ...input, capabilityRequirements };
  const parentTaskId = String(input.parentTaskId || "").trim();
  const parentSession = getState().sessions.find((session) => session.id === parentTaskId);
  if (!parentSession) throw new Error("委派的主任务不存在");
  if (!isWorkbenchDelegationEnabled(parentSession)) throw new Error("当前任务未启用协作插件，不能使用委派桥接");
  if (parentSession.status !== "running") throw new Error("主任务当前未运行，不能继续委派");
  const workspace = executionWorkspaceForSession(parentSession);
  if (!workspace) throw new Error("主任务工作区不存在");
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("委派任务不能为空");
  const cwd = assertExecutionCwd(workspace, String(input.cwd || workspace.root));
  const fingerprint = delegationFingerprint(input, provider, parentTaskId, cwd, prompt);
  const idempotencyKey = String(input.idempotencyKey || input.taskId || fingerprint).trim();
  const existingIdempotent = getState().delegatedTasks.find((task) => task.parentSessionId === parentTaskId && task.provider === provider && task.idempotencyKey === idempotencyKey);
  if (existingIdempotent) {
    if (delegationIdempotency(existingIdempotent.requestFingerprint, fingerprint).conflict) {
      throw new Error(`幂等键 ${idempotencyKey} 已被不同的委派内容使用`);
    }
    return { ok: true, accepted: true, deduplicated: true, taskId: existingIdempotent.id, parentTaskId, status: existingIdempotent.status };
  }
  const taskId = String(input.taskId || `${provider}-worker-${fingerprint.slice(0, 16)}`).trim();
  const existingTaskId = getState().delegatedTasks.find((task) => task.id === taskId);
  if (activeDelegationTasks.has(taskId) || existingTaskId) {
    if (existingTaskId?.requestFingerprint === fingerprint) {
      return { ok: true, accepted: true, deduplicated: true, taskId, parentTaskId, status: existingTaskId.status };
    }
    throw new Error(`子任务 ID ${taskId} 已被其他委派使用`);
  }

  const openTasks = getState().delegatedTasks.filter((task) => OPEN_DELEGATED_STATUSES.has(task.status));
  const parentOpenCount = openTasks.filter((task) => task.parentSessionId === parentTaskId).length;
  if (parentOpenCount >= MAX_DELEGATED_TASKS_PER_PARENT) {
    throw new Error(`当前主任务已达到子 Agent 并发上限（${MAX_DELEGATED_TASKS_PER_PARENT}）`);
  }
  if (openTasks.length >= MAX_DELEGATED_TASKS_GLOBAL) {
    throw new Error(`工作台已达到全局子 Agent 并发上限（${MAX_DELEGATED_TASKS_GLOBAL}），请稍后重试`);
  }

  const now = new Date().toISOString();
  const mode = input.mode === "analysis" || input.mode === "review" || input.mode === "implementation"
    ? input.mode
    : provider === "claude" ? "analysis" : "implementation";
  upsertDelegatedTask({
    id: taskId, parentSessionId: parentTaskId, provider, adapterId: descriptor.adapterId, mode,
    nickname: String(input.nickname || `${descriptor.shortName} 子 Agent`),
    cwd, task: prompt, status: "queued", updatedAt: now, usage: emptyUsage(),
    idempotencyKey, requestFingerprint: fingerprint,
    capabilityRequirements: input.capabilityRequirements, adapterOptions: input.adapterOptions,
    acceptance: Array.isArray(input.acceptance) ? input.acceptance.map(String).map((item) => item.trim()).filter(Boolean) : [],
    retryCount: 0
  });
  try { await saveState(); }
  catch (error) {
    getState().delegatedTasks = getState().delegatedTasks.filter((task) => task.id !== taskId);
    throw error;
  }
  const task = getState().delegatedTasks.find((item) => item.id === taskId);
  if (!task || parentSession.status !== "running" || !isWorkbenchDelegationEnabled(parentSession)) {
    if (task) {
      task.status = "interrupted";
      task.updatedAt = new Date().toISOString();
      task.completedAt = task.updatedAt;
      task.lastError = "主任务已停止，委派未启动";
      await saveState();
    }
    throw new Error("主任务已停止，委派未启动");
  }
  launchDelegatedExecution(task);
  return { ok: true, accepted: true, deduplicated: false, taskId, parentTaskId, status: "queued" as const };
}

  return {
    queue(input: AgentBridgeRequest, provider: AgentProviderId) {
      const admitted = tail.then(() => queueDelegatedTask(input, provider));
      tail = admitted.then(() => undefined, () => undefined);
      return admitted;
    }
  };
}
