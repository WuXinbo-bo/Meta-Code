import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentMarketStore } from "../server/providers/market.ts";
import { providerBrandAccent } from "../server/providers/branding.ts";
import { acpDelegationEnvironment, acpProviderManifest, createAcpRuntimeDefinition } from "../server/providers/acp/runtime.ts";

const serverSource = fs.readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const marketViewSource = fs.readFileSync(new URL("../src/settings/AgentMarketSettings.tsx", import.meta.url), "utf8");
assert.match(serverSource, /app\.post\("\/api\/runtime\/:runtimeId\/check-update"/);
assert.doesNotMatch(serverSource, /for \(const runtimeId of cliRuntimeManager\.ids\(\)\)/, "CLI routes must remain available for providers installed after startup");
assert.match(serverSource, /controls: Object\.fromEntries\(controlEntries\)/, "Agent 市场必须返回统一 Provider 控制状态");
assert.match(marketViewSource, /label: "可使用"/, "已连接 Agent 必须区别于仅已安装状态");
assert.match(marketViewSource, /label: "待连接"/, "已安装但未连接的 Agent 必须显示下一步");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-agent-market-"));
let requests = 0;
const document = {
  version: "1.0.0",
  agents: [{
    id: "fixture-agent", name: "Fixture Agent", version: "1.2.3", description: "fixture", authors: ["test"], license: "MIT",
    distribution: { npx: { package: "@fixture/agent@1.2.3", args: ["--acp"] } }
  }]
};
const client = { list: async () => { requests += 1; return structuredClone(document); } };
const store = new AgentMarketStore(root, client);

const catalog = await store.catalog([
  { id: "codex", name: "Codex CLI", version: "1", description: "native" },
  { id: "claude", name: "Claude CLI", version: "1", description: "native" }
]);
assert.equal(requests, 1);
assert.equal(catalog.items.length, 4);
assert.deepEqual(catalog.items.slice(0, 2).map((item) => item.id), ["codex", "claude"]);
assert.equal(catalog.items.find((item) => item.id === "deepseek-harness")?.verified, true);
assert.equal(catalog.items.find((item) => item.id === "deepseek-harness")?.maturity, "preview");
assert.equal(catalog.items.find((item) => item.id === "deepseek-harness")?.installable, true);
const deepseek = await store.agent("deepseek-harness");
assert.equal(deepseek.distribution.npx?.package, "@deepseek-ai/dsh@0.1.1-rc.2");
assert.equal(createAcpRuntimeDefinition(deepseek)?.command, "dsh");
assert.equal(catalog.items.find((item) => item.id === "fixture-agent")?.installed, false);
assert.equal(catalog.items.find((item) => item.id === "fixture-agent")?.accent, providerBrandAccent("fixture-agent"));
assert.equal(providerBrandAccent("gemini"), "#4285f4");
assert.equal(fs.existsSync(path.join(root, "installed.json")), false, "listing the catalog must not install an Agent");

store.rememberInstalled(document.agents[0]);
assert.equal(store.installed()[0].agent.id, "fixture-agent");
assert.equal(acpProviderManifest(document.agents[0]).capabilities.delegation.worker, true);
assert.equal(acpProviderManifest(document.agents[0]).capabilities.delegation.nativeSubagents, false);
assert.deepEqual(acpDelegationEnvironment({ enabled: false }), { WORKBENCH_AGENT_DEPTH: "1" });
assert.deepEqual(acpDelegationEnvironment({ enabled: true, bridgeUrl: "http://127.0.0.1/bridge", bridgeToken: "secret", parentTaskId: "parent-1" }), {
  WORKBENCH_AGENT_BRIDGE_URL: "http://127.0.0.1/bridge",
  WORKBENCH_AGENT_BRIDGE_TOKEN: "secret",
  WORKBENCH_PARENT_TASK_ID: "parent-1",
  WORKBENCH_AGENT_DEPTH: "0"
});
assert.throws(() => acpDelegationEnvironment({ enabled: true }), /缺少工作台委派桥接配置/);
assert.equal((await store.catalog([])).items.find((item) => item.id === "fixture-agent")?.installed, true);

const offline = new AgentMarketStore(root, { list: async () => { throw new Error("offline"); } });
const cached = await offline.registry();
assert.equal(cached.source, "cache");
assert.equal(cached.document.agents[0].id, "fixture-agent");

fs.rmSync(root, { recursive: true, force: true });
console.log("Agent market catalog, explicit install record, and offline Registry cache tests passed");
