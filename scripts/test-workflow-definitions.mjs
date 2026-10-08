import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowDefinitionStore, instantiateWorkflowDefinition } from "../server/plugins/orchestration/definitions.ts";
import { DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES, normalizeWorkflowPlan, plannerTurnPrompt, planSystemPrompt, validateWorkflowPlan } from "../server/plugins/orchestration/plan.ts";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "metacode-definitions-"));
const environment = { availableSkills: new Set(), availableMcpServers: new Set(), providerCapabilities: DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES, plannerAvailable: (id) => id === "codex" || id === "claude" };
const plan = {
  planSchemaVersion: 3, title: "Review {{component}}", summary: "Inspect {{component}}", assumptions: [], questions: [], risks: [],
  finalDelivery: { required: false, directory: "deliverables", primary: null, format: "", additional: [], producerNodeId: null, reason: "Analysis only" },
  audit: { status: "passed", changes: [], checks: ["dependency-minimality", "critical-path", "concurrency-utilization", "read-write-consistency", "provider-allocation", "final-delivery"].map((key) => ({ key, status: "passed", note: "checked" })) },
  nodes: [{ id: "review", title: "Review", objective: "Read {{component}} in {{folder}}", nonGoals: [], constraints: [], dependsOn: [], provider: "codex", providerReason: "Code inspection", skills: [], mcpServers: [], mcpRequired: false, workspaceAccess: "read", writeScope: [], requiredArtifacts: [], deliverables: [], acceptance: ["Report findings"], verificationCommands: [], failurePolicy: "review", required: true }]
};
try {
  const store = new WorkflowDefinitionStore(directory);
  const saved = store.save({ ownerUserId: "owner", name: "Review", goalTemplate: "Review {{component}}", parameters: [{ name: "component", label: "Component", kind: "text", required: true }, { name: "folder", label: "Folder", kind: "path", required: true, defaultValue: "src" }], planTemplate: plan, team: { plannerEngine: "claude", nodeProviders: { review: "codex" } } }, environment);
  assert.equal(saved.revision, 1);
  assert.equal(store.list("owner").length, 1);
  assert.equal(store.list("other").length, 0);
  assert.equal(store.get(saved.id, "other"), null);
  const instantiated = instantiateWorkflowDefinition(saved, { component: "navigation" }, environment);
  assert.equal(instantiated.prompt, "Review navigation");
  assert.equal(instantiated.plan.nodes[0].objective, "Read navigation in src");
  assert.equal(instantiated.plan.nodes[0].provider, "codex");
  assert.ok(!Object.hasOwn(instantiated.plan.nodes[0], "logs"));
  assert.throws(() => instantiateWorkflowDefinition(saved, {}, environment), /Component/);
  assert.throws(() => instantiateWorkflowDefinition(saved, { component: "x", unknown: "y" }, environment), /未知参数/);
  assert.throws(() => instantiateWorkflowDefinition(saved, { component: "x", folder: "..\\secret" }, environment), /相对路径/);
  assert.throws(() => instantiateWorkflowDefinition(saved, { component: "x", folder: "C:\\private" }, environment), /相对路径/);
  assert.throws(() => instantiateWorkflowDefinition(saved, { component: "{{other}}" }, environment), /嵌套模板/);
  assert.throws(() => instantiateWorkflowDefinition(saved, { component: "x" }, { ...environment, plannerAvailable: () => false }), /当前不可用/);
  const unavailable = structuredClone(DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES);
  unavailable.providers.codex.available = false;
  assert.throws(() => instantiateWorkflowDefinition(saved, { component: "x" }, { ...environment, providerCapabilities: unavailable }), /不可用/);
  assert.throws(() => store.save({ ...saved, expectedRevision: 0 }, environment), /已更新/);
  const next = store.save({ ...saved, expectedRevision: 1, description: "Updated" }, environment);
  assert.equal(next.revision, 2);
  assert.equal(new WorkflowDefinitionStore(directory).get(saved.id, "owner").description, "Updated");
  const commandTemplate = structuredClone(plan);
  commandTemplate.nodes[0].verificationCommands = ["node {{folder}}/test.mjs"];
  assert.throws(() => store.save({ ...saved, id: undefined, planTemplate: commandTemplate }, environment), /验收命令/);
  const escapedScope = structuredClone(plan);
  escapedScope.nodes[0].workspaceAccess = "write";
  escapedScope.nodes[0].writeScope = ["{{folder}}/**"];
  const scoped = store.save({ ...saved, id: undefined, planTemplate: escapedScope }, environment);
  assert.equal(instantiateWorkflowDefinition(scoped, { component: "x", folder: "src/widgets" }, environment).plan.nodes[0].writeScope[0], "src/widgets/**");
  const textScope = structuredClone(escapedScope);
  textScope.nodes[0].writeScope = ["{{component}}/**"];
  assert.throws(() => store.save({ ...saved, id: undefined, planTemplate: textScope }, environment), /path 类型/);
  const absoluteScope = structuredClone(escapedScope);
  absoluteScope.nodes[0].writeScope = ["C:\\private\\**"];
  assert.throws(() => store.save({ ...saved, id: undefined, planTemplate: absoluteScope }, environment), /执行目录内/);
  const invalidPaths = ["/private/results", "/", "C:/private/results", "C:\\private\\results", "C:private", "\\\\host\\share\\results", "../results", "src\\..\\results", "src/\u0000results", "src/\u001bresults", "src/results\n", "\tsrc/results", "src/results\u007f"];
  for (const field of ["directory", "primary", "additional"]) for (const invalidPath of invalidPaths) {
    const invalidDelivery = structuredClone(plan);
    invalidDelivery.finalDelivery.directory = ".";
    invalidDelivery.finalDelivery[field] = field === "additional" ? [invalidPath] : invalidPath;
    const normalized = normalizeWorkflowPlan(invalidDelivery);
    assert.ok(validateWorkflowPlan(normalized, new Set()).some((issue) => /finalDelivery.directory|最终交付路径/.test(issue)), `${field} must reject ${JSON.stringify(invalidPath)} on every host`);
    assert.throws(() => store.save({ ...saved, id: undefined, planTemplate: invalidDelivery }, environment), /执行目录内/, `definitions must reject ${field}=${JSON.stringify(invalidPath)}`);
  }
  for (const field of ["writeScope", "requiredArtifacts", "deliverables"]) for (const invalidPath of invalidPaths) {
    const invalidNodePath = structuredClone(escapedScope);
    invalidNodePath.nodes[0][field] = [invalidPath];
    assert.throws(() => store.save({ ...saved, id: undefined, planTemplate: invalidNodePath }, environment), /执行目录内/, `definitions must reject ${field}=${JSON.stringify(invalidPath)}`);
  }
  for (const invalidPath of invalidPaths) assert.throws(() => instantiateWorkflowDefinition(saved, { component: "x", folder: invalidPath }, environment), /相对路径/);
  const rootDelivery = structuredClone(plan);
  rootDelivery.finalDelivery = { required: true, directory: ".", primary: "src/result.ts", format: "typescript", additional: ["package.json"], producerNodeId: "review", reason: "" };
  Object.assign(rootDelivery.nodes[0], { workspaceAccess: "write", writeScope: ["."], deliverables: ["src/result.ts", "package.json"] });
  assert.deepEqual(validateWorkflowPlan(normalizeWorkflowPlan(rootDelivery), new Set()), []);
  const savedRootDelivery = store.save({ ...saved, id: undefined, planTemplate: rootDelivery }, environment);
  assert.equal(instantiateWorkflowDefinition(savedRootDelivery, { component: "x" }, environment).plan.finalDelivery.directory, ".", "project-root delivery must not require another business directory");
  assert.match(planSystemPrompt([], [], "", 3), /只读节点的已批准 verificationCommands 由工作台在 Agent 回合开始前执行/);
  assert.match(planSystemPrompt([], [], "", 3), /审查这些证据/);
  assert.match(plannerTurnPrompt("system", "Check progress"), /reason 参数必填/);
  assert.match(plannerTurnPrompt("system", "Check progress"), /workflow_no_change\(\{reason: '用户仅询问进度，保持计划不变'\}\)/);
  assert.throws(() => store.remove(saved.id, "owner", 1), /已更新/);
  store.remove(saved.id, "owner", 2);
  assert.equal(store.get(saved.id, "owner"), null);
  console.log("workflow definitions: parameter substitution, portable paths, contracts, capability validation, ownership, revision and persistence passed");
} finally { await fs.rm(directory, { recursive: true, force: true }); }
