import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentTranscriptIndex } from "../dist-server/agentTranscriptIndex.js";

function transcript(threadId, parentThreadId) {
  return `${JSON.stringify({ type: "session_meta", payload: { id: threadId, thread_source: "subagent", source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId } } } } })}\n${JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "task_started" } })}\n`;
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "metacode-agent-index-"));
try {
  const nested = path.join(root, "2026", "08", "28");
  await fsp.mkdir(nested, { recursive: true });
  const child = path.join(nested, "child.jsonl");
  const grandchild = path.join(nested, "grandchild.jsonl");
  const unrelated = path.join(nested, "unrelated.jsonl");
  await Promise.all([
    fsp.writeFile(child, transcript("child", "parent")),
    fsp.writeFile(grandchild, transcript("grandchild", "child")),
    fsp.writeFile(unrelated, transcript("other-child", "other-parent"))
  ]);

  const cacheFile = path.join(root, "cache", "index.json");
  const index = new AgentTranscriptIndex(root, 0, cacheFile);
  const related = await index.related("parent");
  assert.deepEqual(related.map((item) => item.threadId).sort(), ["child", "grandchild"]);
  assert.equal(related.some((item) => item.threadId === "other-child"), false);

  const previousSize = related.find((item) => item.threadId === "child")?.size || 0;
  await fsp.appendFile(child, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n`);
  const changed = await index.related("parent");
  assert.ok((changed.find((item) => item.threadId === "child")?.size || 0) > previousSize);

  const late = path.join(nested, "late.jsonl");
  await fsp.writeFile(late, transcript("late-child", "parent"));
  const refreshed = await index.related("parent");
  assert.equal(refreshed.some((item) => item.threadId === "late-child"), true);

  const persisted = JSON.parse(await fsp.readFile(cacheFile, "utf8"));
  assert.equal(persisted.some((item) => item.threadId === "child"), true);
  const restored = new AgentTranscriptIndex(root, 0, cacheFile);
  assert.deepEqual((await restored.related("parent")).map((item) => item.threadId).sort(), ["child", "grandchild", "late-child"]);
  console.log("Agent transcript index tests passed");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
