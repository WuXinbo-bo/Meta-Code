import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isWorkflowRelativePath, normalizeWorkflowPlan, validateWorkflowPlan, type WorkflowProviderCapabilitiesInput } from "./plan.js";
import type { WorkflowPlan } from "./types.js";

export type WorkflowDefinitionParameter = {
  name: string;
  label: string;
  kind: "text" | "path" | "choice";
  required: boolean;
  defaultValue?: string;
  options?: string[];
};
export type WorkflowTeamDefinition = { plannerEngine: string; nodeProviders: Record<string, string> };
export type WorkflowDefinition = {
  schemaVersion: 1;
  id: string;
  ownerUserId: string;
  name: string;
  description: string;
  goalTemplate: string;
  parameters: WorkflowDefinitionParameter[];
  planTemplate: WorkflowPlan;
  team: WorkflowTeamDefinition;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type WorkflowDefinitionInput = {
  id?: string;
  expectedRevision?: number;
  ownerUserId: string;
  name: string;
  description?: string;
  goalTemplate: string;
  parameters?: WorkflowDefinitionParameter[];
  planTemplate: unknown;
  team: WorkflowTeamDefinition;
};
export type WorkflowDefinitionEnvironment = {
  availableSkills: Set<string>;
  availableMcpServers: Set<string>;
  providerCapabilities: WorkflowProviderCapabilitiesInput;
  plannerAvailable: (providerId: string) => boolean;
};

const PARAMETER_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/;
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const MAX_DEFINITION_BYTES = 1_000_000;

function clone<T>(value: T): T { return structuredClone(value); }

function parameterValue(parameter: WorkflowDefinitionParameter, value: unknown) {
  if (typeof value !== "string") throw new Error(`参数 ${parameter.name} 必须是文本`);
  if (parameter.kind === "path" && /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`参数 ${parameter.name} 必须是工作区内的相对路径`);
  const result = value.trim();
  if (parameter.required && !result) throw new Error(`请输入 ${parameter.label || parameter.name}`);
  if (result.length > 4_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) throw new Error(`参数 ${parameter.name} 过长或包含非法字符`);
  if (parameter.kind === "choice" && result && !parameter.options?.includes(result)) throw new Error(`参数 ${parameter.name} 不在允许选项中`);
  if (parameter.kind === "path" && result && (!isWorkflowRelativePath(result) || /[*?\[\]{}]/.test(result))) throw new Error(`参数 ${parameter.name} 必须是工作区内的相对路径`);
  if (result.includes("{{") || result.includes("}}")) throw new Error(`参数 ${parameter.name} 不能嵌套模板`);
  return parameter.kind === "path" ? result.replaceAll("\\", "/") : result;
}

function normalizeParameters(parameters: WorkflowDefinitionParameter[] = []) {
  if (!Array.isArray(parameters) || parameters.length > 30) throw new Error("工作定义最多包含 30 个输入参数");
  const seen = new Set<string>();
  return parameters.map((input) => {
    if (!PARAMETER_NAME.test(input.name) || seen.has(input.name)) throw new Error(`参数名无效或重复：${input.name}`);
    seen.add(input.name);
    if (!["text", "path", "choice"].includes(input.kind)) throw new Error(`参数 ${input.name} 类型无效`);
    const parameter: WorkflowDefinitionParameter = {
      name: input.name, label: String(input.label || input.name).trim().slice(0, 120), kind: input.kind,
      required: input.required !== false,
      ...(input.kind === "choice" ? { options: [...new Set((input.options || []).map(String))] } : {})
    };
    if (parameter.kind === "choice" && (!parameter.options?.length || parameter.options.length > 50)) throw new Error(`参数 ${input.name} 需要 1 至 50 个选项`);
    if (input.defaultValue !== undefined) parameter.defaultValue = parameterValue(parameter, input.defaultValue);
    return parameter;
  });
}

function substitute(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === "string") {
    const rendered = value.replace(PLACEHOLDER, (_, name: string) => {
      if (!Object.hasOwn(values, name)) throw new Error(`未声明的工作定义参数：${name}`);
      return values[name];
    });
    if (rendered.includes("{{") || rendered.includes("}}")) throw new Error("工作定义包含无效的参数占位符");
    return rendered;
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, values));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, values)]));
  return value;
}

function assertStableControls(plan: WorkflowPlan) {
  // Parameters describe business inputs, not executable commands or identities.
  for (const node of plan.nodes) for (const value of [node.id, node.provider, ...node.dependsOn, ...node.skills, ...node.mcpServers, ...node.verificationCommands]) {
    if (value.includes("{{") || value.includes("}}")) throw new Error("节点标识、模型、Skill、MCP 和验收命令不能包含输入占位符");
  }
}

function assertPathParameters(plan: WorkflowPlan, parameters: WorkflowDefinitionParameter[]) {
  const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));
  const paths = [plan.finalDelivery.directory, plan.finalDelivery.primary || "", ...plan.finalDelivery.additional,
    ...plan.nodes.flatMap((node) => [...node.writeScope, ...node.requiredArtifacts, ...node.deliverables])];
  for (const value of paths) for (const match of value.matchAll(PLACEHOLDER)) {
    if (byName.get(match[1])?.kind !== "path") throw new Error(`路径字段的参数 ${match[1]} 必须声明为 path 类型`);
  }
}

function assertPlanPaths(plan: WorkflowPlan) {
  for (const value of [plan.finalDelivery.directory, plan.finalDelivery.primary, ...plan.finalDelivery.additional]) {
    if (value !== null && !isWorkflowRelativePath(value)) throw new Error("最终交付文件范围必须位于执行目录内");
  }
  for (const node of plan.nodes) for (const value of [...node.writeScope, ...node.requiredArtifacts, ...node.deliverables]) {
    if (!isWorkflowRelativePath(value)) throw new Error(`节点 ${node.id} 的文件范围必须位于执行目录内`);
  }
}

export function instantiateWorkflowDefinition(definition: WorkflowDefinition, inputs: Record<string, unknown>, environment: WorkflowDefinitionEnvironment) {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("工作定义输入必须是参数对象");
  const parameters = normalizeParameters(definition.parameters);
  const known = new Set(parameters.map((parameter) => parameter.name));
  for (const key of Object.keys(inputs)) if (!known.has(key)) throw new Error(`未知参数：${key}`);
  const values = Object.fromEntries(parameters.map((parameter) => [parameter.name, parameterValue(parameter, inputs[parameter.name] ?? parameter.defaultValue ?? "")]));
  assertStableControls(definition.planTemplate);
  assertPathParameters(definition.planTemplate, parameters);
  const plan = normalizeWorkflowPlan(substitute(definition.planTemplate, values));
  assertPlanPaths(plan);
  for (const [nodeId, provider] of Object.entries(definition.team.nodeProviders || {})) {
    const node = plan.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error(`团队配置引用了不存在的节点：${nodeId}`);
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(provider)) throw new Error(`节点 ${nodeId} 的模型配置无效`);
    node.provider = provider;
  }
  if (!environment.plannerAvailable(definition.team.plannerEngine)) throw new Error(`规划模型 ${definition.team.plannerEngine} 当前不可用`);
  const issues = validateWorkflowPlan(plan, environment.availableSkills, environment.availableMcpServers, environment.providerCapabilities);
  if (issues.length) throw new Error(`工作定义无法用于当前工作区：${issues.join("；")}`);
  const prompt = String(substitute(definition.goalTemplate, values)).trim();
  if (!prompt) throw new Error("实例化后的任务目标不能为空");
  return { plan, prompt, plannerEngine: definition.team.plannerEngine, inputs: values, definitionId: definition.id, definitionRevision: definition.revision };
}

export class WorkflowDefinitionStore {
  private readonly directory: string;
  constructor(runtimeDirectory: string) {
    this.directory = path.join(path.resolve(runtimeDirectory), "definitions");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  private file(id: string) {
    if (!ID.test(id)) throw new Error("工作定义 ID 无效");
    return path.join(this.directory, `${id}.json`);
  }
  get(id: string, ownerUserId: string): WorkflowDefinition | null {
    const file = this.file(id);
    if (!fs.existsSync(file)) return null;
    if (fs.statSync(file).size > MAX_DEFINITION_BYTES) throw new Error("工作定义文件过大");
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as WorkflowDefinition;
    if (value.schemaVersion !== 1 || value.id !== id) throw new Error("工作定义格式无效");
    return value.ownerUserId === ownerUserId ? clone(value) : null;
  }
  list(ownerUserId: string) {
    return fs.readdirSync(this.directory).filter((name) => name.endsWith(".json")).flatMap((name) => {
      const definition = this.get(name.slice(0, -5), ownerUserId);
      return definition ? [definition] : [];
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  save(input: WorkflowDefinitionInput, environment: WorkflowDefinitionEnvironment) {
    if (!String(input.name || "").trim() || !String(input.ownerUserId || "").trim()) throw new Error("工作定义名称和所属用户不能为空");
    const id = input.id || `definition-${crypto.randomUUID()}`;
    const file = this.file(id);
    const existing = this.get(id, input.ownerUserId);
    if (fs.existsSync(file) && !existing) throw new Error("工作定义不存在或无权修改");
    if (existing && existing.revision !== input.expectedRevision) throw new Error("工作定义已更新，请刷新后重试");
    if (!input.team || !/^[a-z][a-z0-9._-]{0,63}$/.test(input.team.plannerEngine)) throw new Error("请选择有效的规划模型");
    const now = new Date().toISOString();
    const definition: WorkflowDefinition = {
      schemaVersion: 1, id, ownerUserId: input.ownerUserId, name: input.name.trim().slice(0, 120), description: String(input.description || "").trim().slice(0, 2_000),
      goalTemplate: String(input.goalTemplate || "").trim(), parameters: normalizeParameters(input.parameters), planTemplate: normalizeWorkflowPlan(input.planTemplate),
      team: { plannerEngine: input.team.plannerEngine, nodeProviders: { ...input.team.nodeProviders } }, revision: (existing?.revision || 0) + 1,
      createdAt: existing?.createdAt || now, updatedAt: now
    };
    const sampleInputs = Object.fromEntries(definition.parameters.map((parameter) => [parameter.name, parameter.defaultValue ?? (parameter.kind === "choice" ? parameter.options![0] : "sample")]));
    instantiateWorkflowDefinition(definition, sampleInputs, environment);
    const serialized = JSON.stringify(definition, null, 2);
    if (Buffer.byteLength(serialized) > MAX_DEFINITION_BYTES) throw new Error("工作定义过大");
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, `${serialized}\n`, { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
    return clone(definition);
  }
  remove(id: string, ownerUserId: string, expectedRevision: number) {
    const definition = this.get(id, ownerUserId);
    if (!definition) throw new Error("工作定义不存在");
    if (definition.revision !== expectedRevision) throw new Error("工作定义已更新，请刷新后重试");
    fs.unlinkSync(this.file(id));
  }
}
