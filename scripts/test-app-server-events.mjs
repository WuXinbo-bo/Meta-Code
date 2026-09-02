import assert from "node:assert/strict";
import { classifyAppServerMessage, normalizeCodexThread } from "../server/codexLink/appServerClient.ts";

assert.deepEqual(classifyAppServerMessage({ id: 3, result: { ok: true } }), { kind: "response", id: 3, result: { ok: true }, error: undefined });
assert.deepEqual(classifyAppServerMessage({ method: "fileChange/patch/updated", params: { threadId: "t1", diff: "@@" } }), {
  kind: "notification",
  method: "fileChange/patch/updated",
  params: { threadId: "t1", diff: "@@" }
});
assert.deepEqual(classifyAppServerMessage({ id: 9, method: "item/commandExecution/requestApproval", params: { command: "npm test" } }), {
  kind: "request",
  id: 9,
  method: "item/commandExecution/requestApproval",
  params: { command: "npm test" }
});
assert.deepEqual(classifyAppServerMessage({ garbage: true }), { kind: "invalid" });

const paginated = normalizeCodexThread({ id: "thread-paginated", historyMode: "paginated", status: { type: "idle" }, isPinned: true }, true);
assert.equal(paginated.resumable, true, "paginated threads remain resumable on current app-server APIs");
assert.equal(paginated.archived, true);
assert.equal(paginated.isPinned, true);

console.log("Codex app-server responses, notifications and server requests are classified without dropping pushes");
