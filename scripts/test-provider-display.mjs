import assert from "node:assert/strict";
import { providerMainAgentUnavailableReason, providerShowcaseItems, providerStatusLabel } from "../src/providers/display.ts";

const fixture = (id, status = "ready", runtimeAvailable = true) => ({
  providerId: id, identity: { displayName: id, shortName: id }, lifecycle: { installed: true, runtimeAvailable, updating: false }, connection: { status }
});
const items = [fixture("one"), fixture("two", "attention"), fixture("three"), fixture("four"), fixture("five"), fixture("six"), fixture("missing", "unavailable", false)];
const result = providerShowcaseItems(items, "six", 5);
assert.equal(result.displayed.length, 5);
assert.equal(result.displayed[0].providerId, "six");
assert.equal(result.overflow.length, 1);
assert.equal(result.displayed.some((item) => item.providerId === "missing"), false);
assert.equal(providerStatusLabel("attention"), "需要配置");
const workerOnly = {
  ...fixture("worker-only"),
  lifecycle: { installed: true, runtimeAvailable: true, updating: false, message: "CLI 可用" },
  connection: { status: "ready", message: "账号与连接已通过 ACP 会话校验" },
  capabilities: { sessions: { create: false } },
  operations: { setDefault: false }
};
assert.match(providerMainAgentUnavailableReason(workerOnly), /仅支持作为子 Agent/);
assert.equal(providerMainAgentUnavailableReason({ ...workerOnly, lifecycle: { ...workerOnly.lifecycle, runtimeAvailable: false, message: "未找到 CLI" } }), "未找到 CLI");
console.log("Provider showcase filtering, ordering, and overflow tests passed");
