import fs from "node:fs";
import path from "node:path";
import { snapshotEntryIgnored } from "./enforcement.js";
import type { NormalizedEngineEvent } from "../../engines/types.js";

export type WorkflowReadEvidence = {
  schemaVersion: 1;
  source: "host-native-tool-events";
  complete: boolean;
  capabilityId: string | null;
  paths: string[];
  toolEvents: number;
  fallbackReasons: string[];
};

/** Completeness must be explicitly promised by the adapter, never inferred from
 * a model's report or the absence of shell calls. Current native adapters do not
 * make that promise, so their evidence intentionally remains conservative. */
export function createWorkflowReadObserver(options: {
  executionRoot: string;
  completeReadObservation?: { capabilityId: string; initialContextPaths: string[] };
  resumed?: boolean;
  verificationCommands?: string[];
  externalCapabilities?: boolean;
}) {
  const root = path.resolve(options.executionRoot);
  const reasons = new Set<string>();
  const paths = new Set<string>();
  const observed = new Set<string>();
  const capability = options.completeReadObservation;
  if (!capability?.capabilityId) reasons.add("adapter-does-not-guarantee-complete-read-observation");
  if (options.resumed) reasons.add("resumed-session-has-unobserved-prior-inputs");
  if (options.verificationCommands?.length) reasons.add("verification-command-inputs-are-not-observed");
  if (options.externalCapabilities) reasons.add("external-skill-or-mcp-inputs-are-not-observed");
  const addPath = (value: unknown, directory: boolean) => {
    if (typeof value !== "string" || !value.trim()) { reasons.add("tool-path-not-observed"); return; }
    const absolute = path.resolve(root, value);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (relative.split("/").slice(0, directory ? undefined : -1).some((part) => snapshotEntryIgnored(part, true))) { reasons.add("read-in-snapshot-excluded-directory"); return; }
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) { reasons.add("read-outside-execution-root"); return; }
    // A symlink may reach another root; the workspace snapshot records the
    // link identity but cannot certify the content the provider followed.
    let cursor = root;
    for (const part of relative.split("/").filter(Boolean)) {
      cursor = path.join(cursor, part);
      try { if (fs.lstatSync(cursor).isSymbolicLink()) { reasons.add("read-through-symbolic-link"); return; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") reasons.add("read-path-cannot-be-verified"); }
    }
    paths.add(directory ? `directory:${relative || "."}` : relative || ".");
  };
  for (const initial of capability?.initialContextPaths || []) addPath(initial, initial.endsWith("/"));
  return {
    observe(event: NormalizedEngineEvent) {
      if (event.type !== "tool.started" && event.type !== "tool.completed") return;
      const detail = event.detail && typeof event.detail === "object" ? event.detail as Record<string, unknown> : {};
      const name = String(detail.tool || event.toolName || "");
      const identity = event.sourceId || `${name}:${observed.size}`;
      if (observed.has(identity)) return;
      observed.add(identity);
      if (/^workflow_/.test(name) && /workbench-workflow-(?:plan|result)/.test(String(detail.server || "")) || /^mcp__workbench-workflow-(?:plan|result)__workflow_/.test(name)) return;
      if (!["Read", "Glob", "Grep"].includes(name)) { reasons.add(`unobserved-tool-inputs:${name || "unknown"}`); return; }
      const input = detail.input && typeof detail.input === "object" ? detail.input as Record<string, unknown> : null;
      if (!input) { reasons.add("native-tool-arguments-missing"); return; }
      if (name === "Read") addPath(input.file_path, false);
      else addPath(input.path || root, true); // Query results depend on new/deleted matches as well.
    },
    snapshot(): WorkflowReadEvidence {
      return { schemaVersion: 1, source: "host-native-tool-events", complete: reasons.size === 0, capabilityId: capability?.capabilityId || null, paths: [...paths].sort(), toolEvents: observed.size, fallbackReasons: [...reasons].sort() };
    }
  };
}
