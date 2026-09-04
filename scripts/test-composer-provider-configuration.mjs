import assert from "node:assert/strict";
import {
  acpConfigurationSummary,
  flattenAcpConfigChoices,
  orderedAcpConfigOptions,
  reasoningChoices
} from "../src/chat/providerConfiguration.ts";

const options = [
  { type: "boolean", id: "tools", name: "工具调用", category: "other", currentValue: true },
  { type: "select", id: "mode", name: "Agent 模式", category: "mode", currentValue: "plan", options: [{ value: "plan", name: "规划" }] },
  { type: "select", id: "thinking", name: "思考强度", category: "thought_level", currentValue: "high", options: [{ group: "levels", name: "强度", options: [{ value: "high", name: "高" }] }] },
  { type: "select", id: "model", name: "模型", category: "model", currentValue: "gemini-2.5-pro", options: [{ value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }] }
];

assert.deepEqual(orderedAcpConfigOptions(options).map((option) => option.id), ["model", "thinking", "mode", "tools"]);
assert.deepEqual(flattenAcpConfigChoices(options[2]).map((option) => option.value), ["high"]);
assert.equal(acpConfigurationSummary(options, "Gemini"), "Gemini 2.5 Pro · 高");
assert.equal(acpConfigurationSummary([], "Gemini"), "Gemini");
assert.deepEqual(reasoningChoices({ type: "enum", options: [{ value: "high", label: "高", rank: 2 }, { value: "low", label: "低", rank: 0 }] }), [
  { value: "low", label: "低" },
  { value: "high", label: "高" }
]);
assert.deepEqual(reasoningChoices({ type: "none" }), []);

const runtimeControl = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/chat/ComposerRuntimeControl.tsx", import.meta.url), "utf8"));
assert.match(runtimeControl, /control\?\.configuration\.sessionOptions/);
assert.match(runtimeControl, /onProfileConfigurationChange\(provider, configId, value\)/);
assert.match(runtimeControl, /control\.identity\.transport === "native" \|\| control\.capabilities\.tools\.shell/);
assert.match(runtimeControl, /该 Agent 当前仅支持原生运行/);
assert.doesNotMatch(runtimeControl, /创建任务后可配置此 Agent/);

console.log("Composer Provider configuration contract passed.");
