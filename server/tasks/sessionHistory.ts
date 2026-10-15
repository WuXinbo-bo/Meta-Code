import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkbenchMcpServer } from "../mcpConfig.js";
import { taskRootsEqual, type TaskContextStore, type TaskHandoff } from "./context.js";

export const TASK_HISTORY_SERVER_NAME = "workbench-task-history";

/** Private control servers replace name collisions only in the run configuration. */
export function mergeTaskHistoryServers(servers: WorkbenchMcpServer[], additions: WorkbenchMcpServer[] = []) {
  const history = additions.find((server) => server.name.toLowerCase() === TASK_HISTORY_SERVER_NAME);
  return history ? [history, ...servers.filter((server) => server.name.toLowerCase() !== TASK_HISTORY_SERVER_NAME)] : [...servers];
}

/** A content-addressed snapshot stays fixed for the entire native session run. */
export async function prepareSessionTaskHistoryServers(input: {
  store: TaskContextStore; sessionId: string; ownerUserId: string; executionRoot: string; handoff?: TaskHandoff;
  runtimeDirectory: string; command: string; args: string[];
}): Promise<WorkbenchMcpServer[]> {
  if (!input.handoff?.history) return [];
  const context = input.store.forExecution({ kind: "session", id: input.sessionId }, input.ownerUserId);
  const source = context?.executions.find((execution) => execution.kind === "session" && execution.id === input.sessionId);
  if (!context || context.id !== input.handoff.history.taskContextId || !taskRootsEqual(source?.executionRoot, input.executionRoot)
    || !taskRootsEqual(input.handoff.source.executionRoot, input.executionRoot)) throw new Error("任务历史来源或执行目录与当前对话不匹配");
  const snapshot = input.store.exportHistorySnapshot(context.id, input.ownerUserId, input.executionRoot);
  const content = JSON.stringify(snapshot);
  const sessionKey = crypto.createHash("sha256").update(`${input.ownerUserId}:${input.sessionId}`).digest("hex").slice(0, 24);
  const digest = crypto.createHash("sha256").update(content).digest("hex");
  const directory = path.join(input.runtimeDirectory, "task-history", sessionKey);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const snapshotPath = path.join(directory, `${digest}.json`);
  try { await fs.writeFile(snapshotPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await fs.readFile(snapshotPath, "utf8") !== content) throw new Error("任务历史快照内容已变化，请重新加载任务");
  }
  return [{ name: TASK_HISTORY_SERVER_NAME, transport: "stdio", command: input.command, args: input.args,
    env: { METACODE_TASK_HISTORY_PATH: snapshotPath }, required: true }];
}
