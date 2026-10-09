import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../../pathBoundary.js";
import type { WorkflowRecord } from "./types.js";

type ExecutionRootRecord = Pick<WorkflowRecord, "workDirectory"> & Partial<Pick<WorkflowRecord, "executionRoot">>;

export function workflowExecutionRoot(workflow: ExecutionRootRecord) {
  const root = workflow.executionRoot || workflow.workDirectory;
  if (!root) throw new Error("编排没有配置业务执行目录");
  return path.resolve(root);
}

function realExistingAncestor(target: string): string {
  let current = target;
  const missing: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("执行目录不存在");
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(fs.realpathSync(current), ...missing);
}

export function resolveWorkflowResultPath(workflow: ExecutionRootRecord, reportedPath: string, mustExist: boolean) {
  const raw = reportedPath.trim();
  if (!raw) throw new Error("执行结果包含空文件路径");
  const root = workflowExecutionRoot(workflow);
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  if (!isPathInside(root, resolved)) throw new Error(`执行结果路径越出业务执行目录：${raw}`);
  if (mustExist && !fs.existsSync(resolved)) throw new Error(`Agent 声明的产物不存在：${raw}`);
  const realRoot = fs.realpathSync(root);
  if (!isPathInside(realRoot, realExistingAncestor(resolved))) throw new Error(`执行结果路径通过符号链接越出业务执行目录：${raw}`);
  return { absolute: resolved, relative: path.relative(root, resolved).replaceAll("\\", "/") || "." };
}
