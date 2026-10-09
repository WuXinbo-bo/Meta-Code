import path from "node:path";
import type { Workspace } from "../../workbench/types.js";
import type { WorkflowRecord, WorkflowNodeResult, WorkflowNodeAttemptRecord } from "./types.js";
import { DEFAULT_WORKFLOW_MAX_CONCURRENT_AGENTS, GLOBAL_WORKFLOW_MAX_CONCURRENT_AGENTS } from "./types.js";
import type { RuntimeExecutionIdentity } from "../../runtime/types.js";
import type { WorkflowProviderCapabilities } from "./plan.js";
import { resolveWorkflowProvider } from "./plan.js";
import type { WorkflowRepository } from "./repository.js";
import type { WorkflowStateFiles } from "./stateFiles.js";
import type { WorkspaceSkillProjectionManager } from "../../skillProjection.js";
import type { WorkspaceTreeIndex } from "../../workspaceTreeIndex.js";
import { workflowLog } from "./logs.js";
import { failedDependencyReason, missingRequiredArtifacts, workflowFailureCategory, workflowRetryLimit, workflowAgentRetryAllowed } from "./execution.js";
import { timeoutReason } from "../../orchestration/timeouts.js";
import { WorkflowNodeOutcomeError, WorkflowNodeStageRetryError } from "./errors.js";
import { workspaceExecutionCoordinator, type WorkspaceExecutionLease } from "../../runtime/workspaceExecutionCoordinator.js";
import { captureWorkspaceSnapshot } from "./enforcement.js";
import { workflowCompletedFileIntegrityIssues } from "./fileIntegrity.js";

export type OrchestrationSchedulerPorts = {
  workflowTicks: Set<string>;
  workspaceById: (id: string, ownerUserId?: string | undefined) => Workspace | undefined;
  syncWorkflowProtocolFiles: (workflowId: string, ownerUserId: string) => WorkflowRecord | null;
  appendWorkflowProtocolEvent: (workflowId: string, ownerUserId: string, type: string, payload?: unknown, nodeId?: string | undefined, attempt?: number | undefined) => void;
  workflowEvent: (workflowId: string, type: string, ownerUserId: string, workspaceId: string, revision: number, nodeId?: string | undefined) => void;
  activeWorkflowNodes: Map<string, AbortController>;
  activeWorkflowIntegrations: Map<string, AbortController>;
  activeDelegationTasks: Map<string, { parentTaskId: string; providerId: string; controller: AbortController; }>;
  getDelegationActiveCount?: () => number;
  integrateWorkflow: (workflowId: string, ownerUserId: string) => Promise<void>;
  currentWorkflowProviderCapabilities: (ownerUserId: string, workspace?: Workspace | undefined) => Promise<WorkflowProviderCapabilities>;
  runtimeBindingForProvider: (providerId: string) => Promise<RuntimeExecutionIdentity>;
  WORKFLOW_RUNNER_ID: string;
  workflowNodeIntents: Map<string, "pause" | "restart" | "cancel">;
  skillProjectionManager: WorkspaceSkillProjectionManager;
  workspaceTreeIndex: WorkspaceTreeIndex;
  executeWorkflowNode: (workflowId: string, ownerUserId: string, nodeId: string, controller: AbortController, attempt: WorkflowNodeAttemptRecord, runnerId: string) => Promise<WorkflowNodeResult>;
  workflowResultDigest: (result: WorkflowNodeResult) => string;
  workflowRepository: WorkflowRepository;
  workflowStateFiles: WorkflowStateFiles;
  isEnabled: () => boolean;
};

export function workflowAuthorizedWriteScopes(scopes: string[], executionTarget: WorkflowRecord["executionTarget"] = "isolated") {
  // Only historical isolated tasks used an implicit artifacts mirror. Direct
  // project execution must honor the approved write contract exactly.
  if (executionTarget !== "isolated") return [...scopes];
  const expanded = new Set(scopes);
  for (const scope of scopes) {
    const normalized = scope.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized && !normalized.startsWith(".") && !normalized.startsWith("artifacts/")) expanded.add(`artifacts/${normalized}`);
  }
  return [...expanded];
}

export function workflowWriteScopesOverlap(left: string[], right: string[]) {
  if (!left.length || !right.length) return true;
  const describe = (value: string) => {
    const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
    const wildcard = normalized.search(/[\*?]/);
    return { prefix: wildcard < 0 ? normalized : normalized.slice(0, wildcard), wildcard: wildcard >= 0 };
  };
  const within = (parent: string, child: string) => parent === child || child.startsWith(`${parent}/`);
  return left.some((a) => right.some((b) => {
    const x = describe(a); const y = describe(b);
    if (!x.prefix || !y.prefix || x.prefix === "." || y.prefix === ".") return true;
    if (!x.wildcard && !y.wildcard) return within(x.prefix, y.prefix) || within(y.prefix, x.prefix);
    if (x.wildcard && y.wildcard) return x.prefix.startsWith(y.prefix) || y.prefix.startsWith(x.prefix);
    const pattern = x.wildcard ? x : y;
    const literal = x.wildcard ? y : x;
    return literal.prefix.startsWith(pattern.prefix) || within(literal.prefix, pattern.prefix.replace(/\/$/, ""));
  }));
}

export function createOrchestrationScheduler(ports: OrchestrationSchedulerPorts) {
  const { workflowTicks, workspaceById, syncWorkflowProtocolFiles, appendWorkflowProtocolEvent, workflowEvent, activeWorkflowNodes, activeWorkflowIntegrations, activeDelegationTasks, integrateWorkflow, currentWorkflowProviderCapabilities, runtimeBindingForProvider, WORKFLOW_RUNNER_ID, workflowNodeIntents, skillProjectionManager, workspaceTreeIndex, executeWorkflowNode, workflowResultDigest, workflowRepository, workflowStateFiles, isEnabled } = ports;
const retryTimers = new Map<string, NodeJS.Timeout>();
const pendingTicks = new Set<string>();
const executionLeases = new Map<string, WorkspaceExecutionLease>();
const releaseIdleExecution = (workflowId: string) => {
  if (activeWorkflowIntegrations.has(workflowId) || [...activeWorkflowNodes.keys()].some((key) => key.startsWith(`${workflowId}:`))) return;
  executionLeases.get(workflowId)?.release();
  executionLeases.delete(workflowId);
};
function scheduleTick(workflowId: string, ownerUserId: string, delay: number) {
  if (!isEnabled()) return;
  const previous = retryTimers.get(workflowId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    retryTimers.delete(workflowId);
    queueWorkflowTick(workflowId, ownerUserId);
  }, delay);
  timer.unref();
  retryTimers.set(workflowId, timer);
}
function dispose() {
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  pendingTicks.clear();
  for (const workflowId of executionLeases.keys()) releaseIdleExecution(workflowId);
}

function queueWorkflowTick(workflowId: string, ownerUserId: string) {
  if (!isEnabled()) return;
  const delayed = retryTimers.get(workflowId);
  if (delayed) { clearTimeout(delayed); retryTimers.delete(workflowId); }
  if (workflowTicks.has(workflowId)) { pendingTicks.add(workflowId); return; }
  workflowTicks.add(workflowId);
  setImmediate(() => void tickWorkflow(workflowId, ownerUserId).catch((error) => {
    console.error("Workflow scheduler failed", error);
    releaseIdleExecution(workflowId);
    scheduleTick(workflowId, ownerUserId, 1_000);
  }).finally(() => {
    workflowTicks.delete(workflowId);
    if (pendingTicks.delete(workflowId)) queueWorkflowTick(workflowId, ownerUserId);
  }));
}

function reopenRecoveredWorkflowDependents(workflowId: string, ownerUserId: string) {
  const workflow = workflowRepository.get(workflowId, ownerUserId);
  if (!workflow) return [];
  const completed = new Set(workflow.nodes.filter((node) => node.status === "completed").map((node) => node.id));
  const reopened: string[] = [];
  for (const node of workflow.nodes) {
    if (!["blocked", "skipped"].includes(node.status) || !node.dependsOn.length || !node.dependsOn.every((dependency) => completed.has(dependency))) continue;
    node.status = "pending";
    node.error = null;
    node.finishedAt = null;
    node.nextRetryAt = null;
    node.logs.push(workflowLog("status", "依赖已恢复", "上游节点修复完成，已重新进入自动调度队列"));
    workflowRepository.updateNode(node);
    reopened.push(node.id);
  }
  return reopened;
}

async function tickWorkflow(workflowId: string, ownerUserId: string) {
  const workflow = workflowRepository.get(workflowId, ownerUserId);
  if (!isEnabled() || !workflow || ["completed", "canceled", "failed", "paused", "awaiting_approval", "planning", "draft", "needs_review"].includes(workflow.status)) {
    releaseIdleExecution(workflowId);
    return;
  }
  const workspace = workspaceById(workflow.workspaceId, workflow.ownerUserId); if (!workspace) { releaseIdleExecution(workflowId); return; }
  if (!executionLeases.has(workflowId)) {
    const workflowAccess = workflow.nodes.some((node) => node.workspaceAccess === "write") ? "write" : "read";
    const lease = workspaceExecutionCoordinator.tryAcquire({ root: workflow.executionRoot || workflow.workDirectory || workspace.root, ownerId: `workflow:${workflowId}`, label: workflow.title, access: workflowAccess });
    if (!lease) { scheduleTick(workflowId, ownerUserId, 500); return; }
    executionLeases.set(workflowId, lease);
    if (workflow.nodes.some((node) => node.status === "completed" && (node.summary?.fileIntegrity || workflow.executionTarget === "workspace" || workflow.executionTarget === "worktree"))) {
      let snapshot;
      try {
        snapshot = await captureWorkspaceSnapshot(workflow.executionRoot || workflow.workDirectory || workspace.root);
      } catch (error) {
        const latest = workflowRepository.get(workflowId, ownerUserId);
        if (!latest || !["queued", "running", "integrating"].includes(latest.status)) { releaseIdleExecution(workflowId); return; }
        const reason = `恢复前无法读取业务执行目录，已停止消费已完成结果：${error instanceof Error ? error.message : String(error)}`;
        const current = workflowRepository.blockStaleFileResults(workflowId, ownerUserId, new Map(latest.nodes.filter((node) => node.status === "completed").map((node) => [node.id, reason])));
        syncWorkflowProtocolFiles(workflowId, ownerUserId);
        appendWorkflowProtocolEvent(workflowId, ownerUserId, "workflow.needs_review", { reason: "snapshot_failed", error: reason });
        workflowEvent(workflowId, "workflow.needs_review", ownerUserId, current.workspaceId, current.revision);
        releaseIdleExecution(workflowId);
        return;
      }
      const latest = workflowRepository.get(workflowId, ownerUserId);
      if (!latest || !["queued", "running", "integrating"].includes(latest.status)) { releaseIdleExecution(workflowId); return; }
      const issues = workflowCompletedFileIntegrityIssues(latest, snapshot);
      if (issues.size) {
        const current = workflowRepository.blockStaleFileResults(workflowId, ownerUserId, issues);
        for (const [nodeId, issue] of issues) appendWorkflowProtocolEvent(workflowId, ownerUserId, "node.result_stale", { reason: issue }, nodeId);
        syncWorkflowProtocolFiles(workflowId, ownerUserId);
        workflowEvent(workflowId, "workflow.needs_review", ownerUserId, current.workspaceId, current.revision);
        releaseIdleExecution(workflowId);
        return;
      }
    }
  }
  const nowMs = Date.now();
  let nextRetryDelay: number | null = null;
  for (const node of workflow.nodes.filter((item) => item.status === "retry_wait")) {
    const dueAt = Date.parse(node.nextRetryAt || "");
    if (!Number.isFinite(dueAt) || dueAt <= nowMs) {
      node.status = "pending"; node.nextRetryAt = null; workflowRepository.updateNode(node);
    } else nextRetryDelay = nextRetryDelay === null ? dueAt - nowMs : Math.min(nextRetryDelay, dueAt - nowMs);
  }
  if (nextRetryDelay !== null) {
    scheduleTick(workflowId, ownerUserId, Math.max(50, nextRetryDelay));
  }
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const node of workflow.nodes) {
      if (!["pending", "ready", "interrupted"].includes(node.status)) continue;
      const dependencyError = failedDependencyReason(node, workflow.nodes);
      const dependenciesCompleted = node.dependsOn.every((id) => workflow.nodes.find((item) => item.id === id)?.status === "completed");
      const missingArtifacts = dependenciesCompleted ? missingRequiredArtifacts(node, workflow.nodes) : [];
      const error = dependencyError || (missingArtifacts.length ? `缺少必需上游产物：${missingArtifacts.join(", ")}` : null);
      if (!error) continue;
      node.status = node.required ? "blocked" : "skipped";
      node.error = error;
      node.finishedAt = new Date().toISOString();
      node.logs.push(workflowLog("error", node.required ? "依赖阻塞" : "跳过可选节点", error));
      workflowRepository.updateNode(node);
      syncWorkflowProtocolFiles(workflowId, ownerUserId);
      appendWorkflowProtocolEvent(workflowId, ownerUserId, node.required ? "node.blocked" : "node.skipped", { error }, node.id, node.attempt);
      workflowEvent(workflowId, "workflow.node.blocked", ownerUserId, workflow.workspaceId, workflow.revision + 1, node.id);
      propagated = true;
    }
  }
  const completed = new Set(workflow.nodes.filter((node) => node.status === "completed").map((node) => node.id));
  const hasRequiredFailure = workflow.nodes.some((node) => node.required && ["failed", "blocked", "canceled"].includes(node.status));
  const hasActiveNode = workflow.nodes.some((node) => ["running", "queued", "retry_wait"].includes(node.status));
  const hasRunnableNode = workflow.nodes.some((node) => ["pending", "ready", "interrupted"].includes(node.status) && node.dependsOn.every((id) => completed.has(id)));
  if (hasRequiredFailure && !hasActiveNode && !hasRunnableNode) { workflowRepository.updateRun(workflowId, "needs_review"); syncWorkflowProtocolFiles(workflowId, ownerUserId); appendWorkflowProtocolEvent(workflowId, ownerUserId, "workflow.needs_review", { reason: "required_node_failed" }); workflowEvent(workflowId, "workflow.needs_review", ownerUserId, workflow.workspaceId, workflow.revision + 1); releaseIdleExecution(workflowId); return; }
  if (workflow.nodes.length && workflow.nodes.every((node) => node.status === "completed" || (!node.required && ["failed", "blocked", "skipped", "canceled"].includes(node.status)))) {
    const globalActive = activeWorkflowNodes.size + activeWorkflowIntegrations.size + (ports.getDelegationActiveCount?.() ?? activeDelegationTasks.size);
    if (globalActive >= GLOBAL_WORKFLOW_MAX_CONCURRENT_AGENTS) {
      scheduleTick(workflowId, ownerUserId, 1_000);
      return;
    }
    try { await integrateWorkflow(workflowId, ownerUserId); }
    finally {
      const latest = workflowRepository.get(workflowId, ownerUserId);
      if (!latest || !["queued", "running", "integrating"].includes(latest.status)) releaseIdleExecution(workflowId);
    }
    return;
  }
  if (workflow.status === "queued") { workflowRepository.updateRun(workflowId, "running"); syncWorkflowProtocolFiles(workflowId, ownerUserId); }
  const running = workflow.nodes.filter((node) => node.status === "running" || node.status === "queued");
  const providerCapabilities = await currentWorkflowProviderCapabilities(ownerUserId, workspace);
  if (workflowRepository.get(workflowId, ownerUserId)?.status !== "running") return;
  for (const node of workflow.nodes) {
    if (node.status !== "pending" && node.status !== "ready" && node.status !== "interrupted") continue;
    if (!node.dependsOn.every((id) => completed.has(id))) continue;
    if (node.workspaceAccess === "write" && running.some((other) => other.workspaceAccess === "write" && workflowWriteScopesOverlap(workflowAuthorizedWriteScopes(node.writeScope, workflow.executionTarget), workflowAuthorizedWriteScopes(other.writeScope, workflow.executionTarget)))) continue;
    const workflowActive = [...activeWorkflowNodes.keys()].filter((key) => key.startsWith(`${workflowId}:`)).length;
    const taskLimit = workflow.maxConcurrentAgents || DEFAULT_WORKFLOW_MAX_CONCURRENT_AGENTS;
    const globalActive = activeWorkflowNodes.size + activeWorkflowIntegrations.size + (ports.getDelegationActiveCount?.() ?? activeDelegationTasks.size);
    if (workflowActive >= taskLimit || globalActive >= GLOBAL_WORKFLOW_MAX_CONCURRENT_AGENTS) {
      scheduleTick(workflowId, ownerUserId, 1_000);
      break;
    }
    if (node.provider === "auto") { node.provider = resolveWorkflowProvider("auto", node.workspaceAccess, providerCapabilities); workflowRepository.updateNode(node); }
    const checkpointRoot = path.join(workflowStateFiles.directoryFor(workflow.id), "nodes", node.id, "plans", String(node.planVersion), "attempts");
    let attempt: WorkflowNodeAttemptRecord;
    try {
      const runtimeBinding = await runtimeBindingForProvider(node.provider);
      // Runtime discovery may yield while another workflow or delegation
      // occupies the budget. Recheck immediately before the synchronous claim.
      const currentWorkflowActive = [...activeWorkflowNodes.keys()].filter((key) => key.startsWith(`${workflowId}:`)).length;
      const currentGlobalActive = activeWorkflowNodes.size + activeWorkflowIntegrations.size + (ports.getDelegationActiveCount?.() ?? activeDelegationTasks.size);
      if (workflowRepository.get(workflowId, ownerUserId)?.status !== "running") break;
      if (currentWorkflowActive >= taskLimit || currentGlobalActive >= GLOBAL_WORKFLOW_MAX_CONCURRENT_AGENTS) {
        scheduleTick(workflowId, ownerUserId, 1_000);
        break;
      }
      attempt = workflowRepository.claimNodeAttempt(node.recordId, WORKFLOW_RUNNER_ID, checkpointRoot, new Date(Date.now() + 5 * 60_000).toISOString(), runtimeBinding);
    }
    catch { continue; }
    const claimedNode = workflowRepository.get(workflowId, ownerUserId)?.nodes.find((item) => item.id === node.id); if (!claimedNode) continue;
    const controller = new AbortController(); const key = `${workflowId}:${node.id}`; workflowNodeIntents.delete(key); activeWorkflowNodes.set(key, controller);
    let leaseHeartbeat: NodeJS.Timeout | undefined;
    let releaseSkillProjection = () => {};
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      syncWorkflowProtocolFiles(workflowId, ownerUserId);
      appendWorkflowProtocolEvent(workflowId, ownerUserId, "node.started", { provider: claimedNode.provider }, node.id, attempt.attempt);
      releaseSkillProjection = skillProjectionManager.acquireTemporarySkills(
        `${workspace.id}:workflow:${workflowId}`,
        workflow.workDirectory,
        claimedNode.skills
      );
      leaseHeartbeat = setInterval(() => {
        const renewed = workflowRepository.renewNodeLease(claimedNode.recordId, attempt.id, WORKFLOW_RUNNER_ID, new Date(Date.now() + 5 * 60_000).toISOString());
        if (!renewed) controller.abort(new Error("节点执行租约已失效"));
      }, 30_000);
      leaseHeartbeat.unref();
      workspaceTreeIndex.invalidate(workspace.root, path.relative(workspace.root, workflow.workDirectory));
      workflowEvent(workflowId, "workflow.node.started", ownerUserId, workflow.workspaceId, workflow.revision + 1, node.id);
      return executeWorkflowNode(workflowId, ownerUserId, node.id, controller, attempt, WORKFLOW_RUNNER_ID);
    }).then((result) => {
      if (workflowNodeIntents.has(key)) throw new Error("节点已收到用户控制请求");
      const latest = workflowRepository.get(workflowId, ownerUserId)?.nodes.find((item) => item.id === node.id); if (!latest) return;
      const finishedAt = new Date().toISOString();
      const previousDigest = latest.resultDigest || (latest.summary ? workflowResultDigest(latest.summary) : null);
      const nextDigest = workflowResultDigest(result);
      workflowRepository.checkpointNodeAttempt(attempt.id, { phase: "completed", status: "completed", leaseExpiresAt: null, verifiedResult: result, finishedAt });
      latest.status = "completed"; latest.summary = result; latest.resultDigest = nextDigest; latest.staleReason = null; latest.leaseExpiresAt = null; latest.nextRetryAt = null; latest.finishedAt = finishedAt; latest.logs.push(workflowLog("status", "执行完成", result.humanSummary, undefined, { attempt: latest.attempt, runId: attempt.id, contextId: latest.engineThreadId })); workflowRepository.updateNode(latest);
      if (previousDigest && previousDigest !== nextDigest) workflowRepository.invalidateCompletedDependents(workflowId, latest.planVersion, latest.id);
      const reopenedDependents = reopenRecoveredWorkflowDependents(workflowId, ownerUserId);
      syncWorkflowProtocolFiles(workflowId, ownerUserId);
      appendWorkflowProtocolEvent(workflowId, ownerUserId, "node.completed", { outcome: result.outcome, resultDigest: nextDigest }, node.id, latest.attempt);
      for (const reopenedNodeId of reopenedDependents) appendWorkflowProtocolEvent(workflowId, ownerUserId, "node.dependency_recovered", { upstreamNodeId: latest.id }, reopenedNodeId);
      workflowEvent(workflowId, "workflow.node.completed", ownerUserId, workflow.workspaceId, workflow.revision + 1, node.id);
    }).catch((error) => {
      const latest = workflowRepository.get(workflowId, ownerUserId)?.nodes.find((item) => item.id === node.id); if (!latest) return;
      const controlIntent = workflowNodeIntents.get(key);
      if (controlIntent === "pause" || controlIntent === "restart" || controlIntent === "cancel") {
        try {
          workflowRepository.checkpointNodeAttempt(attempt.id, { status: controlIntent === "cancel" ? "abandoned" : "interrupted", leaseExpiresAt: null, error: controlIntent === "cancel" ? "节点已由用户终止" : null, finishedAt: controlIntent === "cancel" ? new Date().toISOString() : null });
          if (controlIntent === "pause") {
            const paused = workflowRepository.completeNodePause(workflowId, ownerUserId, node.id);
            syncWorkflowProtocolFiles(workflowId, ownerUserId);
            appendWorkflowProtocolEvent(workflowId, ownerUserId, "node.paused", { reason: "user" }, node.id, latest.attempt);
            workflowEvent(workflowId, "workflow.node.paused", ownerUserId, paused.workspaceId, paused.revision, node.id);
          } else if (controlIntent === "restart") {
            const restarted = workflowRepository.restartNode(workflowId, ownerUserId, node.id);
            syncWorkflowProtocolFiles(workflowId, ownerUserId);
            appendWorkflowProtocolEvent(workflowId, ownerUserId, "node.restart_requested", { reason: "user" }, node.id, latest.attempt);
            workflowEvent(workflowId, "workflow.node.restart_requested", ownerUserId, restarted.workspaceId, restarted.revision, node.id);
          } else {
            const canceled = workflowRepository.get(workflowId, ownerUserId)!;
            syncWorkflowProtocolFiles(workflowId, ownerUserId);
            appendWorkflowProtocolEvent(workflowId, ownerUserId, "node.canceled", { reason: "user" }, node.id, latest.attempt);
            workflowEvent(workflowId, "workflow.node.canceled", ownerUserId, canceled.workspaceId, canceled.revision, node.id);
          }
        } catch (controlError) {
          console.error(`Workflow node control failed for ${key}`, controlError);
        }
        return;
      }
      const interruptedWithoutTimeout = controller.signal.aborted && !timeoutReason(controller.signal);
      if (interruptedWithoutTimeout) {
        const reason = controller.signal.reason instanceof Error
          ? controller.signal.reason.message
          : "节点执行进程中断，等待安全恢复";
        latest.status = "interrupted";
        latest.error = reason;
        latest.leaseExpiresAt = null;
        latest.nextRetryAt = null;
        latest.finishedAt = null;
        latest.logs.push(workflowLog("status", "执行已中断", `${reason}；将从 Agent 执行阶段重新接管，不消耗合同重试次数`, undefined, { attempt: latest.attempt, runId: attempt.id, contextId: latest.engineThreadId }));
        workflowRepository.updateNode(latest);
        workflowRepository.checkpointNodeAttempt(attempt.id, { status: "interrupted", leaseExpiresAt: null, error: reason, finishedAt: null });
        syncWorkflowProtocolFiles(workflowId, ownerUserId);
        appendWorkflowProtocolEvent(workflowId, ownerUserId, "node.interrupted", { reason, recoverable: true }, node.id, latest.attempt);
        workflowEvent(workflowId, "workflow.node.interrupted", ownerUserId, workflow.workspaceId, workflow.revision + 1, node.id);
        return;
      }
      if (error instanceof WorkflowNodeOutcomeError) latest.summary = error.result;
      latest.error = error instanceof Error ? error.message : String(error); latest.logs.push(workflowLog("error", "执行失败", latest.error, undefined, { attempt: latest.attempt, runId: attempt.id, contextId: latest.engineThreadId }));
      const runStatus = workflowRepository.get(workflowId, ownerUserId)?.status;
      const category = workflowFailureCategory(error); const retryLimit = workflowRetryLimit(category);
      const blocked = error instanceof WorkflowNodeOutcomeError && error.result.outcome === "blocked";
      const stageRetryError = error instanceof WorkflowNodeStageRetryError ? error : null;
      const stageRetry = Boolean(stageRetryError);
      const automaticRetryAllowed = !(error instanceof WorkflowNodeOutcomeError) || error.allowAutomaticRetry;
      const retry = runStatus !== "canceled" && !blocked && automaticRetryAllowed && (stageRetry || workflowAgentRetryAllowed(latest.provider, latest.failurePolicy, latest.attempt, retryLimit));
      latest.status = runStatus === "canceled" ? "canceled" : blocked ? "blocked" : retry ? "retry_wait" : "failed";
      const stageRetryText = stageRetryError?.stage === "snapshot"
        ? "仅重新运行工作区快照与后续文件验收，不重新执行 Agent，也不消耗新的尝试次数"
        : "仅重新运行系统验收，不重新执行 Agent，也不消耗新的尝试次数";
      latest.logs.push(workflowLog("status", retry ? (stageRetry ? "等待阶段重试" : "等待重试") : "停止重试", stageRetry ? stageRetryText : `${category} · ${latest.attempt}/${retryLimit}`, undefined, { attempt: latest.attempt, runId: attempt.id, contextId: latest.engineThreadId }));
      const finishedAt = new Date().toISOString();
      const delay = category === "transient" ? Math.min(8_000, 1_000 * (2 ** latest.attempt)) : 1_000;
      latest.nextRetryAt = retry ? new Date(Date.now() + delay).toISOString() : null;
      latest.leaseExpiresAt = null; latest.finishedAt = ["failed", "blocked", "canceled"].includes(latest.status) ? finishedAt : null; workflowRepository.updateNode(latest);
      workflowRepository.checkpointNodeAttempt(attempt.id, { status: runStatus === "canceled" ? "abandoned" : stageRetry ? "interrupted" : "failed", leaseExpiresAt: null, error: latest.error, finishedAt: stageRetry ? null : finishedAt });
      if (retry) scheduleTick(workflowId, ownerUserId, delay);
      syncWorkflowProtocolFiles(workflowId, ownerUserId);
      appendWorkflowProtocolEvent(workflowId, ownerUserId, retry ? "node.retry_wait" : "node.failed", { error: latest.error, category, retry, stage: stageRetryError?.stage || null }, node.id, latest.attempt);
      workflowEvent(workflowId, "workflow.node.failed", ownerUserId, workflow.workspaceId, workflow.revision + 1, node.id);
    }).finally(() => {
      try {
        releaseSkillProjection();
        workspaceTreeIndex.invalidate(workspace.root, path.relative(workspace.root, workflow.workDirectory));
      } finally {
        if (leaseHeartbeat) clearInterval(leaseHeartbeat);
        activeWorkflowNodes.delete(key);
        workflowNodeIntents.delete(key);
        const currentStatus = workflowRepository.get(workflowId, ownerUserId)?.status;
        if (!isEnabled() || !currentStatus || !["queued", "running", "integrating"].includes(currentStatus)) releaseIdleExecution(workflowId);
        queueWorkflowTick(workflowId, ownerUserId);
      }
    }).catch((error) => console.error("Workflow node state or cleanup failed", error));
    running.push(claimedNode);
  }
}

return { queueWorkflowTick, reopenRecoveredWorkflowDependents, dispose };
}
