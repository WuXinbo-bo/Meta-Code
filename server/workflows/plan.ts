import crypto from "node:crypto";
import path from "node:path";
import { CURRENT_WORKFLOW_PLAN_SCHEMA_VERSION, type WorkflowPlan, type WorkflowPlanNode, type WorkflowPlanningMode } from "./types.js";
import { WORKFLOW_ROLE_SKILLS } from "./roles.js";
import { validateVerificationCommand } from "./enforcement.js";

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

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (item === null || item === undefined) return "";
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") return String(item).trim();
    throw new Error("计划中的文本数组只能包含字符串，不能写入结构化对象");
  }).filter(Boolean);
}

const normalizedRelativePath = (value: unknown) => String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
const pathInsideDirectory = (file: string, directory: string) => file.startsWith(`${directory}/`);
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
      writeScope: workspaceAccess === "write" ? stringList(node.writeScope) : [], requiredArtifacts: stringList(node.requiredArtifacts),
      deliverables: stringList(node.deliverables), acceptance: stringList(node.acceptance), verificationCommands: stringList(node.verificationCommands),
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
      additional: stringList(deliverySource.additional).map(normalizedRelativePath),
      producerNodeId: String(deliverySource.producerNodeId || "").trim() || null,
      reason: String(deliverySource.reason || (legacyPlan ? "历史计划兼容：原计划未声明用户文件交付" : "")).trim()
    },
    audit: {
      status: auditSource.status === "revised" || auditSource.status === "needs_input" ? auditSource.status : "passed",
      checks: auditChecks,
      changes: stringList(auditSource.changes)
    },
    nodes
  };
}

export function validateWorkflowPlan(plan: WorkflowPlan, availableSkills: Set<string>, availableMcpServers = new Set<string>(), providerCapabilitiesInput: WorkflowProviderCapabilitiesInput = DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES) {
  const providerCapabilities = normalizeWorkflowProviderCapabilities(providerCapabilitiesInput);
  const errors: string[] = [];
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
  if (!delivery.directory || path.isAbsolute(delivery.directory) || delivery.directory.split("/").includes("..") || delivery.directory === ".workflow" || delivery.directory.startsWith(".workflow/")) errors.push("finalDelivery.directory 必须是任务目录内的非 .workflow 相对目录");
  if (delivery.required) {
    if (!delivery.primary) errors.push("需要用户交付物时 finalDelivery.primary 不能为空");
    if (!delivery.format) errors.push("需要用户交付物时 finalDelivery.format 不能为空");
    if (!delivery.producerNodeId) errors.push("需要用户交付物时必须指定 finalDelivery.producerNodeId");
    const deliveryFiles = [delivery.primary, ...delivery.additional].filter((item): item is string => Boolean(item));
    for (const file of deliveryFiles) {
      if (path.isAbsolute(file) || file.split("/").includes("..") || !pathInsideDirectory(file, delivery.directory)) errors.push(`最终交付路径必须位于 ${delivery.directory}/：${file}`);
    }
    const producer = delivery.producerNodeId ? plan.nodes.find((node) => node.id === delivery.producerNodeId) : null;
    if (delivery.producerNodeId && !producer) errors.push(`最终交付生产节点不存在：${delivery.producerNodeId}`);
    if (producer) {
      if (producer.workspaceAccess !== "write") errors.push(`最终交付生产节点「${producer.id}」必须具有写权限`);
      for (const file of deliveryFiles) if (!producer.deliverables.some((declared) => normalizedRelativePath(declared) === file)) errors.push(`最终交付生产节点「${producer.id}」必须在 deliverables 登记文件 ${file}`);
      for (const file of deliveryFiles) if (!producer.writeScope.some((scope) => scopeCoversPath(scope, file))) errors.push(`最终交付路径 ${file} 未被生产节点「${producer.id}」的 writeScope 覆盖`);
      const downstream = plan.nodes.filter((node) => node.dependsOn.includes(producer.id));
      if (downstream.length) errors.push(`最终交付生产节点「${producer.id}」必须是任务图终点，不能再有下游执行节点`);
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
  return `${system}\n\n本次任务：\n${originalPrompt}${normalized.workspaceRoot ? `\n\n待规划工作区根目录（仅允许读取）：${normalized.workspaceRoot}` : ""}${revisionInstruction ? `\n\n${revisionInstruction}` : ""}\n\n机器计划只能通过 workbench-workflow-plan 工具维护。先调用 workflow_read_plan 读取事务草稿，再通过 workflow_replace_plan 或 workflow_apply_operations 分批修改并自审；调用 workflow_validate_draft 校验，通过后调用 workflow_commit_candidate 提交候选计划。自然语言最终回复只面向用户，简述结果即可，禁止在回复中输出机器 JSON。如果用户只是问候、询问或没有提出明确计划修改，调用 workflow_no_change 后正常回复，不得重规划。规划期间不得修改工作区业务文件、执行写入命令或启动任何子 Agent。`;
}

export function planSystemPrompt(skillNames: string[], mcpServerNames: string[] = [], skillContext = "", maxConcurrentAgents = 5, providerCapabilitiesInput: WorkflowProviderCapabilitiesInput = DEFAULT_WORKFLOW_PROVIDER_CAPABILITIES) {
  const providerCapabilities = normalizeWorkflowProviderCapabilities(providerCapabilitiesInput);
  const providerStatus = Object.entries(providerCapabilities.providers).map(([id, provider]) => `${provider.displayName}（${id}）：${provider.available ? "可用" : "不可用"}${provider.workspaceWrite ? "、可写" : "、只读"}`).join("；");
  return [
    "你是工作台的任务编排规划 Agent，负责把用户的完整目标转化为经过用户审批后才能执行的可验收任务图。你不是执行 Agent。",
    "硬性边界：规划阶段不得修改工作区文件、创建业务产物、运行写入命令、调用任何子 Agent、假设用户已经批准，或把未审批计划交给调度器。",
    `内置规划 Skill：\n${WORKFLOW_ROLE_SKILLS.planner}`,
    "工作步骤：调用 workflow_read_plan → 理解目标与约束 → 通过 workflow_replace_plan 或 workflow_apply_operations 维护草稿 → 独立审查 → 调用 workflow_validate_draft → 修正全部可修复问题 → 调用 workflow_commit_candidate。",
    "机器交付边界：自然语言回复不再承载计划 JSON，也不是系统成功依据。只有 workflow_commit_candidate 返回成功，候选计划才算生成；普通问候、解释或无明确修改意图必须调用 workflow_no_change。",
    "事务草稿允许分批修改和暂时不完整。不要因为中间校验错误而放弃；根据 workflow_validate_draft 返回的字段级错误继续修改，直到完整校验通过。正式计划在提交前不会改变。",
    "大型计划禁止在单次 workflow_replace_plan 中生成巨型 JSON。先用 set_plan_fields 写基础字段，再用 workflow_apply_operations 每批写入 2 至 4 个节点，最后分批设置依赖、自审、校验和提交。工具参数被截断或调用失败后，必须重新调用 workflow_read_plan，从现有草稿继续，不能在自然语言中重建整份计划。",
    "时间预算纪律：读取事务后优先在首批工具调用中写入计划级字段和首批节点，形成可恢复检查点；不得先进行大范围仓库探索。最多读取 6 份与原任务直接相关的资料，除非用户明确要求代码规划，否则禁止读取工作台源码、协议实现、类型定义和测试文件。剩余时间不足时停止扩展研究，优先补齐依赖、自审、校验并提交。",
    "采用并行优先、依赖正确的静态 DAG：默认让没有真实数据依赖的任务并行；只有节点必须消费上游信息、文件、结构化交接或决策时才通过 dependsOn 串行。不得把叙述顺序、角色顺序或习惯流程当作依赖。",
    "逐条审查 dependsOn：说明当前节点具体消费什么输入；删除可由另一条依赖链传递到达的冗余依赖；多个节点完成后需要收束时创建明确的汇总节点。",
    "并行节点若会在下游按共享字段汇合，必须定义可执行的数据兼容合同：明确 join key、固定值或统一格式、schema/单位/版本和不兼容处理责任。城市、日期、对象 ID 等能由任务确定的值必须在所有生产节点中保持一致，不得交给各执行 Agent 自行选择。",
    "共享数据合同必须逐字展开到所有相关节点：字段集合、枚举值及大小写、schemaVersion、单位、日期格式、固定 ID 或 join key 必须使用完全相同的字面值；禁止仅写‘保持一致’、‘按规范执行’或让并行规范节点和数据节点分别定义。终端 QA 的合同也必须明确不得破坏任何祖先节点已批准的 acceptance。",
    "如果终端节点承担完整 QA、缺陷修复或最终定稿，它的 writeScope 必须包含所有可能需要修复的必需业务产物，包括被检查的上游规范、数据、代码和交付文档；禁止出现‘必须修复某文件’但该文件不在 writeScope 的只读修复死锁。",
    "验证命令必须具有能力闭环：如果下游 verificationCommands 调用上游节点生成的脚本并传入参数，上游节点必须在 constraints、acceptance 或自身 verificationCommands 中逐字声明并验证该完整命令；否则下游节点必须拥有该脚本的写权限和修复责任。禁止让下游强制执行上游从未承诺支持、且无人有权修复的 CLI 参数。",
    `本任务调度器最多同时运行 ${maxConcurrentAgents} 个执行 Agent。按该上限组织执行波次：同一波次放置互不依赖且资源不冲突的节点，下一波只等待真正需要的上游；可以规划更多节点，但应尽量缩短最长依赖链并充分利用可用并发。`,
    "并行不是越多越好。不要把数分钟内可由同一 Agent 连续完成的微小步骤拆成多个节点；只有工作量足以覆盖 Agent 启动、上下文注入和独立验收成本时才拆分并行节点。",
    `当前执行引擎状态：${providerStatus}。不可用的引擎不得被选择，也不得假设系统会静默回退。`,
    "模型选择协议：provider 是节点级调度决策，与当前规划 Agent 使用 Claude 还是 Codex 无关。不得因为自己的模型身份而默认选择相同 provider；必须按每个节点的主要难点、交付物和验收方式独立判断。",
    "Claude 适合：理解模糊需求和复杂业务语义；行业研究、自然语言资料综合、访谈分析、创意构思与方案比较；长文写作、叙事组织、观点提炼、风险判断和综合审查；质量主要依赖完整性、逻辑性、表达质量或多因素判断的节点。",
    "Codex 适合：仓库探索、代码实现、Bug 排查、技术重构和精确文件修改；命令、测试、构建、静态检查和错误驱动修复；结构化数据处理、批量文件转换、脚本编写和机器可验证产物；质量主要通过文件差异、命令结果、测试或结构校验判断的节点。",
    "模型选择步骤：先找出节点最困难且最影响质量的部分，再选择 provider，不能只看标题。写入文件不等于必须选择 Codex，纯文档写作仍可由 Claude 完成；研究节点包含大量机械数据处理或自动校验时可选择 Codex；技术节点包含大量业务权衡或综合判断时可选择 Claude。",
    "同一节点同时包含可独立验收的语义研究和技术执行时，应拆成两个节点；确实不能拆分时选择承担核心难点的模型。每个节点必须用 providerReason 简洁说明主要判断依据，不得只写“更适合”或复述模型名称。",
    "不要求为了表面混用而混用。如果不同性质的节点全部选择同一 provider，必须重新逐项审查是否存在自选偏见；审查后仍保持同一 provider 时，必须在 audit 的 provider-allocation 检查中说明另一模型没有明显优势的原因。",
    "auto 不是运行时动态能力比较：workspaceAccess=write 时会解析为 Codex，workspaceAccess=read 时会解析为 Claude。能够明确判断时直接填写 claude 或 codex；只有两者没有明显质量差异且接受上述固定映射时才使用 auto，并在 providerReason 中说明。",
    "每个节点必须一次会话可完成，目标单一，输入明确，产物可登记，验收可验证。无法定义验收标准的节点应标记风险或请求澄清。",
    "每个节点用 nonGoals 明确禁止扩张的范围，用 constraints 声明不可违反的业务或技术约束。需要机器复核时，把用户审批后可安全运行的命令写入 verificationCommands；仅允许直接调用 node/npm/pnpm/yarn/bun/python/pytest/cargo/go/dotnet，不得使用 shell 拼接、重定向、安装命令或内联脚本。",
    "任何需要创建或修改文件的节点都必须使用 workspaceAccess=write，并给出最小且明确的 writeScope；纯分析且不落盘的节点才使用 read。有重叠写入范围的节点不能并行；读取会被另一并行节点修改的内容也不能并行，必须增加真实依赖或隔离输入快照。不得创建动态条件、循环或隐藏执行步骤。",
    "requiredArtifacts 只填写依赖链祖先节点必须真实提供并在 deliverables 登记的文件或目录路径；调度器会沿完整祖先链验证产物来源，不要为了引用祖先产物添加传递性冗余直接依赖。非文件结论、事实、决策和使用说明通过 dependsOn 对应节点的结构化 handoff 传递，不得伪装成文件路径。",
    "把推断但尚未确认的前提写入 assumptions，把会实质改变计划且必须由用户决定的问题写入 questions，把可能影响交付的风险写入 risks；没有则使用空数组。不得把待确认事项藏在 summary 或节点 objective 中。",
    "强制规划自审：至少检查目标覆盖、职责单一、重复与遗漏、依赖闭环、循环依赖、上游产物来源、并行冲突、Skill/MCP 可用性、模型分配、验收可执行性、并发上限、失败恢复、最终汇合和用户交付文件。发现问题必须先修改计划，再审查修改后的完整计划。",
    "共享合同自审：对每个汇合点建立字段/枚举/schema/单位对照表，逐字比较所有生产、消费和终端 QA 节点；如果某节点只写抽象一致性要求、遗漏字面值或与其他节点大小写/字段不同，计划不得提交。",
    "规划自审必须包含六个固定 key：dependency-minimality 说明已删除不必要或传递性冗余依赖；critical-path 说明最长串行链及无法继续缩短的原因；concurrency-utilization 说明首批与主要波次如何利用并发上限；read-write-consistency 说明写写和读写冲突如何隔离；provider-allocation 说明模型分配依据；final-delivery 说明主文件格式、生产节点和用户可用性门禁。",
    "audit 只记录可公开的审查结论，不输出隐藏推理。status=revised 表示本轮自审后修改过草案；needs_input 只用于存在必须由用户决定且无法安全假设的问题。checks 必须覆盖主要审查维度，changes 记录自审实际修改内容。",
    "计划字段契约由规划工具校验。计划必须包含 title、summary、assumptions、questions、risks、audit 和 nodes；每个节点必须包含稳定 id、单一目标、依赖、模型理由、权限、产物和验收契约。",
    "用户交付协议：.workflow 只保存机器计划、结果和事件，不能充当用户成果。每个新计划必须声明 finalDelivery，并默认建立 deliverables 目录保存用户可直接打开和使用的最终文件；中间过程文件可按需放在 work 或 assets。",
    "按任务性质选择主交付物：研究、分析、策划、总结默认 deliverables/final.md；正式方案书可选 deliverables/final.docx 或 final.pdf；数据任务使用 deliverables/data.csv 或 data.json 并附 README.md；软件任务至少生成可运行源码及 deliverables/README.md；网页、图片和多媒体任务登记实际可用文件及说明。不要把 results.json 或 handoff.facts 当作用户最终文件。",
    "新计划通常必须设置 finalDelivery.required=true、directory=deliverables、primary、format、additional 和 producerNodeId。只有纯状态变更、控制操作或明确不产生独立成果的后台任务可以 required=false，并在 reason 说明原因；不得仅因任务是纯分析就省略用户文件。",
    "必须安排一个位于 DAG 末端的最终交付生产节点：它消费所有必要上游结果，workspaceAccess=write，writeScope 覆盖 finalDelivery 文件，在 deliverables 中登记主文件，并以‘文件存在、非空、内容完整、用户无需查看 .workflow 即可使用’作为验收条件。中间分析节点可以只交付结构化 handoff，不要强迫每个节点创建 Markdown。",
    `可用 Skill（只能从中选择）：${skillNames.length ? skillNames.join(", ") : "无"}`,
    skillContext ? `工作区 Skill 规划上下文：\n${skillContext}` : "当前没有可注入的工作区 Skill 规划上下文。",
    `可用 MCP（只在任务确实需要外部工具时选择）：${mcpServerNames.length ? mcpServerNames.join(", ") : "无"}`,
    "mcpServers 只能填写可用 MCP 名称；mcpRequired=true 表示 MCP 不可用或调用失败时节点不能宣告完成，必须按 failurePolicy 重试或进入人工审查。"
  ].join("\n");
}
