import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodexLinkRepository } from "../dist-server/codexLink/repository.js";

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "meta-codex-link-test-"));
const repository = new CodexLinkRepository(runtime);

try {
  const binding = (overrides = {}) => ({
    ownerUserId: "user-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    threadId: "thread-1",
    accessMode: "resume",
    threadName: "Official task",
    threadPreview: "Preview",
    previousThreadId: "workbench-thread",
    compatibilityMessage: null,
    ...overrides
  });
  const first = repository.bind(binding());
  assert.equal(first.sessionId, "session-1");
  assert.equal(first.accessMode, "resume");
  assert.equal(first.previousThreadId, "workbench-thread");
  assert.equal(repository.findBySession("user-1", "session-1")?.threadId, "thread-1");
  assert.equal(repository.list("user-1", "workspace-1").length, 1);

  const replaced = repository.bind(binding({ threadId: "thread-2", previousThreadId: "should-not-replace-original" }));
  assert.equal(replaced.id, first.id);
  assert.equal(replaced.threadId, "thread-2");
  assert.equal(replaced.previousThreadId, "workbench-thread");
  assert.equal(repository.list("user-1", "workspace-1").length, 1);

  repository.bind(binding({ ownerUserId: "user-2", accessMode: "readOnly", previousThreadId: null }));
  assert.equal(repository.list("user-2", "workspace-1").length, 1);
  const lease = repository.acquireLease({ ownerUserId: "user-1", workspaceId: "workspace-1", sessionId: "session-1", threadId: "thread-1", holder: "holder-1", ttlMs: 60_000 });
  assert.equal(lease?.holder, "holder-1");
  assert.equal(repository.acquireLease({ ownerUserId: "user-1", workspaceId: "workspace-1", sessionId: "session-2", threadId: "thread-1", holder: "holder-2", ttlMs: 60_000 }), null);
  assert.equal(repository.releaseLease("user-1", "thread-1", "holder-1"), true);
  assert.equal(repository.unbind("user-1", first.id)?.previousThreadId, "workbench-thread");
  assert.equal(repository.list("user-1", "workspace-1").length, 0);

  const legacyRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "meta-codex-link-legacy-test-"));
  const legacyDb = new DatabaseSync(path.join(legacyRuntime, "codex-link.db"));
  legacyDb.exec(`CREATE TABLE codex_link_bindings (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, thread_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_user_id, session_id), UNIQUE(owner_user_id, thread_id));`);
  legacyDb.close();
  const migrated = new CodexLinkRepository(legacyRuntime);
  try {
    const columns = migrated.db.prepare("PRAGMA table_info(codex_link_bindings)").all().map((column) => column.name);
    for (const column of ["access_mode", "thread_name", "thread_preview", "previous_thread_id", "compatibility_message"]) assert.ok(columns.includes(column));
  } finally {
    migrated.close();
    fs.rmSync(legacyRuntime, { recursive: true, force: true });
  }
  console.log("Codex link repository tests passed");
} finally {
  repository.close();
  fs.rmSync(runtime, { recursive: true, force: true });
}
