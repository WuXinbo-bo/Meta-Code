import crypto from "node:crypto";
import type { AgentAdapterRegistry } from "../../agents/registry.js";
import type { AgentProviderId } from "../../agents/types.js";
import type { RuntimeExecutionIdentity } from "../../runtime/types.js";
import type { State, Session, DelegatedTask, Message } from "../../workbench/types.js";
import type { AgentBridgeRequest } from "./broker.js";

export type DelegationExecutionPorts = {
  getState: () => Pick<State, "sessions" | "delegatedTasks">;
  isWorkbenchDelegationEnabled: (session: Pick<Session, "id">) => boolean;
  runtimeBindingForProvider: (provider: AgentProviderId) => Promise<RuntimeExecutionIdentity>;
  agentAdapterRegistry: Pick<AgentAdapterRegistry, "execute">;
  saveState: () => Promise<void>;
  upsertDelegatedTask: (task: Omit<DelegatedTask, "createdAt">) => void;
  appendMessage: (session: Session, input: Omit<Message, "id" | "createdAt">) => unknown;
};

const MAX_DELEGATED_RETRIES = 2;
const OPEN_DELEGATED_STATUSES = new Set(["queued", "running"]);
const TERMINAL_DELEGATED_STATUSES = new Set(["completed", "failed", "interrupted"]);
export function createDelegationExecution(ports: DelegationExecutionPorts) {
  const { getState, isWorkbenchDelegationEnabled, runtimeBindingForProvider, agentAdapterRegistry, saveState, upsertDelegatedTask, appendMessage } = ports;
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;
  const reportFailure = (error: unknown) => console.error("Delegation execution persistence failed", error);
  const canRun = (task: DelegatedTask) => {
    const parent = getState().sessions.find((session) => session.id === task.parentSessionId);
    return !stopped && Boolean(parent && parent.status === "running" && isWorkbenchDelegationEnabled(parent));
  };
  const interrupt = async (task: DelegatedTask) => {
    task.status = "interrupted";
    task.updatedAt = new Date().toISOString();
    task.completedAt = task.updatedAt;
    task.lastError = "主任务或协作插件已停止，子 Agent 未继续启动";
    await saveState();
  };
function delegatedErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableDelegatedError(error: unknown) {
  const text = delegatedErrorText(error).toLowerCase();
  return [
    "fetch failed",
    "econnreset",
    "econnrefused",
    "eai_again",
    "etimedout",
    "socket hang up",
    "stream disconnected",
    "connection reset",
    "connection refused",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "rate limit",
    "too many requests",
    "concurrency limit"
  ].some((marker) => text.includes(marker));
}

function retryDelayMs(retryCount: number) {
  return Math.min(8_000, 1_000 * (2 ** Math.max(0, retryCount - 1)));
}

function delegatedRetryInput(task: DelegatedTask) {
  return {
    taskId: task.id,
    parentTaskId: task.parentSessionId,
    cwd: task.cwd,
    prompt: task.task,
    acceptance: task.acceptance,
    nickname: task.nickname,
    mode: task.mode,
    idempotencyKey: task.idempotencyKey,
    capabilityRequirements: task.capabilityRequirements,
    adapterOptions: task.adapterOptions
  } satisfies AgentBridgeRequest;
}

function launchDelegatedExecution(task: DelegatedTask) {
  return (async () => {
    if (!canRun(task) || task.status !== "queued") return interrupt(task);
    task.runtimeBinding = await runtimeBindingForProvider(task.provider);
    task.updatedAt = new Date().toISOString();
    await saveState();
    if (!canRun(task) || task.status !== "queued") return interrupt(task);
    const input = delegatedRetryInput(task);
    await agentAdapterRegistry.execute({ schemaVersion: 3, providerId: task.provider, ...input });
  })().catch((error) => handleDelegatedExecutionFailure(task.id, error));
}

async function handleDelegatedExecutionFailure(taskId: string, error: unknown) {
  const task = getState().delegatedTasks.find((item) => item.id === taskId);
  if (!task) return;
  if (!canRun(task)) { if (OPEN_DELEGATED_STATUSES.has(task.status)) await interrupt(task); return; }
  if (OPEN_DELEGATED_STATUSES.has(task.status)) {
    task.status = "failed";
    task.lastError = delegatedErrorText(error);
    task.updatedAt = new Date().toISOString();
    task.completedAt = task.updatedAt;
    await saveState().catch(() => undefined);
  }
  if (!TERMINAL_DELEGATED_STATUSES.has(task.status) || !isRetryableDelegatedError(error)) return;
  const retryCount = task.retryCount || 0;
  if (retryCount >= MAX_DELEGATED_RETRIES) return;
  const retryNumber = retryCount + 1;
  const now = new Date().toISOString();
  const retryTaskId = `${task.id}:retry-${retryNumber}-${crypto.randomUUID().slice(0, 8)}`;
  const retryTask: DelegatedTask = {
    ...task,
    id: retryTaskId,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    completedAt: undefined,
    reviewedAt: undefined,
    finalText: undefined,
    lastError: undefined,
    retryCount: retryNumber,
    retryOf: task.retryOf || task.id,
    idempotencyKey: `${task.idempotencyKey || task.id}:retry-${retryNumber}`,
    requestFingerprint: undefined
  };
  if (!canRun(task)) return;
  upsertDelegatedTask(retryTask);
  const parentSession = getState().sessions.find((session) => session.id === task.parentSessionId);
  if (parentSession) {
    appendMessage(parentSession, {
      role: "event",
      eventType: "subagent_retry",
      eventPhase: "started",
      text: `${task.nickname} 临时失败，正在进行第 ${retryNumber}/${MAX_DELEGATED_RETRIES} 次自动重试`,
      payload: { type: "subagent_retry", taskId: retryTaskId, retryOf: task.id, retryNumber, maxRetries: MAX_DELEGATED_RETRIES, error: delegatedErrorText(error) }
    });
  }
  try { await saveState(); }
  catch (error) { await interrupt(retryTask); return; }
  const timer = setTimeout(() => {
    timers.delete(timer);
    const current = getState().delegatedTasks.find((item) => item.id === retryTaskId);
    if (!current || current.status !== "queued") return;
    void launchDelegatedExecution(current).catch(reportFailure);
  }, retryDelayMs(retryNumber));
  timers.add(timer);
  timer.unref();
}

  return {
    launch: launchDelegatedExecution,
    start() { stopped = false; },
    stop() { stopped = true; for (const timer of timers) clearTimeout(timer); timers.clear(); }
  };
}
