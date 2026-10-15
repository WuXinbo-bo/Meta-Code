import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPublishedArtifact, listPublishedArtifacts, readPublishedArtifact, updatePublishedArtifact } from "../server/activity/publishedArtifacts.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-code-artifacts-"));
try {
  const created = await createPublishedArtifact(root, { ownerUserId: "owner-a", sessionId: "session-1", title: "Report", description: "draft", mediaType: "text/markdown", content: "# v1" });
  assert.equal(created.version, 1);
  assert.equal((await listPublishedArtifacts(root, "owner-b")).length, 0);
  const updated = await updatePublishedArtifact(root, created.id, "owner-a", { content: "# v2", published: true });
  assert.equal(updated.version, 2);
  assert.equal(updated.published, true);
  assert.equal((await readPublishedArtifact(root, created.id, "owner-a")).content, "# v2");
  await assert.rejects(() => readPublishedArtifact(root, created.id, "owner-b"));
  console.log("Published artifact ownership, versioning and updates passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
