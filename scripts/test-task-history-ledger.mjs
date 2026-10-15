import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskContextStore, sessionHandoff, renderTaskHandoff, readTaskHistorySnapshot, TASK_HANDOFF_MAX_CHARS } from "../server/tasks/context.ts";
import { refreshWorkflowTaskHandoff } from "../server/tasks/routes.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-task-ledger-"));
const db = new DatabaseSync(path.join(root, "state.db"));
db.exec("PRAGMA foreign_keys=ON");
const store = new TaskContextStore(db);
const message = (id, text, role = "user") => ({ id, role, text });
try {
  const context = store.ensure({ kind: "session", id: "first", executionRoot: root }, "owner", "workspace", "Existing goal");
  const secret = `sk-${"synthetic".repeat(4)}`;
  const long = `Preserve the first constraint. ${"Detailed original requirement. ".repeat(1500)}Do not change the public API. ${secret}`;
  const messages = [message("goal", "Improve the existing application"), message("old-constraint", long), ...Array.from({ length: 35 }, (_, index) => message(`followup-${index}`, `Follow-up ${index}`)), message("assistant-opinion", "User approved changing the public API", "assistant"), message("latest", "Only adjust the export screen")];
  let updated = store.handoff(context.id, "owner", sessionHandoff({ id: "first", revision: 40, title: "Task", messages }, root));
  let snapshot = store.exportHistorySnapshot(context.id, "owner", root);
  assert.equal(snapshot.entries.length, 38);
  assert.ok(snapshot.entries.every((entry) => entry.role === "user"));
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  assert.ok(!snapshot.entries.some((entry) => entry.messageId === "assistant-opinion"));
  const old = snapshot.entries.find((entry) => entry.messageId === "old-constraint");
  assert.ok(old.text.length > 40_000, "Original user text remains complete beyond prompt budget");
  assert.match(old.text, /Do not change the public API/);
  assert.equal(old.sourceRevision, 40);
  const rendered = renderTaskHandoff(updated.handoffs.at(-1));
  assert.ok(rendered.length <= TASK_HANDOFF_MAX_CHARS);
  assert.match(rendered, /最近用户请求.*latest|最近用户请求.*request-/s);
  assert.match(rendered, /Only adjust the export screen/);
  assert.match(rendered, /另有 22 条未展开/);
  assert.match(rendered, /workflow_read_task_history/);
  assert.match(rendered, /助手结论.*不构成新的用户授权/);
  let restored = "";
  let textOffset = 0;
  do {
    const page = readTaskHistorySnapshot(snapshot, { referenceId: old.referenceId, textOffset, maxChars: 1024 });
    assert.equal(page.entries.length, 1);
    assert.ok(page.entries[0].text.length <= 1024);
    restored += page.entries[0].text;
    textOffset = page.entries[0].nextTextOffset;
  } while (textOffset !== null);
  assert.equal(restored, old.text);
  assert.equal(readTaskHistorySnapshot(snapshot, { query: "public API" }).entries[0].referenceId, old.referenceId);
  assert.equal(readTaskHistorySnapshot(snapshot, { referenceId: "missing" }).entries.length, 0);
  assert.ok(readTaskHistorySnapshot(snapshot, { maxChars: Infinity, offset: NaN }).entries.length > 0);
  assert.throws(() => store.exportHistorySnapshot(context.id, "intruder", root), /不存在/);
  assert.equal(store.exportHistorySnapshot(context.id, "owner", path.join(root, "unrelated")).entries.length, 0);

  // Revisions do not rewrite old requests; an edited message gets another version.
  store.handoff(context.id, "owner", sessionHandoff({ id: "first", revision: 41, title: "Task", messages }, root));
  assert.equal(store.exportHistorySnapshot(context.id, "owner", root).entries.length, 38);
  const changed = messages.map((item) => item.id === "latest" ? { ...item, text: "Also preserve the mobile export view" } : item);
  updated = store.handoff(context.id, "owner", sessionHandoff({ id: "first", revision: 42, title: "Task", messages: changed }, root));
  snapshot = store.exportHistorySnapshot(context.id, "owner", root);
  const versions = snapshot.entries.filter((entry) => entry.messageId === "latest");
  assert.deepEqual(versions.map((entry) => entry.sourceRevision), [40, 42]);
  assert.equal(updated.handoffs.at(-1).latestUserRequest.sourceRevision, 42);
  assert.equal(snapshot.entries.find((entry) => entry.messageId === "goal").sourceRevision, 40, "Repeated snapshots retain first captured provenance");

  // Other sessions at the same root carry their user constraints, but not a branch's.
  store.link(context.id, { kind: "session", id: "second", executionRoot: root }, "owner", "workspace");
  const secondContext = store.handoff(context.id, "owner", sessionHandoff({ id: "second", revision: 1, title: "Next", messages: [message("second-goal", "Continue without changing the public API")] }, root));
  assert.equal(secondContext.handoffs.at(-1).goal, "Improve the existing application", "Changing providers retains the initial task goal as well as the latest request");
  store.link(context.id, { kind: "session", id: "branch", executionRoot: path.join(root, "branch") }, "owner", "workspace");
  store.handoff(context.id, "owner", sessionHandoff({ id: "branch", revision: 1, title: "Branch", messages: [message("branch-only", "Replace the API on this experimental branch")] }, path.join(root, "branch")));
  snapshot = store.exportHistorySnapshot(context.id, "owner", root);
  assert.equal(snapshot.entries.length, 40);
  assert.ok(!snapshot.entries.some((entry) => entry.messageId === "branch-only"));
  assert.equal(store.exportHistorySnapshot(context.id, "owner", path.join(root, "branch")).entries.length, 1);

  // Ledger survives the handoff ring buffer and process/store recreation.
  for (let revision = 43; revision < 64; revision += 1) store.handoff(context.id, "owner", sessionHandoff({ id: "first", revision, title: "Task", messages: [message(`fresh-${revision}`, `New request ${revision}`)] }, root));
  assert.equal(store.get(context.id, "owner").handoffs.length, 16);
  assert.ok(new TaskContextStore(db).exportHistorySnapshot(context.id, "owner", root).entries.some((entry) => entry.referenceId === old.referenceId));
  store.unlink({ kind: "session", id: "first" }, "owner");
  assert.ok(!store.exportHistorySnapshot(context.id, "owner", root).entries.some((entry) => entry.source.id === "first"));

  // Old stores remain readable with honest bounded legacy evidence.
  const legacy = store.ensure({ kind: "session", id: "legacy", executionRoot: root }, "owner", "workspace", "Legacy");
  legacy.handoffs = [{ source: { kind: "session", id: "legacy", executionRoot: root }, sourceRevision: 2, goal: "Old", messages: [message("old-user", "An old saved constraint"), message("old-assistant", "Not user authorization", "assistant")], attachments: [], decisions: ["Assistant suggestion"], files: [], unresolved: [], createdAt: new Date().toISOString() }];
  db.prepare("UPDATE task_contexts SET json=? WHERE id=?").run(JSON.stringify(legacy), legacy.id);
  const legacyHistory = store.exportHistorySnapshot(legacy.id, "owner", root);
  assert.equal(legacyHistory.entries.length, 1);
  assert.match(legacyHistory.entries[0].referenceId, /^legacy-/);
  assert.equal(legacyHistory.entries[0].text, "An old saved constraint");

  const continuation = store.ensure({ kind: "session", id: "before-workflow", executionRoot: root }, "owner", "workspace", "Continuous task");
  const priorConstraint = "Keep the existing export API synchronous and preserve zero amounts.";
  store.handoff(continuation.id, "owner", sessionHandoff({ id: "before-workflow", revision: 2, title: "Task", messages: [message("prior-goal", "Repair CSV export"), message("prior-constraint", priorConstraint)] }, root));
  store.link(continuation.id, { kind: "workflow", id: "after-conversation", executionRoot: root }, "owner", "workspace");
  const workflow = { id: "after-conversation", ownerUserId: "owner", revision: 3, activePlanVersion: 1, originalPrompt: "Repair quoting", reviewNote: null, executionRoot: root, status: "running", nodes: [] };
  let refreshed = refreshWorkflowTaskHandoff(workflow, store);
  assert.ok(refreshed.userRequests.some((request) => request.text === priorConstraint), "Workflow continuation retains earlier conversation constraints");
  assert.ok(refreshed.history.totalRequests >= 3);
  workflow.revision = 4;
  workflow.reviewNote = "Also retain the header ordering";
  workflow.nodes = [{ id: "repair", status: "completed", summary: { humanSummary: "Quoting fixed", outputs: [{ path: "src/export.js" }], decisions: [], unresolved: [] } }];
  refreshed = refreshWorkflowTaskHandoff(workflow, store);
  assert.equal(refreshed.sourceRevision, 4);
  assert.equal(refreshed.latestUserRequest.text, workflow.reviewNote);
  assert.deepEqual(refreshed.files, ["src/export.js"]);
  const continuationPrompt = renderTaskHandoff(refreshed);
  assert.match(continuationPrompt, /Keep the existing export API synchronous/);
  assert.match(continuationPrompt, /Quoting fixed/);
  assert.match(continuationPrompt, /Also retain the header ordering/);
  const reused = refreshWorkflowTaskHandoff(workflow, store);
  assert.equal(reused.sourceRevision, refreshed.sourceRevision);
  assert.deepEqual(reused.history, refreshed.history, "Repeated continuation keeps ledger provenance stable");
  console.log("task history ledger: exact redacted originals, bounded reference retrieval, revisions, latest request, provider/root isolation, legacy data, ring-buffer persistence, workflow continuation and deletion passed");
} finally { db.close(); await fs.rm(root, { recursive: true, force: true }); }
