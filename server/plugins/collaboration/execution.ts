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
  activeDelegationTasks?: ReadonlyMap<string, { parentTaskId: string }>;
  getExternalActiveCount?: () => number;
};

const MAX_DELEGATED_RETRIES = 2;
const MAX_DELEGATED_TASKS_PER_PARENT = 5;
const MAX_DELEGATED_TASKS_GLOBAL = 20;
const OPEN_DELEGATED_STATUSES = new Set(["queued", "running"]);

type ExecutionJob = {
  task: DelegatedTask;
  generation: number;
  readyAt: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export function createDelegationExecution(ports: DelegationExecutionPorts) {
  const { getState, isWorkbenchDelegationEnabled, runtimeBindingForProvider, agentAdapterRegistry, saveState, upsertDelegatedTask, appendMessage } = ports;
  const jobs = new Map<string, ExecutionJob>();
  const leases = new Map<string, string>();
  const registeringRetries = new Set<string>();
  let wakeTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let generation = 0;
  const reportFailure = (error: unknown) => console.error("Delegation execution persistence failed", error);
  const canRun = (task: DelegatedTask, expectedGeneration = generation) => {
    const parent = getState().sessions.find((session) => session.id === task.parentSessionId);
    return !stopped && expectedGeneration === generation && Boolean(parent && parent.status === "running" && isWorkbenchDelegationEnabled(parent));
  };
  function activeParents() {
    const active = new Map<string, string>();
    for (const [id, task] of ports.activeDelegationTasks || []) active.set(id, task.parentTaskId);
    for (const [id, parentId] of leases) active.set(id, parentId);
    return active;
  }
  async function interrupt(task: DelegatedTask) {
    if (!OPEN_DELEGATED_STATUSES.has(task.status)) return;
    markInterrupted(task);
    await saveState();
  }
  function markInterrupted(task: DelegatedTask) {
    task.status = "interrupted";
    task.updatedAt = new Date().toISOString();
    task.completedAt = task.updatedAt;
    task.lastError = "主任务或协作插件已停止，子 Agent 未继续启动";
  }
  function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
  function isRetryable(error: unknown) {
    const text = errorText(error).toLowerCase();
    return ["fetch failed", "econnreset", "econnrefused", "eai_again", "etimedout", "socket hang up", "stream disconnected", "connection reset", "connection refused", "service unavailable", "bad gateway", "gateway timeout", "rate limit", "too many requests", "concurrency limit"].some((marker) => text.includes(marker));
  }
  function retryInput(task: DelegatedTask): AgentBridgeRequest {
    return {
      taskId: task.id, parentTaskId: task.parentSessionId, cwd: task.cwd, prompt: task.task,
      acceptance: task.acceptance, nickname: task.nickname, mode: task.mode,
      idempotencyKey: task.idempotencyKey, capabilityRequirements: task.capabilityRequirements, adapterOptions: task.adapterOptions
    };
  }
  function scheduleWake() {
    if (wakeTimer || stopped) return;
    const waiting = [...jobs.values()].filter((job) => !leases.has(job.task.id));
    if (!waiting.length) return;
    const nextReady = Math.min(...waiting.map((job) => job.readyAt));
    const remaining = nextReady - Date.now();
    const delay = remaining > 0 ? Math.min(1_000, Math.max(25, remaining)) : 1_000;
    wakeTimer = setTimeout(() => { wakeTimer = undefined; pump(); }, delay);
    wakeTimer.unref();
  }
  function pump() {
    if (stopped) return;
    for (const job of jobs.values()) {
      if (leases.has(job.task.id)) continue;
      if (job.task.status !== "queued") { jobs.delete(job.task.id); job.resolve(); continue; }
      if (!canRun(job.task, job.generation)) {
        jobs.delete(job.task.id);
        void interrupt(job.task).then(job.resolve, job.reject);
        continue;
      }
      if (job.readyAt > Date.now()) continue;
      const active = activeParents();
      const parentActive = [...active.values()].filter((id) => id === job.task.parentSessionId).length;
      const externalActive = Math.max(0, ports.getExternalActiveCount?.() || 0);
      if (parentActive >= MAX_DELEGATED_TASKS_PER_PARENT || active.size + externalActive >= MAX_DELEGATED_TASKS_GLOBAL) continue;
      // Reserve synchronously before runtime discovery or persistence awaits.
      // Queued retries can exceed the admission limit, but never execution slots.
      leases.set(job.task.id, job.task.parentSessionId);
      void runJob(job).then(job.resolve, job.reject).finally(() => {
        leases.delete(job.task.id);
        if (jobs.get(job.task.id) === job) jobs.delete(job.task.id);
        pump();
      });
    }
    scheduleWake();
  }
  function enqueue(task: DelegatedTask, readyAt = Date.now()) {
    const existing = jobs.get(task.id);
    if (existing) return existing.promise;
    if (stopped || task.status !== "queued") return interrupt(task);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    jobs.set(task.id, { task, readyAt, generation, promise, resolve, reject });
    pump();
    return promise;
  }
  async function runJob(job: ExecutionJob) {
    const task = job.task;
    try {
      if (!canRun(task, job.generation) || task.status !== "queued") return await interrupt(task);
      task.runtimeBinding = await runtimeBindingForProvider(task.provider);
      task.updatedAt = new Date().toISOString();
      await saveState();
      if (!canRun(task, job.generation) || task.status !== "queued") return await interrupt(task);
      await agentAdapterRegistry.execute({ schemaVersion: 3, providerId: task.provider, ...retryInput(task) });
    } catch (error) { await handleFailure(task.id, error, job.generation); }
  }
  async function handleFailure(taskId: string, error: unknown, expectedGeneration: number) {
    const task = getState().delegatedTasks.find((item) => item.id === taskId);
    if (!task) return;
    if (!canRun(task, expectedGeneration)) return interrupt(task);
    // A transport/cleanup exception after a recorded success must not repeat
    // already completed file edits or other side effects.
    if (task.status === "completed") return;
    if (OPEN_DELEGATED_STATUSES.has(task.status)) {
      task.status = "failed";
      task.lastError = errorText(error);
      task.updatedAt = new Date().toISOString();
      task.completedAt = task.updatedAt;
    }
    const retryCount = task.retryCount || 0;
    if (task.status !== "failed" || !isRetryable(error) || retryCount >= MAX_DELEGATED_RETRIES) { await saveState(); return; }
    const retryNumber = retryCount + 1;
    const now = new Date().toISOString();
    const retryTask: DelegatedTask = {
      ...task, id: `${task.id}:retry-${retryNumber}-${crypto.randomUUID().slice(0, 8)}`, status: "queued",
      createdAt: now, updatedAt: now, completedAt: undefined, reviewedAt: undefined,
      finalText: undefined, lastError: undefined, retryCount: retryNumber, retryOf: task.retryOf || task.id,
      idempotencyKey: `${task.idempotencyKey || task.id}:retry-${retryNumber}`, requestFingerprint: undefined
    };
    // Install the waiting retry before the first await. The parent barrier
    // must remain closed between a failed attempt and its durable retry.
    upsertDelegatedTask(retryTask);
    registeringRetries.add(retryTask.id);
    const parent = getState().sessions.find((session) => session.id === task.parentSessionId);
    if (parent) appendMessage(parent, {
      role: "event", eventType: "subagent_retry", eventPhase: "started",
      text: `${task.nickname} 临时失败，正在进行第 ${retryNumber}/${MAX_DELEGATED_RETRIES} 次自动重试`,
      payload: { type: "subagent_retry", taskId: retryTask.id, retryOf: task.id, retryNumber, maxRetries: MAX_DELEGATED_RETRIES, error: errorText(error) }
    });
    try {
      await saveState();
      if (!canRun(retryTask, expectedGeneration) || retryTask.status !== "queued") return await interrupt(retryTask);
      const readyAt = Date.now() + Math.min(8_000, 1_000 * (2 ** Math.max(0, retryNumber - 1)));
      void enqueue(retryTask, readyAt).catch(reportFailure);
    } catch (saveError) {
      await interrupt(retryTask);
      throw saveError;
    } finally { registeringRetries.delete(retryTask.id); }
  }

  return {
    launch: enqueue,
    activeCount: () => activeParents().size,
    start() { stopped = false; pump(); },
    stop() {
      if (stopped) return Promise.resolve();
      stopped = true;
      generation++;
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = undefined;
      let changed = false;
      const waiting: ExecutionJob[] = [];
      for (const job of jobs.values()) {
        if (job.task.status === "queued") { markInterrupted(job.task); changed = true; }
        if (!leases.has(job.task.id)) { jobs.delete(job.task.id); waiting.push(job); }
      }
      for (const task of getState().delegatedTasks) if (registeringRetries.has(task.id) && task.status === "queued") { markInterrupted(task); changed = true; }
      // The host cleanup hook is synchronous; mutate immediately and attach a
      // rejection handler. Shutdown's final save also persists this snapshot.
      const saved = changed ? saveState() : Promise.resolve();
      void saved.catch(reportFailure);
      for (const job of waiting) void saved.then(job.resolve, job.reject);
      return saved;
    }
  };
}
