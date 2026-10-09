import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { registerOrchestrationExtensionRoutes } from "../server/plugins/orchestration/extensionRoutes.ts";
import { WorkflowDefinitionStore } from "../server/plugins/orchestration/definitions.ts";
import { DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES } from "../server/plugins/orchestration/plan.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-extension-api-"));
const environment = { availableSkills: new Set(), availableMcpServers: new Set(), providerCapabilities: DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES, plannerAvailable: () => true };
const plan = {
  planSchemaVersion: 3, title: "Research", summary: "Research", assumptions: [], questions: [], risks: [],
  finalDelivery: { required: false, directory: "deliverables", reason: "Analysis only" },
  audit: { status: "passed", changes: [], checks: ["dependency-minimality", "critical-path", "concurrency-utilization", "read-write-consistency", "provider-allocation", "final-delivery"].map((key) => ({ key, status: "passed", note: "checked" })) },
  nodes: [{ id: "research", title: "Research", objective: "Analyze", nonGoals: [], constraints: [], dependsOn: [], provider: "claude", providerReason: "Research", skills: [], mcpServers: [], mcpRequired: false, workspaceAccess: "read", writeScope: [], requiredArtifacts: [], deliverables: [], acceptance: ["Provide findings"], verificationCommands: [], failurePolicy: "review", required: true }]
};
let workflow = { id: "workflow", ownerUserId: "owner", workspaceId: "workspace", revision: 1, status: "completed", worktreeId: "worktree", plan, title: "Research", originalPrompt: "Research", plannerEngine: "claude" };
let createdInput;
let integrated = 0;
let releases = 0;
let locked = false;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUser = { id: "owner" }; next(); });
registerOrchestrationExtensionRoutes(app, {
  definitions: new WorkflowDefinitionStore(temporary),
  acquireRequest: () => () => { releases += 1; },
  workflowById: (id) => id === workflow.id ? workflow : null,
  definitionEnvironment: async (workspaceId) => { if (workspaceId !== "workspace") throw new Error("Workspace unavailable"); return environment; },
  createDefinitionWorkflow: async (input) => { createdInput = input; return { ...workflow, id: "new-workflow", status: "awaiting_approval" }; },
  workflowRuntimeActive: () => false,
  withWorkspaceWriteLock: async (_id, _owner, operation) => { locked = true; try { return await operation(); } finally { locked = false; } },
  onWorkflowIntegrated: () => { assert.equal(locked, true); },
  targets: {
    compare: async () => ({ binding: { revision: 2 }, previewDigest: "preview" }),
    integrate: async (_id, _owner, input) => { assert.equal(locked, true); assert.equal(input.previewDigest, "preview"); integrated += 1; return { status: "integrated" }; }
  }
});
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const request = async (route, body, method = "POST") => {
  const response = await fetch(`${url}${route}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};
try {
  const saved = await request("/api/workflow-definitions", { workflowId: "workflow", name: "Reusable research" });
  assert.equal(saved.status, 201);
  assert.equal(Object.hasOwn(saved.body, "ownerUserId"), false);
  const definitions = await request("/api/workflow-definitions", undefined, "GET");
  assert.equal(definitions.body.items.length, 1);
  const endpoint = `/api/workflow-definitions/${saved.body.id}/instantiate`;
  assert.equal((await request(endpoint, { workspaceId: "workspace", expectedRevision: 0 })).status, 409);
  assert.equal(createdInput, undefined);
  const instantiated = await request(endpoint, { workspaceId: "workspace", expectedRevision: 1, inputs: {} });
  assert.equal(instantiated.status, 201);
  assert.equal(instantiated.body.status, "awaiting_approval");
  assert.equal(createdInput.definitionRevision, 1);
  assert.equal(Object.hasOwn(createdInput.plan, "logs"), false);
  const preview = await request("/api/workflows/workflow/worktree/compare", undefined, "GET");
  assert.equal(preview.body.workflowRevision, 1);
  const integrateBody = { workflowRevision: 1, expectedRevision: 2, previewDigest: "preview", snapshotChanges: true };
  workflow.status = "running";
  assert.equal((await request("/api/workflows/workflow/worktree/integrate", integrateBody)).status, 409);
  assert.equal(integrated, 0);
  workflow.status = "completed";
  assert.equal((await request("/api/workflows/workflow/worktree/integrate", { ...integrateBody, workflowRevision: 0 })).status, 409);
  assert.equal(integrated, 0);
  assert.equal((await request("/api/workflows/workflow/worktree/integrate", integrateBody)).status, 200);
  assert.equal(integrated, 1);
  assert.ok(releases >= 6);
  console.log("workflow extension API: owner filtering, stale definition rejection, approval-preserving instantiation, completed/revision gates and integration locks passed");
} finally { await new Promise((resolve) => server.close(resolve)); await fs.rm(temporary, { recursive: true, force: true }); }
