import fs from "node:fs/promises";
import type { Session, Workspace } from "../workbench/types.js";
import type { WorkflowRecord } from "../plugins/orchestration/types.js";
import type { PreparedWorkflowTarget, WorkflowTargetService } from "../plugins/orchestration/targets.js";
import { sessionHandoff, taskRootsEqual, type TaskContextStore } from "./context.js";

export type PrepareWorkflowTaskInput = { ownerUserId: string; workspaceId: string; hostSessionId?: string; taskContextId?: string; prompt: string };

/** Mode switches inherit host-validated business roots, never client paths. */
export async function prepareWorkflowTaskContext(input: PrepareWorkflowTaskInput, ports: {
  store: TaskContextStore;
  workspaceById: (id: string, ownerUserId: string) => Workspace | undefined;
  sessionById: (id: string, ownerUserId: string) => Session | undefined;
  executionRootForSession: (session: Session) => string | undefined;
  workflowById: (id: string, ownerUserId: string) => WorkflowRecord | null;
  targets: Pick<WorkflowTargetService, "get">;
}): Promise<{ prompt: string; taskContextId?: string; inheritedTarget?: PreparedWorkflowTarget }> {
  const workspace = ports.workspaceById(input.workspaceId, input.ownerUserId);
  if (!workspace) throw new Error("工作区不存在");
  const session = input.hostSessionId ? ports.sessionById(input.hostSessionId, input.ownerUserId) : undefined;
  if (input.hostSessionId && (!session || session.workspaceId !== input.workspaceId)) throw new Error("来源对话不存在或工作区不匹配");
  let context = input.taskContextId ? ports.store.get(input.taskContextId, input.ownerUserId) : null;
  if (input.taskContextId && (!context || context.workspaceId !== input.workspaceId)) throw new Error("任务上下文不存在或工作区不匹配");
  if (!session) return { prompt: input.prompt, taskContextId: context?.id };

  const effectiveRoot = ports.executionRootForSession(session);
  if (!effectiveRoot) throw new Error("来源对话的执行目录不可用");
  const executionRoot = await fs.realpath(effectiveRoot);
  const workspaceRoot = await fs.realpath(workspace.root);
  if (!(await fs.stat(executionRoot)).isDirectory()) throw new Error("来源对话的执行目录不可用");
  const source = ports.store.ensure({ kind: "session", id: session.id, executionRoot }, session.ownerUserId, session.workspaceId, session.title);
  if (context && context.id !== source.id) throw new Error("来源对话不属于当前任务");

  let inheritedTarget: PreparedWorkflowTarget;
  if (taskRootsEqual(executionRoot, workspaceRoot)) {
    inheritedTarget = { executionTarget: "workspace", executionRoot, workspaceRoot, workDirectory: executionRoot, worktreeId: null };
  } else {
    const sourceWorkflow = [...source.executions].reverse().filter((execution) => execution.kind === "workflow" && taskRootsEqual(execution.executionRoot, executionRoot))
      .map((execution) => ports.workflowById(execution.id, input.ownerUserId))
      .find((workflow) => workflow && workflow.workspaceId === workspace.id && taskRootsEqual(workflow.executionRoot || workflow.workDirectory, executionRoot));
    if (!sourceWorkflow || !["isolated", "worktree"].includes(sourceWorkflow.executionTarget)) throw new Error("当前任务的隔离执行目录没有有效编排绑定，请从原编排进入");
    if (sourceWorkflow.workspaceRoot && !taskRootsEqual(sourceWorkflow.workspaceRoot, workspaceRoot)) throw new Error("当前任务关联的原工作区目录已变化");
    const worktreeId = sourceWorkflow.executionTarget === "worktree" ? sourceWorkflow.worktreeId || sourceWorkflow.id : null;
    if (worktreeId) {
      const binding = await ports.targets.get(worktreeId, input.ownerUserId);
      if (!binding || binding.workspaceId !== workspace.id || !taskRootsEqual(binding.workspaceRoot, workspaceRoot) || !taskRootsEqual(binding.executionRoot, executionRoot)) throw new Error("当前任务的 Worktree 绑定不可用");
    }
    inheritedTarget = { executionTarget: sourceWorkflow.executionTarget, executionRoot, workspaceRoot, workDirectory: executionRoot, worktreeId };
  }
  context = ports.store.handoff(source.id, input.ownerUserId, sessionHandoff(session, executionRoot));
  return { prompt: input.prompt, taskContextId: context.id, inheritedTarget };
}
