import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { captureWorkspaceSnapshotSync, workflowFileScopeMatcher, type WorkspaceSnapshot } from "./enforcement.js";
import { resolveWorkflowResultPath, workflowExecutionRoot } from "./executionRoot.js";
import type { WorkflowFileIntegrity, WorkflowNodeRecord, WorkflowNodeResult, WorkflowRecord } from "./types.js";

function relevantInputs(snapshot: WorkspaceSnapshot, integrity: Pick<WorkflowFileIntegrity, "excludedInputPaths" | "includedInputPaths" | "executionRoot" | "outputPaths">) {
  const included = new Set(integrity.includedInputPaths);
  const directories = integrity.includedInputPaths.filter((file) => file.startsWith("directory:")).map((file) => file.slice("directory:".length));
  const excluded = workflowFileScopeMatcher(integrity.excludedInputPaths, integrity.executionRoot);
  const outputs = workflowFileScopeMatcher(integrity.outputPaths, integrity.executionRoot);
  return new Map([...snapshot].filter(([file]) => !outputs(file) && (!excluded(file)
    || included.has(file) || directories.some((directory) => file.startsWith(`${directory}/`)))));
}

function outputSignatures(workflow: WorkflowRecord, outputPaths: string[], snapshot: WorkspaceSnapshot) {
  const root = workflowExecutionRoot(workflow);
  const outputMatches = workflowFileScopeMatcher(outputPaths, root);
  const signatures = Object.fromEntries([...snapshot].filter(([file]) => outputMatches(file)));
  const recordFile = (absolute: string, relative: string, stat: fs.Stats) => {
    signatures[relative] = stat.isSymbolicLink() ? `symlink:${fs.readlinkSync(absolute)}`
      : stat.size <= 2 * 1024 * 1024 ? crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")
      : `metadata:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  };
  const recordDirectory = (absolute: string, relative: string) => {
    signatures[`directory:${relative}`] = "directory";
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(absolute, entry.name);
      const childRelative = path.relative(root, child).replaceAll("\\", "/");
      if (entry.isDirectory()) recordDirectory(child, childRelative);
      else if (entry.isFile() || entry.isSymbolicLink()) recordFile(child, childRelative, fs.lstatSync(child));
    }
  };
  for (const file of outputPaths) {
    const resolved = resolveWorkflowResultPath(workflow, file, false);
    try {
      const stat = fs.lstatSync(resolved.absolute);
      // Snapshot ignores are for transient/source scan performance. Explicit
      // business directory outputs still need their complete contents checked.
      if (stat.isDirectory()) recordDirectory(resolved.absolute, resolved.relative);
      else if (stat.isFile() || stat.isSymbolicLink()) recordFile(resolved.absolute, resolved.relative, stat);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      signatures[`missing:${file}`] = "missing";
    }
  }
  return signatures;
}

export function buildWorkflowFileIntegrity(workflow: WorkflowRecord, node: WorkflowNodeRecord, result: WorkflowNodeResult, before: WorkspaceSnapshot, after: WorkspaceSnapshot, checkpointDirectory: string): WorkflowFileIntegrity {
  const executionRoot = workflowExecutionRoot(workflow);
  const outputPaths = [...new Set([...result.outputs.flatMap((output) => output.path ? [output.path] : []), ...result.changedFiles])]
    .flatMap((file) => { try { return [resolveWorkflowResultPath(workflow, file, false).relative]; } catch { return []; } });
  const authorized = workflowFileScopeMatcher(node.writeScope, executionRoot);
  for (const file of result.changedFiles.filter((item) => before.has(item) && !after.has(item))) {
    let directory = path.posix.dirname(file);
    while (directory !== ".") {
      if (authorized(directory) && !fs.existsSync(path.join(executionRoot, directory)) && !outputPaths.includes(directory)) outputPaths.push(directory);
      directory = path.posix.dirname(directory);
    }
  }
  const outputMatches = workflowFileScopeMatcher(outputPaths, executionRoot);
  const priorInputFiles = [...before.keys()].filter((file) => !outputMatches(file));
  const upstreamFiles = workflow.nodes.filter((item) => node.dependsOn.includes(item.id)).flatMap((item) => item.summary?.outputs.flatMap((output) => output.path ? [output.path] : []) || []);
  const explicitInputs = [...node.requiredArtifacts, ...upstreamFiles].flatMap((file) => {
    try {
      const resolved = resolveWorkflowResultPath(workflow, file, false);
      return [fs.existsSync(resolved.absolute) && fs.statSync(resolved.absolute).isDirectory() ? `directory:${resolved.relative}` : resolved.relative];
    } catch { return []; }
  });
  const includedInputPaths = [...new Set([...priorInputFiles, ...explicitInputs])];
  // Files assigned to other approved producers may legitimately change later.
  // Explicit upstream inputs remain checked even inside those write scopes.
  const excludedInputPaths = workflow.nodes.filter((item) => item.workspaceAccess === "write").flatMap((item) => item.writeScope);
  const integrity: WorkflowFileIntegrity = { schemaVersion: 1, verifiedAt: new Date().toISOString(), executionRoot, inputSnapshotPath: path.join(checkpointDirectory, "input-snapshot.json"), excludedInputPaths, includedInputPaths, outputPaths, outputSignatures: outputSignatures(workflow, outputPaths, after) };
  fs.writeFileSync(integrity.inputSnapshotPath, JSON.stringify([...relevantInputs(before, integrity)]), { encoding: "utf8", mode: 0o600 });
  return integrity;
}

export function workflowResultFileIntegrityIssue(workflow: WorkflowRecord, result: WorkflowNodeResult | null, currentSnapshot?: WorkspaceSnapshot, supersedingChanges: ReadonlySet<string> = new Set()): string | null {
  if (!result) return "节点没有可复用结果";
  const integrity = result.fileIntegrity;
  if (!integrity) return workflow.executionTarget === "workspace" || workflow.executionTarget === "worktree" ? "历史结果缺少业务文件版本记录，需要重新执行" : null;
  try {
    const root = workflowExecutionRoot(workflow);
    if (path.resolve(integrity.executionRoot) !== root) return "业务执行目录已变化";
    const snapshot = currentSnapshot || captureWorkspaceSnapshotSync(root);
    const saved = new Map(JSON.parse(fs.readFileSync(integrity.inputSnapshotPath, "utf8")) as Array<[string, string]>);
    const previous = new Map([...relevantInputs(saved, integrity)].filter(([file]) => !supersedingChanges.has(file)));
    const current = new Map([...relevantInputs(snapshot, integrity)].filter(([file]) => !supersedingChanges.has(file)));
    if (previous.size !== current.size || [...previous].some(([file, signature]) => current.get(file) !== signature)) return "节点输入文件已变化，需要重新执行";
    const currentOutputs = outputSignatures(workflow, integrity.outputPaths, snapshot);
    const retained = (entries: Record<string, string>) => Object.entries(entries).filter(([file]) => !supersedingChanges.has(file.replace(/^(?:directory|missing):/, ""))).sort();
    if (JSON.stringify(retained(currentOutputs)) !== JSON.stringify(retained(integrity.outputSignatures))) return "节点产物已被修改或删除，需要重新执行";
    return null;
  } catch (error) { return `节点文件版本无法验证：${error instanceof Error ? error.message : String(error)}`; }
}

export function workflowCompletedFileIntegrityIssues(workflow: WorkflowRecord, snapshot: WorkspaceSnapshot, eligibleWriterIds?: ReadonlySet<string>) {
  const issues = new Map<string, string>();
  const completed = workflow.nodes.filter((node) => node.status === "completed");
  const currentOutputs = new Map<string, Record<string, string>>();
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const dependsOn = (node: WorkflowNodeRecord, ancestor: string): boolean => {
    const pending = [...node.dependsOn];
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === ancestor) return true;
      if (visited.has(id)) continue;
      visited.add(id);
      pending.push(...(nodes.get(id)?.dependsOn || []));
    }
    return false;
  };
  for (const node of completed) {
    const supersedingChanges = new Set<string>();
    const verifiedAt = (item: WorkflowNodeRecord) => Date.parse(item.summary?.fileIntegrity?.verifiedAt || item.finishedAt || "");
    const finishedAt = verifiedAt(node);
    // Later verified writers may intentionally update a predecessor's files.
    // Accept only actual recorded changes whose latest signatures still match.
    const laterWriters = completed.filter((writer) => writer.id !== node.id && writer.workspaceAccess === "write" && writer.summary?.fileIntegrity
      && (!eligibleWriterIds || eligibleWriterIds.has(writer.id))
      && Number.isFinite(finishedAt) && (dependsOn(writer, node.id) || verifiedAt(writer) > finishedAt))
      .sort((left, right) => dependsOn(right, left.id) ? -1 : dependsOn(left, right.id) ? 1 : verifiedAt(left) - verifiedAt(right));
    for (const writer of laterWriters) {
      try {
        const integrity = writer.summary!.fileIntegrity!;
        if (path.resolve(integrity.executionRoot) !== workflowExecutionRoot(workflow)) continue;
        let actual = currentOutputs.get(writer.id);
        if (!actual) { actual = outputSignatures(workflow, integrity.outputPaths, snapshot); currentOutputs.set(writer.id, actual); }
        const authorized = workflowFileScopeMatcher(writer.writeScope, workflowExecutionRoot(workflow));
        const recordedDeletes = integrity.outputPaths.filter((file) => integrity.outputSignatures[`missing:${file}`] === "missing");
        for (const file of new Set([...writer.summary!.changedFiles, ...recordedDeletes])) {
          if (!authorized(file)) continue;
          const expected = integrity.outputSignatures[file];
          const observed = actual[file];
          const verifiedDeletion = integrity.outputSignatures[`missing:${file}`] === "missing" && actual[`missing:${file}`] === "missing" && !snapshot.has(file);
          if (expected !== undefined && expected === observed || verifiedDeletion) supersedingChanges.add(file);
          else supersedingChanges.delete(file);
        }
      } catch { /* A damaged later result cannot authorize predecessor changes. */ }
    }
    const issue = workflowResultFileIntegrityIssue(workflow, node.summary, snapshot, supersedingChanges);
    if (issue) issues.set(node.id, issue);
  }
  return issues;
}
