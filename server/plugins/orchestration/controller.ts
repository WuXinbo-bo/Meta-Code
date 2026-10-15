import type { Express, RequestHandler } from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentAdapterRegistry } from "../../agents/registry.js";
import {
normalizeProviderId
} from "../../agents/types.js";
import type { NormalizedEngineEvent } from "../../engines/types.js";
import type { ManagedSkillManager } from "../../managedSkillManager.js";
import { timeoutReason } from "../../orchestration/timeouts.js";
import type { RuntimeExecutionIdentity } from "../../runtime/types.js";
import { workspaceExecutionCoordinator, type WorkspaceExecutionLease } from "../../runtime/workspaceExecutionCoordinator.js";
import { taskDeletionPolicy } from "../../sessionManagement/deletionPolicy.js";
import type { McpServer, SkillPolicies, Workspace } from "../../workbench/types.js";
import type { WorkspaceTreeIndex } from "../../workspaceTreeIndex.js";
import { workflowLog, workflowLogFromEngineEvent } from "./logs.js";
import { normalizeWorkflowPlan, validateWorkflowPlan, type WorkflowProviderCapabilities } from "./plan.js";
import { abortWorkflowPlanTransaction, openWorkflowPlanTransaction, readWorkflowPlanTransaction } from "./plannerTransactions.js";
import { WorkflowRepository } from "./repository.js";
import { WorkflowTargetService, type PreparedWorkflowTarget } from "./targets.js";
import { pathKey } from "../../pathBoundary.js";
import { WorkflowStateFiles } from "./stateFiles.js";
import { calculateWorkflowPlanImpactAsync } from "./fileIntegrityAsync.js";
import { captureWorkspaceSnapshot } from "./enforcement.js";
import type { WorkflowRecord } from "./types.js";
import { isWorkflowStatusQuestion, workflowQuestionSnapshot, workflowStatusAnswer, type WorkflowQuestionAnswerer } from "./questions.js";
import { GLOBAL_WORKFLOW_MAX_CONCURRENT_AGENTS, type WorkflowPlan, type WorkflowPlanningMode } from "./types.js";

export type OrchestrationControllerPorts = {
  acquireRequest: () => () => void;
  workspaceTreeIndex: WorkspaceTreeIndex;
  workflowRepository: WorkflowRepository;
  workspaceById: (id: string, ownerUserId?: string | undefined) => Workspace | undefined;
  agentAdapterRegistry: Pick<AgentAdapterRegistry, "descriptor"> & { workflowPlannerRunner: (id: string) => unknown };
  providerReadiness: (providerId: string, ownerUserId: string, workspace?: Workspace) => Promise<{ ready: boolean; issues: Array<{ message: string }> }>;
  uid: (prefix: string) => string;
  workflowStateFiles: WorkflowStateFiles;
  workflowEvent: (workflowId: string, type: string, ownerUserId: string, workspaceId: string, revision: number, nodeId?: string | undefined) => void;
  workflowRuntimeActive: (workflowId: string) => boolean;
  activeWorkflowPlanners: Map<string, AbortController>;
  activeWorkflowNodes: Map<string, AbortController>;
  workflowNodeIntents: Map<string, "pause" | "cancel" | "restart">;
  activeWorkflowIntegrations: Map<string, AbortController>;
  waitForWorkflowRuntimeRelease: (workflowId: string, timeoutMs?: number) => Promise<void>;
  openInSystemFileManager: (target: string, selectFile?: boolean) => Promise<void>;
  assertExistingDirectory: (input: string) => string;
  workflowResultPath: (workflow: WorkflowRecord, workspace: Workspace, reportedPath: string, mustExist: boolean) => { absolute: string; relative: string; };
  runtimeBindingForProvider: (providerId: string) => Promise<RuntimeExecutionIdentity>;
  workspaceAgentConfig: (workspace: Workspace) => { skillPolicies: SkillPolicies };
  managedSkillManager: Pick<ManagedSkillManager, "listPublic">;
  mcpServersForWorkspace: (workspace: Workspace, onlyServerId?: string | undefined) => McpServer[];
  currentWorkflowProviderCapabilities: (ownerUserId: string, workspace?: Workspace | undefined) => Promise<WorkflowProviderCapabilities>;
  WORKFLOW_PLANNER_TRANSACTION_DIR: string;
  workflowPlannerRequestKey: (workflow: WorkflowRecord, mode: WorkflowPlanningMode, note: string | null, previousPlan: WorkflowPlan | null) => string;
  requestWorkflowPlan: (workflow: WorkflowRecord, workspace: Workspace, skillNames: string[], mcpServerNames: string[], skillContext: string, providerCapabilities: WorkflowProviderCapabilities, signalController: AbortController, transactionPath: string, onActivity: (event: NormalizedEngineEvent) => void, planningMode?: WorkflowPlanningMode | undefined, previousPlan?: WorkflowPlan | null | undefined) => Promise<{ plan: WorkflowPlan; engineSessionId: string | null; noChange: boolean; note: string | null; finalText: string; }>;
  plannerSkillContext: (workspace: Workspace, policies: SkillPolicies) => string;
  workflowPlannerFailureMessage: (error: unknown, controller: AbortController) => string;
  retryableWorkflowPlannerFailure: (message: string) => boolean;
  activeWorkflowPlannerRuns: Map<string, { mode: WorkflowPlanningMode; maintenance: boolean; }>;
  assertWorkflowExecutionReady: (workflow: WorkflowRecord, ownerUserId: string) => Promise<void>;
  queueWorkflowTick: (workflowId: string, ownerUserId: string) => void;
  prepareTaskContext?: (input: { ownerUserId: string; workspaceId: string; hostSessionId?: string; taskContextId?: string; prompt: string }) => { prompt: string; taskContextId?: string; inheritedTarget?: PreparedWorkflowTarget } | Promise<{ prompt: string; taskContextId?: string; inheritedTarget?: PreparedWorkflowTarget }>;
  onWorkflowCreated?: (workflow: WorkflowRecord, taskContextId?: string) => void;
  onWorkflowDeleted?: (workflowId: string, ownerUserId: string) => void;
  plannerContextForWorkflow?: (workflow: WorkflowRecord) => string;
  taskContextIdForWorkflow?: (workflow: WorkflowRecord) => string | null;
  workflowTargetService?: WorkflowTargetService;
  answerWorkflowQuestion?: WorkflowQuestionAnswerer;
};

export function registerOrchestrationRoutes(app: Express, ports: OrchestrationControllerPorts) {
  const { workspaceTreeIndex, workflowRepository, workspaceById, agentAdapterRegistry, providerReadiness, uid, workflowStateFiles, workflowEvent, workflowRuntimeActive, activeWorkflowPlanners, activeWorkflowNodes, workflowNodeIntents, activeWorkflowIntegrations, waitForWorkflowRuntimeRelease, openInSystemFileManager, assertExistingDirectory, workflowResultPath, runtimeBindingForProvider, workspaceAgentConfig, managedSkillManager, mcpServersForWorkspace, currentWorkflowProviderCapabilities, WORKFLOW_PLANNER_TRANSACTION_DIR, workflowPlannerRequestKey, requestWorkflowPlan, plannerSkillContext, workflowPlannerFailureMessage, retryableWorkflowPlannerFailure, activeWorkflowPlannerRuns, assertWorkflowExecutionReady, queueWorkflowTick } = ports;
function withAdmission(handler: RequestHandler<Record<string, string>>): RequestHandler<Record<string, string>> {
  return async (req, res, next) => {
    let release: () => void;
    try { release = ports.acquireRequest(); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error), code: "orchestration-plugin-disabled" }); return; }
    try { await handler(req, res, next); }
    finally { release(); }
  };
}

const targetService = ports.workflowTargetService || new WorkflowTargetService(path.dirname(WORKFLOW_PLANNER_TRANSACTION_DIR));

function requestedWorkflowConcurrency(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > GLOBAL_WORKFLOW_MAX_CONCURRENT_AGENTS) throw new Error(`并行 Agent 数必须是 1-${GLOBAL_WORKFLOW_MAX_CONCURRENT_AGENTS} 的整数`);
  return parsed;
}

app.get("/api/workflows", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(workflowRepository.list(req.authUser!.id, req.query.workspaceId ? String(req.query.workspaceId) : undefined));
});

app.post("/api/workflows", withAdmission(async (req, res) => {
  let preparedId: string | undefined;
  let createdId: string | undefined;
  try {
    const workspace = workspaceById(String(req.body?.workspaceId || ""), req.authUser!.id);
    const prompt = String(req.body?.prompt || "").trim();
    const plannerEngine = normalizeProviderId(req.body?.plannerEngine || "claude");
    const plannerProvider = agentAdapterRegistry.descriptor(plannerEngine);
    if (!plannerProvider?.capabilities.workflow.planner || !agentAdapterRegistry.workflowPlannerRunner(plannerEngine)) return res.status(400).json({ error: "规划 Provider 未注册或不支持工作流规划" });
    const maxConcurrentAgents = requestedWorkflowConcurrency(req.body?.maxConcurrentAgents);
    if (!workspace) return res.status(400).json({ error: "请选择工作区" });
    if (!prompt) return res.status(400).json({ error: "请输入完整任务" });
    const taskContext = await ports.prepareTaskContext?.({ ownerUserId: req.authUser!.id, workspaceId: workspace.id, hostSessionId: req.body?.hostSessionId, taskContextId: req.body?.taskContextId, prompt });
    const inheritedTarget = taskContext?.inheritedTarget;
    if (req.body?.hostSessionId && !inheritedTarget) throw new Error("当前主机不支持继承来源对话的执行目录");
    if (inheritedTarget && (req.body?.executionTarget && req.body.executionTarget !== inheritedTarget.executionTarget || req.body?.executionRoot && pathKey(fs.realpathSync(String(req.body.executionRoot))) !== pathKey(inheritedTarget.executionRoot) || req.body?.worktreeRef || req.body?.worktreeBranch)) throw new Error("切换编排必须保留当前任务目录；其他目录请通过新建方案明确选择");
    const readiness = await providerReadiness(plannerEngine, req.authUser!.id, workspace);
    if (!readiness.ready) return res.status(409).json({ error: readiness.issues[0]?.message || "规划 Agent 尚未准备好", code: "provider-not-ready", readiness });
    const id = uid("workflow");
    if (!inheritedTarget) preparedId = id;
    const target = inheritedTarget || await targetService.prepare({ runId: id, ownerUserId: req.authUser!.id, workspaceId: workspace.id, workspaceRoot: workspace.root, executionTarget: req.body?.executionTarget, executionRoot: req.body?.executionRoot, worktreeRef: req.body?.worktreeRef, worktreeBranch: req.body?.worktreeBranch });
    const workflow = workflowRepository.create({ id, ownerUserId: req.authUser!.id, workspaceId: workspace.id, ...target, prompt, plannerEngine, maxConcurrentAgents });
    createdId = id;
    ports.onWorkflowCreated?.(workflow, taskContext?.taskContextId);
    workflowStateFiles.sync(workflow);
    workflowStateFiles.appendEvent(workflow, { type: "workflow.created", payload: { workspaceId: workspace.id } });
    workflowEvent(workflow.id, "workflow.created", req.authUser!.id, workspace.id, workflow.revision);
    targetService.confirmPrepared(id, req.authUser!.id);
    preparedId = undefined;
    createdId = undefined;
    res.status(201).json({ ...workflow, taskContextId: ports.taskContextIdForWorkflow?.(workflow) || taskContext?.taskContextId || null });
  } catch (error) {
    if (createdId) {
      workflowRepository.delete(createdId, req.authUser!.id);
      ports.onWorkflowDeleted?.(createdId, req.authUser!.id);
    }
    if (preparedId) await targetService.rollbackPrepared(preparedId, req.authUser!.id).catch(() => undefined);
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

app.get("/api/workflows/:id", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  res.setHeader("Cache-Control", "no-store"); res.json({ ...workflow, taskContextId: ports.taskContextIdForWorkflow?.(workflow) || null });
});

app.get("/api/workflows/:id/branches", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  res.setHeader("Cache-Control", "no-store");
  res.json(workflowRepository.listBranches(workflow.originId, req.authUser!.id));
});

app.post("/api/workflows/:id/branches", withAdmission(async (req, res) => {
  const source = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!source) return res.status(404).json({ error: "工作流不存在" });
  let preparedId: string | undefined;
  let createdId: string | undefined;
  try {
    const workspace = workspaceById(source.workspaceId, req.authUser!.id); if (!workspace) throw new Error("工作区不存在");
    const prompt = String(req.body?.prompt || source.originalPrompt).trim(); if (!prompt) throw new Error("初始任务不能为空");
    const plannerEngine = normalizeProviderId(req.body?.plannerEngine || source.plannerEngine);
    const plannerProvider = agentAdapterRegistry.descriptor(plannerEngine);
    if (!plannerProvider?.capabilities.workflow.planner || !agentAdapterRegistry.workflowPlannerRunner(plannerEngine)) throw new Error("规划 Provider 未注册或不支持工作流规划");
    const readiness = await providerReadiness(plannerEngine, req.authUser!.id, workspace);
    if (!readiness.ready) throw new Error(readiness.issues[0]?.message || "规划 Agent 尚未准备好");
    const maxConcurrentAgents = req.body?.maxConcurrentAgents === undefined ? source.maxConcurrentAgents : requestedWorkflowConcurrency(req.body.maxConcurrentAgents);
    const branchIndex = workflowRepository.nextBranchIndex(source.originId, req.authUser!.id);
    const id = uid("workflow");
    preparedId = id;
    const target = await targetService.prepare({ runId: id, ownerUserId: req.authUser!.id, workspaceId: workspace.id, workspaceRoot: workspace.root, executionTarget: req.body?.executionTarget || await targetService.preferredBranchTarget(workspace.root), executionRoot: req.body?.executionRoot, worktreeRef: req.body?.worktreeRef, worktreeBranch: req.body?.worktreeBranch });
    const branch = workflowRepository.create({ id, ownerUserId: req.authUser!.id, workspaceId: source.workspaceId, ...target, prompt, plannerEngine, maxConcurrentAgents, originId: source.originId, parentWorkflowId: source.id, branchIndex, branchLabel: `方案 ${branchIndex}`, reviewNote: String(req.body?.note || "").trim() || null });
    createdId = id;
    ports.onWorkflowCreated?.(branch, req.body?.taskContextId || ports.taskContextIdForWorkflow?.(source) || undefined);
    workflowStateFiles.sync(branch);
    workflowStateFiles.appendEvent(branch, { type: "workflow.branch.created", payload: { originId: branch.originId, parentWorkflowId: branch.parentWorkflowId, branchIndex } });
    workflowEvent(branch.id, "workflow.branch.created", req.authUser!.id, workspace.id, branch.revision);
    targetService.confirmPrepared(id, req.authUser!.id);
    preparedId = undefined;
    createdId = undefined;
    res.status(201).json({ ...branch, taskContextId: ports.taskContextIdForWorkflow?.(branch) || null });
  } catch (error) {
    if (createdId) {
      workflowRepository.delete(createdId, req.authUser!.id);
      ports.onWorkflowDeleted?.(createdId, req.authUser!.id);
    }
    if (preparedId) await targetService.rollbackPrepared(preparedId, req.authUser!.id).catch(() => undefined);
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

app.put("/api/workflows/:id/prompt", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    const updated = workflowRepository.updateOriginalPrompt(workflow.id, req.authUser!.id, Number(req.body?.revision), String(req.body?.prompt || ""));
    workflowStateFiles.sync(updated);
    workflowStateFiles.appendEvent(updated, { type: "workflow.prompt.changed" });
    workflowEvent(updated.id, "workflow.prompt.changed", req.authUser!.id, updated.workspaceId, updated.revision);
    res.json(updated);
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.put("/api/workflows/:id/metadata", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "任务编排不存在" });
  try {
    const workspace = workspaceById(workflow.workspaceId, req.authUser!.id);
    const folderId = req.body?.folderId === undefined ? undefined : String(req.body.folderId || "").trim() || null;
    if (folderId && !workspace?.taskFolders?.some((folder) => folder.id === folderId)) throw new Error("目标任务文件夹不存在");
    if (req.body?.archived && ["planning", "queued", "running", "integrating"].includes(workflow.status)) throw new Error("执行中的任务不能归档");
    const updated = workflowRepository.updateMetadata(workflow.id, req.authUser!.id, { title: req.body?.title, pinned: req.body?.pinned, archived: req.body?.archived, folderId });
    workflowStateFiles.syncWorkflow(updated);
    workflowEvent(updated.id, "workflow.metadata.changed", req.authUser!.id, updated.workspaceId, updated.revision);
    res.json(updated);
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.delete("/api/workflows/:id", async (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "任务编排不存在" });
  const terminate = req.query.terminate === "true" || req.query.terminate === "1";
  const policy = taskDeletionPolicy("workflow", workflow.status, workflowRuntimeActive(workflow.id));
  if (policy.requiresTermination && !terminate) {
    return res.status(409).json({ error: `${policy.reason}，请使用“取消并删除”`, code: "TASK_TERMINATION_REQUIRED", deletionPolicy: policy });
  }
  try {
    let current = workflow;
    if (policy.requiresTermination) {
      if (["draft", "planning", "awaiting_approval", "queued", "running", "integrating", "needs_review", "paused"].includes(current.status)) {
        current = workflowRepository.cancel(current.id, req.authUser!.id, current.revision);
        workflowStateFiles.sync(current);
        workflowStateFiles.appendEvent(current, { type: "workflow.canceled", payload: { reason: "delete" } });
        workflowEvent(current.id, "workflow.canceled", req.authUser!.id, current.workspaceId, current.revision);
      }
      activeWorkflowPlanners.get(current.id)?.abort(new Error("任务编排正在删除"));
      for (const [key, controller] of activeWorkflowNodes) if (key.startsWith(`${current.id}:`)) {
        workflowNodeIntents.set(key, "cancel");
        controller.abort(new Error("任务编排正在删除"));
      }
      activeWorkflowIntegrations.get(current.id)?.abort(new Error("任务编排正在删除"));
      await waitForWorkflowRuntimeRelease(current.id);
    }
    const latest = workflowRepository.get(current.id, req.authUser!.id);
    if (!latest) return res.status(204).end();
    const latestPolicy = taskDeletionPolicy("workflow", latest.status, workflowRuntimeActive(latest.id));
    if (latestPolicy.requiresTermination) throw new Error(latestPolicy.reason || "任务编排仍在结束");
    workflowRepository.delete(latest.id, req.authUser!.id);
    ports.onWorkflowDeleted?.(latest.id, req.authUser!.id);
    workflowEvent(latest.id, "workflow.deleted", req.authUser!.id, latest.workspaceId, latest.revision + 1);
    res.status(204).end();
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/workflows/:id/open-folder", async (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "任务编排不存在" });
  try { await openInSystemFileManager(assertExistingDirectory(workflow.workDirectory)); res.json({ ok: true }); }
  catch (error) { res.status(400).json({ error: `无法打开任务文件夹：${error instanceof Error ? error.message : String(error)}` }); }
});

app.get("/api/workflows/:id/artifacts", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "任务编排不存在" });
  const workspace = workspaceById(workflow.workspaceId, req.authUser!.id);
  if (!workspace) return res.status(404).json({ error: "工作区不存在" });
  const reportedPaths = [...new Set([workflow.finalResult, ...workflow.nodes.map((node) => node.summary)].flatMap((result) => result?.outputs.map((output) => output.path).filter((item): item is string => Boolean(item)) || []))];
  const items = reportedPaths.map((reportedPath) => {
    try {
      const resolved = workflowResultPath(workflow, workspace, reportedPath, false);
      if (!fs.existsSync(resolved.absolute)) return { path: reportedPath, relativePath: resolved.relative, exists: false, kind: "missing", size: null };
      const stat = fs.statSync(resolved.absolute);
      return { path: reportedPath, relativePath: resolved.relative, exists: true, kind: stat.isDirectory() ? "directory" : "file", size: stat.isFile() ? stat.size : null };
    } catch {
      return { path: reportedPath, relativePath: null, exists: false, kind: "invalid", size: null };
    }
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ items });
});

app.get("/api/workflows/:id/maintenance", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  res.setHeader("Cache-Control", "no-store");
  res.json(workflowStateFiles.maintenance(workflow));
});

async function executeWorkflowPlanningRun(input: {
  workflowId: string;
  ownerUserId: string;
  mode: WorkflowPlanningMode;
  note: string | null;
  previousPlan: WorkflowPlan | null;
  baseWorkflow: NonNullable<ReturnType<WorkflowRepository["get"]>>;
  maintenance: boolean;
  controller: AbortController;
  intent?: "question" | "adjust";
  resumeAfter?: boolean;
}) {
  const { workflowId, ownerUserId, mode, note, previousPlan, baseWorkflow, maintenance, controller, intent = "adjust", resumeAfter = false } = input;
  let transactionPath = "";
  let transactionFinished = false;
  let executionLease: WorkspaceExecutionLease | undefined;
  let shouldResume = false;
  const assertPlanningOwnership = () => {
    controller.signal.throwIfAborted();
    const current = workflowRepository.get(workflowId, ownerUserId);
    if (activeWorkflowPlanners.get(workflowId) !== controller || !current) throw new Error("规划运行已失效");
    if (current.activePlanVersion !== baseWorkflow.activePlanVersion) throw new Error("规划基线版本已变化，请刷新后重新维护");
    if (current.status === "canceled" || (!maintenance && current.status !== "planning")) throw new Error("规划运行状态已变化");
    return current;
  };
  try {
    const workspace = workspaceById(baseWorkflow.workspaceId, ownerUserId); if (!workspace) throw new Error("工作区不存在");
    executionLease = await workspaceExecutionCoordinator.acquire({ root: baseWorkflow.executionRoot || baseWorkflow.workDirectory || workspace.root, ownerId: `workflow:${workflowId}`, label: `${baseWorkflow.title} · 规划`, access: "read" }, { signal: controller.signal });
    let snapshot = assertPlanningOwnership();
    const plannerBinding = await runtimeBindingForProvider(snapshot.plannerEngine);
    assertPlanningOwnership();
    const plannerRuntime = workflowRepository.bindPlannerRuntime(workflowId, ownerUserId, plannerBinding);
    if (plannerRuntime.changed) {
      workflowRepository.appendPlannerLog(workflowId, ownerUserId, workflowLog("status", "运行时已更新", "规划器运行时或能力已变化，已清除旧原生会话并从持久化任务上下文重新开始"));
      snapshot = workflowRepository.get(workflowId, ownerUserId)!;
    }
    workflowRepository.setPlannerSession(workflowId, ownerUserId, snapshot.plannerSessionId || `workflow-planner:${workflowId}`, snapshot.plannerEngineSessionId);
    snapshot = workflowRepository.get(workflowId, ownerUserId)!;
    workflowStateFiles.syncWorkflow(snapshot);
    workflowStateFiles.appendEvent(snapshot, { type: maintenance ? "planner.maintenance.started" : "planner.started", payload: { mode } });
    workflowEvent(workflowId, "workflow.planner.started", ownerUserId, workspace.id, snapshot.revision);
    const policies = workspaceAgentConfig(workspace).skillPolicies;
    const allowedSkills = managedSkillManager.listPublic()
      .filter((skill) => !skill.builtIn && (policies[skill.name] === "auto" || policies[skill.name] === "always"))
      .map((skill) => skill.name);
    const availableMcpServers = mcpServersForWorkspace(workspace).map((server) => server.name);
    const providerCapabilities = await currentWorkflowProviderCapabilities(ownerUserId, workspace);
    await fsp.mkdir(WORKFLOW_PLANNER_TRANSACTION_DIR, { recursive: true });
    assertPlanningOwnership();
    transactionPath = path.join(WORKFLOW_PLANNER_TRANSACTION_DIR, `${workflowId}-${mode}.json`);
    const openedTransaction = openWorkflowPlanTransaction(transactionPath, {
      workflowId, mode, baseRevision: snapshot.revision, basePlanVersion: baseWorkflow.activePlanVersion,
      previousPlan, availableSkills: allowedSkills, availableMcpServers, providerCapabilities,
      requestKey: workflowPlannerRequestKey(baseWorkflow, mode, note, previousPlan)
    });
    workflowRepository.appendPlannerLog(workflowId, ownerUserId, workflowLog("tool", openedTransaction.resumed ? "恢复规划事务" : "建立规划事务", openedTransaction.resumed ? `已恢复 ${openedTransaction.transaction.operations.length} 条草稿操作，将从断点继续` : "已创建隔离草稿，正式计划在校验提交前保持不变"));
    workflowRepository.appendPlannerLog(workflowId, ownerUserId, workflowLog("tool", "匹配工作区 Skill", allowedSkills.length ? `已载入 ${allowedSkills.length} 个可用 Skill 候选` : "当前任务不附加业务 Skill"));
    workflowRepository.appendPlannerLog(workflowId, ownerUserId, workflowLog("reasoning", "分析任务结构", `正在调用 ${baseWorkflow.plannerEngine === "claude" ? "Claude" : "Codex"} 维护任务图字段和依赖关系`));
    snapshot = workflowRepository.get(workflowId, ownerUserId)!;
    workflowEvent(workflowId, "workflow.planner.log", ownerUserId, workspace.id, snapshot.revision);
    const plannerLogUpdatedAt = new Map<string, number>();
    const planningContext = ports.plannerContextForWorkflow?.(snapshot);
    const planningSnapshot = {
      ...snapshot,
      ...(planningContext ? { originalPrompt: `${snapshot.originalPrompt}\n\n${planningContext}` } : {}),
      ...(intent === "question" ? { reviewNote: `本轮只回答用户问题，禁止修改任务图或提交候选计划。请通过无修改结束机制提交回答。用户问题：${note || ""}` } : {})
    };
    const planned = await requestWorkflowPlan(planningSnapshot, workspace, allowedSkills, availableMcpServers, plannerSkillContext(workspace, policies), providerCapabilities, controller, transactionPath, (event) => {
      if (controller.signal.aborted || activeWorkflowPlanners.get(workflowId) !== controller || !workflowRepository.get(workflowId, ownerUserId)) return;
      const eventKey = event.sourceId ? `engine:${event.sourceId}` : "event";
      if (event.type === "assistant") {
        const now = Date.now();
        const finalAssistant = (event.payload as { type?: string } | undefined)?.type === "assistant";
        if (!finalAssistant && now - (plannerLogUpdatedAt.get(eventKey) || 0) < 250) return;
        plannerLogUpdatedAt.set(eventKey, now);
      }
      workflowRepository.appendPlannerLog(workflowId, ownerUserId, workflowLogFromEngineEvent(event, "planner"));
      const current = workflowRepository.get(workflowId, ownerUserId)!;
      workflowStateFiles.appendEvent(current, { type: "planner.engine_event", payload: { type: event.type, sourceId: event.sourceId, toolName: event.toolName, text: event.text } });
      workflowEvent(workflowId, "workflow.planner.log", ownerUserId, workspace.id, current.revision);
    }, mode, previousPlan);
    assertPlanningOwnership();
    if (planned.engineSessionId) workflowRepository.setPlannerSession(workflowId, ownerUserId, snapshot.plannerSessionId || `workflow-planner:${workflowId}`, planned.engineSessionId);
    if (planned.noChange || intent === "question") {
      if (!maintenance) throw new Error("首次规划和全新重做不能以无修改结束");
      const message = intent === "question" ? planned.finalText || planned.note || "已完成当前计划的只读询问，执行计划保持不变" : planned.note || planned.finalText || "没有检测到需要修改计划的明确要求";
      const unchanged = workflowRepository.finishMaintenanceWithoutPlan(workflowId, ownerUserId, workflowLog("message", "计划未修改", message));
      workflowStateFiles.finishMaintenanceWithoutChange(unchanged, message);
      workflowStateFiles.syncResults(unchanged);
      workflowEvent(workflowId, "workflow.planner.no_change", ownerUserId, workspace.id, unchanged.revision);
      transactionFinished = true;
      shouldResume = resumeAfter;
      return;
    }
    const transaction = readWorkflowPlanTransaction(transactionPath);
    if (transaction.basePlanVersion !== baseWorkflow.activePlanVersion) throw new Error("规划基线版本已变化，请刷新后重新维护");
    const plan = normalizeWorkflowPlan(planned.plan);
    workflowRepository.appendPlannerLog(workflowId, ownerUserId, workflowLog("tool", "校验任务图", `规划事务已提交，共 ${plan.nodes.length} 个节点，正在执行服务端复核`));
    const errors = validateWorkflowPlan(plan, new Set(allowedSkills), new Set(availableMcpServers), providerCapabilities);
    if (errors.length) throw new Error(`计划校验失败：${errors.join("；")}`);
    const impact = maintenance ? await calculateWorkflowPlanImpactAsync(baseWorkflow, plan, await captureWorkspaceSnapshot(baseWorkflow.executionRoot || baseWorkflow.workDirectory)) : null;
    assertPlanningOwnership();
    workflowRepository.appendPlannerLog(workflowId, ownerUserId, workflowLog("message", "规划完成", `候选计划已原子提交，共 ${plan.nodes.length} 个节点，等待用户审批`));
    const saved = maintenance
      ? workflowRepository.saveMaintenancePlan(workflowId, ownerUserId, plan, note || undefined)
      : workflowRepository.savePlan(workflowId, ownerUserId, plan, note || undefined);
    if (maintenance && impact) workflowStateFiles.finishMaintenance(saved, plan, impact, planned.finalText);
    else workflowStateFiles.sync(saved);
    workflowStateFiles.appendEvent(saved, { type: "plan.ready", payload: { version: saved.activePlanVersion, mode, transactionId: transaction.id, digest: transaction.digest } });
    workflowEvent(workflowId, "workflow.plan.ready", ownerUserId, workspace.id, saved.revision);
    transactionFinished = true;
  } catch (error) {
    try {
      const current = workflowRepository.get(workflowId, ownerUserId);
      if (activeWorkflowPlanners.get(workflowId) !== controller || !current) return;
      const message = workflowPlannerFailureMessage(error, controller);
      if (current?.status === "canceled" || current?.status === "paused" && controller.signal.aborted) {
        if (current.status === "canceled" && transactionPath && fs.existsSync(transactionPath)) abortWorkflowPlanTransaction(transactionPath, message);
        return;
      }
      const retryable = retryableWorkflowPlannerFailure(message) || controller.signal.aborted && Boolean(timeoutReason(controller.signal));
      if (!retryable && transactionPath && fs.existsSync(transactionPath)) abortWorkflowPlanTransaction(transactionPath, message);
      if (/工具权限未授权|permission (?:isn't|wasn't|hasn't been|not) granted|requires approval|not authorized|unauthori[sz]ed/i.test(message)) {
        workflowRepository.clearPlannerEngineSession(workflowId, ownerUserId);
      }
      if (maintenance) workflowRepository.finishMaintenanceWithoutPlan(workflowId, ownerUserId, workflowLog("error", "规划维护失败", message));
      else if (current.status === "planning") workflowRepository.failPlanning(workflowId, ownerUserId, workflowLog("error", "规划失败", message));
      const failed = workflowRepository.get(workflowId, ownerUserId)!;
      if (maintenance) workflowStateFiles.failMaintenance(failed, message);
      else workflowStateFiles.appendEvent(failed, { type: "planner.failed", payload: { error: message, recoverableDraft: retryable } });
      workflowStateFiles.sync(failed);
      workflowEvent(workflowId, "workflow.planner.failed", ownerUserId, failed.workspaceId, failed.revision);
      shouldResume = maintenance && resumeAfter;
    } catch (recoveryError) { console.error("Workflow planner failure recovery failed", recoveryError); }
  } finally {
    const ownsCleanup = activeWorkflowPlanners.get(workflowId) === controller;
    // Keep ownership while deleting the completed transaction; a new planner
    // must not create the same file before the old cleanup has finished.
    if (ownsCleanup && transactionFinished && transactionPath) await fsp.rm(transactionPath, { force: true }).catch(() => undefined);
    if (activeWorkflowPlanners.get(workflowId) === controller) {
      activeWorkflowPlanners.delete(workflowId);
      activeWorkflowPlannerRuns.delete(workflowId);
    }
    executionLease?.release();
    const workspace = workspaceById(baseWorkflow.workspaceId, ownerUserId);
    if (workspace) workspaceTreeIndex.invalidate(workspace.root, path.relative(workspace.root, baseWorkflow.workDirectory));
    const current = workflowRepository.get(workflowId, ownerUserId);
    if (ownsCleanup && shouldResume && current?.status === "paused" && !current.pendingMaintenance && current.pauseMode === "checkpoint") {
      const resumed = workflowRepository.resume(workflowId, ownerUserId, current.revision);
      workflowStateFiles.sync(resumed);
      workflowEvent(workflowId, "workflow.resumed", ownerUserId, resumed.workspaceId, resumed.revision);
      queueWorkflowTick(workflowId, ownerUserId);
    }
  }
}

const pendingMaintenanceRuns = new Set<string>();
function queuePendingMaintenance(workflowId: string, ownerUserId: string) {
  if (pendingMaintenanceRuns.has(workflowId)) return;
  pendingMaintenanceRuns.add(workflowId);
  void (async () => {
    let admittedRelease: (() => void) | undefined;
    let replacementPending = false;
    try {
      while (workflowRepository.get(workflowId, ownerUserId)?.pendingMaintenance && workflowRuntimeActive(workflowId)) {
        await waitForWorkflowRuntimeRelease(workflowId).catch(() => undefined);
      }
      const base = workflowRepository.get(workflowId, ownerUserId);
      const pending = base?.pendingMaintenance;
      if (!base || !pending || base.status === "canceled" || base.pauseMode === "immediate") return;
      admittedRelease = ports.acquireRequest();
      const workspace = workspaceById(base.workspaceId, ownerUserId);
      if (!workspace) throw new Error("工作区不存在");
      const readiness = await providerReadiness(pending.plannerEngine, ownerUserId, workspace);
      const current = workflowRepository.get(workflowId, ownerUserId);
      // Readiness can yield while the user stops or replaces the request. Only
      // the still-current checkpoint request may start a planning process.
      if (!current || current.status === "canceled" || current.pauseMode === "immediate" || !current.pendingMaintenance) return;
      if (JSON.stringify(current.pendingMaintenance) !== JSON.stringify(pending)) {
        replacementPending = true;
        return;
      }
      if (!readiness.ready) throw new Error(readiness.issues[0]?.message || "规划 Agent 尚未准备好");
      const switched = workflowRepository.changePlannerProvider(workflowId, ownerUserId, pending.plannerEngine);
      const started = workflowRepository.startMaintenance(workflowId, ownerUserId, workflowLog("status", pending.intent === "question" ? "回答计划问题" : "维护规划", "执行已到达检查点，正在读取当前计划与有效成果"), pending.note);
      workflowStateFiles.beginMaintenance(started, pending.note);
      const controller = new AbortController();
      activeWorkflowPlanners.set(workflowId, controller);
      activeWorkflowPlannerRuns.set(workflowId, { mode: "refine", maintenance: true });
      await executeWorkflowPlanningRun({ workflowId, ownerUserId, mode: "refine", note: pending.note, previousPlan: switched.plan, baseWorkflow: started, maintenance: true, controller, intent: pending.intent, resumeAfter: pending.resumeAfter });
    } catch (error) {
      const current = workflowRepository.get(workflowId, ownerUserId);
      if (current && current.status !== "canceled") {
        workflowRepository.appendPlannerLog(workflowId, ownerUserId, workflowLog("error", "调整请求未启动", error instanceof Error ? error.message : String(error)));
        const latest = workflowRepository.get(workflowId, ownerUserId)!;
        workflowStateFiles.sync(latest);
        workflowEvent(workflowId, "workflow.planner.failed", ownerUserId, latest.workspaceId, latest.revision);
      }
    } finally {
      admittedRelease?.();
      pendingMaintenanceRuns.delete(workflowId);
      if (replacementPending) queuePendingMaintenance(workflowId, ownerUserId);
    }
  })();
}

setImmediate(() => {
  for (const workflow of workflowRepository.listAll()) if (workflow.pendingMaintenance && workflow.pauseMode !== "immediate") queuePendingMaintenance(workflow.id, workflow.ownerUserId);
});

const activeQuestions = new Map<string, AbortController>();
app.post("/api/workflows/:id/question/cancel", withAdmission((req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  activeQuestions.get(workflow.id)?.abort(new Error("询问已取消"));
  return res.json({ canceled: true });
}));

app.post("/api/workflows/:id/plan", withAdmission(async (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  if (req.body?.source === "maintenance" && req.body?.intent === "question") {
    const question = String(req.body?.note || "").trim();
    if (!question) return res.status(400).json({ error: "请输入问题" });
    if (question.length > 12_000) return res.status(400).json({ error: "问题过长，请聚焦一个具体问题" });
    const snapshot = workflowQuestionSnapshot(workflow);
    const provider = normalizeProviderId(req.body?.plannerEngine || workflow.plannerEngine);
    const controller = new AbortController();
    activeQuestions.get(workflow.id)?.abort(new Error("已有新的询问"));
    activeQuestions.set(workflow.id, controller);
    const timeout = setTimeout(() => controller.abort(new Error("询问超时，请稍后重试")), 120_000);
    timeout.unref();
    const disconnected = () => { if (!res.writableEnded) controller.abort(new Error("询问连接已关闭")); };
    res.on("close", disconnected);
    try {
      const statusQuestion = isWorkflowStatusQuestion(question);
      if (!statusQuestion && !ports.answerWorkflowQuestion) return res.status(409).json({ error: "当前执行器不支持无工具快照问答；可先询问任务进度，或在普通对话中分析这个问题", code: "snapshot-question-unsupported" });
      const answer = statusQuestion ? workflowStatusAnswer(snapshot) : await ports.answerWorkflowQuestion!(snapshot, question, provider, controller.signal);
      controller.signal.throwIfAborted();
      if (!answer.trim()) throw new Error("询问没有返回有效回答");
      const current = workflowRepository.get(workflow.id, req.authUser!.id);
      if (!current) return res.status(404).json({ error: "工作流已删除" });
      workflowRepository.appendPlannerLog(workflow.id, req.authUser!.id, workflowLog("message", "任务问答", answer));
      const answered = workflowRepository.get(workflow.id, req.authUser!.id)!;
      workflowEvent(workflow.id, "workflow.question.answered", req.authUser!.id, workflow.workspaceId, answered.revision);
      return res.json({ accepted: true, queriedSnapshot: true, queryAnswer: answer, answer, snapshotRevision: snapshot.revision, capturedAt: snapshot.capturedAt, workflow: answered });
    } catch (error) {
      if (!res.destroyed) return res.status(controller.signal.aborted ? 409 : 502).json({ error: error instanceof Error ? error.message : String(error), code: "snapshot-question-failed" });
      return;
    } finally {
      clearTimeout(timeout);
      res.off("close", disconnected);
      if (activeQuestions.get(workflow.id) === controller) activeQuestions.delete(workflow.id);
    }
  }
  const existingController = activeWorkflowPlanners.get(workflow.id);
  if (existingController || workflow.status === "planning") {
    return res.status(202).json({ accepted: true, alreadyRunning: true, workflow: workflowRepository.get(workflow.id, req.authUser!.id) });
  }
  const maintenance = req.body?.source === "maintenance";
  if (workflow.pendingMaintenance) return res.status(202).json({ accepted: true, alreadyRunning: true, queuedUntilCheckpoint: true, workflow });
  try {
    const workspace = workspaceById(workflow.workspaceId, req.authUser!.id);
    if (!workspace) throw new Error("工作区不存在");
    const requestedPlanner = normalizeProviderId(req.body?.plannerEngine || workflow.plannerEngine);
    const requestedProvider = agentAdapterRegistry.descriptor(requestedPlanner);
    if (!requestedProvider?.capabilities.workflow.planner || !agentAdapterRegistry.workflowPlannerRunner(requestedPlanner)) throw new Error("规划 Provider 未注册或不支持工作流规划");
    const readiness = requestedPlanner === workflow.plannerEngine
      ? await providerReadiness(workflow.plannerEngine, req.authUser!.id, workspace)
      : await providerReadiness(requestedPlanner, req.authUser!.id, workspace);
    if (!readiness.ready) return res.status(409).json({ error: readiness.issues[0]?.message || "规划 Agent 尚未准备好", code: "provider-not-ready", readiness });
    const mode: WorkflowPlanningMode = req.body?.mode === "fresh" ? "fresh" : req.body?.mode === "refine" ? "refine" : workflow.activePlanVersion > 0 && workflow.reviewNote ? "refine" : "initial";
    if (mode === "refine" && !workflow.plan) throw new Error("当前没有可追加修改的完整计划");
    const previousPlan = mode === "refine" ? workflow.plan : null;
    const note = String(req.body?.note ?? workflow.reviewNote ?? "").trim() || null;
    const intent = req.body?.intent === "question" ? "question" : "adjust";
    if (maintenance) {
      if (mode !== "refine") throw new Error("规划维护只能基于当前完整计划追加修改");
      if (!note) throw new Error("请输入需要调整或询问的内容");
      if (["queued", "running", "integrating", "paused"].includes(workflow.status)) {
        const queued = workflowRepository.requestMaintenance(workflow.id, req.authUser!.id, workflow.revision, { note, intent, plannerEngine: requestedPlanner, requestedAt: new Date().toISOString(), resumeAfter: workflow.status !== "paused" });
        workflowStateFiles.sync(queued);
        workflowStateFiles.appendEvent(queued, { type: "maintenance.checkpoint.requested", payload: { intent, plannerEngine: requestedPlanner } });
        workflowEvent(queued.id, "workflow.maintenance.queued", req.authUser!.id, queued.workspaceId, queued.revision);
        queueWorkflowTick(queued.id, req.authUser!.id);
        queuePendingMaintenance(queued.id, req.authUser!.id);
        return res.status(202).json({ accepted: true, queuedUntilCheckpoint: true, alreadyRunning: false, workflow: queued });
      }
      workflowRepository.changePlannerProvider(workflow.id, req.authUser!.id, requestedPlanner);
      const started = workflowRepository.startMaintenance(workflow.id, req.authUser!.id, workflowLog("status", "维护规划", "正在读取当前机器计划并判断是否需要修改"), note, { note, intent, plannerEngine: requestedPlanner, requestedAt: new Date().toISOString(), resumeAfter: false });
      try { workflowStateFiles.beginMaintenance(started, note); }
      catch (error) {
        workflowRepository.finishMaintenanceWithoutPlan(workflow.id, req.authUser!.id, workflowLog("error", "维护启动失败", error instanceof Error ? error.message : String(error)));
        throw error;
      }
    } else {
      const switched = workflowRepository.changePlannerProvider(workflow.id, req.authUser!.id, requestedPlanner);
      workflowRepository.setPlanning(workflow.id, req.authUser!.id, switched.revision, workflowLog("status", mode === "refine" ? "追加修改计划" : mode === "fresh" ? "重新生成计划" : "开始规划", mode === "refine" ? "正在读取上一版完整计划和用户调整意见" : "正在读取初始任务并建立规划上下文"), { reviewNote: note, resetSession: mode === "fresh" });
    }
    const controller = new AbortController();
    activeWorkflowPlanners.set(workflow.id, controller);
    activeWorkflowPlannerRuns.set(workflow.id, { mode, maintenance });
    const snapshot = workflowRepository.get(workflow.id, req.authUser!.id)!;
    res.status(202).json({ accepted: true, alreadyRunning: false, workflow: snapshot });
    void executeWorkflowPlanningRun({ workflowId: workflow.id, ownerUserId: req.authUser!.id, mode, note, previousPlan, baseWorkflow: snapshot, maintenance, controller, intent });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

app.post("/api/workflows/:id/approve", withAdmission(async (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    if (workflowRuntimeActive(workflow.id)) throw new Error("规划仍在结束，请稍后批准执行");
    await assertWorkflowExecutionReady(workflow, req.authUser!.id);
    const snapshot = workflow.activePlanVersion > 1 ? await captureWorkspaceSnapshot(workflow.executionRoot || workflow.workDirectory) : undefined;
    const validationMode = req.body?.validationMode;
    if (validationMode !== undefined && !["standard", "strict", "deterministic"].includes(validationMode)) throw new Error("无效的验收方式");
    if (workflow.plan?.validationMode === "deterministic" && validationMode === undefined) throw new Error("机器验收需要在计划审批时明确选择；可选择标准或严格验收");
    const approved = await workflowRepository.approveWithEvidence(workflow.id, req.authUser!.id, Number(req.body?.revision), snapshot, validationMode);
    workflowStateFiles.sync(approved);
    workflowStateFiles.applyMaintenance(approved);
    workflowStateFiles.appendEvent(approved, { type: "plan.approved", payload: { version: approved.activePlanVersion } });
    workflowEvent(approved.id, "workflow.plan.approved", req.authUser!.id, approved.workspaceId, approved.revision);
    queueWorkflowTick(approved.id, req.authUser!.id);
    res.json(approved);
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
}));

app.post("/api/workflows/:id/retry-integration", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    if (workflow.status !== "needs_review" || !workflow.integrationStartedAt) throw new Error("当前工作流不在最终验收待处理状态");
    if (activeWorkflowIntegrations.has(workflow.id)) throw new Error("最终整合正在运行");
    if (workflow.nodes.some((node) => node.required && node.status !== "completed")) throw new Error("仍有必需执行节点未完成，不能只重试最终验收");
    const queued = workflowRepository.prepareIntegrationRetry(workflow.id, req.authUser!.id);
    workflowStateFiles.sync(queued);
    workflowStateFiles.appendEvent(queued, { type: "integration.retry_requested" });
    queueWorkflowTick(workflow.id, req.authUser!.id);
    workflowEvent(workflow.id, "workflow.integration.retry", req.authUser!.id, workflow.workspaceId, queued.revision);
    res.json(queued);
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/workflows/:id/nodes/:nodeId/pause", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    const node = workflow.nodes.find((item) => item.id === req.params.nodeId);
    if (!node) throw new Error("工作流节点不存在");
    const key = `${workflow.id}:${node.id}`;
    if (node.status === "running" && !activeWorkflowNodes.has(key)) throw new Error("节点运行控制器正在切换，请稍后重试");
    const requested = workflowRepository.requestNodePause(workflow.id, req.authUser!.id, node.id);
    if (node.status === "running") {
      workflowNodeIntents.set(key, "pause");
      activeWorkflowNodes.get(key)?.abort(new Error("用户请求暂停节点"));
    } else {
      workflowStateFiles.sync(requested);
      workflowStateFiles.appendEvent(requested, { type: "node.paused", nodeId: node.id });
      workflowEvent(requested.id, "workflow.node.paused", req.authUser!.id, requested.workspaceId, requested.revision, node.id);
    }
    res.status(202).json(requested);
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/workflows/:id/nodes/:nodeId/resume", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    if (workflow.pendingMaintenance || activeWorkflowPlanners.has(workflow.id)) throw new Error("调整请求仍在处理，请先完成计划审批");
    const resumed = workflowRepository.resumeNode(workflow.id, req.authUser!.id, req.params.nodeId);
    workflowStateFiles.sync(resumed);
    workflowStateFiles.appendEvent(resumed, { type: "node.resumed", nodeId: req.params.nodeId });
    queueWorkflowTick(resumed.id, req.authUser!.id);
    workflowEvent(resumed.id, "workflow.node.resumed", req.authUser!.id, resumed.workspaceId, resumed.revision, req.params.nodeId);
    res.json(resumed);
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/workflows/:id/nodes/:nodeId/restart", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    if (workflow.pendingMaintenance || activeWorkflowPlanners.has(workflow.id)) throw new Error("调整请求仍在处理，请先完成计划审批");
    const node = workflow.nodes.find((item) => item.id === req.params.nodeId);
    if (!node) throw new Error("工作流节点不存在");
    const key = `${workflow.id}:${node.id}`;
    if (node.status === "running") {
      if (!activeWorkflowNodes.has(key)) throw new Error("节点运行控制器正在切换，请稍后重试");
      const requested = workflowRepository.requestNodeRestart(workflow.id, req.authUser!.id, node.id);
      workflowNodeIntents.set(key, "restart");
      activeWorkflowNodes.get(key)?.abort(new Error("用户请求重新执行节点"));
      res.status(202).json(requested);
    } else {
      const restarted = workflowRepository.restartNode(workflow.id, req.authUser!.id, node.id);
      workflowStateFiles.sync(restarted);
      workflowStateFiles.appendEvent(restarted, { type: "node.restart_requested", nodeId: node.id });
      queueWorkflowTick(restarted.id, req.authUser!.id);
      workflowEvent(restarted.id, "workflow.node.restart_requested", req.authUser!.id, restarted.workspaceId, restarted.revision, node.id);
      res.json(restarted);
    }
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/workflows/:id/nodes/:nodeId/cancel", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    const node = workflow.nodes.find((item) => item.id === req.params.nodeId);
    if (!node) throw new Error("工作流节点不存在");
    const key = `${workflow.id}:${node.id}`;
    const canceled = workflowRepository.cancelNode(workflow.id, req.authUser!.id, node.id);
    if (activeWorkflowNodes.has(key)) {
      workflowNodeIntents.set(key, "cancel");
      activeWorkflowNodes.get(key)?.abort(new Error("用户终止节点"));
    } else {
      workflowStateFiles.sync(canceled);
      workflowStateFiles.appendEvent(canceled, { type: "node.canceled", nodeId: node.id });
      workflowEvent(canceled.id, "workflow.node.canceled", req.authUser!.id, canceled.workspaceId, canceled.revision, node.id);
      queueWorkflowTick(canceled.id, req.authUser!.id);
    }
    res.status(202).json(canceled);
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/workflows/:id/nodes/:nodeId/retry", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    if ([...activeWorkflowNodes.keys()].some((key) => key.startsWith(`${workflow.id}:`))) throw new Error("仍有执行节点正在运行");
    const queued = workflowRepository.retryNodes(workflow.id, req.authUser!.id, [req.params.nodeId]);
    workflowStateFiles.sync(queued);
    workflowStateFiles.appendEvent(queued, { type: "node.retry_requested", nodeId: req.params.nodeId });
    queueWorkflowTick(queued.id, req.authUser!.id);
    workflowEvent(queued.id, "workflow.node.retry_requested", req.authUser!.id, queued.workspaceId, queued.revision, req.params.nodeId);
    res.json(queued);
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/workflows/:id/nodes/:nodeId/repair-result", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    if ([...activeWorkflowNodes.keys()].some((key) => key.startsWith(`${workflow.id}:`))) throw new Error("仍有执行节点正在运行");
    const queued = workflowRepository.prepareResultRepair(workflow.id, req.authUser!.id, req.params.nodeId);
    workflowStateFiles.sync(queued);
    workflowStateFiles.appendEvent(queued, { type: "node.result_repair_requested", nodeId: req.params.nodeId });
    queueWorkflowTick(queued.id, req.authUser!.id);
    workflowEvent(queued.id, "workflow.node.result_repair_requested", req.authUser!.id, queued.workspaceId, queued.revision, req.params.nodeId);
    res.json(queued);
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/workflows/:id/retry-failed-nodes", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    if ([...activeWorkflowNodes.keys()].some((key) => key.startsWith(`${workflow.id}:`))) throw new Error("仍有执行节点正在运行");
    const queued = workflowRepository.retryNodes(workflow.id, req.authUser!.id);
    workflowStateFiles.sync(queued);
    workflowStateFiles.appendEvent(queued, { type: "failed_nodes.retry_requested" });
    queueWorkflowTick(queued.id, req.authUser!.id);
    workflowEvent(queued.id, "workflow.failed_nodes.retry_requested", req.authUser!.id, queued.workspaceId, queued.revision);
    res.json(queued);
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/workflows/:id/revise", withAdmission(async (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try { const revised = workflowRepository.revise(workflow.id, req.authUser!.id, Number(req.body?.revision), String(req.body?.note || "")); workflowStateFiles.sync(revised); workflowStateFiles.appendEvent(revised, { type: "plan.rejected" }); workflowEvent(revised.id, "workflow.plan.rejected", req.authUser!.id, revised.workspaceId, revised.revision); res.json(revised); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
}));

app.post("/api/workflows/:id/pause", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    const plannerRun = activeWorkflowPlannerRuns.get(workflow.id);
    if (workflow.status === "paused" && req.body?.mode !== "immediate" && !plannerRun) return res.status(202).json(workflow);
    if (req.body?.mode !== "immediate" && !plannerRun && ["queued", "running", "integrating"].includes(workflow.status)) {
      const paused = workflowRepository.checkpointPause(workflow.id, req.authUser!.id, workflow.revision);
      workflowStateFiles.sync(paused);
      workflowStateFiles.appendEvent(paused, { type: "workflow.checkpoint.requested", payload: { from: paused.pausedFromStatus } });
      workflowEvent(paused.id, "workflow.paused", req.authUser!.id, paused.workspaceId, paused.revision);
      queueWorkflowTick(paused.id, req.authUser!.id);
      return res.status(202).json(paused);
    }
    const paused = workflowRepository.pause(workflow.id, req.authUser!.id, workflow.revision, plannerRun || {});
    activeWorkflowPlanners.get(workflow.id)?.abort(new Error("用户暂停工作流规划"));
    for (const [key, controller] of activeWorkflowNodes) if (key.startsWith(`${workflow.id}:`)) {
      workflowNodeIntents.set(key, "pause");
      controller.abort(new Error("用户暂停整个工作流"));
    }
    activeWorkflowIntegrations.get(workflow.id)?.abort(new Error("用户暂停最终整合"));
    workflowStateFiles.sync(paused);
    workflowStateFiles.appendEvent(paused, { type: "workflow.paused", payload: { from: paused.pausedFromStatus } });
    workflowEvent(paused.id, "workflow.paused", req.authUser!.id, paused.workspaceId, paused.revision);
    res.status(202).json(paused);
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/workflows/:id/resume", withAdmission(async (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    if (workflow.pendingMaintenance) {
      if (workflow.pauseMode === "immediate") workflowRepository.prepareMaintenanceResume(workflow.id, req.authUser!.id, workflow.revision);
      queuePendingMaintenance(workflow.id, req.authUser!.id);
      return res.status(202).json({ accepted: true, queuedUntilCheckpoint: true, workflow });
    }
    if (activeWorkflowPlanners.has(workflow.id) || activeWorkflowIntegrations.has(workflow.id) || [...activeWorkflowNodes.keys()].some((key) => key.startsWith(`${workflow.id}:`))) throw new Error("工作流仍在安全暂停中，请稍后继续");
    if (workflow.pausedPlanningMode) {
      const workspace = workspaceById(workflow.workspaceId, req.authUser!.id);
      if (!workspace) throw new Error("工作区不存在");
      const readiness = await providerReadiness(workflow.plannerEngine, req.authUser!.id, workspace);
      if (!readiness.ready) throw new Error(readiness.issues[0]?.message || "规划 Agent 尚未准备好");
    } else await assertWorkflowExecutionReady(workflow, req.authUser!.id);
    const from = workflow.pausedFromStatus;
    const mode = workflow.pausedPlanningMode || "initial";
    const maintenance = workflow.pausedPlanningMaintenance;
    const resumed = workflowRepository.resume(workflow.id, req.authUser!.id, workflow.revision);
    workflowStateFiles.sync(resumed);
    workflowStateFiles.appendEvent(resumed, { type: "workflow.resumed", payload: { from } });
    workflowEvent(resumed.id, "workflow.resumed", req.authUser!.id, resumed.workspaceId, resumed.revision);
    if (workflow.pausedPlanningMode) {
      const controller = new AbortController();
      activeWorkflowPlanners.set(resumed.id, controller);
      activeWorkflowPlannerRuns.set(resumed.id, { mode, maintenance });
      const previousPlan = mode === "refine" ? resumed.plan : null;
      void executeWorkflowPlanningRun({ workflowId: resumed.id, ownerUserId: req.authUser!.id, mode, note: resumed.reviewNote, previousPlan, baseWorkflow: resumed, maintenance, controller });
    } else queueWorkflowTick(resumed.id, req.authUser!.id);
    res.json(resumed);
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
}));

app.post("/api/workflows/:id/cancel", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    const canceled = workflowRepository.cancel(workflow.id, req.authUser!.id, workflow.revision);
    activeWorkflowPlanners.get(workflow.id)?.abort(new Error("规划已取消"));
    for (const [key, controller] of activeWorkflowNodes) if (key.startsWith(`${workflow.id}:`)) { workflowNodeIntents.set(key, "cancel"); controller.abort(new Error("工作流已终止")); }
    activeWorkflowIntegrations.get(workflow.id)?.abort(new Error("最终整合已取消"));
    workflowStateFiles.sync(canceled);
    workflowStateFiles.appendEvent(canceled, { type: "workflow.canceled" });
    workflowEvent(canceled.id, "workflow.canceled", req.authUser!.id, canceled.workspaceId, canceled.revision); res.json(canceled);
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

}
