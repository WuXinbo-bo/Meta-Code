function rejectedControlReceipt(value, depth = 0) {
  if (depth > 5 || value == null) return false;
  if (typeof value === "string") { try { return rejectedControlReceipt(JSON.parse(value), depth + 1); } catch { return false; } }
  if (Array.isArray(value)) return value.some((item) => rejectedControlReceipt(item, depth + 1));
  if (typeof value !== "object") return false;
  if (value.ok === false || value.isError === true || value.is_error === true) return true;
  return rejectedControlReceipt(value.content ?? value.text, depth + 1);
}

/** Observations only: missing native usage/response data remains null. */
export function measureWorkflowRun(workflow, events = []) {
  const phases = [
    ["planning", workflow.plannerLogs || []],
    ...workflow.nodes.map((node) => [`node:${node.id}`, node.logs || []]),
    ["integration", workflow.integrationLogs || []]
  ];
  const calls = [];
  const usageObservations = [];
  for (const [phase, logs] of phases) {
    const seen = new Set();
    for (const log of logs) {
      const detail = log.detail || {};
      const usage = detail.usage || detail.message?.usage;
      if (usage && typeof usage === "object" && Object.values(usage).some((value) => typeof value === "number")) usageObservations.push({ phase, logId: log.id, usage });
      if (log.kind !== "tool" || !log.detail) continue; // Synthetic host status is not a model tool call.
      const identity = `${log.runId || ""}:${log.attempt || ""}:${log.id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const name = String(detail.tool || detail.name || log.activity?.toolName || log.title || "unknown").replace(/(?:完成|开始|运行中)$/, "");
      const control = /(?:^workflow_|workbench.workflow.(?:plan|result)|mcp__workbench-workflow-)/.test(`${detail.server || ""}:${name}`);
      const response = detail.result ?? detail.output;
      const rejected = control && rejectedControlReceipt(response);
      calls.push({ phase, name, control, rejected, failed: rejected || log.phase === "failed" || detail.status === "failed" || detail.result?.is_error === true || detail.result?.isError === true,
        responseBytes: response === undefined ? null : Buffer.byteLength(typeof response === "string" ? response : JSON.stringify(response), "utf8") });
    }
  }
  const duration = (start, end) => {
    const a = Date.parse(start || ""); const b = Date.parse(end || "");
    return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
  };
  const eventTime = (type, last = false) => (last ? [...events].reverse() : events).find((event) => event.type === type)?.createdAt;
  const controlCalls = calls.filter((call) => call.control);
  const observedBytes = controlCalls.filter((call) => call.responseBytes !== null);
  return {
    requestedValidationMode: workflow.plan?.validationMode || "legacy-strict",
    integrationPolicy: events.filter((event) => event.type === "integration.policy").map((event) => event.payload || null),
    toolCalls: calls.length, controlToolCalls: controlCalls.length, businessToolCalls: calls.length - controlCalls.length,
    controlToolCallFraction: calls.length ? controlCalls.length / calls.length : null,
    toolFailures: calls.filter((call) => call.failed).length,
    rejectedControlReceipts: controlCalls.filter((call) => call.rejected).length,
    controlResponseBytes: observedBytes.length ? observedBytes.reduce((sum, call) => sum + call.responseBytes, 0) : null,
    controlResponsesObserved: observedBytes.length,
    controlResponsesMissing: controlCalls.length - observedBytes.length,
    toolCallHistogram: calls.reduce((counts, call) => { counts[call.name] = (counts[call.name] || 0) + 1; return counts; }, {}),
    durationsMs: {
      planning: duration(eventTime("planner.started"), eventTime("plan.ready")),
      executionThroughCompletion: duration(eventTime("plan.approved"), eventTime("workflow.completed")),
      integration: duration(eventTime("integration.started"), eventTime("workflow.completed")),
      total: duration(eventTime("planner.started") || workflow.createdAt, eventTime("workflow.completed") || workflow.completedAt),
      nodes: workflow.nodes.map((node) => ({ id: node.id, elapsed: duration(node.startedAt, node.finishedAt), attempts: node.attempt }))
    },
    // Providers may expose cumulative snapshots; never sum those as per-turn usage.
    usage: workflow.telemetry?.usage || workflow.metrics?.usage || null,
    usageObservations,
    cost: workflow.telemetry?.cost || workflow.metrics?.cost || null,
    measurementNotes: ["Durations include provider/network time; not a direct measure of model attention.", "Tool response bytes come from stored native tool results and may reflect log truncation.", "Missing native usage is null; cumulative observations are not summed."]
  };
}
