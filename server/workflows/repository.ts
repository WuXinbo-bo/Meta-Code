import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { normalizeWorkflowNodeResult } from "./execution.js";
import { reopenWorkflowNodeResultTransaction, validateWorkflowNodeResultTransaction } from "./nodeResultTransactions.js";
import { normalizeWorkflowPlan, workflowNodeContractDigest } from "./plan.js";
import { CURRENT_WORKFLOW_PLAN_SCHEMA_VERSION, type WorkflowIntegrationPhase, type WorkflowNodeAttemptRecord, type WorkflowNodeLog, type WorkflowNodePhase, type WorkflowNodeRecord, type WorkflowNodeResult, type WorkflowPlan, type WorkflowRecord, type WorkflowStatus } from "./types.js";
import type { RuntimeExecutionIdentity } from "../runtime/types.js";

type WorkflowRow = { id: string; owner_user_id: string; workspace_id: string; work_directory: string; origin_id: string; parent_workflow_id: string | null; branch_index: number; branch_label: string; title: string; original_prompt: string; planner_engine: string; max_concurrent_agents: number | null; planner_session_id: string | null; planner_engine_session_id: string | null; planner_runtime_binding_json: string | null; status: WorkflowStatus; paused_from_status: WorkflowStatus | null; paused_planning_mode: "initial" | "refine" | "fresh" | null; paused_planning_maintenance: number; active_plan_version: number; revision: number; review_note: string | null; final_result_json: string | null; planner_logs_json: string; planner_started_at: string | null; planner_finished_at: string | null; integration_logs_json: string; integration_phase: WorkflowIntegrationPhase | null; integration_attempt: number; integration_runtime_binding_json: string | null; integrator_result_json: string | null; validator_result_json: string | null; integration_started_at: string | null; integration_finished_at: string | null; pinned: number; archived_at: string | null; folder_id: string | null; created_at: string; updated_at: string };

const parse = <T>(value: string | null, fallback: T): T => value ? JSON.parse(value) as T : fallback;

export function compactPlannerLogs(logs: WorkflowNodeLog[]) {
  let latestAssistant: WorkflowNodeLog | null = null;
  const retained: WorkflowNodeLog[] = [];
  for (const log of logs) {
    if (log.kind === "message" && log.title === "assistant") latestAssistant = log;
    else retained.push(log);
  }
  if (latestAssistant) retained.push(latestAssistant);
  return retained.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-120);
}

function recoverableResultTransaction(checkpointDirectory: string | null | undefined) {
  if (!checkpointDirectory) return false;
  try {
    const target = path.join(checkpointDirectory, "result-transaction.json");
    const transaction = JSON.parse(fs.readFileSync(target, "utf8")) as { status?: string };
    if (transaction.status === "validated" || transaction.status === "committed") return true;
    return transaction.status === "editing" && validateWorkflowNodeResultTransaction(target).valid;
  } catch { return false; }
}

function recoverableAttemptResult(attempt: any): WorkflowNodeResult | null {
  if (!attempt) return null;
  try {
    const target = path.join(String(attempt.checkpoint_directory || ""), "result-transaction.json");
    if (recoverableResultTransaction(attempt.checkpoint_directory)) {
      const transaction = JSON.parse(fs.readFileSync(target, "utf8")) as { draftResult?: unknown };
      if (transaction.draftResult) return normalizeWorkflowNodeResult(transaction.draftResult);
    }
  } catch { /* Fall through to persisted attempt candidates. */ }
  const persisted = attempt.verified_result_json || attempt.parsed_result_json;
  try { return persisted ? normalizeWorkflowNodeResult(parse(persisted, {})) : null; }
  catch { return null; }
}

export class WorkflowRepository {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, work_directory TEXT NOT NULL DEFAULT '', origin_id TEXT NOT NULL DEFAULT '', parent_workflow_id TEXT, branch_index INTEGER NOT NULL DEFAULT 1, branch_label TEXT NOT NULL DEFAULT '方案 1', title TEXT NOT NULL, original_prompt TEXT NOT NULL, planner_engine TEXT NOT NULL, max_concurrent_agents INTEGER, planner_session_id TEXT, planner_engine_session_id TEXT, planner_runtime_binding_json TEXT, status TEXT NOT NULL, paused_from_status TEXT, paused_planning_mode TEXT, paused_planning_maintenance INTEGER NOT NULL DEFAULT 0, active_plan_version INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, review_note TEXT, final_result_json TEXT, planner_logs_json TEXT NOT NULL DEFAULT '[]', planner_started_at TEXT, planner_finished_at TEXT, integration_logs_json TEXT NOT NULL DEFAULT '[]', integration_phase TEXT, integration_attempt INTEGER NOT NULL DEFAULT 0, integration_runtime_binding_json TEXT, integrator_result_json TEXT, validator_result_json TEXT, integration_started_at TEXT, integration_finished_at TEXT, pinned INTEGER NOT NULL DEFAULT 0, archived_at TEXT, folder_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_plan_versions (workflow_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, plan_json TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, review_note TEXT, approved_at TEXT, created_at TEXT NOT NULL, PRIMARY KEY(workflow_id, version), FOREIGN KEY(workflow_id) REFERENCES workflow_runs(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS workflow_nodes (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, plan_version INTEGER NOT NULL, node_key TEXT NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, provider_reason TEXT NOT NULL DEFAULT '', contract_digest TEXT, prompt TEXT NOT NULL, non_goals_json TEXT NOT NULL DEFAULT '[]', constraints_json TEXT NOT NULL DEFAULT '[]', depends_json TEXT NOT NULL, skill_names_json TEXT NOT NULL, mcp_servers_json TEXT NOT NULL DEFAULT '[]', mcp_required INTEGER NOT NULL DEFAULT 0, workspace_access TEXT NOT NULL, write_scope_json TEXT NOT NULL, required_artifacts_json TEXT NOT NULL, deliverables_json TEXT NOT NULL, acceptance_json TEXT NOT NULL, verification_commands_json TEXT NOT NULL DEFAULT '[]', failure_policy TEXT NOT NULL, required INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, engine_thread_id TEXT, context_recovery_count INTEGER NOT NULL DEFAULT 0, context_recovery_mode TEXT, idempotency_key TEXT, summary_json TEXT, result_digest TEXT, stale_reason TEXT, logs_json TEXT NOT NULL DEFAULT '[]', error TEXT, lease_expires_at TEXT, next_retry_at TEXT, started_at TEXT, finished_at TEXT, UNIQUE(workflow_id, plan_version, node_key), FOREIGN KEY(workflow_id) REFERENCES workflow_runs(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS workflow_node_attempts (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, node_record_id TEXT NOT NULL, node_key TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL, runner_id TEXT, lease_expires_at TEXT, raw_output TEXT, parsed_result_json TEXT, verified_result_json TEXT, result_repair_count INTEGER NOT NULL DEFAULT 0, verification_run_count INTEGER NOT NULL DEFAULT 0, snapshot_retry_count INTEGER NOT NULL DEFAULT 0, engine_thread_id TEXT, context_recovery_count INTEGER NOT NULL DEFAULT 0, context_recovery_mode TEXT, runtime_binding_json TEXT, checkpoint_directory TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT, UNIQUE(node_record_id, attempt), FOREIGN KEY(workflow_id) REFERENCES workflow_runs(id) ON DELETE CASCADE, FOREIGN KEY(node_record_id) REFERENCES workflow_nodes(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS workflow_artifacts (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, node_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, result_digest TEXT, path TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT, summary TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, FOREIGN KEY(workflow_id) REFERENCES workflow_runs(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS idx_workflow_owner_workspace ON workflow_runs(owner_user_id, workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workflow_nodes_status ON workflow_nodes(workflow_id, status);
      CREATE INDEX IF NOT EXISTS idx_workflow_attempts_status ON workflow_node_attempts(workflow_id, status, lease_expires_at);
    `);
    const runColumns = db.prepare("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string }>;
    if (!runColumns.some((column) => column.name === "work_directory")) db.exec("ALTER TABLE workflow_runs ADD COLUMN work_directory TEXT NOT NULL DEFAULT ''");
    if (!runColumns.some((column) => column.name === "origin_id")) db.exec("ALTER TABLE workflow_runs ADD COLUMN origin_id TEXT NOT NULL DEFAULT ''");
    if (!runColumns.some((column) => column.name === "parent_workflow_id")) db.exec("ALTER TABLE workflow_runs ADD COLUMN parent_workflow_id TEXT");
    if (!runColumns.some((column) => column.name === "branch_index")) db.exec("ALTER TABLE workflow_runs ADD COLUMN branch_index INTEGER NOT NULL DEFAULT 1");
    if (!runColumns.some((column) => column.name === "branch_label")) db.exec("ALTER TABLE workflow_runs ADD COLUMN branch_label TEXT NOT NULL DEFAULT '方案 1'");
    if (!runColumns.some((column) => column.name === "max_concurrent_agents")) db.exec("ALTER TABLE workflow_runs ADD COLUMN max_concurrent_agents INTEGER");
    if (!runColumns.some((column) => column.name === "pinned")) db.exec("ALTER TABLE workflow_runs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    if (!runColumns.some((column) => column.name === "archived_at")) db.exec("ALTER TABLE workflow_runs ADD COLUMN archived_at TEXT");
    if (!runColumns.some((column) => column.name === "folder_id")) db.exec("ALTER TABLE workflow_runs ADD COLUMN folder_id TEXT");
    if (!runColumns.some((column) => column.name === "planner_session_id")) db.exec("ALTER TABLE workflow_runs ADD COLUMN planner_session_id TEXT");
    if (!runColumns.some((column) => column.name === "planner_engine_session_id")) db.exec("ALTER TABLE workflow_runs ADD COLUMN planner_engine_session_id TEXT");
    if (!runColumns.some((column) => column.name === "planner_runtime_binding_json")) db.exec("ALTER TABLE workflow_runs ADD COLUMN planner_runtime_binding_json TEXT");
    if (!runColumns.some((column) => column.name === "paused_from_status")) db.exec("ALTER TABLE workflow_runs ADD COLUMN paused_from_status TEXT");
    if (!runColumns.some((column) => column.name === "paused_planning_mode")) db.exec("ALTER TABLE workflow_runs ADD COLUMN paused_planning_mode TEXT");
    if (!runColumns.some((column) => column.name === "paused_planning_maintenance")) db.exec("ALTER TABLE workflow_runs ADD COLUMN paused_planning_maintenance INTEGER NOT NULL DEFAULT 0");
    if (!runColumns.some((column) => column.name === "planner_logs_json")) db.exec("ALTER TABLE workflow_runs ADD COLUMN planner_logs_json TEXT NOT NULL DEFAULT '[]'");
    if (!runColumns.some((column) => column.name === "planner_started_at")) db.exec("ALTER TABLE workflow_runs ADD COLUMN planner_started_at TEXT");
    if (!runColumns.some((column) => column.name === "planner_finished_at")) db.exec("ALTER TABLE workflow_runs ADD COLUMN planner_finished_at TEXT");
    if (!runColumns.some((column) => column.name === "integration_logs_json")) db.exec("ALTER TABLE workflow_runs ADD COLUMN integration_logs_json TEXT NOT NULL DEFAULT '[]'");
    if (!runColumns.some((column) => column.name === "integration_started_at")) db.exec("ALTER TABLE workflow_runs ADD COLUMN integration_started_at TEXT");
    if (!runColumns.some((column) => column.name === "integration_finished_at")) db.exec("ALTER TABLE workflow_runs ADD COLUMN integration_finished_at TEXT");
    if (!runColumns.some((column) => column.name === "integration_phase")) db.exec("ALTER TABLE workflow_runs ADD COLUMN integration_phase TEXT");
    if (!runColumns.some((column) => column.name === "integration_attempt")) db.exec("ALTER TABLE workflow_runs ADD COLUMN integration_attempt INTEGER NOT NULL DEFAULT 0");
    if (!runColumns.some((column) => column.name === "integration_runtime_binding_json")) db.exec("ALTER TABLE workflow_runs ADD COLUMN integration_runtime_binding_json TEXT");
    if (!runColumns.some((column) => column.name === "integrator_result_json")) db.exec("ALTER TABLE workflow_runs ADD COLUMN integrator_result_json TEXT");
    if (!runColumns.some((column) => column.name === "validator_result_json")) db.exec("ALTER TABLE workflow_runs ADD COLUMN validator_result_json TEXT");
    const planColumns = db.prepare("PRAGMA table_info(workflow_plan_versions)").all() as Array<{ name: string }>;
    if (!planColumns.some((column) => column.name === "schema_version")) db.exec("ALTER TABLE workflow_plan_versions ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1");
    const nodeColumns = db.prepare("PRAGMA table_info(workflow_nodes)").all() as Array<{ name: string }>;
    if (!nodeColumns.some((column) => column.name === "provider_reason")) db.exec("ALTER TABLE workflow_nodes ADD COLUMN provider_reason TEXT NOT NULL DEFAULT ''");
    if (!nodeColumns.some((column) => column.name === "contract_digest")) db.exec("ALTER TABLE workflow_nodes ADD COLUMN contract_digest TEXT");
    if (!nodeColumns.some((column) => column.name === "non_goals_json")) db.exec("ALTER TABLE workflow_nodes ADD COLUMN non_goals_json TEXT NOT NULL DEFAULT '[]'");
    if (!nodeColumns.some((column) => column.name === "constraints_json")) db.exec("ALTER TABLE workflow_nodes ADD COLUMN constraints_json TEXT NOT NULL DEFAULT '[]'");
    if (!nodeColumns.some((column) => column.name === "mcp_servers_json")) db.exec("ALTER TABLE workflow_nodes ADD COLUMN mcp_servers_json TEXT NOT NULL DEFAULT '[]'");
    if (!nodeColumns.some((column) => column.name === "mcp_required")) db.exec("ALTER TABLE workflow_nodes ADD COLUMN mcp_required INTEGER NOT NULL DEFAULT 0");
    if (!nodeColumns.some((column) => column.name === "verification_commands_json")) db.exec("ALTER TABLE workflow_nodes ADD COLUMN verification_commands_json TEXT NOT NULL DEFAULT '[]'");
    if (!nodeColumns.some((column) => column.name === "next_retry_at")) db.exec("ALTER TABLE workflow_nodes ADD COLUMN next_retry_at TEXT");
    if (!nodeColumns.some((column) => column.name === "result_digest")) db.exec("ALTER TABLE workflow_nodes ADD COLUMN result_digest TEXT");
    if (!nodeColumns.some((column) => column.name === "stale_reason")) db.exec("ALTER TABLE workflow_nodes ADD COLUMN stale_reason TEXT");
    if (!nodeColumns.some((column) => column.name === "engine_thread_id")) db.exec("ALTER TABLE workflow_nodes ADD COLUMN engine_thread_id TEXT");
    if (!nodeColumns.some((column) => column.name === "context_recovery_count")) db.exec("ALTER TABLE workflow_nodes ADD COLUMN context_recovery_count INTEGER NOT NULL DEFAULT 0");
    if (!nodeColumns.some((column) => column.name === "context_recovery_mode")) db.exec("ALTER TABLE workflow_nodes ADD COLUMN context_recovery_mode TEXT");
    const artifactColumns = db.prepare("PRAGMA table_info(workflow_artifacts)").all() as Array<{ name: string }>;
    if (!artifactColumns.some((column) => column.name === "attempt")) db.exec("ALTER TABLE workflow_artifacts ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0");
    if (!artifactColumns.some((column) => column.name === "result_digest")) db.exec("ALTER TABLE workflow_artifacts ADD COLUMN result_digest TEXT");
    if (!artifactColumns.some((column) => column.name === "active")) db.exec("ALTER TABLE workflow_artifacts ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
    const attemptColumns = db.prepare("PRAGMA table_info(workflow_node_attempts)").all() as Array<{ name: string }>;
    if (!attemptColumns.some((column) => column.name === "result_repair_count")) db.exec("ALTER TABLE workflow_node_attempts ADD COLUMN result_repair_count INTEGER NOT NULL DEFAULT 0");
    if (!attemptColumns.some((column) => column.name === "verification_run_count")) db.exec("ALTER TABLE workflow_node_attempts ADD COLUMN verification_run_count INTEGER NOT NULL DEFAULT 0");
    if (!attemptColumns.some((column) => column.name === "snapshot_retry_count")) db.exec("ALTER TABLE workflow_node_attempts ADD COLUMN snapshot_retry_count INTEGER NOT NULL DEFAULT 0");
    if (!attemptColumns.some((column) => column.name === "engine_thread_id")) db.exec("ALTER TABLE workflow_node_attempts ADD COLUMN engine_thread_id TEXT");
    if (!attemptColumns.some((column) => column.name === "context_recovery_count")) db.exec("ALTER TABLE workflow_node_attempts ADD COLUMN context_recovery_count INTEGER NOT NULL DEFAULT 0");
    if (!attemptColumns.some((column) => column.name === "context_recovery_mode")) db.exec("ALTER TABLE workflow_node_attempts ADD COLUMN context_recovery_mode TEXT");
    if (!attemptColumns.some((column) => column.name === "runtime_binding_json")) db.exec("ALTER TABLE workflow_node_attempts ADD COLUMN runtime_binding_json TEXT");
    const plannerRows = db.prepare("SELECT id, planner_logs_json FROM workflow_runs WHERE planner_logs_json LIKE '%\"title\":\"assistant\"%'").all() as Array<{ id: string; planner_logs_json: string }>;
    const updatePlannerLogs = db.prepare("UPDATE workflow_runs SET planner_logs_json = ? WHERE id = ?");
    for (const row of plannerRows) {
      const current = parse<WorkflowNodeLog[]>(row.planner_logs_json, []);
      const compacted = compactPlannerLogs(current);
      if (compacted.length !== current.length) updatePlannerLogs.run(JSON.stringify(compacted), row.id);
    }
    db.exec("UPDATE workflow_runs SET origin_id = id WHERE origin_id IS NULL OR origin_id = ''");
    const legacyPlans = db.prepare("SELECT workflow_id, version, plan_json, schema_version FROM workflow_plan_versions WHERE schema_version < ?").all(CURRENT_WORKFLOW_PLAN_SCHEMA_VERSION) as Array<{ workflow_id: string; version: number; plan_json: string; schema_version: number }>;
    const migratePlan = db.prepare("UPDATE workflow_plan_versions SET plan_json = ?, schema_version = ? WHERE workflow_id = ? AND version = ?");
    for (const row of legacyPlans) {
      const migrated = normalizeWorkflowPlan(parse(row.plan_json, {}));
      migratePlan.run(JSON.stringify(migrated), CURRENT_WORKFLOW_PLAN_SCHEMA_VERSION, row.workflow_id, row.version);
    }
  }

  create(input: { id?: string; ownerUserId: string; workspaceId: string; workDirectory?: string; prompt: string; plannerEngine: string; maxConcurrentAgents?: number | null; originId?: string; parentWorkflowId?: string | null; branchIndex?: number; branchLabel?: string; reviewNote?: string | null }) {
    const now = new Date().toISOString(); const id = input.id || `workflow-${crypto.randomUUID()}`;
    const branchIndex = Math.max(1, input.branchIndex || 1);
    this.db.prepare("INSERT INTO workflow_runs (id, owner_user_id, workspace_id, work_directory, origin_id, parent_workflow_id, branch_index, branch_label, title, original_prompt, planner_engine, max_concurrent_agents, status, review_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)")
      .run(id, input.ownerUserId, input.workspaceId, input.workDirectory || "", input.originId || id, input.parentWorkflowId || null, branchIndex, input.branchLabel || `方案 ${branchIndex}`, input.prompt.trim().slice(0, 80) || "任务编排", input.prompt.trim(), input.plannerEngine, input.maxConcurrentAgents ?? null, input.reviewNote?.trim() || null, now, now);
    return this.get(id, input.ownerUserId)!;
  }

  list(ownerUserId: string, workspaceId?: string) {
    const rows = (workspaceId
      ? this.db.prepare("SELECT * FROM workflow_runs WHERE owner_user_id = ? AND workspace_id = ? ORDER BY updated_at DESC").all(ownerUserId, workspaceId)
      : this.db.prepare("SELECT * FROM workflow_runs WHERE owner_user_id = ? ORDER BY updated_at DESC").all(ownerUserId)) as WorkflowRow[];
    return rows.map((row) => this.hydrate(row, false));
  }

  listAll() {
    const rows = this.db.prepare("SELECT * FROM workflow_runs ORDER BY updated_at DESC").all() as WorkflowRow[];
    return rows.map((row) => this.hydrate(row, true));
  }

  get(id: string, ownerUserId: string) {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE id = ? AND owner_user_id = ?").get(id, ownerUserId) as WorkflowRow | undefined;
    return row ? this.hydrate(row, true) : null;
  }

  listBranches(originId: string, ownerUserId: string) {
    const rows = this.db.prepare("SELECT * FROM workflow_runs WHERE origin_id = ? AND owner_user_id = ? ORDER BY branch_index, created_at").all(originId, ownerUserId) as WorkflowRow[];
    return rows.map((row) => this.hydrate(row, false));
  }

  nextBranchIndex(originId: string, ownerUserId: string) {
    const row = this.db.prepare("SELECT COALESCE(MAX(branch_index), 0) AS value FROM workflow_runs WHERE origin_id = ? AND owner_user_id = ?").get(originId, ownerUserId) as { value: number };
    return Number(row.value || 0) + 1;
  }

  setPlanning(id: string, ownerUserId: string, revision: number, firstLog?: WorkflowNodeLog, options: { reviewNote?: string | null; resetSession?: boolean } = {}) {
    this.transition(id, ownerUserId, revision, ["draft", "awaiting_approval", "needs_review", "completed"], "planning");
    const now = new Date().toISOString();
    this.db.prepare("UPDATE workflow_runs SET review_note = ?, planner_logs_json = ?, planner_started_at = ?, planner_finished_at = NULL, planner_session_id = CASE WHEN ? THEN NULL ELSE planner_session_id END, planner_engine_session_id = CASE WHEN ? THEN NULL ELSE planner_engine_session_id END, integration_logs_json = '[]', integration_phase = NULL, integration_attempt = 0, integrator_result_json = NULL, validator_result_json = NULL, integration_started_at = NULL, integration_finished_at = NULL, final_result_json = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ?")
      .run(options.reviewNote?.trim() || null, JSON.stringify(firstLog ? [firstLog] : []), now, options.resetSession ? 1 : 0, options.resetSession ? 1 : 0, now, id, ownerUserId);
  }

  startMaintenance(id: string, ownerUserId: string, firstLog: WorkflowNodeLog, note: string) {
    const row = this.require(id, ownerUserId);
    if (!row.active_plan_version) throw new Error("当前没有可以维护的计划");
    if (!["awaiting_approval", "completed", "needs_review", "draft"].includes(row.status)) throw new Error(`当前状态 ${row.status} 不能维护规划`);
    const logs = [...parse<WorkflowNodeLog[]>(row.planner_logs_json, []), firstLog].slice(-300);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE workflow_runs SET review_note = ?, planner_logs_json = ?, planner_started_at = ?, planner_finished_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?")
      .run(note.trim(), JSON.stringify(logs), now, now, id, ownerUserId);
    return this.get(id, ownerUserId)!;
  }

  updateOriginalPrompt(id: string, ownerUserId: string, revision: number, prompt: string) {
    const row = this.require(id, ownerUserId); if (row.revision !== revision) throw new Error("工作流已更新，请刷新后重试");
    if (!["draft", "awaiting_approval", "needs_review"].includes(row.status)) throw new Error("已经进入执行的方案不能覆盖修改，请创建规划分支");
    const nodeCount = (this.db.prepare("SELECT COUNT(*) AS count FROM workflow_nodes WHERE workflow_id = ?").get(id) as { count: number }).count;
    if (nodeCount || row.integration_started_at) throw new Error("已经产生执行记录的方案不能覆盖修改，请创建规划分支");
    const value = prompt.trim(); if (!value) throw new Error("初始任务不能为空");
    const now = new Date().toISOString();
    this.db.prepare("UPDATE workflow_runs SET title = ?, original_prompt = ?, status = 'draft', active_plan_version = 0, review_note = NULL, planner_session_id = NULL, planner_engine_session_id = NULL, planner_logs_json = '[]', planner_started_at = NULL, planner_finished_at = NULL, final_result_json = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?")
      .run(value.slice(0, 80) || "任务编排", value, now, id, ownerUserId);
    return this.get(id, ownerUserId)!;
  }

  appendPlannerLog(id: string, ownerUserId: string, log: WorkflowNodeLog) {
    const row = this.require(id, ownerUserId);
    const current = parse<WorkflowNodeLog[]>(row.planner_logs_json, []);
    const existing = current.findIndex((item) => item.id === log.id);
    const logs = existing >= 0
      ? current.map((item, index) => index === existing ? log : item)
      : [...current, log].slice(-120);
    this.db.prepare("UPDATE workflow_runs SET planner_logs_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?")
      .run(JSON.stringify(logs), new Date().toISOString(), id, ownerUserId);
  }

  setPlannerSession(id: string, ownerUserId: string, sessionId: string, engineSessionId?: string | null) {
    this.db.prepare(`UPDATE workflow_runs
      SET planner_session_id = ?,
          planner_engine_session_id = COALESCE(?, planner_engine_session_id),
          revision = revision + 1,
          updated_at = ?
      WHERE id = ? AND owner_user_id = ?
        AND (COALESCE(planner_session_id, '') <> ? OR (? IS NOT NULL AND COALESCE(planner_engine_session_id, '') <> ?))`)
      .run(sessionId, engineSessionId || null, new Date().toISOString(), id, ownerUserId, sessionId, engineSessionId || null, engineSessionId || null);
  }

  clearPlannerEngineSession(id: string, ownerUserId: string) {
    this.db.prepare("UPDATE workflow_runs SET planner_engine_session_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?")
      .run(new Date().toISOString(), id, ownerUserId);
  }

  bindPlannerRuntime(id: string, ownerUserId: string, binding: RuntimeExecutionIdentity) {
    const row = this.require(id, ownerUserId);
    const previous = row.planner_runtime_binding_json ? parse<RuntimeExecutionIdentity | null>(row.planner_runtime_binding_json, null) : null;
    const changed = Boolean(previous && previous.capabilityFingerprint !== binding.capabilityFingerprint);
    this.db.prepare("UPDATE workflow_runs SET planner_runtime_binding_json = ?, planner_engine_session_id = CASE WHEN ? THEN NULL ELSE planner_engine_session_id END, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?")
      .run(JSON.stringify(binding), changed ? 1 : 0, new Date().toISOString(), id, ownerUserId);
    return { changed, previous };
  }

  failPlanning(id: string, ownerUserId: string, errorLog: WorkflowNodeLog) {
    const row = this.require(id, ownerUserId);
    if (row.status !== "planning") throw new Error(`当前状态 ${row.status} 不能标记规划失败`);
    const logs = [...parse<WorkflowNodeLog[]>(row.planner_logs_json, []), errorLog].slice(-300);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE workflow_runs SET status = 'needs_review', planner_logs_json = ?, planner_finished_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?")
      .run(JSON.stringify(logs), now, now, id, ownerUserId);
  }

  finishMaintenanceWithoutPlan(id: string, ownerUserId: string, log: WorkflowNodeLog) {
    const row = this.require(id, ownerUserId);
    const logs = [...parse<WorkflowNodeLog[]>(row.planner_logs_json, []), log].slice(-300);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE workflow_runs SET planner_logs_json = ?, planner_finished_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?")
      .run(JSON.stringify(logs), now, now, id, ownerUserId);
    return this.get(id, ownerUserId)!;
  }

  savePlan(id: string, ownerUserId: string, plan: WorkflowPlan, reviewNote?: string) {
    const row = this.require(id, ownerUserId);
    if (row.status !== "planning") throw new Error(`当前状态 ${row.status} 不能保存规划结果`);
    const version = row.active_plan_version + 1; const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO workflow_plan_versions (workflow_id, version, status, plan_json, schema_version, review_note, created_at) VALUES (?, ?, 'draft', ?, ?, ?, ?)").run(id, version, JSON.stringify(normalizeWorkflowPlan(plan)), CURRENT_WORKFLOW_PLAN_SCHEMA_VERSION, reviewNote || null, now);
      this.db.prepare("UPDATE workflow_runs SET title = ?, status = 'awaiting_approval', active_plan_version = ?, review_note = ?, planner_finished_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?").run(plan.title, version, reviewNote || null, now, now, id, ownerUserId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id, ownerUserId)!;
  }

  saveMaintenancePlan(id: string, ownerUserId: string, plan: WorkflowPlan, reviewNote?: string) {
    const row = this.require(id, ownerUserId);
    if (!row.active_plan_version) throw new Error("当前没有可以维护的计划");
    if (!["awaiting_approval", "completed", "needs_review", "draft"].includes(row.status)) throw new Error(`当前状态 ${row.status} 不能保存维护候选计划`);
    const version = row.active_plan_version + 1; const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO workflow_plan_versions (workflow_id, version, status, plan_json, schema_version, review_note, created_at) VALUES (?, ?, 'draft', ?, ?, ?, ?)").run(id, version, JSON.stringify(normalizeWorkflowPlan(plan)), CURRENT_WORKFLOW_PLAN_SCHEMA_VERSION, reviewNote || null, now);
      this.db.prepare("UPDATE workflow_runs SET title = ?, status = 'awaiting_approval', active_plan_version = ?, review_note = ?, planner_finished_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?").run(plan.title, version, reviewNote || null, now, now, id, ownerUserId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id, ownerUserId)!;
  }

  approve(id: string, ownerUserId: string, revision: number) {
    const row = this.require(id, ownerUserId); if (row.revision !== revision) throw new Error("工作流已更新，请刷新后重试");
    if (row.status !== "awaiting_approval") throw new Error("当前计划不在待审批状态");
    const planRow = this.db.prepare("SELECT plan_json FROM workflow_plan_versions WHERE workflow_id = ? AND version = ?").get(id, row.active_plan_version) as { plan_json: string };
    const plan = normalizeWorkflowPlan(JSON.parse(planRow.plan_json)); const now = new Date().toISOString();
    const previousRows = this.db.prepare("SELECT * FROM workflow_nodes WHERE workflow_id = ? AND plan_version < ? ORDER BY plan_version DESC, rowid").all(id, row.active_plan_version) as any[];
    const previousById = new Map<string, any>();
    for (const previous of previousRows) if (!previousById.has(previous.node_key)) previousById.set(previous.node_key, previous);
    const reusable = new Set<string>();
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const node of plan.nodes) {
        if (reusable.has(node.id) || !node.dependsOn.every((dependency) => reusable.has(dependency))) continue;
        const previous = previousById.get(node.id);
        if (!previous || previous.status !== "completed" || !previous.summary_json || !previous.result_digest) continue;
        if (String(previous.contract_digest || "") !== workflowNodeContractDigest(node)) continue;
        reusable.add(node.id); expanded = true;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE workflow_plan_versions SET status = 'approved', approved_at = ? WHERE workflow_id = ? AND version = ?").run(now, id, row.active_plan_version);
      const insert = this.db.prepare("INSERT INTO workflow_nodes (id, workflow_id, plan_version, node_key, status, provider, provider_reason, contract_digest, prompt, non_goals_json, constraints_json, depends_json, skill_names_json, mcp_servers_json, mcp_required, workspace_access, write_scope_json, required_artifacts_json, deliverables_json, acceptance_json, verification_commands_json, failure_policy, required, logs_json) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')");
      const reuse = this.db.prepare("UPDATE workflow_nodes SET status = 'completed', attempt = ?, summary_json = ?, result_digest = ?, logs_json = ?, started_at = ?, finished_at = ? WHERE id = ?");
      for (const node of plan.nodes) {
        const recordId = `${id}:${row.active_plan_version}:${node.id}`;
        insert.run(recordId, id, row.active_plan_version, node.id, node.provider, node.providerReason, workflowNodeContractDigest(node), node.objective, JSON.stringify(node.nonGoals), JSON.stringify(node.constraints), JSON.stringify(node.dependsOn), JSON.stringify(node.skills), JSON.stringify(node.mcpServers), node.mcpRequired ? 1 : 0, node.workspaceAccess, JSON.stringify(node.writeScope), JSON.stringify(node.requiredArtifacts), JSON.stringify(node.deliverables), JSON.stringify(node.acceptance), JSON.stringify(node.verificationCommands), node.failurePolicy, node.required ? 1 : 0);
        if (!reusable.has(node.id)) continue;
        const previous = previousById.get(node.id);
        const logs = [...parse<WorkflowNodeLog[]>(previous.logs_json, []), { id: `workflow-reused-${crypto.randomUUID()}`, createdAt: now, kind: "status" as const, title: "复用已验证结果", text: `节点合同及上游输入未变化，复用计划 v${previous.plan_version} 的结果` }].slice(-300);
        reuse.run(previous.attempt, previous.summary_json, previous.result_digest, JSON.stringify(logs), previous.started_at, previous.finished_at, recordId);
      }
      this.db.prepare("UPDATE workflow_runs SET status = 'queued', revision = revision + 1, updated_at = ? WHERE id = ?").run(now, id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id, ownerUserId)!;
  }

  revise(id: string, ownerUserId: string, revision: number, note: string) {
    const row = this.require(id, ownerUserId); if (row.revision !== revision) throw new Error("工作流已更新，请刷新后重试");
    if (!note.trim()) throw new Error("请填写重新规划意见");
    this.db.prepare("UPDATE workflow_runs SET status = 'draft', review_note = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?").run(note.trim(), new Date().toISOString(), id, ownerUserId);
    return this.get(id, ownerUserId)!;
  }

  pause(id: string, ownerUserId: string, revision: number, planning: { mode?: "initial" | "refine" | "fresh"; maintenance?: boolean } = {}) {
    const row = this.require(id, ownerUserId);
    if (row.revision !== revision) throw new Error("工作流已更新，请刷新后重试");
    if (row.status === "paused") return this.get(id, ownerUserId)!;
    if (!["planning", "queued", "running", "integrating"].includes(row.status) && !planning.mode) throw new Error(`当前状态 ${row.status} 不能暂停`);
    const pausedFrom = planning.maintenance ? row.status : planning.mode ? "planning" : row.status;
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE workflow_runs SET status = 'paused', paused_from_status = ?, paused_planning_mode = ?, paused_planning_maintenance = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?")
        .run(pausedFrom, planning.mode || null, planning.maintenance ? 1 : 0, now, id, ownerUserId);
      if (["queued", "running"].includes(pausedFrom)) {
        this.db.prepare("UPDATE workflow_nodes SET status = CASE WHEN status = 'running' THEN 'pause_requested' ELSE 'paused' END, next_retry_at = NULL WHERE workflow_id = ? AND plan_version = ? AND status IN ('pending', 'ready', 'queued', 'running', 'retry_wait', 'interrupted')")
          .run(id, row.active_plan_version);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id, ownerUserId)!;
  }

  resume(id: string, ownerUserId: string, revision: number) {
    const row = this.require(id, ownerUserId);
    if (row.revision !== revision) throw new Error("工作流已更新，请刷新后重试");
    if (row.status !== "paused") throw new Error("当前工作流不在暂停状态");
    const from = row.paused_from_status;
    if (!from) throw new Error("缺少暂停前阶段，无法安全恢复");
    const next: WorkflowStatus = row.paused_planning_mode ? row.paused_planning_maintenance ? from : "planning" : "queued";
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE workflow_nodes SET status = 'interrupted', error = NULL, lease_expires_at = NULL, next_retry_at = NULL, finished_at = NULL WHERE workflow_id = ? AND plan_version = ? AND status IN ('paused', 'pause_requested')")
        .run(id, row.active_plan_version);
      this.db.prepare("UPDATE workflow_runs SET status = ?, paused_from_status = NULL, paused_planning_mode = NULL, paused_planning_maintenance = 0, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?")
        .run(next, now, id, ownerUserId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id, ownerUserId)!;
  }

  cancel(id: string, ownerUserId: string, revision: number) {
    const row = this.require(id, ownerUserId);
    if (row.revision !== revision) throw new Error("工作流已更新，请刷新后重试");
    if (!["draft", "planning", "awaiting_approval", "queued", "running", "integrating", "needs_review", "paused"].includes(row.status)) throw new Error(`当前状态 ${row.status} 不能取消`);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE workflow_runs SET status = 'canceled', paused_from_status = NULL, paused_planning_mode = NULL, paused_planning_maintenance = 0, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?").run(now, id, ownerUserId);
      this.db.prepare("UPDATE workflow_nodes SET status = 'canceled', error = COALESCE(error, '工作流已终止'), lease_expires_at = NULL, next_retry_at = NULL, finished_at = COALESCE(finished_at, ?) WHERE workflow_id = ? AND plan_version = ? AND status NOT IN ('completed', 'failed', 'blocked', 'skipped', 'canceled')").run(now, id, row.active_plan_version);
      this.db.prepare("UPDATE workflow_node_attempts SET status = 'abandoned', runner_id = NULL, lease_expires_at = NULL, error = COALESCE(error, '工作流已终止'), finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE workflow_id = ? AND status = 'running'").run(now, now, id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id, ownerUserId)!;
  }

  updateMetadata(id: string, ownerUserId: string, input: { title?: string; pinned?: boolean; archived?: boolean; folderId?: string | null }) {
    const row = this.require(id, ownerUserId);
    const title = input.title === undefined ? row.title : String(input.title || "").trim().slice(0, 120);
    if (!title) throw new Error("任务名称不能为空");
    const archivedAt = input.archived === undefined ? row.archived_at : input.archived ? new Date().toISOString() : null;
    const pinned = archivedAt ? 0 : input.pinned === undefined ? row.pinned : input.pinned ? 1 : 0;
    const folderId = input.folderId === undefined ? row.folder_id : String(input.folderId || "").trim() || null;
    this.db.prepare("UPDATE workflow_runs SET title = ?, pinned = ?, archived_at = ?, folder_id = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?")
      .run(title, pinned, archivedAt, folderId, new Date().toISOString(), id, ownerUserId);
    return this.get(id, ownerUserId)!;
  }

  delete(id: string, ownerUserId: string) {
    const exists = this.db.prepare("SELECT id FROM workflow_runs WHERE id = ? AND owner_user_id = ?").get(id, ownerUserId);
    if (!exists) throw new Error("工作流不存在");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM workflow_artifacts WHERE workflow_id = ?").run(id);
      this.db.prepare("DELETE FROM workflow_node_attempts WHERE workflow_id = ?").run(id);
      this.db.prepare("DELETE FROM workflow_nodes WHERE workflow_id = ?").run(id);
      this.db.prepare("DELETE FROM workflow_plan_versions WHERE workflow_id = ?").run(id);
      this.db.prepare("DELETE FROM workflow_runs WHERE id = ? AND owner_user_id = ?").run(id, ownerUserId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateRun(id: string, status: WorkflowStatus, finalResult?: WorkflowNodeResult | null) {
    this.db.prepare("UPDATE workflow_runs SET status = ?, final_result_json = COALESCE(?, final_result_json), revision = revision + 1, updated_at = ? WHERE id = ?").run(status, finalResult ? JSON.stringify(finalResult) : null, new Date().toISOString(), id);
  }

  requestNodePause(id: string, ownerUserId: string, nodeId: string) {
    const workflow = this.hydrate(this.require(id, ownerUserId), true);
    const node = workflow.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("工作流节点不存在");
    if (node.status === "paused") return workflow;
    if (!["running", "queued", "pending", "ready", "retry_wait", "interrupted"].includes(node.status)) throw new Error("当前节点不能暂停");
    const now = new Date().toISOString();
    const requested = node.status === "running" ? "pause_requested" : "paused";
    const logs = [...node.logs, { id: `workflow-pause-${crypto.randomUUID()}`, createdAt: now, kind: "status" as const, title: requested === "pause_requested" ? "请求暂停" : "已暂停", text: requested === "pause_requested" ? "正在安全停止当前 Agent 并保存检查点" : "节点已暂停，等待手动继续" }].slice(-300);
    this.db.prepare("UPDATE workflow_nodes SET status = ?, logs_json = ?, error = NULL, next_retry_at = NULL WHERE id = ?").run(requested, JSON.stringify(logs), node.recordId);
    this.db.prepare("UPDATE workflow_runs SET revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?").run(now, id, ownerUserId);
    return this.get(id, ownerUserId)!;
  }

  requestNodeRestart(id: string, ownerUserId: string, nodeId: string) {
    const workflow = this.hydrate(this.require(id, ownerUserId), true);
    const node = workflow.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("工作流节点不存在");
    if (node.status !== "running") throw new Error("当前节点不在运行状态");
    const now = new Date().toISOString();
    const logs = [...node.logs, { id: `workflow-restart-request-${crypto.randomUUID()}`, createdAt: now, kind: "status" as const, title: "请求重新执行", text: "正在安全停止当前 Agent，随后创建新的执行尝试" }].slice(-300);
    this.db.prepare("UPDATE workflow_nodes SET status = 'restart_requested', logs_json = ?, error = NULL WHERE id = ?").run(JSON.stringify(logs), node.recordId);
    this.db.prepare("UPDATE workflow_runs SET revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?").run(now, id, ownerUserId);
    return this.get(id, ownerUserId)!;
  }

  completeNodePause(id: string, ownerUserId: string, nodeId: string) {
    const workflow = this.hydrate(this.require(id, ownerUserId), true);
    const node = workflow.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("工作流节点不存在");
    const now = new Date().toISOString();
    const logs = [...node.logs, { id: `workflow-paused-${crypto.randomUUID()}`, createdAt: now, kind: "status" as const, title: "已暂停", text: "Agent 已安全停止，恢复时将从当前检查点继续或重新执行当前节点" }].slice(-300);
    this.db.prepare("UPDATE workflow_nodes SET status = 'paused', logs_json = ?, error = NULL, lease_expires_at = NULL, next_retry_at = NULL, finished_at = NULL WHERE id = ?").run(JSON.stringify(logs), node.recordId);
    this.db.prepare("UPDATE workflow_runs SET revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?").run(now, id, ownerUserId);
    return this.get(id, ownerUserId)!;
  }

  cancelNode(id: string, ownerUserId: string, nodeId: string) {
    const workflow = this.hydrate(this.require(id, ownerUserId), true);
    const node = workflow.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("工作流节点不存在");
    if (node.status === "canceled") return workflow;
    if (["completed", "skipped"].includes(node.status)) throw new Error("已完成或已跳过的节点不能终止，请使用重新执行");
    const now = new Date().toISOString();
    const logs = [...node.logs, { id: `workflow-cancel-${crypto.randomUUID()}`, createdAt: now, kind: "status" as const, title: "节点已终止", text: "当前执行已停止，已有文件、日志和检查点继续保留" }].slice(-300);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE workflow_nodes SET status = 'canceled', logs_json = ?, error = '节点已由用户终止', lease_expires_at = NULL, next_retry_at = NULL, finished_at = ? WHERE id = ?").run(JSON.stringify(logs), now, node.recordId);
      this.db.prepare("UPDATE workflow_node_attempts SET status = 'abandoned', runner_id = NULL, lease_expires_at = NULL, error = COALESCE(error, '节点已由用户终止'), finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE node_record_id = ? AND status = 'running'").run(now, now, node.recordId);
      this.db.prepare("UPDATE workflow_runs SET status = CASE WHEN status = 'paused' THEN status ELSE 'queued' END, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?").run(now, id, ownerUserId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id, ownerUserId)!;
  }

  resumeNode(id: string, ownerUserId: string, nodeId: string) {
    const workflow = this.hydrate(this.require(id, ownerUserId), true);
    const node = workflow.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("工作流节点不存在");
    if (node.status !== "paused") throw new Error("当前节点不在暂停状态");
    const now = new Date().toISOString();
    const logs = [...node.logs, { id: `workflow-resume-${crypto.randomUUID()}`, createdAt: now, kind: "status" as const, title: "继续执行", text: "节点已恢复调度，将复用可用检查点" }].slice(-300);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE workflow_nodes SET status = 'interrupted', logs_json = ?, error = NULL, lease_expires_at = NULL, next_retry_at = NULL, finished_at = NULL WHERE id = ? AND status = 'paused'").run(JSON.stringify(logs), node.recordId);
      this.db.prepare("UPDATE workflow_runs SET status = CASE WHEN status IN ('paused', 'needs_review') THEN 'queued' ELSE status END, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?").run(now, id, ownerUserId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id, ownerUserId)!;
  }

  restartNode(id: string, ownerUserId: string, nodeId: string) {
    const workflow = this.hydrate(this.require(id, ownerUserId), true);
    if (workflow.status === "canceled") throw new Error("已终止的工作流不能重跑单个节点，请创建新的规划分支");
    const target = workflow.nodes.find((item) => item.id === nodeId);
    if (!target) throw new Error("工作流节点不存在");
    if (["running", "pause_requested"].includes(target.status)) throw new Error("节点仍在运行，请先等待停止");
    if (!["pending", "ready", "paused", "restart_requested", "retry_wait", "interrupted", "failed", "blocked", "canceled", "completed"].includes(target.status)) throw new Error("当前节点不能重新执行");
    const resetIds = new Set([target.id]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const node of workflow.nodes) {
        if (!resetIds.has(node.id) && node.dependsOn.some((dependency) => resetIds.has(dependency))) {
          if (["running", "pause_requested"].includes(node.status)) throw new Error(`下游节点「${node.title}」正在运行，暂时不能重跑`);
          resetIds.add(node.id); expanded = true;
        }
      }
    }
    const now = new Date().toISOString();
    const update = this.db.prepare("UPDATE workflow_nodes SET status = 'pending', engine_thread_id = NULL, context_recovery_count = 0, context_recovery_mode = NULL, idempotency_key = NULL, summary_json = ?, result_digest = COALESCE(result_digest, ?), stale_reason = ?, logs_json = ?, error = NULL, lease_expires_at = NULL, next_retry_at = NULL, started_at = NULL, finished_at = NULL WHERE id = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const node of workflow.nodes.filter((item) => resetIds.has(item.id))) {
        const isTarget = node.id === target.id;
        const logs = [...node.logs, { id: `workflow-restart-${crypto.randomUUID()}`, createdAt: now, kind: "status" as const, title: isTarget ? "重新排队" : "等待上游重跑", text: isTarget ? `保留已有产物，开始第 ${node.attempt + 1} 次执行` : `上游节点「${target.title}」将重新执行，本节点结果已标记为过期` }].slice(-300);
        const previousDigest = node.summary ? crypto.createHash("sha256").update(JSON.stringify({ outputs: node.summary.outputs, decisions: node.summary.decisions, handoff: node.summary.handoff, checks: node.summary.checks })).digest("hex") : null;
        update.run(node.summary ? JSON.stringify(node.summary) : null, previousDigest, isTarget ? null : `上游节点 ${target.id} 重新执行`, JSON.stringify(logs), node.recordId);
      }
      this.db.prepare("UPDATE workflow_runs SET status = 'queued', integration_logs_json = '[]', integration_phase = NULL, integrator_result_json = NULL, validator_result_json = NULL, integration_started_at = NULL, integration_finished_at = NULL, final_result_json = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?").run(now, id, ownerUserId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id, ownerUserId)!;
  }

  retryNodes(id: string, ownerUserId: string, requestedNodeIds?: string[]) {
    const row = this.require(id, ownerUserId);
    if (row.status !== "needs_review") throw new Error("当前工作流不在节点待处理状态");
    const workflow = this.hydrate(row, true);
    const requested = requestedNodeIds?.length ? new Set(requestedNodeIds) : null;
    const abnormalIds = new Set(workflow.nodes.filter((node) => ["failed", "blocked"].includes(node.status)).map((node) => node.id));
    const retryTargets = workflow.nodes.filter((node) => {
      if (requested) return requested.has(node.id) && (["failed", "blocked"].includes(node.status) || (Boolean(workflow.integrationStartedAt) && node.status === "completed"));
      return node.status === "failed" || (node.status === "blocked" && !node.dependsOn.some((dependency) => abnormalIds.has(dependency)));
    });
    if (workflow.integrationStartedAt && !requested) throw new Error("最终验收阶段请指定需要纠正的节点，或使用重新验收");
    if (requested && retryTargets.length !== requested.size) throw new Error("目标节点不存在或当前不能恢复");
    if (!retryTargets.length) throw new Error("当前没有可恢复的失败或阻塞节点");

    const resetIds = new Set(retryTargets.map((node) => node.id));
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const node of workflow.nodes) {
        if (!resetIds.has(node.id) && ["blocked", "skipped"].includes(node.status) && node.dependsOn.some((dependency) => resetIds.has(dependency))) {
          resetIds.add(node.id);
          expanded = true;
        }
      }
    }

    const now = new Date().toISOString();
    const update = this.db.prepare("UPDATE workflow_nodes SET status = 'pending', engine_thread_id = NULL, context_recovery_count = 0, context_recovery_mode = NULL, idempotency_key = NULL, summary_json = ?, result_digest = COALESCE(result_digest, ?), stale_reason = ?, logs_json = ?, error = NULL, lease_expires_at = NULL, next_retry_at = NULL, started_at = NULL, finished_at = NULL WHERE id = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const node of workflow.nodes.filter((item) => resetIds.has(item.id))) {
        const target = retryTargets.some((item) => item.id === node.id);
        const logs = [...node.logs, {
          id: `workflow-retry-${crypto.randomUUID()}`,
          createdAt: now,
          kind: "status" as const,
          title: target ? "重新排队" : "解除依赖阻塞",
          text: target ? `保留已有产物，准备进行第 ${node.attempt + 1} 次纠正执行` : "上游节点已进入重试，等待重新调度"
        }].slice(-300);
        const previousDigest = node.summary ? crypto.createHash("sha256").update(JSON.stringify({ outputs: node.summary.outputs, decisions: node.summary.decisions, handoff: node.summary.handoff, checks: node.summary.checks })).digest("hex") : null;
        update.run(node.summary ? JSON.stringify(node.summary) : null, previousDigest, target ? null : `上游节点 ${retryTargets.map((item) => item.id).join(", ")} 已进入纠正执行`, JSON.stringify(logs), node.recordId);
      }
      this.db.prepare("UPDATE workflow_runs SET status = 'queued', integration_logs_json = '[]', integration_phase = NULL, integrator_result_json = NULL, validator_result_json = NULL, integration_started_at = NULL, integration_finished_at = NULL, final_result_json = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?")
        .run(now, id, ownerUserId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id, ownerUserId)!;
  }

  beginIntegration(id: string, runtimeBinding?: RuntimeExecutionIdentity) {
    const row = this.db.prepare("SELECT integration_phase, integration_started_at FROM workflow_runs WHERE id = ?").get(id) as { integration_phase: WorkflowIntegrationPhase | null; integration_started_at: string | null } | undefined;
    if (!row) throw new Error("工作流不存在");
    const now = new Date().toISOString();
    const bindingRow = this.db.prepare("SELECT integration_runtime_binding_json FROM workflow_runs WHERE id = ?").get(id) as { integration_runtime_binding_json: string | null };
    const previous = bindingRow.integration_runtime_binding_json ? parse<RuntimeExecutionIdentity | null>(bindingRow.integration_runtime_binding_json, null) : null;
    const runtimeChanged = Boolean(runtimeBinding && previous && runtimeBinding.capabilityFingerprint !== previous.capabilityFingerprint);
    const fresh = !row.integration_started_at || !row.integration_phase || runtimeChanged;
    this.db.prepare(`UPDATE workflow_runs SET status = 'integrating', integration_logs_json = CASE WHEN ? THEN '[]' ELSE integration_logs_json END, integration_phase = CASE WHEN ? THEN 'started' ELSE integration_phase END, integration_attempt = integration_attempt + 1, integration_runtime_binding_json = COALESCE(?, integration_runtime_binding_json), integrator_result_json = CASE WHEN ? THEN NULL ELSE integrator_result_json END, validator_result_json = CASE WHEN ? THEN NULL ELSE validator_result_json END, integration_started_at = CASE WHEN ? THEN ? ELSE COALESCE(integration_started_at, ?) END, integration_finished_at = NULL, final_result_json = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`)
      .run(fresh ? 1 : 0, fresh ? 1 : 0, runtimeBinding ? JSON.stringify(runtimeBinding) : null, fresh ? 1 : 0, fresh ? 1 : 0, runtimeChanged ? 1 : 0, now, now, now, id);
    return { changed: runtimeChanged, previous };
  }

  checkpointIntegration(id: string, phase: WorkflowIntegrationPhase, input: { integratorResult?: WorkflowNodeResult | null; validatorResult?: WorkflowNodeResult | null } = {}) {
    const row = this.db.prepare("SELECT integrator_result_json, validator_result_json FROM workflow_runs WHERE id = ?").get(id) as { integrator_result_json: string | null; validator_result_json: string | null } | undefined;
    if (!row) throw new Error("工作流不存在");
    const now = new Date().toISOString();
    this.db.prepare("UPDATE workflow_runs SET integration_phase = ?, integrator_result_json = ?, validator_result_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(phase, input.integratorResult === undefined ? row.integrator_result_json : input.integratorResult ? JSON.stringify(input.integratorResult) : null, input.validatorResult === undefined ? row.validator_result_json : input.validatorResult ? JSON.stringify(input.validatorResult) : null, now, id);
  }

  prepareIntegrationRetry(id: string, ownerUserId: string) {
    const row = this.require(id, ownerUserId);
    const candidate = row.integrator_result_json ? normalizeWorkflowNodeResult(parse(row.integrator_result_json, {})) : null;
    const validation = row.validator_result_json ? normalizeWorkflowNodeResult(parse(row.validator_result_json, {})) : null;
    const keepValidation = Boolean(candidate && validation?.outcome === "completed" && !validation.unresolved.length && !validation.checks.some((check) => check.status === "failed"));
    const phase: WorkflowIntegrationPhase = keepValidation ? "validator_completed" : candidate ? "integrator_completed" : "started";
    const now = new Date().toISOString();
    this.db.prepare("UPDATE workflow_runs SET status = 'queued', integration_phase = ?, validator_result_json = CASE WHEN ? THEN validator_result_json ELSE NULL END, integration_finished_at = NULL, final_result_json = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?")
      .run(phase, keepValidation ? 1 : 0, now, id, ownerUserId);
    return this.get(id, ownerUserId)!;
  }

  appendIntegrationLog(id: string, log: WorkflowNodeLog) {
    const row = this.db.prepare("SELECT integration_logs_json FROM workflow_runs WHERE id = ?").get(id) as { integration_logs_json: string } | undefined;
    if (!row) throw new Error("工作流不存在");
    const current = parse<WorkflowNodeLog[]>(row.integration_logs_json, []);
    const existing = current.findIndex((item) => item.id === log.id);
    const logs = (existing >= 0 ? current.map((item, index) => index === existing ? log : item) : [...current, log]).slice(-300);
    this.db.prepare("UPDATE workflow_runs SET integration_logs_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(logs), new Date().toISOString(), id);
  }

  finishIntegration(id: string, status: "completed" | "needs_review", finalResult: WorkflowNodeResult) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE workflow_runs SET status = ?, integration_phase = ?, final_result_json = ?, integration_finished_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(status, status === "completed" ? "completed" : "result_committed", JSON.stringify(finalResult), now, now, id);
  }

  updateNode(node: WorkflowNodeRecord) {
    this.db.prepare("UPDATE workflow_nodes SET status = ?, provider = ?, attempt = ?, engine_thread_id = ?, context_recovery_count = ?, context_recovery_mode = ?, idempotency_key = ?, summary_json = ?, result_digest = ?, stale_reason = ?, logs_json = ?, error = ?, lease_expires_at = ?, next_retry_at = ?, started_at = ?, finished_at = ? WHERE id = ?")
      .run(node.status, node.provider, node.attempt, node.engineThreadId, node.contextRecoveryCount, node.contextRecoveryMode, node.idempotencyKey, node.summary ? JSON.stringify(node.summary) : null, node.resultDigest, node.staleReason, JSON.stringify(node.logs.slice(-300)), node.error, node.leaseExpiresAt, node.nextRetryAt, node.startedAt, node.finishedAt, node.recordId);
    this.db.prepare("UPDATE workflow_runs SET revision = revision + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), node.workflowId);
  }

  claimNodeAttempt(nodeRecordId: string, runnerId: string, checkpointRoot: string, leaseExpiresAt: string, runtimeBinding?: RuntimeExecutionIdentity) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const node = this.db.prepare("SELECT id, workflow_id, plan_version, node_key, status, attempt FROM workflow_nodes WHERE id = ?").get(nodeRecordId) as { id: string; workflow_id: string; plan_version: number; node_key: string; status: string; attempt: number } | undefined;
      if (!node || !["pending", "ready", "interrupted"].includes(node.status)) throw new Error("节点当前不能被调度");
      const latest = this.db.prepare("SELECT * FROM workflow_node_attempts WHERE node_record_id = ? ORDER BY attempt DESC LIMIT 1").get(nodeRecordId) as any;
      const transactionRecoverable = latest && recoverableResultTransaction(latest.checkpoint_directory);
      const restartAgentInPlace = latest && latest.status === "interrupted" && ["pending", "interrupted"].includes(node.status) && ["claimed", "result_draft_started", "agent_running"].includes(latest.phase) && !transactionRecoverable;
      const latestBinding = latest?.runtime_binding_json ? parse<RuntimeExecutionIdentity | null>(latest.runtime_binding_json, null) : null;
      const sameRuntime = !runtimeBinding || !latestBinding || runtimeBinding.capabilityFingerprint === latestBinding.capabilityFingerprint;
      const resumable = latest && sameRuntime && latest.status === "interrupted" && ["pending", "interrupted"].includes(node.status) && (restartAgentInPlace || ["agent_output_received", "result_parsed", "result_candidate_committed", "verification_completed", "result_verified", "result_committed"].includes(latest.phase) || (["result_draft_started", "agent_running"].includes(latest.phase) && transactionRecoverable));
      let attemptId: string;
      let attempt = node.attempt;
      if (resumable) {
        attemptId = latest.id;
        if (restartAgentInPlace) {
          const checkpointDirectory = path.resolve(latest.checkpoint_directory);
          const resolvedCheckpointRoot = path.resolve(checkpointRoot);
          if (checkpointDirectory !== resolvedCheckpointRoot && checkpointDirectory.startsWith(`${resolvedCheckpointRoot}${path.sep}`)) fs.rmSync(checkpointDirectory, { recursive: true, force: true });
          this.db.prepare("UPDATE workflow_node_attempts SET status = 'running', phase = 'claimed', runner_id = ?, lease_expires_at = ?, raw_output = NULL, parsed_result_json = NULL, verified_result_json = NULL, result_repair_count = 0, verification_run_count = 0, finished_at = NULL, updated_at = ?, error = NULL WHERE id = ?")
            .run(runnerId, leaseExpiresAt, now, attemptId);
        } else {
          const recoveredPhase = transactionRecoverable && ["result_draft_started", "agent_running"].includes(latest.phase) ? "agent_output_received" : latest.phase;
          this.db.prepare("UPDATE workflow_node_attempts SET status = 'running', phase = ?, runner_id = ?, lease_expires_at = ?, updated_at = ?, error = NULL WHERE id = ?")
            .run(recoveredPhase, runnerId, leaseExpiresAt, now, attemptId);
        }
      } else {
        if (latest && ["running", "interrupted"].includes(latest.status)) {
          const reason = !sameRuntime ? "运行时能力已变化，不能安全续接" : "旧执行尝试已由新的调度接管";
          this.db.prepare("UPDATE workflow_node_attempts SET status = 'abandoned', error = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(reason, now, now, latest.id);
        }
        attempt += 1;
        attemptId = `workflow-attempt-${crypto.randomUUID()}`;
        const checkpointDirectory = path.join(checkpointRoot, String(attempt));
        this.db.prepare("INSERT INTO workflow_node_attempts (id, workflow_id, node_record_id, node_key, attempt, status, phase, runner_id, lease_expires_at, runtime_binding_json, checkpoint_directory, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'running', 'claimed', ?, ?, ?, ?, ?, ?)")
          .run(attemptId, node.workflow_id, node.id, node.node_key, attempt, runnerId, leaseExpiresAt, runtimeBinding ? JSON.stringify(runtimeBinding) : null, checkpointDirectory, now, now);
      }
      if (resumable && runtimeBinding && !latestBinding) this.db.prepare("UPDATE workflow_node_attempts SET runtime_binding_json = ? WHERE id = ?").run(JSON.stringify(runtimeBinding), attemptId);
      const idempotencyKey = `${node.workflow_id}:${node.plan_version}:${node.node_key}:${attempt}`;
      const claimed = this.db.prepare("UPDATE workflow_nodes SET status = 'running', attempt = ?, idempotency_key = ?, lease_expires_at = ?, next_retry_at = NULL, started_at = COALESCE(started_at, ?), finished_at = NULL, error = NULL WHERE id = ? AND status IN ('pending', 'ready', 'interrupted')")
        .run(attempt, idempotencyKey, leaseExpiresAt, now, nodeRecordId);
      if (!claimed.changes) throw new Error("节点已被其他调度器接管");
      this.db.prepare("UPDATE workflow_runs SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, node.workflow_id);
      this.db.exec("COMMIT");
      return this.getNodeAttempt(attemptId)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getLatestNodeAttempt(nodeRecordId: string) {
    const row = this.db.prepare("SELECT * FROM workflow_node_attempts WHERE node_record_id = ? ORDER BY attempt DESC LIMIT 1").get(nodeRecordId) as any;
    return row ? this.hydrateAttempt(row) : null;
  }

  getNodeAttempts(nodeRecordId: string) {
    return (this.db.prepare("SELECT * FROM workflow_node_attempts WHERE node_record_id = ? ORDER BY attempt DESC").all(nodeRecordId) as any[])
      .map((row) => this.hydrateAttempt(row));
  }

  prepareResultRepair(id: string, ownerUserId: string, nodeId: string) {
    const row = this.require(id, ownerUserId);
    if (!["needs_review", "failed", "paused"].includes(row.status)) throw new Error("当前工作流不在可修复状态");
    const node = this.db.prepare("SELECT * FROM workflow_nodes WHERE workflow_id = ? AND plan_version = ? AND node_key = ?").get(id, row.active_plan_version, nodeId) as any;
    if (!node) throw new Error("工作流节点不存在");
    if (node.status === "running") throw new Error("节点仍在运行，不能修复结果");
    const attempts = this.db.prepare("SELECT * FROM workflow_node_attempts WHERE node_record_id = ? ORDER BY attempt DESC").all(node.id) as any[];
    const attempt = attempts[0];
    const sourceAttempt = attempts.find((candidate) => recoverableResultTransaction(candidate.checkpoint_directory))
      || attempts.find((candidate) => Boolean(candidate.raw_output) || recoverableAttemptResult(candidate));
    if (!attempt || !sourceAttempt) throw new Error("该节点没有可恢复的机器结果事务或旧版 Agent 输出，请使用重新执行");
    const historicalResult = sourceAttempt.id === attempt.id ? null : recoverableAttemptResult(sourceAttempt);
    const resultTransactionPath = attempt.checkpoint_directory ? path.join(attempt.checkpoint_directory, "result-transaction.json") : "";
    if (!historicalResult && fs.existsSync(resultTransactionPath)) reopenWorkflowNodeResultTransaction(resultTransactionPath, [String(attempt.error || node.error || "请求重新修复机器结果")]);
    if (historicalResult) {
      fs.mkdirSync(attempt.checkpoint_directory, { recursive: true });
      const sourceSnapshot = path.join(sourceAttempt.checkpoint_directory, "before-snapshot.json");
      const targetSnapshot = path.join(attempt.checkpoint_directory, "before-snapshot.json");
      if (fs.existsSync(sourceSnapshot)) fs.copyFileSync(sourceSnapshot, targetSnapshot);
    }
    const now = new Date().toISOString();
    const logs = [...parse<WorkflowNodeLog[]>(node.logs_json, []), {
      id: `workflow-result-repair-${crypto.randomUUID()}`,
      createdAt: now,
      kind: "status" as const,
      title: "重新解析机器结果",
      text: historicalResult
        ? `复用第 ${sourceAttempt.attempt} 次已提交机器结果，只重新执行快照与系统验收，不重新执行业务 Agent`
        : "保留已有 Agent 输出，只修复结果合同并重新执行验收"
    }].slice(-300);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE workflow_node_attempts SET status = 'interrupted', phase = ?, runner_id = NULL, lease_expires_at = NULL, raw_output = ?, parsed_result_json = ?, verified_result_json = NULL, result_repair_count = 0, verification_run_count = 0, snapshot_retry_count = 0, error = NULL, finished_at = NULL, updated_at = ? WHERE id = ?")
        .run(historicalResult ? "result_candidate_committed" : "agent_output_received", sourceAttempt.raw_output || attempt.raw_output, historicalResult ? JSON.stringify(historicalResult) : null, now, attempt.id);
      this.db.prepare("UPDATE workflow_nodes SET status = 'interrupted', logs_json = ?, error = NULL, lease_expires_at = NULL, next_retry_at = NULL, finished_at = NULL WHERE id = ?")
        .run(JSON.stringify(logs), node.id);
      this.db.prepare("UPDATE workflow_runs SET status = 'queued', integration_logs_json = '[]', integration_phase = NULL, integrator_result_json = NULL, validator_result_json = NULL, integration_started_at = NULL, integration_finished_at = NULL, final_result_json = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?")
        .run(now, id, ownerUserId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id, ownerUserId)!;
  }

  checkpointNodeAttempt(id: string, input: { phase?: WorkflowNodePhase; status?: WorkflowNodeAttemptRecord["status"]; leaseExpiresAt?: string | null; rawOutput?: string | null; parsedResult?: WorkflowNodeResult | null; verifiedResult?: WorkflowNodeResult | null; resultRepairCount?: number; verificationRunCount?: number; snapshotRetryCount?: number; engineThreadId?: string | null; contextRecoveryCount?: number; contextRecoveryMode?: "fresh" | "resumed" | null; error?: string | null; finishedAt?: string | null }) {
    const row = this.db.prepare("SELECT * FROM workflow_node_attempts WHERE id = ?").get(id) as any;
    if (!row) throw new Error("节点尝试不存在");
    const now = new Date().toISOString();
    this.db.prepare("UPDATE workflow_node_attempts SET phase = ?, status = ?, lease_expires_at = ?, raw_output = ?, parsed_result_json = ?, verified_result_json = ?, result_repair_count = ?, verification_run_count = ?, snapshot_retry_count = ?, engine_thread_id = ?, context_recovery_count = ?, context_recovery_mode = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?")
      .run(input.phase ?? row.phase, input.status ?? row.status, input.leaseExpiresAt === undefined ? row.lease_expires_at : input.leaseExpiresAt, input.rawOutput === undefined ? row.raw_output : input.rawOutput, input.parsedResult === undefined ? row.parsed_result_json : input.parsedResult ? JSON.stringify(input.parsedResult) : null, input.verifiedResult === undefined ? row.verified_result_json : input.verifiedResult ? JSON.stringify(input.verifiedResult) : null, input.resultRepairCount ?? row.result_repair_count, input.verificationRunCount ?? row.verification_run_count, input.snapshotRetryCount ?? row.snapshot_retry_count, input.engineThreadId === undefined ? row.engine_thread_id : input.engineThreadId, input.contextRecoveryCount ?? row.context_recovery_count, input.contextRecoveryMode === undefined ? row.context_recovery_mode : input.contextRecoveryMode, input.error === undefined ? row.error : input.error, input.finishedAt === undefined ? row.finished_at : input.finishedAt, now, id);
    return this.getNodeAttempt(id)!;
  }

  renewNodeLease(nodeRecordId: string, attemptId: string, runnerId: string, leaseExpiresAt: string) {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE workflow_node_attempts SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND node_record_id = ? AND runner_id = ? AND status = 'running'")
      .run(leaseExpiresAt, now, attemptId, nodeRecordId, runnerId);
    if (result.changes) this.db.prepare("UPDATE workflow_nodes SET lease_expires_at = ? WHERE id = ? AND status = 'running'").run(leaseExpiresAt, nodeRecordId);
    return Boolean(result.changes);
  }

  invalidateCompletedDependents(workflowId: string, planVersion: number, upstreamNodeId: string) {
    const rows = this.db.prepare("SELECT id, node_key, status, depends_json, logs_json FROM workflow_nodes WHERE workflow_id = ? AND plan_version = ? ORDER BY rowid").all(workflowId, planVersion) as Array<{ id: string; node_key: string; status: string; depends_json: string; logs_json: string }>;
    const invalidated = new Set([upstreamNodeId]);
    const now = new Date().toISOString();
    let expanded = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      while (expanded) {
        expanded = false;
        for (const row of rows) {
          if (invalidated.has(row.node_key) || row.status !== "completed") continue;
          const dependencies = parse<string[]>(row.depends_json, []);
          if (!dependencies.some((dependency) => invalidated.has(dependency))) continue;
          invalidated.add(row.node_key); expanded = true;
          const logs = [...parse<WorkflowNodeLog[]>(row.logs_json, []), { id: `workflow-stale-${crypto.randomUUID()}`, createdAt: now, kind: "status" as const, title: "上游结果已更新", text: `依赖 ${dependencies.filter((dependency) => invalidated.has(dependency)).join(", ")} 的旧结果已失效，等待定向重跑` }].slice(-300);
          this.db.prepare("UPDATE workflow_nodes SET status = 'pending', stale_reason = ?, logs_json = ?, error = NULL, lease_expires_at = NULL, next_retry_at = NULL, started_at = NULL, finished_at = NULL WHERE id = ?")
            .run(`上游节点 ${upstreamNodeId} 的已验收结果发生变化`, JSON.stringify(logs), row.id);
        }
      }
      if (invalidated.size > 1) this.db.prepare("UPDATE workflow_runs SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, workflowId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    invalidated.delete(upstreamNodeId);
    return [...invalidated];
  }

  replaceNodeArtifacts(workflowId: string, nodeId: string, artifacts: Array<{ path: string; kind: string; hash: string | null; summary: string }>, attempt = 0, resultDigest: string | null = null) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE workflow_artifacts SET active = 0 WHERE workflow_id = ? AND node_id = ? AND active = 1").run(workflowId, nodeId);
      const insert = this.db.prepare("INSERT INTO workflow_artifacts (id, workflow_id, node_id, attempt, result_digest, path, kind, hash, summary, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)");
      for (const artifact of artifacts) insert.run(`artifact-${crypto.randomUUID()}`, workflowId, nodeId, attempt, resultDigest, artifact.path, artifact.kind, artifact.hash, artifact.summary, now);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  recoverAfterRestart() {
    const interrupted = this.db.prepare("SELECT id, owner_user_id, workspace_id, status FROM workflow_runs WHERE status IN ('planning', 'queued', 'running', 'integrating')").all() as Array<{ id: string; owner_user_id: string; workspace_id: string; status: WorkflowStatus }>;
    if (!interrupted.length) return [];
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of interrupted) {
        if (item.status === "planning") {
          this.db.prepare("UPDATE workflow_runs SET status = 'needs_review', review_note = '规划过程因工作台重启中断，请重新生成计划', revision = revision + 1, updated_at = ? WHERE id = ?").run(now, item.id);
          continue;
        }
        this.db.prepare("UPDATE workflow_node_attempts SET status = 'interrupted', runner_id = NULL, lease_expires_at = NULL, error = COALESCE(error, '工作台重启中断'), updated_at = ? WHERE workflow_id = ? AND status = 'running'").run(now, item.id);
        this.db.prepare("UPDATE workflow_nodes SET status = 'interrupted', error = '节点因工作台重启中断，等待恢复调度', lease_expires_at = NULL WHERE workflow_id = ? AND status IN ('queued', 'running')").run(item.id);
        this.db.prepare("UPDATE workflow_runs SET status = 'queued', revision = revision + 1, updated_at = ? WHERE id = ?").run(now, item.id);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return interrupted.filter((item) => item.status !== "planning").map((item) => ({ id: item.id, ownerUserId: item.owner_user_id, workspaceId: item.workspace_id }));
  }

  recoverExpiredLeases(activeNodeKeys: ReadonlySet<string> = new Set()) {
    const now = new Date().toISOString();
    const expired = (this.db.prepare(`SELECT r.id, r.owner_user_id, r.workspace_id, n.id AS node_record_id, n.node_key FROM workflow_runs r JOIN workflow_nodes n ON n.workflow_id = r.id WHERE r.status IN ('queued', 'running') AND n.status = 'running' AND n.lease_expires_at IS NOT NULL AND n.lease_expires_at < ?`).all(now) as Array<{ id: string; owner_user_id: string; workspace_id: string; node_record_id: string; node_key: string }>)
      .filter((item) => !activeNodeKeys.has(`${item.id}:${item.node_key}`));
    if (!expired.length) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of expired) {
        this.db.prepare("UPDATE workflow_node_attempts SET status = 'interrupted', runner_id = NULL, lease_expires_at = NULL, error = COALESCE(error, '执行租约过期'), updated_at = ? WHERE node_record_id = ? AND status = 'running' AND lease_expires_at < ?").run(now, item.node_record_id, now);
        this.db.prepare("UPDATE workflow_nodes SET status = 'interrupted', error = '节点执行租约过期，等待安全接管', lease_expires_at = NULL WHERE id = ? AND status = 'running' AND lease_expires_at < ?").run(item.node_record_id, now);
      }
      for (const workflowId of new Set(expired.map((item) => item.id))) this.db.prepare("UPDATE workflow_runs SET status = 'queued', revision = revision + 1, updated_at = ? WHERE id = ?").run(now, workflowId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return [...new Map(expired.map((item) => [item.id, { id: item.id, ownerUserId: item.owner_user_id, workspaceId: item.workspace_id }])).values()];
  }

  private transition(id: string, owner: string, revision: number, from: WorkflowStatus[], to: WorkflowStatus) {
    const row = this.require(id, owner); if (row.revision !== revision) throw new Error("工作流已更新，请刷新后重试");
    if (!from.includes(row.status)) throw new Error(`当前状态 ${row.status} 不能执行此操作`);
    this.db.prepare("UPDATE workflow_runs SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?").run(to, new Date().toISOString(), id, owner);
  }

  private require(id: string, owner: string) { const row = this.db.prepare("SELECT * FROM workflow_runs WHERE id = ? AND owner_user_id = ?").get(id, owner) as WorkflowRow | undefined; if (!row) throw new Error("工作流不存在"); return row; }

  private hydrate(row: WorkflowRow, detail: boolean): WorkflowRecord {
    const planRow = row.active_plan_version ? this.db.prepare("SELECT plan_json FROM workflow_plan_versions WHERE workflow_id = ? AND version = ?").get(row.id, row.active_plan_version) as { plan_json: string } | undefined : undefined;
    const plan = planRow ? normalizeWorkflowPlan(JSON.parse(planRow.plan_json)) : null;
    const nodeRows = detail ? this.db.prepare("SELECT * FROM workflow_nodes WHERE workflow_id = ? AND plan_version = ? ORDER BY rowid").all(row.id, row.active_plan_version) as any[] : [];
    const repairableNodes = new Set<string>();
    if (detail) for (const attempt of this.db.prepare("SELECT node_record_id, raw_output, parsed_result_json, verified_result_json, checkpoint_directory FROM workflow_node_attempts WHERE workflow_id = ? ORDER BY node_record_id, attempt DESC").all(row.id) as any[]) {
      if (attempt.raw_output || recoverableAttemptResult(attempt)) repairableNodes.add(attempt.node_record_id);
    }
    const nodes: WorkflowNodeRecord[] = nodeRows.map((node) => ({
      id: node.node_key, title: plan?.nodes.find((item) => item.id === node.node_key)?.title || node.node_key, objective: node.prompt,
      nonGoals: parse(node.non_goals_json, []), constraints: parse(node.constraints_json, []), dependsOn: parse(node.depends_json, []), provider: node.provider, providerReason: String(node.provider_reason || plan?.nodes.find((item) => item.id === node.node_key)?.providerReason || ""), skills: parse(node.skill_names_json, []), mcpServers: parse(node.mcp_servers_json, []), mcpRequired: Boolean(node.mcp_required), workspaceAccess: node.workspace_access,
      writeScope: parse(node.write_scope_json, []), requiredArtifacts: parse(node.required_artifacts_json, []), deliverables: parse(node.deliverables_json, []), acceptance: parse(node.acceptance_json, []), verificationCommands: parse(node.verification_commands_json, []), failurePolicy: node.failure_policy, required: Boolean(node.required),
      recordId: node.id, workflowId: row.id, planVersion: node.plan_version, status: node.status, attempt: node.attempt, engineThreadId: node.engine_thread_id || null, contextRecoveryCount: node.context_recovery_count || 0, contextRecoveryMode: node.context_recovery_mode || null, idempotencyKey: node.idempotency_key,
      summary: node.summary_json ? normalizeWorkflowNodeResult(parse(node.summary_json, {})) : null, resultDigest: node.result_digest, staleReason: node.stale_reason, logs: parse(node.logs_json, []), error: node.error, resultRepairable: repairableNodes.has(node.id), leaseExpiresAt: node.lease_expires_at, nextRetryAt: node.next_retry_at, startedAt: node.started_at, finishedAt: node.finished_at
    }));
    return { id: row.id, ownerUserId: row.owner_user_id, workspaceId: row.workspace_id, workDirectory: row.work_directory, originId: row.origin_id || row.id, parentWorkflowId: row.parent_workflow_id, branchIndex: row.branch_index || 1, branchLabel: row.branch_label || `方案 ${row.branch_index || 1}`, title: row.title, originalPrompt: row.original_prompt, plannerEngine: row.planner_engine, maxConcurrentAgents: row.max_concurrent_agents, plannerSessionId: row.planner_session_id, plannerEngineSessionId: row.planner_engine_session_id, plannerRuntimeBinding: row.planner_runtime_binding_json ? parse(row.planner_runtime_binding_json, null) : null, status: row.status, pausedFromStatus: row.paused_from_status, pausedPlanningMode: row.paused_planning_mode, pausedPlanningMaintenance: Boolean(row.paused_planning_maintenance), activePlanVersion: row.active_plan_version, revision: row.revision, reviewNote: row.review_note, finalResult: row.final_result_json ? normalizeWorkflowNodeResult(parse(row.final_result_json, {})) : null, plannerLogs: parse(row.planner_logs_json, []), plannerStartedAt: row.planner_started_at, plannerFinishedAt: row.planner_finished_at, integrationLogs: parse(row.integration_logs_json, []), integrationPhase: row.integration_phase, integrationAttempt: row.integration_attempt || 0, integrationRuntimeBinding: row.integration_runtime_binding_json ? parse(row.integration_runtime_binding_json, null) : null, integratorResult: row.integrator_result_json ? normalizeWorkflowNodeResult(parse(row.integrator_result_json, {})) : null, validatorResult: row.validator_result_json ? normalizeWorkflowNodeResult(parse(row.validator_result_json, {})) : null, integrationStartedAt: row.integration_started_at, integrationFinishedAt: row.integration_finished_at, pinned: Boolean(row.pinned), archivedAt: row.archived_at, folderId: row.folder_id, createdAt: row.created_at, updatedAt: row.updated_at, plan, nodes };
  }

  private getNodeAttempt(id: string) {
    const row = this.db.prepare("SELECT * FROM workflow_node_attempts WHERE id = ?").get(id) as any;
    return row ? this.hydrateAttempt(row) : null;
  }

  private hydrateAttempt(row: any): WorkflowNodeAttemptRecord {
    return {
      id: row.id, workflowId: row.workflow_id, nodeRecordId: row.node_record_id, nodeId: row.node_key, attempt: row.attempt,
      status: row.status, phase: row.phase, runnerId: row.runner_id, leaseExpiresAt: row.lease_expires_at, rawOutput: row.raw_output,
      parsedResult: row.parsed_result_json ? normalizeWorkflowNodeResult(parse(row.parsed_result_json, {})) : null,
      verifiedResult: row.verified_result_json ? normalizeWorkflowNodeResult(parse(row.verified_result_json, {})) : null,
      resultRepairCount: row.result_repair_count || 0, verificationRunCount: row.verification_run_count || 0, snapshotRetryCount: row.snapshot_retry_count || 0,
      engineThreadId: row.engine_thread_id || null, contextRecoveryCount: row.context_recovery_count || 0, contextRecoveryMode: row.context_recovery_mode || null,
      checkpointDirectory: row.checkpoint_directory, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at,
      runtimeBinding: row.runtime_binding_json ? parse(row.runtime_binding_json, null) : null
    };
  }
}
