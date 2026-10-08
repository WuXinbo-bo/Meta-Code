import crypto from "node:crypto";
import type { WorkflowRecord } from "../plugins/orchestration/types.js";
import type { Message, Session } from "../workbench/types.js";
import { redactTaskText, taskRootsEqual, type TaskContextStore } from "./context.js";
import { workflowHandoff } from "./routes.js";

/** Publish into conversations at the result's business root only. */
export function publishTaskWorkflowResult(workflow: WorkflowRecord, ports: {
  store: TaskContextStore;
  sessionById: (id: string, ownerUserId: string) => Session | undefined;
  executionRootForSession: (session: Session) => string | undefined;
  appendMessage: (session: Session, message: Omit<Message, "id" | "createdAt">) => unknown;
  onPublished: (session: Session) => void;
}) {
  const context = ports.store.forExecution({ kind: "workflow", id: workflow.id }, workflow.ownerUserId);
  if (!context) return 0;
  const handoff = workflowHandoff(workflow);
  ports.store.handoff(context.id, workflow.ownerUserId, handoff);
  const resultDigest = crypto.createHash("sha256").update(JSON.stringify({ messages: handoff.messages, decisions: handoff.decisions, files: handoff.files, unresolved: handoff.unresolved })).digest("hex").slice(0, 16);
  const sourceId = `workflow-result:${workflow.id}:${workflow.activePlanVersion}:${workflow.status}:${resultDigest}`;
  let published = 0;
  for (const execution of context.executions.filter((item) => item.kind === "session")) {
    const session = ports.sessionById(execution.id, workflow.ownerUserId);
    if (!session || session.messages.some((message) => message.sourceId === sourceId)) continue;
    const executionRoot = ports.executionRootForSession(session);
    if (!taskRootsEqual(executionRoot, handoff.source.executionRoot)) continue;
    ports.store.link(context.id, { kind: "session", id: session.id, executionRoot }, workflow.ownerUserId, workflow.workspaceId);
    const text = redactTaskText([
      `编排${workflow.status === "completed" ? "已完成" : "进度交接"}：${workflow.title}`,
      handoff.messages[0]?.text || "",
      handoff.decisions.length ? `关键决定：\n${handoff.decisions.join("\n")}` : "",
      handoff.files.length ? `成果：\n${handoff.files.join("\n")}` : "",
      handoff.unresolved.length ? `待处理：\n${handoff.unresolved.join("\n")}` : ""
    ].filter(Boolean).join("\n\n"));
    ports.appendMessage(session, { role: "assistant", text, sourceId, eventType: "task.workflow.result", payload: { workflowId: workflow.id, planVersion: workflow.activePlanVersion, taskContextId: context.id, executionRoot } });
    ports.onPublished(session);
    published += 1;
  }
  return published;
}
