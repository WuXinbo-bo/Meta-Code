import assert from "node:assert/strict";
import { measureWorkflowRun } from "./lib/workflow-live-metrics.mjs";
const workflow = { createdAt: "2026-01-01T00:00:00Z", plan: { validationMode: "standard" }, plannerLogs: [
  { id: "synthetic", kind: "tool", title: "建立规划事务" },
  { id: "plan", kind: "tool", title: "mcp_tool_call完成", detail: { server: "workbench-workflow-plan", tool: "workflow_submit_plan", result: { ok: true } } }
], nodes: [{ id: "fix", attempt: 1, startedAt: "2026-01-01T00:00:03Z", finishedAt: "2026-01-01T00:00:07Z", logs: [
  { id: "read", kind: "tool", title: "Read完成", detail: { output: "source" } },
  { id: "finish", kind: "tool", title: "mcp__workbench-workflow-result__workflow_submit_result完成", detail: { output: "完成" } },
  { id: "finish", kind: "tool", title: "mcp__workbench-workflow-result__workflow_submit_result完成", detail: { output: "完成" } }
] }] };
const events = [{ type: "planner.started", createdAt: "2026-01-01T00:00:00Z" }, { type: "plan.ready", createdAt: "2026-01-01T00:00:02Z" }, { type: "plan.approved", createdAt: "2026-01-01T00:00:03Z" }, { type: "integration.started", createdAt: "2026-01-01T00:00:07Z" }, { type: "workflow.completed", createdAt: "2026-01-01T00:00:09Z" }];
const metrics = measureWorkflowRun(workflow, events);
assert.equal(metrics.toolCalls, 3);
assert.equal(metrics.controlToolCalls, 2);
assert.equal(metrics.businessToolCalls, 1);
assert.equal(metrics.controlResponseBytes, Buffer.byteLength(JSON.stringify({ ok: true })) + Buffer.byteLength("完成"));
assert.equal(metrics.durationsMs.planning, 2000);
assert.equal(metrics.durationsMs.integration, 2000);
assert.equal(metrics.durationsMs.total, 9000);
assert.equal(metrics.usage, null);
assert.equal(metrics.cost, null);
const parallel = measureWorkflowRun({ createdAt: "2026-01-01T00:00:00Z", plannerLogs: [], nodes: [
  { id: "a", startedAt: "2026-01-01T00:00:01Z", finishedAt: "2026-01-01T00:00:05Z", logs: [{ id: "read", kind: "tool", title: "Read完成", createdAt: "2026-01-01T00:00:02Z", detail: { output: "facts" } }] },
  { id: "b", startedAt: "2026-01-01T00:00:02Z", finishedAt: "2026-01-01T00:00:05Z", logs: [] },
  { id: "c", startedAt: "2026-01-01T00:00:05Z", finishedAt: "2026-01-01T00:00:06Z", logs: [{ title: "自动修复机器交接" }] }
] });
assert.equal(parallel.observedNodeOverlapPeak, 2, "Intervals touching at one timestamp do not overlap");
assert.equal(parallel.timeToFirstObservedBusinessToolMs, 2000);
assert.equal(parallel.resultRepairRounds, 1);
assert.equal(measureWorkflowRun({ nodes: [], plannerLogs: [] }).controlResponseBytes, null);
const rejection = measureWorkflowRun({ nodes: [], plannerLogs: [{ id: "rejected", kind: "tool", title: "mcp__workbench-workflow-result__workflow_submit_result完成", detail: { result: { type: "tool_result", content: [{ type: "text", text: JSON.stringify({ ok: false, status: "editing", errors: ["missing artifact"] }) }] } } }] });
assert.equal(rejection.toolFailures, 1, "An MCP transport success with a rejected protocol receipt is still a failed submission");
assert.equal(rejection.rejectedControlReceipts, 1);
console.log("workflow live metrics: actual native tool identities, deduplication, UTF-8 response bytes, phase timing and honest missing usage passed");

// The live outcome oracle must reject the fixture and accept a correct fix.
const { invoiceExportOracle, brokenInvoiceExportSource } = await import("./lib/workflow-open-goal-fixture.mjs");
const fs = await import("node:fs/promises");
const path = await import("node:path");
const os = await import("node:os");
const { execFileSync } = await import("node:child_process");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-oracle-"));
try {
  const oracle = path.join(root, "oracle.mjs");
  const fixture = path.join(root, "export.mjs");
  await fs.writeFile(oracle, invoiceExportOracle);
  await fs.writeFile(fixture, brokenInvoiceExportSource);
  assert.throws(() => execFileSync(process.execPath, [oracle, fixture], { stdio: "pipe" }));
  await fs.writeFile(fixture, String.raw`export function exportInvoices(rows) {
    const field = value => { const text = String(value ?? ""); return /[,"\r\n]/.test(text) ? '"' + text.replaceAll('"','""') + '"' : text; };
    return ['name,amount', ...rows.map(row => [field(row.name),field(row.amount)].join(','))].join('\n');
  }`);
  assert.match(execFileSync(process.execPath, [oracle, fixture], { encoding: "utf8" }), /Independent CSV behavior checks passed/);
  console.log("open-goal oracle: rejects broken CSV, accepts escaping/zero/immutable synchronous API behavior");
} finally { await fs.rm(root, { recursive: true, force: true }); }
