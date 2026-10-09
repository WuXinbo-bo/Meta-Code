import crypto from "node:crypto";
import path from "node:path";
import { CURRENT_WORKFLOW_PLAN_SCHEMA_VERSION, type WorkflowExecutionTarget, type WorkflowPlan, type WorkflowPlanNode, type WorkflowPlanningMode } from "./types.js";
import { validateVerificationCommand } from "./enforcement.js";
import { compileWorkflowSharedContracts, workflowSharedContractIssues } from "./sharedContracts.js";

const NODE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const AUDIT_KEY_ALIASES: Record<string, string> = {
  "duplication-gaps": "duplication",
  "duplication-omission": "duplication",
  "cycle-check": "cycle",
  "cycle-dependency": "cycle",
  "artifact-source": "upstream-artifact-source",
  "artifact-provenance": "upstream-artifact-source",
  "skill-availability": "skill-mcp-availability",
  "acceptance-executability": "acceptance-verifiability",
  "parallel-write-conflicts": "parallel-write-conflict",
  "dependency-minimization": "dependency-minimality",
  "minimal-dependencies": "dependency-minimality",
  "critical-path-analysis": "critical-path",
  "parallel-capacity": "concurrency-utilization",
  "concurrency-capacity": "concurrency-utilization",
  "read-write-conflicts": "read-write-consistency",
  "final-merge": "final-convergence"
};

const REQUIRED_PLANNING_AUDIT_CHECKS = [
  "dependency-minimality",
  "critical-path",
  "concurrency-utilization",
  "read-write-consistency",
  "provider-allocation",
  "final-delivery"
] as const;

export type WorkflowProviderCapabilities = {
  providers: Record<string, { displayName: string; available: boolean; workspaceRead: boolean; workspaceWrite: boolean }>;
  defaults: { read: string; write: string };
};

export type WorkflowProviderCapabilitiesInput = WorkflowProviderCapabilities | {
  claudeAvailable?: boolean;
  codexAvailable?: boolean;
};

export const DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES: WorkflowProviderCapabilities = {
  providers: {
    claude: { displayName: "Claude", available: true, workspaceRead: true, workspaceWrite: true },
    codex: { displayName: "Codex", available: true, workspaceRead: true, workspaceWrite: true }
  },
  defaults: { read: "claude", write: "codex" }
};

export function normalizeWorkflowProviderCapabilities(value: WorkflowProviderCapabilitiesInput | null | undefined): WorkflowProviderCapabilities {
  if (value && "providers" in value && value.providers && typeof value.providers === "object") {
    const providers = Object.fromEntries(Object.entries(value.providers).filter(([id]) => /^[a-z][a-z0-9._-]{0,63}$/.test(id)));
    const firstReadable = Object.entries(providers).find(([, provider]) => provider.workspaceRead)?.[0] || Object.keys(providers)[0] || "claude";
    const firstWritable = Object.entries(providers).find(([, provider]) => provider.workspaceWrite)?.[0] || firstReadable;
    return {
      providers,
      defaults: {
        read: providers[value.defaults?.read] ? value.defaults.read : firstReadable,
        write: providers[value.defaults?.write] ? value.defaults.write : firstWritable
      }
    };
  }
  const legacy = value && !("providers" in value) ? value : undefined;
  return {
    providers: {
      claude: { ...DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES.providers.claude, available: legacy?.claudeAvailable !== false },
      codex: { ...DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES.providers.codex, available: legacy?.codexAvailable !== false }
    },
    defaults: { ...DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES.defaults }
  };
}

export function resolveWorkflowProvider(provider: string, workspaceAccess: "read" | "write", input: WorkflowProviderCapabilitiesInput) {
  const capabilities = normalizeWorkflowProviderCapabilities(input);
  return provider === "auto" ? capabilities.defaults[workspaceAccess] : provider;
}

export function workflowNodeContractDigest(node: WorkflowPlanNode) {
  return crypto.createHash("sha256").update(JSON.stringify({
    id: node.id,
    objective: node.objective,
    nonGoals: node.nonGoals,
    constraints: node.constraints,
    ...(node.contractRefs ? { contractRefs: node.contractRefs } : {}),
    dependsOn: node.dependsOn,
    provider: node.provider,
    skills: node.skills,
    mcpServers: node.mcpServers,
    mcpRequired: node.mcpRequired,
    workspaceAccess: node.workspaceAccess,
    writeScope: node.writeScope,
    requiredArtifacts: node.requiredArtifacts,
    deliverables: node.deliverables,
    acceptance: node.acceptance,
    verificationCommands: node.verificationCommands,
    failurePolicy: node.failurePolicy,
    required: node.required
  })).digest("hex");
}

function stringList(value: unknown, preservePathControls = false) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (item === null || item === undefined) return "";
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      const text = String(item);
      return preservePathControls && PATH_CONTROL_CHARACTERS.test(text) ? text : text.trim();
    }
    throw new Error("计划中的文本数组只能包含字符串，不能写入结构化对象");
  }).filter(Boolean);
}

const PATH_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
export function isWorkflowRelativePath(value: string) {
  return Boolean(value) && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !/^[a-z]:/i.test(value) && !value.split(/[\\/]/).includes("..") && !PATH_CONTROL_CHARACTERS.test(value);
}
const normalizedRelativePath = (value: unknown) => {
  const raw = String(value || "");
  const normalized = (PATH_CONTROL_CHARACTERS.test(raw) ? raw : raw.trim()).replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.replace(/\/+$/, "") || normalized;
};
const pathInsideDirectory = (file: string, directory: string) => isWorkflowRelativePath(file) && (directory === "." || file.startsWith(`${directory}/`));
const artifactPathMatches = (required: string, available: string) => {
  const target = normalizedRelativePath(required).toLowerCase();
  const candidate = normalizedRelativePath(available).toLowerCase();
  return candidate === target || candidate.endsWith(`/${target}`) || target.endsWith(`/${candidate}`);
};
const scopeCoversPath = (scope: string, file: string) => {
  const normalized = normalizedRelativePath(scope).replace(/\/\*\*$/, "").replace(/\/\*$/, "");
  return normalized === "." || file === normalized || file.startsWith(`${normalized}/`);
};

export function normalizeWorkflowPlan(value: unknown): WorkflowPlan {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const sourceSchemaVersion = Number(source.planSchemaVersion || 0);
  const nodes = Array.isArray(source.nodes) ? source.nodes.map((raw): WorkflowPlanNode => {
    const node = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const rawProvider = String(node.provider || "auto").trim().toLowerCase();
    const provider = rawProvider === "auto" || /^[a-z][a-z0-9._-]{0,63}$/.test(rawProvider) ? rawProvider : "auto";
    const workspaceAccess = node.workspaceAccess === "write" ? "write" : "read";
    return {
      id: String(node.id || "").trim(), title: String(node.title || "").trim(), objective: String(node.objective || "").trim(),
      nonGoals: stringList(node.nonGoals), constraints: stringList(node.constraints),
      dependsOn: stringList(node.dependsOn), provider, providerReason: String(node.providerReason || "").trim(), skills: stringList(node.skills), workspaceAccess,
      mcpServers: stringList(node.mcpServers), mcpRequired: node.mcpRequired === true,
      writeScope: workspaceAccess === "write" ? stringList(node.writeScope, true) : [], requiredArtifacts: stringList(node.requiredArtifacts, true),
      deliverables: stringList(node.deliverables, true), acceptance: stringList(node.acceptance), verificationCommands: stringList(node.verificationCommands),
      failurePolicy: node.failurePolicy === "review" ? "review" : "retry_then_review", required: node.required !== false
    };
  }) : [];
  const auditSource = source.audit && typeof source.audit === "object" && !Array.isArray(source.audit) ? source.audit as Record<string, unknown> : {};
  const deliverySource = source.finalDelivery && typeof source.finalDelivery === "object" && !Array.isArray(source.finalDelivery) ? source.finalDelivery as Record<string, unknown> : {};
  const legacyPlan = sourceSchemaVersion > 0 && sourceSchemaVersion < 3;
  const deliveryRequired = legacyPlan ? false : deliverySource.required !== false;
  const deliveryDirectory = normalizedRelativePath(deliverySource.directory || "deliverables") || "deliverables";
  const auditChecks = Array.isArray(auditSource.checks) ? auditSource.checks.map((raw) => {
    const check = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const status: "passed" | "revised" | "warning" = check.status === "revised" || check.status === "warning" ? check.status : "passed";
    return {
      key: AUDIT_KEY_ALIASES[String(check.key || "").trim()] || String(check.key || "").trim(),
      status,
      note: String(check.note || "").trim()
    };
  }).filter((check) => check.key && check.note) : [];
  return {
    planSchemaVersion: CURRENT_WORKFLOW_PLAN_SCHEMA_VERSION,
    validationMode: source.validationMode === "standard" || source.validationMode === "deterministic" ? source.validationMode : "strict",
    title: String(source.title || "任务编排").trim().slice(0, 120) || "任务编排",
    summary: String(source.summary || "").trim(),
    assumptions: stringList(source.assumptions),
    questions: stringList(source.questions),
    risks: stringList(source.risks),
    finalDelivery: {
      required: deliveryRequired,
      directory: deliveryDirectory,
      primary: normalizedRelativePath(deliverySource.primary) || null,
      format: String(deliverySource.format || "").trim().toLowerCase(),
      additional: stringList(deliverySource.additional, true).map(normalizedRelativePath),
      producerNodeId: String(deliverySource.producerNodeId || "").trim() || null,
      reason: String(deliverySource.reason || (legacyPlan ? "历史计划兼容：原计划未声明用户文件交付" : "")).trim()
    },
    audit: {
      status: auditSource.status === "revised" || auditSource.status === "needs_input" ? auditSource.status : "passed",
      checks: auditChecks,
      changes: stringList(auditSource.changes)
    },
    ...compileWorkflowSharedContracts(source, nodes)
  };
}

export function validateWorkflowPlan(plan: WorkflowPlan, availableSkills: Set<string>, availableMcpServers = new Set<string>(), providerCapabilitiesInput: WorkflowProviderCapabilitiesInput = DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES) {
  const providerCapabilities = normalizeWorkflowProviderCapabilities(providerCapabilitiesInput);
  const errors: string[] = workflowSharedContractIssues(plan);
  if (!plan.nodes.length) errors.push("计划至少需要一个任务节点");
  if (plan.nodes.length > 40) errors.push("第一版单个计划最多 40 个任务节点");
  const ids = new Set<string>();
  for (const node of plan.nodes) {
    if (!NODE_ID.test(node.id)) errors.push(`节点 ID「${node.id || "空"}」格式无效`);
    if (ids.has(node.id)) errors.push(`节点 ID「${node.id}」重复`);
    ids.add(node.id);
    if (!node.title) errors.push(`节点「${node.id}」缺少标题`);
    if (!node.objective) errors.push(`节点「${node.id}」缺少目标`);
    if (!node.providerReason) errors.push(`节点「${node.id}」缺少模型选择理由`);
    if (node.providerReason.length > 300) errors.push(`节点「${node.id}」的模型选择理由过长`);
    if (!node.acceptance.length) errors.push(`节点「${node.id}」缺少验收标准`);
    if (node.verificationCommands.length > 8) errors.push(`节点「${node.id}」最多配置 8 条验收命令`);
    for (const command of node.verificationCommands) {
      if (command.length > 500 || /[\r\n]/.test(command)) errors.push(`节点「${node.id}」包含过长或多行验收命令`);
      else try { validateVerificationCommand(command); }
      catch (error) { errors.push(`节点「${node.id}」验收命令无效：${error instanceof Error ? error.message : String(error)}`); }
    }
    if (node.workspaceAccess === "write" && !node.writeScope.length) errors.push(`写入节点「${node.id}」必须声明 writeScope`);
    for (const skill of node.skills) if (!availableSkills.has(skill)) errors.push(`节点「${node.id}」引用了不可用 Skill「${skill}」`);
    for (const server of node.mcpServers) if (!availableMcpServers.has(server)) errors.push(`节点「${node.id}」引用了不可用 MCP「${server}」`);
    if (node.mcpRequired && !node.mcpServers.length) errors.push(`节点「${node.id}」要求 MCP，但没有指定 MCP 服务`);
    const resolvedProvider = resolveWorkflowProvider(node.provider, node.workspaceAccess, providerCapabilities);
    const provider = providerCapabilities.providers[resolvedProvider];
    if (!provider) errors.push(`节点「${node.id}」选择了未注册的 Provider「${resolvedProvider}」`);
    else if (!provider.available) errors.push(`节点「${node.id}」选择了当前不可用的 ${provider.displayName}`);
    else if (node.workspaceAccess === "write" && !provider.workspaceWrite) errors.push(`节点「${node.id}」需要写入，但 ${provider.displayName} 没有工作区写入能力`);
    else if (node.workspaceAccess === "read" && !provider.workspaceRead) errors.push(`节点「${node.id}」需要读取，但 ${provider.displayName} 没有工作区读取能力`);
  }
  const delivery = plan.finalDelivery;
  if (!isWorkflowRelativePath(delivery.directory) || delivery.directory === ".workflow" || delivery.directory.startsWith(".workflow/")) errors.push("finalDelivery.directory 必须是业务执行目录内的非 .workflow 相对目录");
  const deliveryFiles = [delivery.primary, ...delivery.additional].filter((item): item is string => Boolean(item));
  for (const file of deliveryFiles) {
    if (!pathInsideDirectory(file, delivery.directory)) errors.push(`最终交付路径必须位于 ${delivery.directory}/：${file}`);
  }
  if (delivery.required) {
    if (!delivery.primary) errors.push("需要用户交付物时 finalDelivery.primary 不能为空");
    if (!delivery.format) errors.push("需要用户交付物时 finalDelivery.format 不能为空");
    if (!delivery.producerNodeId) errors.push("需要用户交付物时必须指定 finalDelivery.producerNodeId");
    const producer = delivery.producerNodeId ? plan.nodes.find((node) => node.id === delivery.producerNodeId) : null;
    if (delivery.producerNodeId && !producer) errors.push(`最终交付生产节点不存在：${delivery.producerNodeId}`);
    if (producer) {
      if (producer.workspaceAccess !== "write") errors.push(`最终交付生产节点「${producer.id}」必须具有写权限`);
      for (const file of deliveryFiles) if (!producer.deliverables.some((declared) => normalizedRelativePath(declared) === file)) errors.push(`最终交付生产节点「${producer.id}」必须在 deliverables 登记文件 ${file}`);
      for (const file of deliveryFiles) if (!producer.writeScope.some((scope) => scopeCoversPath(scope, file))) errors.push(`最终交付路径 ${file} 未被生产节点「${producer.id}」的 writeScope 覆盖`);
      const descendants = new Set([producer.id]);
      for (let changed = true; changed;) {
        changed = false;
        for (const node of plan.nodes) if (!descendants.has(node.id) && node.dependsOn.some((id) => descendants.has(id))) {
          descendants.add(node.id); changed = true;
        }
      }
      if (plan.nodes.some((node) => node.id !== producer.id && descendants.has(node.id) && node.workspaceAccess === "write")) {
        errors.push(`最终交付生产节点「${producer.id}」之后只允许只读验收节点，不能再有下游写入节点`);
      }
    }
  } else if (!delivery.reason) errors.push("不生成用户文件时必须在 finalDelivery.reason 说明原因");
  for (const node of plan.nodes) for (const dependency of node.dependsOn) {
    if (!ids.has(dependency)) errors.push(`节点「${node.id}」依赖不存在的节点「${dependency}」`);
    if (dependency === node.id) errors.push(`节点「${node.id}」不能依赖自身`);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cyclic = (byId.get(id)?.dependsOn || []).some(visit);
    visiting.delete(id); visited.add(id);
    return cyclic;
  };
  if (plan.nodes.some((node) => visit(node.id))) errors.push("计划存在循环依赖");
  const reaches = (from: string, target: string) => {
    const pending = [...(byId.get(from)?.dependsOn || [])];
    const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(byId.get(current)?.dependsOn || []));
    }
    return false;
  };
  for (const node of plan.nodes) for (const dependency of node.dependsOn) {
    if (node.dependsOn.some((other) => other !== dependency && reaches(other, dependency))) {
      errors.push(`节点「${node.id}」包含可由其他依赖传递的冗余依赖「${dependency}」`);
    }
  }
  for (const node of plan.nodes) for (const required of node.requiredArtifacts) {
    const producers = plan.nodes.filter((candidate) => candidate.id !== node.id && candidate.deliverables.some((deliverable) => artifactPathMatches(required, deliverable)));
    if (!producers.length) errors.push(`节点「${node.id}」的必需产物没有计划内生产节点：${required}`);
    else if (!producers.some((producer) => reaches(node.id, producer.id))) errors.push(`节点「${node.id}」的必需产物生产节点不在其依赖链上：${required}`);
  }
  for (const node of plan.nodes) for (const command of node.verificationCommands) {
    const normalizedCommand = command.replaceAll("\\", "/");
    for (const required of node.requiredArtifacts) {
      const artifact = normalizedRelativePath(required);
      if (!artifact || !normalizedCommand.includes(artifact)) continue;
      if (node.workspaceAccess === "write" && node.writeScope.some((scope) => scopeCoversPath(scope, artifact))) continue;
      const producers = plan.nodes.filter((candidate) => candidate.id !== node.id
        && reaches(node.id, candidate.id)
        && candidate.deliverables.some((deliverable) => artifactPathMatches(artifact, deliverable)));
      const declared = producers.some((producer) => [...producer.constraints, ...producer.acceptance, ...producer.verificationCommands]
        .some((contract) => contract.replaceAll("\\", "/").includes(normalizedCommand)));
      if (!declared && producers.length) errors.push(`节点「${node.id}」的验收命令「${command}」调用上游产物 ${artifact}，但生产节点未声明该精确命令能力，且当前节点无权修复该产物`);
    }
  }
  for (const key of REQUIRED_PLANNING_AUDIT_CHECKS) {
    if (!plan.audit.checks.some((check) => check.key === key)) errors.push(`规划自审缺少 ${key} 检查`);
  }
  return [...new Set(errors)];
}

export function parsePlanJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate) throw new Error("规划模型没有返回 JSON 计划");
  try { return normalizeWorkflowPlan(JSON.parse(candidate)); }
  catch { throw new Error("规划模型返回的计划不是有效 JSON"); }
}

export function plannerTurnPrompt(system: string, originalPrompt: string, options?: string | { mode?: WorkflowPlanningMode; reviewNote?: string | null; previousPlan?: WorkflowPlan | null; workspaceRoot?: string }) {
  const normalized = typeof options === "string" ? { mode: "refine" as const, reviewNote: options, previousPlan: null } : options || {};
  const mode = normalized.mode || "initial";
  const reviewNote = normalized.reviewNote?.trim() || "";
  const revisionInstruction = mode === "refine"
    ? [
      "这是追加修改，不是推翻方案。保留仍然合理的总体结构，逐条处理用户意见，并检查局部修改对全部依赖、产物、并行关系和验收条件的连锁影响。",
      normalized.previousPlan ? "上一版完整计划已装入规划事务；必须先调用 workflow_read_plan 读取，不要要求用户重新提供。" : "",
      reviewNote ? `用户追加修改意见：\n${reviewNote}` : ""
    ].filter(Boolean).join("\n\n")
    : mode === "fresh"
      ? `这是全新重做。不要沿用上一版拆分结构，重新寻找合理方案。${reviewNote ? `\n用户重做要求：\n${reviewNote}` : ""}`
      : reviewNote ? `本次规划偏好：\n${reviewNote}` : "";
  return `${system}\n\n本次任务：\n${originalPrompt}${normalized.workspaceRoot ? `\n\n待规划工作区根目录（仅允许读取）：${normalized.workspaceRoot}` : ""}${revisionInstruction ? `\n\n${revisionInstruction}` : ""}\n\n机器计划只能通过 workbench-workflow-plan 工具维护。常规计划直接 workflow_submit_plan；维护或恢复时先 workflow_read_plan。大型草稿可 workflow_replace_plan 或 workflow_apply_operations 分批修改，最后 workflow_validate_draft 和 workflow_commit_candidate。自然语言最终回复只面向用户，简述结果即可，禁止在回复中输出机器 JSON。如果用户只是问候、询问或没有提出明确计划修改，调用 workflow_no_change 后正常回复，不得重规划；reason 参数必填，例如 workflow_no_change({reason: '用户仅询问进度，保持计划不变'})。规划期间不得修改工作区业务文件、执行写入命令或启动任何子 Agent。`;
}

export function planSystemPrompt(skillNames: string[], mcpServerNames: string[] = [], skillContext = "", maxConcurrentAgents = 5, providerCapabilitiesInput: WorkflowProviderCapabilitiesInput = DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES, executionTarget: WorkflowExecutionTarget = "isolated") {
  const providerCapabilities = normalizeWorkflowProviderCapabilities(providerCapabilitiesInput);
  const providerStatus = Object.entries(providerCapabilities.providers).map(([id, provider]) => `${provider.displayName}（${id}）：${provider.available ? "可用" : "不可用"}${provider.workspaceWrite ? "、可写" : "、只读"}`).join("；");
  return [
    "你是只读任务规划 Agent：把用户目标转为可审批的静态 DAG。不得执行业务任务、修改文件、启动子 Agent 或假设用户已批准。目标是帮助用户完成工作，不是增加节点或维护协议。",
    "优先理解目标、现有项目与验收。普通计划可一次 workflow_submit_plan 提交；服务器补齐空数组、默认值和客观结构检查，返回错误时只修正相关字段。大型计划在首批工具调用中写入计划级字段，然后 workflow_apply_operations 每批 2 至 4 个节点形成检查点，最后 workflow_validate_draft、workflow_commit_candidate。",
    "追加修改先 workflow_read_plan，沿用仍有效的节点 ID、业务合同和成果，只调整受影响部分。自然语言回复不再承载计划 JSON；工具返回 status=committed 后才说明候选已提交。无修改的维护问题用 workflow_no_change({reason})。",
    "隔离规划工具由工作台预授权，只维护候选草稿，不修改业务文件。不要在第一次草稿写入前做长时间资料探索；除非用户明确要分析工作台自身，禁止读取工作台源码、协议实现或测试来猜字段。按需读取与当前目标相关资料。",
    "采用并行优先、依赖正确的 DAG。dependsOn 只表示真实输入依赖；删除传递冗余。不要按角色顺序强制串行，也不要把微小连续步骤拆成多个 Agent。无法明确验收或缺少关键前提时写入 questions，不编造。",
    `本任务最多同时运行 ${maxConcurrentAgents} 个执行 Agent；并行仅适用于收益足以覆盖启动、上下文与验收成本的独立工作。`,
    "每个节点明确 objective、acceptance、workspaceAccess；写入节点必须给出最小 writeScope。读取会被另一并行节点修改的内容也不能并行，应增加真实依赖或隔离输入。不能要求只读节点承担修复职责。",
    "共享合同必须逐字可比：所有相关生产、消费和 QA 节点使用相同字段、枚举大小写、单位、版本与 join key。不得让多个并行节点各自发明兼容口径。终端 QA/修复节点必须有修复范围，且不得破坏已批准祖先合同；无法同时满足则请求调整。",
    "共享语义在 sharedContracts=[{id,version,constraints}] 中定义一次，相关节点用 contractRefs=[\"id@version\"] 引用，宿主展开固定约束并检测缺失引用；不要在多个节点手抄同一份 schema。业务目标或共享版本变化必须重新提交审批。",
    "requiredArtifacts 只填写依赖链祖先明确承诺的文件或目录路径；普通事实、决定和说明用结构化 handoff。验证命令必须具有能力闭环：下游调用上游脚本时，上游须承诺支持精确命令，或下游拥有该脚本的修复权限。",
    "verificationCommands 只放用户可审批的直接 node/npm/pnpm/yarn/bun/python/pytest/cargo/go/dotnet 命令；禁止 shell 拼接、重定向、安装、内联脚本。只读节点的已批准 verificationCommands 由工作台在 Agent 回合开始前执行，Agent 审查这些证据，不重复执行。测试缓存也需授权写入范围或系统临时目录。",
    `当前引擎：${providerStatus}。不得选择不可用引擎，不得因为自己的模型身份而默认选择相同 provider。`,
    "按节点核心难点选择 Provider，并给出简洁 providerReason；需要业务语义、写作或综合判断时考虑 Claude，需要精确代码、测试和结构化实现时考虑 Codex。无需为了混用而混用；auto 不是运行时动态能力比较，它使用宿主公布的读写默认引擎。",
    "强制规划自审聚焦目标覆盖、范围、依赖、共享语义和用户成果；宿主生成 dependency-minimality、critical-path、concurrency-utilization、read-write-consistency、provider-allocation、final-delivery 的客观结构记录。不要让模型反复抄写固定审计字段替代实际判断。",
    "assumptions 保存可接受但未验证的前提；questions 保存必须由用户决定的问题；risks 保存交付风险。不要把未定事项藏在摘要中。不能规划未审批的动态循环或隐含步骤。",
    executionTarget === "isolated"
      ? "独立成果放在 deliverables：研究、分析、策划、总结默认 deliverables/final.md；文档、数据或软件任务选择真正可使用的对应文件。"
      : "在现有项目真实路径直接工作，不得创建任务副本、任务子目录，也不得为了编排创建 deliverables/artifacts/nodes。仅在业务需要时生成新文件；机器计划、日志和检查点由插件存于项目外。",
    "finalDelivery 声明用户成果，directory 可用 . 表示业务根目录。需要独立文件时 required=true，指定 primary、format、producerNodeId，生产节点必须有写权限、范围与 deliverables；其后仅允许只读验收链。仅修改现有项目、纯分析或控制任务可 required=false 并说明 reason；不要强制生成总结文件。",
    "验收模式默认 standard：确定性门禁后进行一次必要的语义验收。高风险或复杂综合交付可建议 strict；deterministic 仅在用户明确选择且全部验收均有宿主执行命令证据时适用，不得默认为它。",
    `可用 Skill：${skillNames.length ? skillNames.join(", ") : "无"}。只为具体业务需要选择。`,
    skillContext ? `工作区 Skill 上下文：\n${skillContext}` : "",
    `可用业务 MCP：${mcpServerNames.length ? mcpServerNames.join(", ") : "无"}。mcpRequired=true 时不可用必须阻塞，不能伪造结果。系统交接工具不属于可选业务 MCP。`
  ].filter(Boolean).join("\n");
}
