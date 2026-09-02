import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManagementRepository } from "../server/sessionManagement/repository.ts";
import { workbenchInventoryItem } from "../server/sessionManagement/health.ts";
import { readSessionRecoverySnapshot, writeSessionRecoverySnapshot } from "../server/sessionManagement/snapshot.ts";
import { sessionAsMarkdown, sessionAsPortableJson } from "../server/sessionManagement/export.ts";
import { codexOfficialInventory, listClaudeNativeSessions } from "../server/sessionManagement/native.ts";
import { parsePortableSessionImport } from "../server/sessionManagement/import.ts";
import { WorkflowRepository } from "../server/workflows/repository.ts";

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-session-management-"));
const repository = new SessionManagementRepository(root);
try {
  const defaults = repository.preferences("owner");
  assert.equal(defaults.pageSize, 50);
  assert.equal(defaults.autoRepairSafeIssues, false);
  assert.equal(repository.savePreferences("owner", { pageSize: 100, trashRetentionDays: 7 }).trashRetentionDays, 7);
  assert.equal(repository.preferences("owner").pageSize, 100);

  const snapshot = {
    schemaVersion: 1,
    session: { id: "task-1", ownerUserId: "owner", title: "测试会话" },
    delegatedTasks: [{ id: "agent-1", parentSessionId: "task-1" }],
    binding: null,
    createdAt: new Date().toISOString()
  };
  const snapshotPath = await writeSessionRecoverySnapshot(path.join(root, "recovery"), "owner", "task-1", snapshot);
  assert.deepEqual(await readSessionRecoverySnapshot(snapshotPath), snapshot);
  const trash = repository.createTrash({
    sessionId: "task-1",
    ownerUserId: "owner",
    title: "测试会话",
    provider: "codex",
    workspaceId: "workspace-1",
    workspacePath: root,
    snapshotPath,
    deletedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-02-01T00:00:00.000Z"
  });
  assert.equal(repository.listTrash("owner").length, 1);
  assert.equal(repository.getTrash("owner", trash.id)?.sessionId, "task-1");
  assert.equal(repository.expiredTrash("2026-03-01T00:00:00.000Z").length, 1);

  const groupedSnapshotPath = await writeSessionRecoverySnapshot(path.join(root, "recovery"), "owner", "task-grouped", {
    ...snapshot,
    session: { ...snapshot.session, id: "task-grouped" }
  });
  const workspaceTrash = repository.createWorkspaceTrash({
    ownerUserId: "owner",
    workspaceId: "workspace-grouped",
    workspaceName: "成组工作区",
    workspacePath: root,
    sessionCount: 1,
    workflowCount: 1,
    nativeCount: 2,
    snapshot: { schemaVersion: 1, workspace: { id: "workspace-grouped" }, workflowIds: ["workflow-grouped"], sessionTrashIds: [], createdAt: "2026-01-01T00:00:00.000Z" },
    deletedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-02-01T00:00:00.000Z"
  });
  const groupedTrash = repository.createTrash({
    sessionId: "task-grouped",
    ownerUserId: "owner",
    title: "成组会话",
    provider: "claude",
    workspaceId: "workspace-grouped",
    workspacePath: root,
    snapshotPath: groupedSnapshotPath,
    batchId: workspaceTrash.id,
    deletedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-02-01T00:00:00.000Z"
  });
  const groupedSnapshot = { ...workspaceTrash.snapshot, sessionTrashIds: [groupedTrash.id] };
  repository.updateWorkspaceTrashSnapshot("owner", workspaceTrash.id, groupedSnapshot);
  assert.equal(repository.listTrash("owner").length, 1, "工作区批次不应污染普通会话回收站");
  assert.equal(repository.listTrashByBatch("owner", workspaceTrash.id).length, 1);
  assert.equal(repository.getWorkspaceTrash("owner", workspaceTrash.id)?.sessionCount, 1);
  assert.equal(repository.expiredWorkspaceTrash("2026-03-01T00:00:00.000Z").length, 1);

  const workflowRepository = new WorkflowRepository(repository.db);
  const workflow = workflowRepository.create({ id: "workflow-delete-test", ownerUserId: "owner", workspaceId: "workspace-1", prompt: "验证完整清理", plannerEngine: "codex" });
  repository.db.prepare("INSERT INTO workflow_plan_versions (workflow_id, version, status, plan_json, schema_version, created_at) VALUES (?, 1, 'draft', '{}', 1, ?)").run(workflow.id, new Date().toISOString());
  workflowRepository.delete(workflow.id, "owner");
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE id = ?").get(workflow.id).count, 0);
  assert.equal(repository.db.prepare("SELECT COUNT(*) AS count FROM workflow_plan_versions WHERE workflow_id = ?").get(workflow.id).count, 0);

  const healthy = workbenchInventoryItem({
    session: { id: "task-2", title: "正常", engine: "claude", status: "completed", scopeKind: "workspace", workspaceId: "workspace-1", createdAt: "2026-01-01", updatedAt: "2026-01-02", messages: [] },
    workspace: { id: "workspace-1", name: "测试", root },
    linked: false,
    delegatedTaskCount: 0
  });
  assert.equal(healthy.health, "healthy");
  const broken = workbenchInventoryItem({
    session: { id: "task-3", title: "失效", engine: "codex", status: "failed", scopeKind: "workspace", workspaceId: "missing", createdAt: "2026-01-01", updatedAt: "2026-01-02", messages: [] },
    linked: false,
    delegatedTaskCount: 0
  });
  assert.equal(broken.health, "missing-workspace");
  const archived = workbenchInventoryItem({
    session: { id: "task-archived", title: "已归档", engine: "codex", status: "completed", scopeKind: "workspace", workspaceId: "workspace-1", createdAt: "2026-01-01", updatedAt: "2026-01-02", archivedAt: "2026-01-03", messages: [] },
    workspace: { id: "workspace-1", name: "测试", root },
    linked: false,
    delegatedTaskCount: 0
  });
  assert.equal(archived.capabilities.includes("pin"), false, "archived sessions must not advertise pin");
  assert.equal(archived.capabilities.includes("unarchive"), true);

  const exported = { id: "task-4", title: "导出", engine: "codex", createdAt: "2026-01-01", updatedAt: "2026-01-02", messages: [{ role: "user", text: "你好" }, { role: "assistant", text: "完成" }] };
  assert.match(sessionAsMarkdown(exported), /## 用户[\s\S]*你好[\s\S]*## 助手/);
  const portable = JSON.parse(sessionAsPortableJson(exported));
  assert.equal(portable.kind, "metacode-session");
  assert.deepEqual(parsePortableSessionImport(portable), {
    title: "导出",
    engine: "codex",
    workspaceId: "",
    messages: exported.messages,
    createdAt: "2026-01-01"
  });
  assert.equal(parsePortableSessionImport({
    ...portable,
    session: { ...portable.session, engine: "fixture-cli" }
  }).engine, "fixture-cli");
  assert.throws(() => parsePortableSessionImport({
    ...portable,
    session: { ...portable.session, engine: "invalid provider" }
  }), /主脑类型无效/);
  assert.throws(() => parsePortableSessionImport({ schemaVersion: 2, kind: "metacode-session" }), /schemaVersion 1/);

  const claudeRoot = path.join(root, "claude");
  const claudeProject = path.join(claudeRoot, "projects", "project-a");
  await fsp.mkdir(claudeProject, { recursive: true });
  await fsp.writeFile(path.join(claudeProject, "native-1.jsonl"), [
    JSON.stringify({ sessionId: "native-1", cwd: root, timestamp: "2026-01-01T00:00:00.000Z", type: "user", message: { role: "user", content: "原生 Claude 任务" } }),
    JSON.stringify({ sessionId: "native-1", type: "assistant", message: { role: "assistant", content: "完成" } })
  ].join("\n"));
  const claudeItems = await listClaudeNativeSessions(claudeRoot, new Set());
  assert.equal(claudeItems[0]?.id, "claude-native:native-1");
  assert.equal(claudeItems[0]?.capabilities.length, 0);
  assert.equal((await listClaudeNativeSessions(claudeRoot, new Set(["native-1"]))).length, 0);

  const codexItems = codexOfficialInventory([{
    id: "codex-1", name: "官方任务", preview: "", cwd: root, modelProvider: "openai", sourceKind: "cli",
    createdAt: 1, updatedAt: 2, status: { type: "idle" }, forkedFromId: null, isPinned: false, historyMode: "legacy", resumable: true
  }], [{ id: "workspace-1", name: "测试", root }], new Set());
  assert.equal(codexItems[0]?.source, "codex-official");
  assert.deepEqual(codexItems[0]?.capabilities, ["rename", "archive", "delete-native", "resume", "branch"]);
  const activeCodex = codexOfficialInventory([{
    id: "codex-active", name: "执行中", preview: "", cwd: root, modelProvider: "openai", sourceKind: "cli",
    createdAt: 1, updatedAt: 2, status: { type: "active" }, forkedFromId: null, isPinned: false, historyMode: "legacy", resumable: true
  }], [{ id: "workspace-1", name: "测试", root }], new Set())[0];
  assert.deepEqual(activeCodex.capabilities, ["rename"], "active native threads must not expose conflicting lifecycle actions");
  const externalCodex = codexOfficialInventory([{
    id: "codex-2", name: "外部项目", preview: "", cwd: root, modelProvider: "openai", sourceKind: "cli",
    createdAt: 1_800_000_000, updatedAt: 1_800_000_100, status: { type: "idle" }, forkedFromId: null, isPinned: false, historyMode: "paginated", resumable: false
  }], [], new Set(), true)[0];
  assert.equal(externalCodex.health, "healthy");
  assert.match(externalCodex.createdAt, /^2027-/);
  assert.equal(externalCodex.capabilities.includes("resume"), false, "inventory should honor the adapter's negotiated resumable flag");

  repository.removeTrash("owner", trash.id);
  repository.removeTrash("owner", groupedTrash.id);
  repository.removeWorkspaceTrash("owner", workspaceTrash.id);
  assert.equal(repository.listTrash("owner").length, 0);
  console.log("session management tests passed");
} finally {
  repository.close();
  await fsp.rm(root, { recursive: true, force: true });
}
