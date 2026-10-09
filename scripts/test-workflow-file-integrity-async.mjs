import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureWorkspaceSnapshot } from "../server/plugins/orchestration/enforcement.ts";
import { buildWorkflowFileIntegrity, workflowResultFileIntegrityIssue } from "../server/plugins/orchestration/fileIntegrity.ts";
import { buildWorkflowFileIntegrityAsync, workflowResultFileIntegrityIssueAsync, workflowCompletedFileIntegrityIssuesAsync } from "../server/plugins/orchestration/fileIntegrityAsync.ts";
import { createWorkflowReadObserver } from "../server/plugins/orchestration/readDependencies.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-integrity-worker-"));
const project = path.join(root, "project");
const checkpoint = path.join(root, "checkpoint");
const contract = { id: "inspect", workspaceAccess: "read", writeScope: [], verificationCommands: [], skills: [], mcpServers: [], requiredArtifacts: [], dependsOn: [] };
const result = () => ({ outcome: "completed", humanSummary: "Read source", outputs: [], changedFiles: [], checks: [], decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: [], machineResultPath: null });
const event = (name, input, sourceId = name) => ({ type: "tool.completed", sourceId, toolName: name, text: "done", detail: { input } });
try {
  await fs.mkdir(project); await fs.mkdir(checkpoint);
  await fs.writeFile(path.join(project, "read.txt"), "read input");
  await fs.writeFile(path.join(project, "unrelated.txt"), "other input");
  const workflow = { executionTarget: "workspace", executionRoot: project, workDirectory: project, nodes: [contract] };
  const before = await captureWorkspaceSnapshot(project);
  const native = createWorkflowReadObserver({ executionRoot: project });
  native.observe(event("Read", { file_path: "read.txt" }));
  assert.equal(native.snapshot().complete, false, "No proof of complete observation from event absence");
  assert.match(native.snapshot().fallbackReasons.join(), /adapter-does-not-guarantee/);
  const conservative = result();
  conservative.fileIntegrity = buildWorkflowFileIntegrity(workflow, contract, conservative, before, before, checkpoint, native.snapshot());
  assert.equal(conservative.fileIntegrity.inputMode, "conservative");
  await fs.writeFile(path.join(project, "unrelated.txt"), "external edit");
  assert.match(workflowResultFileIntegrityIssue(workflow, conservative), /输入文件已变化/);

  const capability = { capabilityId: "test-adapter-complete-v1", initialContextPaths: [] };
  const precise = createWorkflowReadObserver({ executionRoot: project, completeReadObservation: capability });
  precise.observe(event("Read", { file_path: "read.txt" }));
  assert.equal(precise.snapshot().complete, true);
  const tracked = result();
  tracked.fileIntegrity = buildWorkflowFileIntegrity(workflow, contract, tracked, before, before, checkpoint, precise.snapshot());
  assert.equal(tracked.fileIntegrity.inputMode, "observed");
  assert.equal(await workflowResultFileIntegrityIssueAsync(workflow, tracked), null, "Unrelated changes can be ignored only with positive capability proof");
  await fs.writeFile(path.join(project, "read.txt"), "changed actual input");
  assert.match(await workflowResultFileIntegrityIssueAsync(workflow, tracked), /输入文件已变化/);
  for (const [name, options, tool] of [
    ["shell", {}, event("Bash", { command: "cat read.txt" })],
    ["MCP", {}, event("mcp__business__read", {})],
    ["unknown", {}, event("NotebookRead", {})],
    ["missing arguments", {}, { ...event("Read", {}), detail: undefined }],
    ["resumed", { resumed: true }, event("Read", { file_path: "read.txt" })],
    ["verification", { verificationCommands: ["node --test"] }, event("Read", { file_path: "read.txt" })],
    ["skill", { externalCapabilities: true }, event("Read", { file_path: "read.txt" })],
    ["outside root", {}, event("Read", { file_path: path.join(root, "outside.txt") })],
    ["ignored directory", {}, event("Read", { file_path: "node_modules/package/index.js" })]
  ]) {
    const observer = createWorkflowReadObserver({ executionRoot: project, completeReadObservation: capability, ...options });
    observer.observe(tool);
    assert.equal(observer.snapshot().complete, false, `${name} must remain conservative`);
  }
  const queryBefore = await captureWorkspaceSnapshot(project);
  const query = createWorkflowReadObserver({ executionRoot: project, completeReadObservation: capability });
  query.observe(event("Glob", { pattern: "*.txt", path: project }));
  const queried = result();
  queried.fileIntegrity = buildWorkflowFileIntegrity(workflow, contract, queried, queryBefore, queryBefore, checkpoint, query.snapshot());
  await fs.writeFile(path.join(project, "new-match.txt"), "new input matched the earlier query");
  assert.match(await workflowResultFileIntegrityIssueAsync(workflow, queried), /输入文件已变化/, "Directory query dependencies detect new matches");

  // Explicit output trees include snapshot-ignored build/node_modules subtrees.
  const outputDir = path.join(project, "output");
  await fs.mkdir(path.join(outputDir, "node_modules"), { recursive: true });
  await fs.mkdir(path.join(outputDir, "build"));
  const count = 1800;
  for (let index = 0; index < count; index += 50) await Promise.all(Array.from({ length: Math.min(50, count - index) }, (_, offset) => fs.writeFile(path.join(outputDir, "node_modules", `asset-${index + offset}.txt`), `asset ${index + offset}\n`.repeat(100))));
  await fs.writeFile(path.join(outputDir, "build", "bundle.js"), "original bundle");
  const writer = { ...contract, id: "produce", workspaceAccess: "write", writeScope: ["output"] };
  workflow.nodes = [writer];
  const output = { ...result(), outputs: [{ id: "bundle", type: "directory", path: "output", mediaType: null, description: "Business delivery", consumableBy: [] }] };
  const snapshot = await captureWorkspaceSnapshot(project);
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 1);
  const started = performance.now();
  try { output.fileIntegrity = await buildWorkflowFileIntegrityAsync(workflow, writer, output, snapshot, snapshot, checkpoint); }
  finally { clearInterval(interval); }
  const elapsedMs = performance.now() - started;
  assert.ok(ticks > 0, "Main event loop must remain responsive while hashing large output trees");
  assert.ok(output.fileIntegrity.outputSignatures["output/node_modules/asset-1799.txt"]);
  assert.ok(output.fileIntegrity.outputSignatures["output/build/bundle.js"]);
  assert.equal(await workflowResultFileIntegrityIssueAsync(workflow, output), null);
  const queued = await Promise.all(Array.from({ length: 6 }, () => workflowResultFileIntegrityIssueAsync(workflow, output)));
  assert.ok(queued.every((issue) => issue === null), "Queued jobs preserve independent structured-clone results");
  const completed = { ...workflow, nodes: [{ ...writer, status: "completed", summary: output, finishedAt: new Date().toISOString() }] };
  assert.ok(await workflowCompletedFileIntegrityIssuesAsync(completed, snapshot) instanceof Map);
  await assert.rejects(buildWorkflowFileIntegrityAsync(workflow, writer, output, snapshot, snapshot, path.join(root, "missing-checkpoint")), /ENOENT/);
  assert.equal(await workflowResultFileIntegrityIssueAsync(workflow, output), null, "A failed job must not poison the next queued check");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await workflowResultFileIntegrityIssueAsync(workflow, output), null, "Idle worker can restart without dropping evidence");
  await fs.writeFile(path.join(outputDir, "node_modules", "asset-1799.txt"), "external output edit");
  assert.match(await workflowResultFileIntegrityIssueAsync(workflow, output), /产物已被修改或删除/);
  await fs.writeFile(path.join(outputDir, "node_modules", "asset-1799.txt"), "asset 1799\n".repeat(100));
  await fs.writeFile(path.join(outputDir, "added.txt"), "external addition");
  assert.match(await workflowResultFileIntegrityIssueAsync(workflow, output), /产物已被修改或删除/);
  await fs.rm(path.join(outputDir, "added.txt"));
  await fs.rm(path.join(outputDir, "build"), { recursive: true });
  assert.match(await workflowResultFileIntegrityIssueAsync(workflow, output), /产物已被修改或删除/);
  try {
    await fs.symlink(path.join(project, "read.txt"), path.join(project, "link.txt"));
    const linked = createWorkflowReadObserver({ executionRoot: project, completeReadObservation: capability });
    linked.observe(event("Read", { file_path: "link.txt" }));
    assert.equal(linked.snapshot().complete, false);
    await fs.symlink(path.join(project, "read.txt"), path.join(outputDir, "link.txt"));
    const linkedOutput = { ...output, fileIntegrity: undefined };
    const linkSnapshot = await captureWorkspaceSnapshot(project);
    linkedOutput.fileIntegrity = await buildWorkflowFileIntegrityAsync(workflow, writer, linkedOutput, linkSnapshot, linkSnapshot, checkpoint);
    assert.match(linkedOutput.fileIntegrity.outputSignatures["output/link.txt"], /^symlink:/);
    await fs.rm(path.join(outputDir, "link.txt"));
    await fs.symlink(path.join(project, "unrelated.txt"), path.join(outputDir, "link.txt"));
    assert.match(await workflowResultFileIntegrityIssueAsync(workflow, linkedOutput), /产物已被修改或删除/);
  } catch (error) { if (error.code !== "EPERM") throw error; }
  console.log(JSON.stringify({ test: "workflow-file-integrity-async", outputFiles: count + 1, elapsedMs: Math.round(elapsedMs), responsiveTimerTicks: ticks, nativeReadDependencies: "conservative", passed: true }));
} finally { await fs.rm(root, { recursive: true, force: true }); }
