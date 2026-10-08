import crypto from "node:crypto";
import fs from "node:fs";
import { writeJsonAtomically } from "./transactionFile.js";
import type { WorkspaceSnapshot } from "./enforcement.js";
import type { WorkflowNodeHostVerification, WorkflowNodeResultContract } from "./nodeResultTransactions.js";
import type { WorkflowNodeCheck } from "./types.js";

export type WorkflowHostVerificationCheckpoint = {
  schemaVersion: 1;
  identityDigest: string;
  beforeDigest: string;
  phase: "commands_running" | "commands_completed" | "snapshot_completed";
  checks: WorkflowNodeCheck[];
  verification: WorkflowNodeHostVerification | null;
  afterDigest: string | null;
  commandRunCount: number;
};

export function workflowSnapshotDigest(snapshot: WorkspaceSnapshot) {
  return crypto.createHash("sha256").update(JSON.stringify([...snapshot].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))).digest("hex");
}

export function workflowHostVerificationIdentity(contract: WorkflowNodeResultContract, executionRoot: string, commands: string[]) {
  const canonicalRoot = fs.realpathSync.native(executionRoot);
  return crypto.createHash("sha256").update(JSON.stringify({
    workflowId: contract.workflowId, nodeRecordId: contract.nodeRecordId, nodeId: contract.nodeId,
    planVersion: contract.planVersion, attemptId: contract.attemptId, attempt: contract.attempt,
    contractDigest: contract.contractDigest, idempotencyKey: contract.idempotencyKey,
    executionRoot: process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot, commands
  })).digest("hex");
}

export function readWorkflowHostVerificationCheckpoint(target: string, identityDigest: string, before: WorkspaceSnapshot) {
  if (!fs.existsSync(target)) return null;
  const value = JSON.parse(fs.readFileSync(target, "utf8")) as WorkflowHostVerificationCheckpoint;
  if (value.schemaVersion !== 1 || value.identityDigest !== identityDigest || value.beforeDigest !== workflowSnapshotDigest(before)
    || !["commands_running", "commands_completed", "snapshot_completed"].includes(value.phase) || !Array.isArray(value.checks) || value.commandRunCount !== 1) {
    throw new Error("只读系统验收检查点的合同、执行目录或原始文件快照不匹配，请显式重新执行节点");
  }
  if (value.phase === "commands_running") throw new Error("只读系统验收在命令执行期间中断，不能确认命令是否已经产生副作用，请检查项目并显式重新执行节点");
  if (value.phase === "snapshot_completed" && (!value.verification || !value.afterDigest)) throw new Error("只读系统验收文件证据缺失，请显式重新执行节点");
  return value;
}

export function writeWorkflowHostVerificationCheckpoint(target: string, checkpoint: WorkflowHostVerificationCheckpoint) {
  writeJsonAtomically(target, checkpoint);
}
