import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  attachmentPrompt,
  deleteSessionAttachments,
  MAX_ATTACHMENTS_PER_MESSAGE,
  storeAttachment,
  validateAttachments
} from "../dist-server/attachments.js";

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-attachments-test-"));
const sessionId = "task_test";
try {
  const first = await storeAttachment({
    workspaceRoot: root,
    sessionId,
    originalName: "../notes.txt",
    mimeType: "text/plain",
    data: Buffer.from("first")
  });
  const second = await storeAttachment({
    workspaceRoot: root,
    sessionId,
    originalName: "notes.txt",
    mimeType: "text/plain",
    data: Buffer.from("second")
  });

  assert.equal(first.name, "notes.txt");
  assert.notEqual(first.relativePath, second.relativePath);
  assert.match(first.relativePath, /^\.claude-codex\/attachments\/task_test\//);
  assert.equal((await validateAttachments({ workspaceRoot: root, sessionId, value: [first] }))[0].sha256, first.sha256);
  assert.match(attachmentPrompt("检查文件", [first]), /本轮附件已保存到当前任务执行目录/);
  assert.match(attachmentPrompt("检查文件", [first]), /notes\.txt/);

  await assert.rejects(validateAttachments({
    workspaceRoot: root,
    sessionId,
    value: [{ ...first, relativePath: "outside.txt" }]
  }), /不属于当前任务/);
  await assert.rejects(validateAttachments({
    workspaceRoot: root,
    sessionId,
    value: Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => first)
  }), /最多附加 10 个文件/);
  await assert.rejects(storeAttachment({
    workspaceRoot: root,
    sessionId,
    originalName: "empty.txt",
    data: Buffer.alloc(0)
  }), /附件内容为空/);

  await deleteSessionAttachments(root, sessionId);
  await assert.rejects(fsp.stat(path.join(root, ".claude-codex", "attachments", sessionId)), /ENOENT/);
  console.log("Attachment contracts OK");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
