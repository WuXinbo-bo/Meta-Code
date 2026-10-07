import type { ClaudeSettings, ModelOption, Settings, SkillPolicy, SkillPolicies, ExecutionMode, TaskFolder, SkillFolder, SkillOrganization, CapabilityProfile, Workspace, Message, SessionStatus, PendingInput, Session, McpTransport, McpServer, State, DelegatedTask, AgentLog, AgentThread, AgentThreadSourceKind, AgentThreadIdentity } from "../../workbench/types.js";
import path from "node:path";
import fs from "node:fs";
import { DEFAULT_WORKFLOW_MAX_CONCURRENT_AGENTS, GLOBAL_WORKFLOW_MAX_CONCURRENT_AGENTS, type WorkflowEngine, type WorkflowNodeAttemptRecord, type WorkflowNodeLog, type WorkflowNodePhase, type WorkflowNodeRecord, type WorkflowNodeResult, type WorkflowPlan, type WorkflowPlanningMode } from "./types.js";
import {
  normalizeProviderId,
  type AgentModelAdapter,
  type AgentProviderId,
  type AgentProviderModelSelection,
  type AgentProviderManifestV1,
  type AgentReasoningControl,
  type DelegationMode,
  type DelegationRequest
} from "../../agents/types.js";
import { taskDeletionPolicy } from "../../sessionManagement/deletionPolicy.js";
import { WorkflowRepository } from "./repository.js";
import { upsertWorkflowLog, workflowLog, workflowLogFromEngineEvent, type WorkflowLogContext } from "./logs.js";
import fsp from "node:fs/promises";
import { abortWorkflowPlanTransaction, openWorkflowPlanTransaction, readWorkflowPlanTransaction } from "./plannerTransactions.js";
import { normalizeWorkflowPlan, parsePlanJson, plannerTurnPrompt, planSystemPrompt, resolveWorkflowProvider, validateWorkflowPlan, workflowNodeContractDigest, type WorkflowProviderCapabilities } from "./plan.js";
import { calculateWorkflowPlanImpact, WorkflowStateFiles } from "./stateFiles.js";
import { timeoutReason } from "../../orchestration/timeouts.js";
import type { Express } from "express";
import type { WorkflowRecord } from "./types.js";
import type { RuntimeExecutionIdentity } from "../../runtime/types.js";
import type { NormalizedEngineEvent } from "../../engines/types.js";
import type { WorkspaceTreeIndex } from "../../workspaceTreeIndex.js";
import type { AgentAdapterRegistry } from "../../agents/registry.js";
import type { ManagedSkillManager } from "../../managedSkillManager.js";

export type OrchestrationControllerPorts = {
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
};

export function registerOrchestrationRoutes(app: Express, ports: OrchestrationControllerPorts) {
  const { workspaceTreeIndex, workflowRepository, workspaceById, agentAdapterRegistry, providerReadiness, uid, workflowStateFiles, workflowEvent, workflowRuntimeActive, activeWorkflowPlanners, activeWorkflowNodes, workflowNodeIntents, activeWorkflowIntegrations, waitForWorkflowRuntimeRelease, openInSystemFileManager, assertExistingDirectory, workflowResultPath, runtimeBindingForProvider, workspaceAgentConfig, managedSkillManager, mcpServersForWorkspace, currentWorkflowProviderCapabilities, WORKFLOW_PLANNER_TRANSACTION_DIR, workflowPlannerRequestKey, requestWorkflowPlan, plannerSkillContext, workflowPlannerFailureMessage, retryableWorkflowPlannerFailure, activeWorkflowPlannerRuns, assertWorkflowExecutionReady, queueWorkflowTick } = ports;
function workflowDirectoryName(title: string) {
  const normalized = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48).replace(/[ .]+$/g, "") || "任务编排";
  return normalized;
}

function createWorkflowDirectory(workspace: Workspace, title: string) {
  const base = workflowDirectoryName(title);
  let suffix = 1;
  let directory = path.join(workspace.root, base);
  while (fs.existsSync(directory)) directory = path.join(workspace.root, `${base} (${++suffix})`);
  fs.mkdirSync(path.join(directory, "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(directory, "nodes"), { recursive: true });
  workspaceTreeIndex.invalidate(workspace.root, path.relative(workspace.root, directory));
  return directory;
}

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

app.post("/api/workflows", async (req, res) => {
  try {
    const workspace = workspaceById(String(req.body?.workspaceId || ""), req.authUser!.id);
    const prompt = String(req.body?.prompt || "").trim();
    const plannerEngine = normalizeProviderId(req.body?.plannerEngine || "claude");
    const plannerProvider = agentAdapterRegistry.descriptor(plannerEngine);
    if (!plannerProvider?.capabilities.workflow.planner || !agentAdapterRegistry.workflowPlannerRunner(plannerEngine)) return res.status(400).json({ error: "规划 Provider 未注册或不支持工作流规划" });
    const maxConcurrentAgents = requestedWorkflowConcurrency(req.body?.maxConcurrentAgents);
    if (!workspace) return res.status(400).json({ error: "请选择工作区" });
    if (!prompt) return res.status(400).json({ error: "请输入完整任务" });
    const readiness = await providerReadiness(plannerEngine, req.authUser!.id, workspace);
    if (!readiness.ready) return res.status(409).json({ error: readiness.issues[0]?.message || "规划 Agent 尚未准备好", code: "provider-not-ready", readiness });
    const id = uid("workflow");
    const workDirectory = createWorkflowDirectory(workspace, prompt.split(/\r?\n/, 1)[0]);
    const workflow = workflowRepository.create({ id, ownerUserId: req.authUser!.id, workspaceId: workspace.id, workDirectory, prompt, plannerEngine, maxConcurrentAgents });
    workflowStateFiles.sync(workflow);
    workflowStateFiles.appendEvent(workflow, { type: "workflow.created", payload: { workspaceId: workspace.id } });
    workflowEvent(workflow.id, "workflow.created", req.authUser!.id, workspace.id, workflow.revision);
    res.status(201).json(workflow);
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.get("/api/workflows/:id", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  res.setHeader("Cache-Control", "no-store"); res.json(workflow);
});

app.get("/api/workflows/:id/branches", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  res.setHeader("Cache-Control", "no-store");
  res.json(workflowRepository.listBranches(workflow.originId, req.authUser!.id));
});

app.post("/api/workflows/:id/branches", async (req, res) => {
  const source = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!source) return res.status(404).json({ error: "工作流不存在" });
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
    const workDirectory = createWorkflowDirectory(workspace, `${prompt.split(/\r?\n/, 1)[0]} - 方案 ${branchIndex}`);
    const branch = workflowRepository.create({ id, ownerUserId: req.authUser!.id, workspaceId: source.workspaceId, workDirectory, prompt, plannerEngine, maxConcurrentAgents, originId: source.originId, parentWorkflowId: source.id, branchIndex, branchLabel: `方案 ${branchIndex}`, reviewNote: String(req.body?.note || "").trim() || null });
    workflowStateFiles.sync(branch);
    workflowStateFiles.appendEvent(branch, { type: "workflow.branch.created", payload: { originId: branch.originId, parentWorkflowId: branch.parentWorkflowId, branchIndex } });
    workflowEvent(branch.id, "workflow.branch.created", req.authUser!.id, workspace.id, branch.revision);
    res.status(201).json(branch);
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});

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
    if (req.body?.archived && ["queued", "running", "integrating"].includes(workflow.status)) throw new Error("执行中的任务不能归档");
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
}) {
  const { workflowId, ownerUserId, mode, note, previousPlan, baseWorkflow, maintenance, controller } = input;
  let transactionPath = "";
  let transactionFinished = false;
  try {
    const workspace = workspaceById(baseWorkflow.workspaceId, ownerUserId); if (!workspace) throw new Error("工作区不存在");
    let snapshot = workflowRepository.get(workflowId, ownerUserId)!;
    const plannerBinding = await runtimeBindingForProvider(snapshot.plannerEngine);
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
    const planned = await requestWorkflowPlan(snapshot, workspace, allowedSkills, availableMcpServers, plannerSkillContext(workspace, policies), providerCapabilities, controller, transactionPath, (event) => {
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
    if (planned.engineSessionId) workflowRepository.setPlannerSession(workflowId, ownerUserId, snapshot.plannerSessionId || `workflow-planner:${workflowId}`, planned.engineSessionId);
    if (activeWorkflowPlanners.get(workflowId) !== controller) throw new Error("规划运行已失效");
    if (planned.noChange) {
      if (!maintenance) throw new Error("首次规划和全新重做不能以无修改结束");
      const message = planned.note || "没有检测到需要修改计划的明确要求";
      const unchanged = workflowRepository.finishMaintenanceWithoutPlan(workflowId, ownerUserId, workflowLog("message", "计划未修改", message));
      workflowStateFiles.finishMaintenanceWithoutChange(unchanged, message);
      workflowStateFiles.syncResults(unchanged);
      workflowEvent(workflowId, "workflow.planner.no_change", ownerUserId, workspace.id, unchanged.revision);
      transactionFinished = true;
      return;
    }
    const transaction = readWorkflowPlanTransaction(transactionPath);
    if (transaction.basePlanVersion !== baseWorkflow.activePlanVersion) throw new Error("规划基线版本已变化，请刷新后重新维护");
    const plan = normalizeWorkflowPlan(planned.plan);
    workflowRepository.appendPlannerLog(workflowId, ownerUserId, workflowLog("tool", "校验任务图", `规划事务已提交，共 ${plan.nodes.length} 个节点，正在执行服务端复核`));
    const errors = validateWorkflowPlan(plan, new Set(allowedSkills), new Set(availableMcpServers), providerCapabilities);
    if (errors.length) throw new Error(`计划校验失败：${errors.join("；")}`);
    workflowRepository.appendPlannerLog(workflowId, ownerUserId, workflowLog("message", "规划完成", `候选计划已原子提交，共 ${plan.nodes.length} 个节点，等待用户审批`));
    const saved = maintenance
      ? workflowRepository.saveMaintenancePlan(workflowId, ownerUserId, plan, note || undefined)
      : workflowRepository.savePlan(workflowId, ownerUserId, plan, note || undefined);
    if (maintenance) workflowStateFiles.finishMaintenance(saved, plan, calculateWorkflowPlanImpact(baseWorkflow, plan), planned.finalText);
    else workflowStateFiles.sync(saved);
    workflowStateFiles.appendEvent(saved, { type: "plan.ready", payload: { version: saved.activePlanVersion, mode, transactionId: transaction.id, digest: transaction.digest } });
    workflowEvent(workflowId, "workflow.plan.ready", ownerUserId, workspace.id, saved.revision);
    transactionFinished = true;
  } catch (error) {
    try {
      const current = workflowRepository.get(workflowId, ownerUserId);
      const message = workflowPlannerFailureMessage(error, controller);
      if (current?.status === "paused" || current?.status === "canceled") {
        if (current.status === "canceled" && transactionPath && fs.existsSync(transactionPath)) abortWorkflowPlanTransaction(transactionPath, message);
        return;
      }
      const retryable = retryableWorkflowPlannerFailure(message) || controller.signal.aborted && Boolean(timeoutReason(controller.signal));
      if (!retryable && transactionPath && fs.existsSync(transactionPath)) abortWorkflowPlanTransaction(transactionPath, message);
      const ownsPlanningRun = activeWorkflowPlanners.get(workflowId) === controller;
      if (!ownsPlanningRun || !current) return;
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
    } catch (recoveryError) { console.error("Workflow planner failure recovery failed", recoveryError); }
  } finally {
    if (activeWorkflowPlanners.get(workflowId) === controller) activeWorkflowPlanners.delete(workflowId);
    activeWorkflowPlannerRuns.delete(workflowId);
    if (transactionFinished && transactionPath) await fsp.rm(transactionPath, { force: true }).catch(() => undefined);
    const workspace = workspaceById(baseWorkflow.workspaceId, ownerUserId);
    if (workspace) workspaceTreeIndex.invalidate(workspace.root, path.relative(workspace.root, baseWorkflow.workDirectory));
  }
}

app.post("/api/workflows/:id/plan", async (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  const existingController = activeWorkflowPlanners.get(workflow.id);
  if (existingController || workflow.status === "planning") {
    return res.status(202).json({ accepted: true, alreadyRunning: true, workflow: workflowRepository.get(workflow.id, req.authUser!.id) });
  }
  const maintenance = req.body?.source === "maintenance";
  try {
    const workspace = workspaceById(workflow.workspaceId, req.authUser!.id);
    if (!workspace) throw new Error("工作区不存在");
    const readiness = await providerReadiness(workflow.plannerEngine, req.authUser!.id, workspace);
    if (!readiness.ready) return res.status(409).json({ error: readiness.issues[0]?.message || "规划 Agent 尚未准备好", code: "provider-not-ready", readiness });
    const mode: WorkflowPlanningMode = req.body?.mode === "fresh" ? "fresh" : req.body?.mode === "refine" ? "refine" : workflow.activePlanVersion > 0 && workflow.reviewNote ? "refine" : "initial";
    if (mode === "refine" && !workflow.plan) throw new Error("当前没有可追加修改的完整计划");
    const previousPlan = mode === "refine" ? workflow.plan : null;
    const note = String(req.body?.note ?? workflow.reviewNote ?? "").trim() || null;
    if (maintenance) {
      if (mode !== "refine") throw new Error("规划维护只能基于当前完整计划追加修改");
      if (!note) throw new Error("请输入需要调整或询问的内容");
      const started = workflowRepository.startMaintenance(workflow.id, req.authUser!.id, workflowLog("status", "维护规划", "正在读取当前机器计划并判断是否需要修改"), note);
      try { workflowStateFiles.beginMaintenance(started, note); }
      catch (error) {
        workflowRepository.finishMaintenanceWithoutPlan(workflow.id, req.authUser!.id, workflowLog("error", "维护启动失败", error instanceof Error ? error.message : String(error)));
        throw error;
      }
    } else {
      workflowRepository.setPlanning(workflow.id, req.authUser!.id, workflow.revision, workflowLog("status", mode === "refine" ? "追加修改计划" : mode === "fresh" ? "重新生成计划" : "开始规划", mode === "refine" ? "正在读取上一版完整计划和用户调整意见" : "正在读取初始任务并建立规划上下文"), { reviewNote: note, resetSession: mode === "fresh" });
    }
    const controller = new AbortController();
    activeWorkflowPlanners.set(workflow.id, controller);
    activeWorkflowPlannerRuns.set(workflow.id, { mode, maintenance });
    const snapshot = workflowRepository.get(workflow.id, req.authUser!.id)!;
    res.status(202).json({ accepted: true, alreadyRunning: false, workflow: snapshot });
    void executeWorkflowPlanningRun({ workflowId: workflow.id, ownerUserId: req.authUser!.id, mode, note, previousPlan, baseWorkflow: workflow, maintenance, controller });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/workflows/:id/approve", async (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    await assertWorkflowExecutionReady(workflow, req.authUser!.id);
    const approved = workflowRepository.approve(workflow.id, req.authUser!.id, Number(req.body?.revision));
    workflowStateFiles.sync(approved);
    workflowStateFiles.applyMaintenance(approved);
    workflowStateFiles.appendEvent(approved, { type: "plan.approved", payload: { version: approved.activePlanVersion } });
    workflowEvent(approved.id, "workflow.plan.approved", req.authUser!.id, approved.workspaceId, approved.revision);
    queueWorkflowTick(approved.id, req.authUser!.id);
    res.json(approved);
  } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

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

app.post("/api/workflows/:id/revise", async (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try { const revised = workflowRepository.revise(workflow.id, req.authUser!.id, Number(req.body?.revision), String(req.body?.note || "")); workflowStateFiles.sync(revised); workflowStateFiles.appendEvent(revised, { type: "plan.rejected" }); workflowEvent(revised.id, "workflow.plan.rejected", req.authUser!.id, revised.workspaceId, revised.revision); res.json(revised); }
  catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/workflows/:id/pause", (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
    const plannerRun = activeWorkflowPlannerRuns.get(workflow.id);
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

app.post("/api/workflows/:id/resume", async (req, res) => {
  const workflow = workflowRepository.get(req.params.id, req.authUser!.id);
  if (!workflow) return res.status(404).json({ error: "工作流不存在" });
  try {
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
});

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
