import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { summarizeMessagePayload } from "../server/sessionMessagePayload.ts";

function extract(source, fileName, names, constantNames = []) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Map();
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found.set(node.name.text, node.getText(file));
    if (ts.isVariableDeclaration(node) && constantNames.includes(node.name.getText(file))) found.set(node.name.getText(file), `const ${node.getText(file)};`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const name of [...names, ...constantNames]) assert.ok(found.has(name), `missing identity boundary symbol ${name}`);
  return ts.transpileModule([...found.values()].join("\n"), { fileName, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
}
const plain = value => JSON.parse(JSON.stringify(value));
const serverSource = await readFile(new URL("../server/index.ts", import.meta.url), "utf8");
const messageForResponse = vm.runInNewContext(`${extract(serverSource, "server/index.ts", ["messageForResponse"])}\nmessageForResponse;`, {
  summarizeMessagePayload, safeMessageText: value => typeof value === "string" ? value : "",
  recordOf: value => value && typeof value === "object" && !Array.isArray(value) ? value : undefined,
  isNarrativeMessage: message => message.role === "user" || message.role === "assistant",
  compactStoredActivityDetails: () => {}
}, { filename: "server/index.ts:messageForResponse" });

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const functions = ["asRecord", "parseJsonRecord", "collectDeepValues", "firstDeepString", "subagentInfo", "subagentStatusLabel", "subagentActionLabel", "subagentActivityText", "agentProviderLabel", "EventMessage"];
const ProviderIcon = () => null;
const context = vm.createContext({
  React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
  useState: () => [false, () => {}], ProviderIcon, ChevronRight: () => null,
  compactLine: (value, max = 180) => String(value).slice(0, max),
  claudeQuestions: () => [],
});
vm.runInContext(`${extract(appSource, "src/App.tsx", functions, ["SUBAGENT_ACTIONS", "DEEP_SCAN_SKIP_KEYS"])}\nthis.identityFunctions = { subagentInfo, EventMessage };`, context, { filename: "src/App.tsx:agent-identity" });
const { subagentInfo, EventMessage } = context.identityFunctions;
function providerFromCard(node) {
  if (!node || typeof node !== "object") return undefined;
  if (node.type === ProviderIcon) return node.props.provider;
  for (const child of node.props?.children || []) {
    const provider = providerFromCard(child);
    if (provider) return provider;
  }
}
const card = message => EventMessage({ message, engine: "codex", providerControls: [], onOpenAgent: () => {}, onAnswerQuestion: async () => true });
const message = (payload, extra = {}) => ({ id: "fixture-message", role: "event", eventType: "subagent", eventPhase: "started", sourceId: "claude-worker:fixture", text: "delegated fixture", createdAt: "2026-01-01T00:00:00Z", payload, ...extra });

for (const status of ["running", "completed", "failed", "interrupted"]) {
  const payload = {
    type: "claude_subagent", action: "spawn_agent", provider: "claude", providerId: "claude", nickname: "Evidence review", mode: "review", agent_id: "fixture-agent", status,
    identityKey: "parent:claude:fixture-agent", identityAliases: ["old-id"], identity: { key: "parent:claude:fixture-agent", providerId: "claude", agentId: "fixture-agent", parentSessionId: "parent", sourceKind: "bridge", identityVersion: 1 },
    logs: Array.from({ length: 40 }, (_, index) => ({ id: `log-${index}`, text: "fixture activity".repeat(500), detail: { result: "large tool output".repeat(200) } })),
    result: { output: "must not enter session preview".repeat(2_000) },
    task: "Review bounded fixture", usage: { output_tokens: 20 }, revision: 12
  };
  const original = JSON.stringify(payload);
  const response = messageForResponse(message(payload, { eventPhase: status === "running" ? "started" : "completed" }));
  assert.ok(JSON.stringify(response.payload).length < 24_000, "response summary exceeds the preview budget");
  assert.equal(response.payload.logs, undefined);
  assert.equal(response.payload.result, undefined);
  assert.equal(response.payload.logCount, 40);
  for (const key of ["provider", "providerId", "nickname", "mode", "agent_id", "status", "identityKey"]) assert.equal(response.payload[key], payload[key], key);
  assert.deepEqual(plain(response.payload.identity), payload.identity);
  assert.deepEqual(plain(response.payload.identityAliases), payload.identityAliases);
  assert.equal(JSON.stringify(payload), original, "GET compaction must not mutate stored logs or identity");
  const info = subagentInfo(response);
  assert.equal(info.provider, "claude");
  assert.equal(info.nickname, "Evidence review");
  assert.equal(info.status, status, "terminal status changed across response compaction and UI parsing");
  assert.equal(providerFromCard(card(response)), "claude", "parent Codex cannot override child Claude identity");
}
console.log("Large real session response payloads retain Agent routing, mode, nickname and terminal status while removing nested logs/results without mutating history");

for (const [payload, extra, expected] of [
  [{ type: "claude_subagent", agent_id: "legacy", status: "completed", truncated: true }, {}, "claude"],
  [{ type: "subagent", providerId: "claude", agent_id: "legacy", status: "completed" }, { sourceId: "codex-worker:legacy" }, "claude"],
  [{ type: "subagent", identity: { providerId: "claude" }, provider: "codex", agent_id: "legacy", status: "completed" }, {}, "claude"],
  [{ type: "subagent", agent_id: "legacy", status: "completed" }, {}, "claude"],
  [{ type: "subagent", agent_id: "legacy", status: "completed" }, { sourceId: "codex-worker:legacy" }, "codex"],
  [{ type: "subagent", providerId: "fixture-acp", agent_id: "legacy", status: "completed" }, {}, "fixture-acp"]
]) {
  const legacy = message(payload, extra);
  assert.equal(subagentInfo(legacy).provider, expected);
  assert.equal(providerFromCard(card(legacy)), expected);
}
for (const phase of ["started", "completed"]) {
  const barrier = message({ type: "subagent_wait", counts: { total: 2 } }, { eventType: "subagent_wait", eventPhase: phase, sourceId: "delegated-wait:fixture" });
  assert.equal(subagentInfo(barrier).isSubagent, false, "parent wait bookkeeping must not produce a phantom Agent orb");
  assert.equal(card(barrier), null, "internal waiting barriers must not impersonate a running/completed Codex child");
}
console.log("Actual frontend parsing/rendering keeps legacy, canonical and third-party Provider identities and excludes internal wait barriers from Agent cards");

const oversized = { type: "claude_subagent", provider: "claude", nickname: "x".repeat(80_000), task: "y".repeat(100_000), identity: { key: "k".repeat(80_000), providerId: "claude", unbounded: "discard".repeat(30_000) }, ids: Array.from({ length: 1_000 }, () => "i".repeat(1_000)), logs: [], unknown: "z".repeat(100_000) };
const bounded = messageForResponse(message(oversized)).payload;
assert.ok(JSON.stringify(bounded).length < 24_000);
assert.equal(bounded.unknown, undefined);
assert.equal(bounded.identity.unbounded, undefined);
assert.ok(bounded.nickname.length <= 384);
assert.ok(bounded.task.length <= 2_000);
assert.ok(bounded.identity.key.length <= 512);
assert.ok(bounded.ids.length <= 8);
assert.ok(bounded.ids.every(id => id.length <= 128));
console.log("Oversized identity strings, aliases and arrays remain bounded in the session preview");
