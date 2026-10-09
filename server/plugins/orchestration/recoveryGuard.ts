import crypto from "node:crypto";
import fs from "node:fs";
import type { NormalizedEngineEvent } from "../../engines/types.js";
import { writeJsonAtomically } from "./transactionFile.js";

type RecoveryGuardState = {
  schemaVersion: 1;
  progress: string;
  launchesWithoutProgress: number;
  effects: Array<{ id: string; kind: "command" | "business-tool"; status: "started" | "completed"; recordedAt: string }>;
};

function read(target: string): RecoveryGuardState | null {
  if (!fs.existsSync(target)) return null;
  const value = JSON.parse(fs.readFileSync(target, "utf8")) as RecoveryGuardState;
  if (value.schemaVersion !== 1 || !Array.isArray(value.effects) || typeof value.progress !== "string" || !Number.isInteger(value.launchesWithoutProgress)) throw new Error("执行恢复记录损坏，请检查已有成果后显式重新执行节点");
  return value;
}

/** This governs replay, not sandboxing: arbitrary scripts and MCP effects cannot be inferred safe. */
export function beginWorkflowRecoveryGuard(target: string, input: { snapshotDigest: string; resultDraft: unknown }) {
  const progress = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const previous = read(target);
  const replayIssue = workflowRecoveryReplayIssue(target);
  if (replayIssue) throw new Error(replayIssue);
  const launchesWithoutProgress = previous?.progress === progress ? previous.launchesWithoutProgress + 1 : 1;
  if (launchesWithoutProgress > 3) throw new Error("节点连续恢复但业务文件与结果草稿均无进展，已停止自动循环；请调整任务或显式重新执行");
  const state: RecoveryGuardState = { schemaVersion: 1, progress, launchesWithoutProgress, effects: [], };
  writeJsonAtomically(target, state);
}

export function workflowRecoveryReplayIssue(target: string): string | null {
  try {
    const previous = read(target);
    if (!previous?.effects.length) return null;
    return previous.effects.some((effect) => effect.status === "started")
      ? "上次执行存在未确认结束的命令或业务工具，可能已产生外部副作用；自动恢复已停止。请核对实际结果后显式重新执行节点"
      : "上次执行已调用命令或业务工具，其外部副作用无法由文件快照证明幂等；自动重放已停止。请核对已有结果后显式重新执行节点";
  } catch { return "执行恢复记录损坏，无法判定重复执行是否安全；请检查已有成果后显式重新执行节点"; }
}

function effectKind(event: NormalizedEngineEvent): "command" | "business-tool" | null {
  const payload = event.payload as any;
  const tool = String(event.toolName || payload?.item?.type || payload?.name || "");
  if (/^(?:workflow_(?:read|submit|checkpoint|register|set|self_review|validate|commit|report)_|mcp__workbench[-_]workflow[-_](?:plan|result)__)/i.test(tool) || /^workbench[-_]workflow[-_](?:plan|result)$/i.test(String(payload?.item?.server || ""))) return null;
  if (event.category === "command" || /^(?:Bash|command_execution|exec_command|shell|run_command)$/i.test(tool)) {
    const command = String(payload?.item?.command || payload?.input?.command || (event.detail as any)?.command || "");
    // Only a small syntactic read-only allowlist avoids the external-effect gate.
    // Compound commands, substitutions and user scripts are never assumed safe.
    if (command && !/[;&|><`\n]|\$\(/.test(command) && /^(?:pwd|ls|cat|head|tail|rg)\b/.test(command.trim()) && !/--(?:pre|hostname-bin)|\s-e(?:\s|=)/.test(command)) return null;
    return "command";
  }
  if (event.category === "mcp" || /mcp|^tools\./i.test(tool)) return "business-tool";
  return null;
}

export function recordWorkflowRecoveryEffect(target: string, event: NormalizedEngineEvent) {
  if (event.type !== "tool.started" && event.type !== "tool.completed") return;
  const state = read(target);
  if (!state) return;
  const id = crypto.createHash("sha256").update(event.sourceId || `${event.toolName || event.category || "unknown"}:unidentified`).digest("hex");
  const existing = state.effects.find((effect) => effect.id === id);
  const kind = existing?.kind || effectKind(event);
  if (!kind) return;
  const status = event.type === "tool.completed" ? "completed" : "started";
  if (existing) existing.status = status;
  else state.effects.push({ id, kind, status, recordedAt: new Date().toISOString() });
  // No raw arguments, command output, credentials or business content is persisted.
  writeJsonAtomically(target, state);
}
