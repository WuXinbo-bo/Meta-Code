import { normalizeActivityLogs } from "../components/activityModel";

const controlServer = (value: unknown) => typeof value === "string" && /^workbench[-_]workflow[-_](plan|result)$/.test(value);

/** Preview, counts and transcript share the same effective activity identities. */
export function publicWorkflowActivity(logs: readonly unknown[]) {
  return normalizeActivityLogs(logs).filter((log) => {
    if (log.kind !== "tool" && log.kind !== "error") return true;
    if (/^mcp__workbench[-_]workflow[-_](plan|result)__workflow_/.test(log.title)) return false;
    const raw = log.activity?.detail ?? log.detail;
    const detail = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    return !(controlServer(detail.server) && typeof detail.tool === "string" && detail.tool.startsWith("workflow_"));
  });
}
