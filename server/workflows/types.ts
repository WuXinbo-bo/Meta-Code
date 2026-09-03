import type { CanonicalActivityRecord } from "../activity/types.js";
import type { RuntimeExecutionIdentity } from "../runtime/types.js";

export type WorkflowEngine = string;
export const DEFAULT_WORKFLOW_MAX_CONCURRENT_AGENTS = 5;
export const GLOBAL_WORKFLOW_MAX_CONCURRENT_AGENTS = 20;
export type WorkflowStatus = "draft" | "planning" | "awaiting_approval" | "queued" | "running" | "integrating" | "completed" | "needs_review" | "paused" | "failed" | "canceled";
export type WorkflowNodeStatus = "pending" | "ready" | "queued" | "running" | "pause_requested" | "paused" | "restart_requested" | "retry_wait" | "completed" | "failed" | "blocked" | "skipped" | "canceled" | "interrupted";
export type WorkflowNodePhase = "claimed" | "result_draft_started" | "agent_running" | "agent_output_received" | "result_parsed" | "result_candidate_committed" | "verification_completed" | "result_verified" | "result_committed" | "completed";
export type WorkflowAttemptStatus = "running" | "interrupted" | "failed" | "completed" | "abandoned";
export type WorkflowIntegrationPhase = "started" | "integrator_completed" | "validator_completed" | "result_committed" | "completed";
export type WorkflowPlanningMode = "initial" | "refine" | "fresh";
export const CURRENT_WORKFLOW_PLAN_SCHEMA_VERSION = 3;

export type WorkflowPlanAudit = {
  status: "passed" | "revised" | "needs_input";
  checks: Array<{ key: string; status: "passed" | "revised" | "warning"; note: string }>;
  changes: string[];
};

export type WorkflowPlanNode = {
  id: string;
  title: string;
  objective: string;
  nonGoals: string[];
  constraints: string[];
  dependsOn: string[];
  provider: WorkflowEngine | "auto";
  providerReason: string;
  skills: string[];
  mcpServers: string[];
  mcpRequired: boolean;
  workspaceAccess: "read" | "write";
  writeScope: string[];
  requiredArtifacts: string[];
  deliverables: string[];
  acceptance: string[];
  verificationCommands: string[];
  failurePolicy: "retry_then_review" | "review";
  required: boolean;
};

export type WorkflowFinalDelivery = {
  required: boolean;
  directory: string;
  primary: string | null;
  format: string;
  additional: string[];
  producerNodeId: string | null;
  reason: string;
};

export type WorkflowPlan = {
  planSchemaVersion: number;
  title: string;
  summary: string;
  assumptions: string[];
  questions: string[];
  risks: string[];
  finalDelivery: WorkflowFinalDelivery;
  audit: WorkflowPlanAudit;
  nodes: WorkflowPlanNode[];
};

export type WorkflowNodeOutcome = "completed" | "partial" | "blocked" | "failed";

export type WorkflowNodeOutput = {
  id: string;
  type: "file" | "directory" | "document" | "data" | "code" | "text" | "decision" | "other";
  path: string | null;
  mediaType: string | null;
  description: string;
  consumableBy: string[];
};

export type WorkflowNodeCheck = {
  name: string;
  command: string | null;
  status: "passed" | "failed" | "not_run";
  exitCode: number | null;
  evidence: string;
};

export type WorkflowNodeResult = {
  outcome: WorkflowNodeOutcome;
  humanSummary: string;
  outputs: WorkflowNodeOutput[];
  changedFiles: string[];
  checks: WorkflowNodeCheck[];
  decisions: Array<{ key: string; value: string; reason: string }>;
  handoff: { facts: string[]; constraints: string[]; nextAgentInstructions: string[] };
  warnings: string[];
  unresolved: string[];
  machineResultPath: string | null;
};

export type WorkflowNodeLog = {
  id: string;
  createdAt: string;
  kind: "status" | "message" | "reasoning" | "tool" | "error";
  title: string;
  text: string;
  category?: string;
  phase?: "started" | "running" | "completed" | "failed";
  detail?: unknown;
  activity?: CanonicalActivityRecord;
  attempt?: number;
  runId?: string;
  contextId?: string | null;
};

export type WorkflowNodeRecord = WorkflowPlanNode & {
  recordId: string;
  workflowId: string;
  planVersion: number;
  status: WorkflowNodeStatus;
  attempt: number;
  engineThreadId: string | null;
  contextRecoveryCount: number;
  contextRecoveryMode: "fresh" | "resumed" | null;
  idempotencyKey: string | null;
  summary: WorkflowNodeResult | null;
  resultDigest: string | null;
  staleReason: string | null;
  logs: WorkflowNodeLog[];
  error: string | null;
  resultRepairable: boolean;
  leaseExpiresAt: string | null;
  nextRetryAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WorkflowNodeAttemptRecord = {
  id: string;
  workflowId: string;
  nodeRecordId: string;
  nodeId: string;
  attempt: number;
  status: WorkflowAttemptStatus;
  phase: WorkflowNodePhase;
  runnerId: string | null;
  leaseExpiresAt: string | null;
  rawOutput: string | null;
  parsedResult: WorkflowNodeResult | null;
  verifiedResult: WorkflowNodeResult | null;
  resultRepairCount: number;
  verificationRunCount: number;
  snapshotRetryCount: number;
  engineThreadId: string | null;
  contextRecoveryCount: number;
  contextRecoveryMode: "fresh" | "resumed" | null;
  checkpointDirectory: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  runtimeBinding: RuntimeExecutionIdentity | null;
};

export type WorkflowRecord = {
  id: string;
  ownerUserId: string;
  workspaceId: string;
  workDirectory: string;
  originId: string;
  parentWorkflowId: string | null;
  branchIndex: number;
  branchLabel: string;
  title: string;
  originalPrompt: string;
  plannerEngine: WorkflowEngine;
  maxConcurrentAgents: number | null;
  plannerSessionId: string | null;
  plannerEngineSessionId: string | null;
  plannerRuntimeBinding: RuntimeExecutionIdentity | null;
  status: WorkflowStatus;
  pausedFromStatus: WorkflowStatus | null;
  pausedPlanningMode: WorkflowPlanningMode | null;
  pausedPlanningMaintenance: boolean;
  activePlanVersion: number;
  revision: number;
  reviewNote: string | null;
  finalResult: WorkflowNodeResult | null;
  plannerLogs: WorkflowNodeLog[];
  plannerStartedAt: string | null;
  plannerFinishedAt: string | null;
  integrationLogs: WorkflowNodeLog[];
  integrationPhase: WorkflowIntegrationPhase | null;
  integrationAttempt: number;
  integrationRuntimeBinding: RuntimeExecutionIdentity | null;
  integratorResult: WorkflowNodeResult | null;
  validatorResult: WorkflowNodeResult | null;
  integrationStartedAt: string | null;
  integrationFinishedAt: string | null;
  pinned: boolean;
  archivedAt: string | null;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
  plan: WorkflowPlan | null;
  nodes: WorkflowNodeRecord[];
};
