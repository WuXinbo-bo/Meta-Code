import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { workflowNodeContractDigest } from "./plan.js";
import { captureWorkspaceSnapshotSync, type WorkspaceSnapshot } from "./enforcement.js";
import { workflowExecutionRoot } from "./executionRoot.js";
import { workflowCompletedFileIntegrityIssues, workflowResultFileIntegrityIssue } from "./fileIntegrity.js";
import type { WorkflowNodeResult, WorkflowPlan, WorkflowRecord } from "./types.js";

export type WorkflowPlanImpact = {
  reused: string[];
  rerun: string[];
  added: string[];
  removed: string[];
  requiresIntegration: boolean;
};

export type WorkflowMaintenanceMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  planVersion?: number;
};

export type WorkflowMaintenanceBranch = {
  id: string;
  status: "idle" | "planning" | "ready" | "failed";
  basePlanVersion: number;
  messages: WorkflowMaintenanceMessage[];
  candidatePlan: WorkflowPlan | null;
  impact: WorkflowPlanImpact | null;
  updatedAt: string;
};

type WorkflowFile = {
  schemaVersion: 1;
  workflowId: string;
  revision: number;
  updatedAt: string;
  originalGoal: string;
  plannerEngine: string;
  status: string;
  activePlanVersion: number;
  activePlan: WorkflowPlan | null;
  maintenanceBranch: WorkflowMaintenanceBranch | null;
};

type WorkflowResultsFile = {
  schemaVersion: 1;
  workflowId: string;
  revision: number;
  updatedAt: string;
  nodes: Record<string, {
    status: string;
    attempt: number;
    contractDigest: string;
    inputDigests: Record<string, string | null>;
    resultDigest: string | null;
    result: WorkflowNodeResult | null;
    staleReason: string | null;
    error: string | null;
  }>;
  integration: {
    phase: string | null;
    attempt: number;
    integratorResult: WorkflowNodeResult | null;
    validatorResult: WorkflowNodeResult | null;
  };
  finalResult: WorkflowNodeResult | null;
};

type WorkflowEventInput = {
  type: string;
  nodeId?: string;
  attempt?: number;
  payload?: unknown;
};

function safeRunId(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(id)) throw new Error("工作流 ID 无效");
  return id;
}

function files(workDirectory: string, runtimeRoot?: string, workflowId?: string) {
  // The optional runtime root is used by the orchestration plugin. Keeping the
  // legacy fallback makes old data and standalone library consumers readable.
  const directory = runtimeRoot && workflowId
    ? path.resolve(runtimeRoot, safeRunId(workflowId))
    : path.resolve(workDirectory, ".workflow");
  return {
    directory,
    workflow: path.join(directory, "workflow.json"),
    results: path.join(directory, "results.json"),
    events: path.join(directory, "events.jsonl")
  };
}

function readJson<T>(target: string): T | null {
  try { return JSON.parse(fs.readFileSync(target, "utf8")) as T; }
  catch { return null; }
}

function atomicWriteJson(target: string, value: unknown) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

function resultDigest(result: WorkflowNodeResult | null) {
  if (!result) return null;
  return crypto.createHash("sha256").update(JSON.stringify({ outputs: result.outputs, decisions: result.decisions, handoff: result.handoff, checks: result.checks })).digest("hex");
}

export function calculateWorkflowPlanImpact(workflow: WorkflowRecord, nextPlan: WorkflowPlan, snapshot?: WorkspaceSnapshot): WorkflowPlanImpact {
  const previous = new Map((workflow.plan?.nodes || []).map((node) => [node.id, node]));
  const next = new Map(nextPlan.nodes.map((node) => [node.id, node]));
  const added = [...next.keys()].filter((id) => !previous.has(id));
  const removed = [...previous.keys()].filter((id) => !next.has(id));
  const directlyChanged = new Set(nextPlan.nodes.filter((node) => {
    const old = previous.get(node.id);
    return old && workflowNodeContractDigest(old) !== workflowNodeContractDigest(node);
  }).map((node) => node.id));
  const completedNodes = workflow.nodes.filter((node) => node.status === "completed" && node.summary);
  let currentSnapshot = snapshot;
  let snapshotIssue: string | null = null;
  if (!currentSnapshot && completedNodes.some((node) => node.summary?.fileIntegrity)) {
    try { currentSnapshot = captureWorkspaceSnapshotSync(workflowExecutionRoot(workflow)); }
    catch (error) { snapshotIssue = error instanceof Error ? error.message : String(error); }
  }
  const eligibleWriters = new Set(workflow.nodes.filter((node) => next.has(node.id) && previous.has(node.id)
    && workflowNodeContractDigest(previous.get(node.id)!) === workflowNodeContractDigest(next.get(node.id)!)).map((node) => node.id));
  let writerEligibilityChanged = true;
  while (writerEligibilityChanged) {
    writerEligibilityChanged = false;
    for (const node of nextPlan.nodes) if (eligibleWriters.has(node.id) && node.dependsOn.some((id) => !eligibleWriters.has(id))) {
      eligibleWriters.delete(node.id); writerEligibilityChanged = true;
    }
  }
  const fileIssues = currentSnapshot ? workflowCompletedFileIntegrityIssues(workflow, currentSnapshot, eligibleWriters) : null;
  for (const node of completedNodes) if (snapshotIssue || (fileIssues ? fileIssues.has(node.id) : workflowResultFileIntegrityIssue(workflow, node.summary))) directlyChanged.add(node.id);
  const affected = new Set(directlyChanged);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const node of nextPlan.nodes) {
      if (affected.has(node.id) || !node.dependsOn.some((dependency) => affected.has(dependency))) continue;
      affected.add(node.id); expanded = true;
    }
  }
  const completed = new Set(workflow.nodes.filter((node) => node.status === "completed" && node.summary).map((node) => node.id));
  const reused = nextPlan.nodes.filter((node) => previous.has(node.id) && completed.has(node.id) && !affected.has(node.id)).map((node) => node.id);
  const rerun = nextPlan.nodes.filter((node) => previous.has(node.id) && !reused.includes(node.id)).map((node) => node.id);
  const finalDeliveryChanged = JSON.stringify(workflow.plan?.finalDelivery || null) !== JSON.stringify(nextPlan.finalDelivery);
  return { reused, rerun, added, removed, requiresIntegration: Boolean(rerun.length || added.length || removed.length || finalDeliveryChanged) };
}

export class WorkflowStateFiles {
  private readonly maintenanceCache = new Map<string, WorkflowMaintenanceBranch | null>();

  constructor(private readonly runtimeRoot?: string) {}

  directoryFor(workflowId: string) {
    if (!this.runtimeRoot) throw new Error("当前工作流状态没有配置插件运行目录");
    return path.resolve(this.runtimeRoot, safeRunId(workflowId));
  }

  private files(workflow: Pick<WorkflowRecord, "workDirectory" | "id">) {
    const target = files(workflow.workDirectory, this.runtimeRoot, workflow.id);
    if (this.runtimeRoot) this.migrateLegacyFiles(workflow, target);
    return target;
  }

  private readonly migrated = new Set<string>();

  private migrateLegacyFiles(workflow: Pick<WorkflowRecord, "id" | "workDirectory">, target: ReturnType<typeof files>) {
    if (this.migrated.has(workflow.id)) return;
    const legacy = files(workflow.workDirectory);
    const marker = path.join(target.directory, "legacy-migration.json");
    const safePath = (root: string, relative: string) => {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === ".." || part === ".")) throw new Error("编排迁移路径无效");
      let current = root;
      for (const part of ["", ...relative.split(/[\\/]/)]) {
        current = path.join(current, part);
        try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("编排迁移目录不能包含符号链接"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      return current;
    };
    safePath(this.runtimeRoot!, workflow.id);
    safePath(target.directory, "legacy-migration.json");
    // A durable marker permits cleanup to resume even after workflow.json was
    // removed before a crash. A different run must never claim these files.
    const old = readJson<WorkflowFile>(legacy.workflow);
    if (!fs.existsSync(marker) && (!old || old.schemaVersion !== 1 || old.workflowId !== workflow.id)) {
      this.migrated.add(workflow.id); return;
    }
    if (old && old.workflowId !== workflow.id) { this.migrated.add(workflow.id); return; }
    const knownFile = (relative: string) => /^(workflow\.json|results\.json|events\.jsonl)$/.test(relative)
      || /^nodes\/[a-zA-Z0-9_-]+\/(?:plans\/\d+\/)?attempts\/\d+\/(before-snapshot\.json|raw-output\.txt|result-transaction\.json|verified-result\.json|write-manifest\.json)$/.test(relative.replaceAll("\\", "/"));
    const collect = (relative = ""): string[] => fs.readdirSync(safePath(legacy.directory, relative), { withFileTypes: true }).flatMap((entry) => {
      if (entry.isSymbolicLink()) return [];
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        const normalized = child.replaceAll("\\", "/");
        if (/^nodes(?:\/[a-zA-Z0-9_-]+(?:\/(?:plans(?:\/\d+)?(?:\/attempts(?:\/\d+)?)?|attempts(?:\/\d+)?))?)?$/.test(normalized)) return collect(child);
        return [];
      }
      return entry.isFile() && knownFile(child) ? [child] : [];
    });
    if (!fs.existsSync(marker)) {
      const selected = collect();
      fs.mkdirSync(target.directory, { recursive: true, mode: 0o700 });
      for (const relative of selected) {
        const source = safePath(legacy.directory, relative);
        const backup = safePath(target.directory, path.join("legacy-backup", relative));
        const destination = safePath(target.directory, relative);
        const content = fs.readFileSync(source);
        fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
        if (!fs.existsSync(backup)) fs.writeFileSync(backup, content, { flag: "wx", mode: 0o600 });
        if (!fs.readFileSync(backup).equals(content)) throw new Error("旧编排状态备份校验失败");
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        if (!fs.existsSync(destination)) fs.writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
      }
      atomicWriteJson(marker, { schemaVersion: 1, workflowId: workflow.id, files: selected });
    }
    const migration = readJson<{ schemaVersion: number; workflowId: string; files: string[] }>(marker);
    if (migration?.schemaVersion !== 1 || migration.workflowId !== workflow.id || !Array.isArray(migration.files)) throw new Error("编排迁移标记损坏");
    for (const relative of migration.files) {
      if (typeof relative !== "string" || !knownFile(relative)) throw new Error("编排迁移路径无效");
      const source = safePath(legacy.directory, relative);
      const backup = safePath(target.directory, path.join("legacy-backup", relative));
      if (!fs.existsSync(backup)) throw new Error("编排迁移备份缺失");
      if (fs.existsSync(source) && fs.readFileSync(source).equals(fs.readFileSync(backup))) fs.unlinkSync(source);
      // Prune only directories that contained verified workbench files.
      let parent = path.dirname(source);
      while (parent !== path.dirname(legacy.directory)) {
        try { fs.rmdirSync(parent); } catch { break; }
        parent = path.dirname(parent);
      }
    }
    this.migrated.add(workflow.id);
  }

  checkpointDirectory(workflow: Pick<WorkflowRecord, "id" | "workDirectory">, previous: string) {
    const target = this.files(workflow);
    if (!this.runtimeRoot) return previous;
    const relative = path.relative(path.join(workflow.workDirectory, ".workflow"), previous);
    if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return path.join(target.directory, relative);
    return previous;
  }

  syncWorkflow(workflow: WorkflowRecord, maintenanceBranch?: WorkflowMaintenanceBranch | null) {
    const target = this.files(workflow);
    const cacheKey = workflow.id;
    const existing = maintenanceBranch === undefined && !this.maintenanceCache.has(cacheKey) ? readJson<WorkflowFile>(target.workflow) : null;
    const branch = maintenanceBranch === undefined ? this.maintenanceCache.get(cacheKey) ?? (existing?.workflowId === workflow.id ? existing.maintenanceBranch : null) ?? null : maintenanceBranch;
    const snapshot: WorkflowFile = {
      schemaVersion: 1,
      workflowId: workflow.id,
      revision: workflow.revision,
      updatedAt: new Date().toISOString(),
      originalGoal: workflow.originalPrompt,
      plannerEngine: workflow.plannerEngine,
      status: workflow.status,
      activePlanVersion: workflow.activePlanVersion,
      activePlan: workflow.plan,
      maintenanceBranch: branch
    };
    atomicWriteJson(target.workflow, snapshot);
    this.maintenanceCache.set(cacheKey, branch);
    if (!fs.existsSync(target.events)) fs.writeFileSync(target.events, "", "utf8");
    return snapshot;
  }

  syncResults(workflow: WorkflowRecord) {
    const target = this.files(workflow);
    const existing = readJson<WorkflowResultsFile>(target.results);
    if (existing && existing.workflowId === workflow.id && existing.revision >= workflow.revision) {
      for (const node of workflow.nodes.filter((item) => item.status === "completed" && item.summary)) {
        const entry = existing.nodes[node.id];
        const expected = node.resultDigest || resultDigest(node.summary);
        if (entry?.result && expected && resultDigest(entry.result) !== expected) throw new Error(`节点「${node.title}」的 results.json 哈希不一致，拒绝覆盖可疑机器状态`);
      }
    }
    const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
    const nodes = Object.fromEntries(workflow.nodes.map((node) => [node.id, {
      status: node.status,
      attempt: node.attempt,
      contractDigest: workflowNodeContractDigest(node),
      inputDigests: Object.fromEntries(node.dependsOn.map((dependency) => [dependency, byId.get(dependency)?.resultDigest || resultDigest(byId.get(dependency)?.summary || null)])),
      resultDigest: node.resultDigest || resultDigest(node.summary),
      result: node.summary,
      staleReason: node.staleReason,
      error: node.error
    }]));
    const snapshot: WorkflowResultsFile = {
      schemaVersion: 1,
      workflowId: workflow.id,
      revision: workflow.revision,
      updatedAt: new Date().toISOString(),
      nodes,
      integration: {
        phase: workflow.integrationPhase,
        attempt: workflow.integrationAttempt,
        integratorResult: workflow.integratorResult,
        validatorResult: workflow.validatorResult
      },
      finalResult: workflow.finalResult
    };
    atomicWriteJson(target.results, snapshot);
    return snapshot;
  }

  sync(workflow: WorkflowRecord) {
    this.syncWorkflow(workflow);
    return this.syncResults(workflow);
  }

  appendEvent(workflow: Pick<WorkflowRecord, "id" | "workDirectory" | "revision">, input: WorkflowEventInput) {
    const target = this.files(workflow);
    fs.mkdirSync(target.directory, { recursive: true });
    const event = {
      schemaVersion: 1,
      id: `workflow-event-${crypto.randomUUID()}`,
      workflowId: workflow.id,
      revision: workflow.revision,
      createdAt: new Date().toISOString(),
      ...input
    };
    fs.appendFileSync(target.events, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  results(workflow: Pick<WorkflowRecord, "workDirectory" | "id">) {
    const result = readJson<WorkflowResultsFile>(this.files(workflow).results);
    return result?.workflowId === workflow.id ? result : null;
  }

  maintenance(workflow: Pick<WorkflowRecord, "workDirectory" | "id">) {
    const cacheKey = workflow.id;
    if (this.maintenanceCache.has(cacheKey)) return this.maintenanceCache.get(cacheKey) || null;
    const stored = readJson<WorkflowFile>(this.files(workflow).workflow);
    const branch = stored?.workflowId === workflow.id ? stored.maintenanceBranch : null;
    this.maintenanceCache.set(cacheKey, branch);
    return branch;
  }

  beginMaintenance(workflow: WorkflowRecord, text: string) {
    const current = this.maintenance(workflow);
    const now = new Date().toISOString();
    const branch: WorkflowMaintenanceBranch = current && current.basePlanVersion === workflow.activePlanVersion
      ? { ...current, status: "planning", messages: [...current.messages, { id: `maintenance-message-${crypto.randomUUID()}`, role: "user", text, createdAt: now }], updatedAt: now }
      : { id: `maintenance-${crypto.randomUUID()}`, status: "planning", basePlanVersion: workflow.activePlanVersion, messages: [{ id: `maintenance-message-${crypto.randomUUID()}`, role: "user", text, createdAt: now }], candidatePlan: null, impact: null, updatedAt: now };
    this.syncWorkflow(workflow, branch);
    this.appendEvent(workflow, { type: "planner.maintenance.requested", payload: { branchId: branch.id, text } });
    return branch;
  }

  finishMaintenance(workflow: WorkflowRecord, plan: WorkflowPlan, impact: WorkflowPlanImpact, assistantText?: string) {
    const current = this.maintenance(workflow);
    if (!current) return null;
    const now = new Date().toISOString();
    const summary = `候选计划 v${workflow.activePlanVersion}：复用 ${impact.reused.length}，重跑 ${impact.rerun.length}，新增 ${impact.added.length}，删除 ${impact.removed.length}`;
    const branch: WorkflowMaintenanceBranch = {
      ...current,
      status: "ready",
      basePlanVersion: workflow.activePlanVersion,
      candidatePlan: plan,
      impact,
      messages: [...current.messages, { id: `maintenance-message-${crypto.randomUUID()}`, role: "assistant", text: assistantText?.trim().slice(0, 4_000) || summary, createdAt: now, planVersion: workflow.activePlanVersion }],
      updatedAt: now
    };
    this.syncWorkflow(workflow, branch);
    this.appendEvent(workflow, { type: "planner.maintenance.completed", payload: { branchId: branch.id, impact } });
    return branch;
  }

  failMaintenance(workflow: WorkflowRecord, error: string) {
    const current = this.maintenance(workflow);
    if (!current) return null;
    const now = new Date().toISOString();
    const branch: WorkflowMaintenanceBranch = {
      ...current,
      status: "failed",
      messages: [...current.messages, { id: `maintenance-message-${crypto.randomUUID()}`, role: "system", text: error, createdAt: now }],
      updatedAt: now
    };
    this.syncWorkflow(workflow, branch);
    this.appendEvent(workflow, { type: "planner.maintenance.failed", payload: { branchId: branch.id, error } });
    return branch;
  }

  finishMaintenanceWithoutChange(workflow: WorkflowRecord, note: string) {
    const current = this.maintenance(workflow);
    if (!current) return null;
    const now = new Date().toISOString();
    const branch: WorkflowMaintenanceBranch = {
      ...current,
      status: "idle",
      messages: [...current.messages, { id: `maintenance-message-${crypto.randomUUID()}`, role: "assistant", text: note, createdAt: now }],
      updatedAt: now
    };
    this.syncWorkflow(workflow, branch);
    this.appendEvent(workflow, { type: "planner.maintenance.no_change", payload: { branchId: branch.id, note } });
    return branch;
  }

  applyMaintenance(workflow: WorkflowRecord) {
    const current = this.maintenance(workflow);
    if (!current || current.status !== "ready") return null;
    const now = new Date().toISOString();
    const branch: WorkflowMaintenanceBranch = {
      ...current,
      status: "idle",
      messages: [...current.messages, { id: `maintenance-message-${crypto.randomUUID()}`, role: "system", text: `候选计划 v${workflow.activePlanVersion} 已批准，调度器将按影响范围复用或重跑节点`, createdAt: now, planVersion: workflow.activePlanVersion }],
      updatedAt: now
    };
    this.syncWorkflow(workflow, branch);
    this.appendEvent(workflow, { type: "planner.maintenance.approved", payload: { branchId: branch.id, impact: branch.impact } });
    return branch;
  }
}
