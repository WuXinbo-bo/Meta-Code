import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskContextStore, redactTaskText, renderTaskHandoff, sessionHandoff } from "../server/tasks/context.ts";
import { workflowHandoff } from "../server/tasks/routes.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-task-context-"));
const db = new DatabaseSync(path.join(temporary, "contexts.sqlite"));
db.exec("PRAGMA foreign_keys=ON");
const store = new TaskContextStore(db);
const secret = `sk-${"fixture".repeat(4)}`;
const user = (id, text, attachments) => ({ id, role: "user", text, createdAt: new Date().toISOString(), ...(attachments ? { attachments } : {}) });
const handoff = (id, revision = 1) => ({ source: { kind: "session", id }, sourceRevision: revision, goal: "Maintain project", messages: [], attachments: [], decisions: [], files: [], unresolved: [], createdAt: new Date().toISOString() });
try {
  const context = store.ensure({ kind: "session", id: "main-session" }, "owner", "workspace", `Maintain project ${secret}`);
  assert.equal(context.title.includes(secret), false);
  assert.equal(store.ensure({ kind: "session", id: "main-session" }, "owner", "workspace", "Other title").id, context.id);
  assert.equal(store.get(context.id, "other-owner"), null);
  assert.equal(store.forExecution({ kind: "session", id: "main-session" }, "other-owner"), null);
  assert.throws(() => store.ensure({ kind: "session", id: "main-session" }, "other-owner", "workspace", "Wrong owner"), /不属于/);
  assert.throws(() => store.ensure({ kind: "session", id: "main-session" }, "owner", "other-workspace", "Wrong workspace"), /工作区不匹配/);
  const other = store.ensure({ kind: "session", id: "other-session" }, "other-owner", "workspace", "Other owner");
  assert.throws(() => store.link(other.id, { kind: "session", id: "main-session" }, "other-owner", "workspace"), /不属于/);
  store.link(context.id, { kind: "workflow", id: "workflow-one", executionRoot: temporary }, "owner", "workspace");
  store.link(context.id, { kind: "workflow", id: "workflow-two", executionRoot: path.join(temporary, "branch") }, "owner", "workspace");
  store.link(context.id, { kind: "session", id: "claude-session", executionRoot: temporary }, "owner", "workspace");
  assert.equal(store.get(context.id, "owner").executions.length, 4);
  store.ensure({ kind: "session", id: "main-session", executionRoot: temporary }, "owner", "workspace", "Unused title");
  assert.equal(store.get(context.id, "owner").executions[0].executionRoot, temporary);
  assert.throws(() => store.link(context.id, { kind: "session", id: "main-session", executionRoot: path.join(temporary, "wrong") }, "owner", "workspace"), /不能静默更换/);

  const attachment = { name: "Original design", relativePath: "@attachments/main-session/design.txt" };
  const messages = [user("first", `Original goal ${secret}`, [attachment]), ...Array.from({ length: 15 }, (_, index) => user(`followup-${index}`, `Followup ${index}`)), { id: "tool", role: "event", text: "Internal protocol must stay private" }];
  const snapshot = sessionHandoff({ id: "main-session", revision: 17, title: "Automatic title", messages });
  assert.equal(snapshot.goal, "Original goal [REDACTED]");
  assert.equal(snapshot.messages.length, 12);
  assert.equal(snapshot.messages.some((message) => message.id === "tool"), false);
  assert.deepEqual(snapshot.attachments, [{ name: attachment.name, path: attachment.relativePath }]);
  const stored = store.handoff(context.id, "owner", { ...snapshot, unexpectedCredential: secret, decisions: [`api_key="${secret}"`], files: [`https://fixture.test/result?token=${secret}`] });
  assert.equal(JSON.stringify(stored).includes(secret), false);
  assert.equal(Object.hasOwn(stored.handoffs[0], "unexpectedCredential"), false);
  const revision = stored.revision;
  assert.equal(store.handoff(context.id, "owner", snapshot).revision, revision);
  assert.equal(store.handoff(context.id, "owner", handoff("main-session", 5)).revision, revision, "late snapshots must not replace newer context");
  assert.throws(() => store.handoff(context.id, "owner", handoff("missing-source")), /来源不属于/);
  assert.throws(() => store.handoff(context.id, "owner", { ...snapshot, source: { kind: "session", id: "main-session", executionRoot: path.join(temporary, "wrong") } }), /目录不匹配/);
  assert.throws(() => store.handoff(context.id, "owner", { ...snapshot, sourceRevision: -1 }), /版本无效/);
  assert.equal(renderTaskHandoff(stored.handoffs[0]).includes(secret), false);
  for (const credential of [
    `{"apiKey":"${secret}","password":"fixture password"}`,
    `OPENAI_API_KEY=${secret}`,
    "Authorization: Bearer syntheticfixture",
    "Authorization: Basic Zml4dHVyZTpwYXNzd29yZA==",
    "https://user:password@fixture.test/path",
    "https://fixture.test/?access_token=fixture-token&other=keep"
  ]) {
    const redacted = redactTaskText(credential);
    assert.equal(redacted.includes(secret), false);
    assert.match(redacted, /REDACTED/);
    assert.doesNotMatch(redacted, /fixture password|syntheticfixture|Zml4dHVyZTpwYXNzd29yZA==|user:password|fixture-token/);
  }

  db.exec("CREATE TRIGGER reject_context_link BEFORE INSERT ON task_context_executions WHEN NEW.execution_id='reject-link' BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END");
  assert.throws(() => store.link(context.id, { kind: "session", id: "reject-link" }, "owner", "workspace"), /synthetic storage failure/);
  assert.equal(store.forExecution({ kind: "session", id: "reject-link" }, "owner"), null);
  assert.equal(store.get(context.id, "owner").executions.length, 4);
  const count = db.prepare("SELECT COUNT(*) AS count FROM task_contexts").get().count;
  assert.throws(() => store.ensure({ kind: "session", id: "reject-link" }, "owner", "workspace", "Failed creation"), /synthetic storage failure/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_contexts").get().count, count, "failed creation must not leave an empty task");
  db.exec("DROP TRIGGER reject_context_link");

  const result = (text) => ({ outcome: "completed", humanSummary: text, outputs: [{ path: `${text}.txt` }], decisions: [{ key: "choice", value: text }], unresolved: [] });
  const workflow = { id: "workflow-one", revision: 8, originalPrompt: "Actual user goal", executionRoot: temporary, workDirectory: "legacy-root", status: "running", finalResult: result("old-final"), nodes: [
    { id: "valid", title: "Valid", status: "completed", staleReason: null, summary: result("current") },
    { id: "stale", title: "Stale", status: "completed", staleReason: "Inputs changed", summary: result("stale") },
    { id: "running", title: "Running", status: "running", staleReason: null, summary: result("old-running") },
    { id: "failed", title: "Failed", status: "failed", error: "Provider unavailable", summary: null }
  ] };
  let workflowSnapshot = workflowHandoff(workflow);
  assert.equal(workflowSnapshot.goal, "Actual user goal");
  assert.deepEqual(workflowSnapshot.files, ["current.txt"]);
  assert.match(workflowSnapshot.unresolved.join("\n"), /Inputs changed|Provider unavailable/);
  workflow.status = "completed";
  workflowSnapshot = workflowHandoff(workflow);
  assert.equal(workflowSnapshot.messages[0].text.includes("old-final"), false, "final result with stale dependencies cannot be reused");
  workflow.nodes = workflow.nodes.slice(0, 1);
  assert.match(workflowHandoff(workflow).messages[0].text, /old-final/);

  const linked = store.unlink({ kind: "session", id: "main-session" }, "owner");
  assert.equal(linked.executions.length, 3);
  assert.equal(linked.handoffs.length, 0);
  assert.equal(store.forExecution({ kind: "session", id: "main-session" }, "owner"), null);
  assert.equal(store.unlink({ kind: "session", id: "claude-session" }, "other-owner"), null);
  store.unlink({ kind: "session", id: "claude-session" }, "owner");
  store.unlink({ kind: "workflow", id: "workflow-one" }, "owner");
  assert.equal(store.unlink({ kind: "workflow", id: "workflow-two" }, "owner"), null);
  assert.equal(store.get(context.id, "owner"), null);
  console.log("task context: identity/owner/workspace isolation, multiple executions, root binding, bounded secret-redacted handoff, freshness, atomic rollback and unlink cleanup passed");
} finally { db.close(); await fs.rm(temporary, { recursive: true, force: true }); }
