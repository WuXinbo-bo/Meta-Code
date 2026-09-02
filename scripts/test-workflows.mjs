import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { normalizeWorkflowPlan, plannerTurnPrompt, planSystemPrompt, validateWorkflowPlan } from "../dist-server/workflows/plan.js";
import { failedDependencyReason, missingRequiredArtifacts, normalizeWorkflowNodeResult, parseWorkflowNodeResult, workflowAgentRetryAllowed, workflowCodexContextStrategy, workflowFailureCategory, workflowNodeCheckpointRoot, workflowRetryLimit, workflowResultArtifactPaths } from "../dist-server/workflows/execution.js";
import { captureWorkspaceSnapshot, changedWorkspaceFiles, filesOutsideWriteScope, runVerificationCommand, snapshotEntryIgnored, tokenizeVerificationCommand, validateVerificationCommand, verificationSpawnSpec } from "../dist-server/workflows/enforcement.js";
import { upsertWorkflowLog, workflowLog, workflowLogFromEngineEvent } from "../dist-server/workflows/logs.js";
import { compactPlannerLogs, WorkflowRepository } from "../dist-server/workflows/repository.js";
import { WORKFLOW_ROLE_SKILLS } from "../dist-server/workflows/roles.js";
import { calculateWorkflowPlanImpact, WorkflowStateFiles } from "../dist-server/workflows/stateFiles.js";
import { abortWorkflowPlanTransaction, applyWorkflowPlanOperations, commitWorkflowPlanTransaction, createWorkflowPlanTransaction, finishWorkflowPlanTransactionWithoutChange, openWorkflowPlanTransaction, readWorkflowPlanTransaction, replaceWorkflowPlanDraft, validateWorkflowPlanTransaction } from "../dist-server/workflows/plannerTransactions.js";
import { commitWorkflowNodeResultTransaction, createWorkflowNodeResultTransaction, openWorkflowNodeResultTransaction, readWorkflowNodeResultTransaction, recordWorkflowNodeSelfReview, registerWorkflowNodeChecks, registerWorkflowNodeOutputs, reopenWorkflowNodeResultTransaction, setWorkflowNodeHandoff, setWorkflowNodeOutcome, setWorkflowNodeResultSummary, validateWorkflowNodeResultTransaction, WORKFLOW_NODE_SELF_REVIEW_KEYS } from "../dist-server/workflows/nodeResultTransactions.js";

const execFileAsync = promisify(execFile);

const serverSource = await fs.readFile(new URL("../server/index.ts", import.meta.url), "utf8");
const transactionFileSource = await fs.readFile(new URL("../server/workflows/transactionFile.ts", import.meta.url), "utf8");
assert.match(
  serverSource,
  /runVerificationCommands\(current\.verificationCommands, workflow\.workDirectory,/,
  "工作流系统验收必须在独立任务目录执行，不能误用父工作区根目录"
);
assert.match(serverSource, /new WorkflowNodeStageRetryError\("snapshot"/, "快照异常必须进入阶段重试，不能重跑整个 Agent");
assert.match(WORKFLOW_ROLE_SKILLS.planner, /并行产物一致性契约/, "规划官必须约束并行生产节点的共享数据口径");
assert.match(WORKFLOW_ROLE_SKILLS.planner, /共享合同必须逐字可比/, "规划官必须逐字核对共享 schema 和枚举");
assert.match(WORKFLOW_ROLE_SKILLS.planner, /终端 QA\/修复节点/, "终端修复节点必须获得所需业务产物写入范围");
assert.match(WORKFLOW_ROLE_SKILLS.executor, /祖先保护契约/, "终端 QA 不得通过改写产物破坏已完成祖先合同");
assert.match(serverSource, /ancestorContracts/, "执行节点合同必须注入完整祖先正式合同");
assert.match(serverSource, /合同优先级固定为/, "执行提示必须声明正式合同高于业务文档");
assert.match(serverSource, /changedFiles: result\?\.changedFiles \|\| \[\]/, "最终 Validator 必须接收节点已验证的 changedFiles，不能把真实登记误判为缺失");
assert.match(transactionFileSource, /retryableCodes = new Set\(\["EACCES", "EBUSY", "EEXIST", "EPERM"\]\)/, "Windows 事务锁竞争必须识别 EPERM/EBUSY/EACCES");
assert.match(transactionFileSource, /if \(!retryableCodes\.has\(errorCode\(error\)\)\) throw error;/, "事务锁获取必须使用跨平台可重试错误集合，不能只识别 EEXIST");
assert.match(serverSource, /workflowNodeCheckpointRoot\(workflow\.workDirectory, node\.id, node\.planVersion\)/, "节点检查点必须按计划版本隔离");
const planOneCheckpoint = workflowNodeCheckpointRoot("C:/workspace/task", "implement", 1);
const planTwoCheckpoint = workflowNodeCheckpointRoot("C:/workspace/task", "implement", 2);
assert.notEqual(planOneCheckpoint, planTwoCheckpoint, "不同计划版本不能复用同一节点结果事务目录");
assert.match(planTwoCheckpoint.replaceAll("\\", "/"), /\/nodes\/implement\/plans\/2\/attempts$/);

const validPlan = normalizeWorkflowPlan({
  title: "测试工作流", summary: "验证审批门禁和静态依赖",
  audit: { status: "passed", checks: [
    { key: "dependency-minimality", status: "passed", note: "实现节点只保留对研究结果的必要依赖" },
    { key: "critical-path", status: "passed", note: "关键路径为研究到实现，无法继续缩短" },
    { key: "concurrency-utilization", status: "passed", note: "当前样例只有一条真实依赖链" },
    { key: "read-write-consistency", status: "passed", note: "研究完成后才修改代码，不存在读写竞态" },
    { key: "provider-allocation", status: "passed", note: "研究使用 Claude，实现使用 Codex" },
    { key: "final-delivery", status: "passed", note: "测试基线为控制型任务，不生成独立用户文件" }
  ], changes: [] },
  finalDelivery: { required: false, directory: "deliverables", primary: null, format: "", additional: [], producerNodeId: null, reason: "测试基线只验证工作流控制合同" },
  nodes: [
    { id: "research", title: "研究", objective: "只读分析", nonGoals: ["不修改代码"], constraints: ["只使用现有资料"], dependsOn: [], provider: "claude", providerReason: "需要综合自然语言资料并形成判断", skills: [], workspaceAccess: "read", writeScope: [], requiredArtifacts: [], deliverables: [], acceptance: ["形成摘要"], verificationCommands: [], required: true },
    { id: "implement", title: "实现", objective: "实现结果", nonGoals: [], constraints: ["保持现有接口"], dependsOn: ["research"], provider: "codex", providerReason: "需要修改代码并通过命令验证", skills: [], workspaceAccess: "write", writeScope: ["src/**"], requiredArtifacts: [], deliverables: ["src/result.ts"], acceptance: ["构建通过"], verificationCommands: ["npm run typecheck"], required: true }
  ]
});
const compactedPlannerLogs = compactPlannerLogs([
  { id: "status", createdAt: "2026-01-01T00:00:00.000Z", kind: "status", title: "开始规划", text: "开始" },
  { id: "assistant-1", createdAt: "2026-01-01T00:00:01.000Z", kind: "message", title: "assistant", text: "部分" },
  { id: "assistant-2", createdAt: "2026-01-01T00:00:02.000Z", kind: "message", title: "assistant", text: "完整" }
]);
assert.deepEqual(compactedPlannerLogs.map((log) => log.id), ["status", "assistant-2"]);
assert.deepEqual(validateWorkflowPlan(validPlan, new Set()), []);
assert.deepEqual(validPlan.nodes[0].nonGoals, ["不修改代码"]);
assert.deepEqual(validPlan.nodes[1].verificationCommands, ["npm run typecheck"]);
assert.deepEqual(validPlan.assumptions, []);
assert.deepEqual(validPlan.questions, []);
assert.deepEqual(validPlan.risks, []);
assert.equal(validPlan.nodes[0].providerReason, "需要综合自然语言资料并形成判断");
assert.ok(validPlan.audit.checks.some((check) => check.key === "provider-allocation"));
assert.ok(validPlan.audit.checks.some((check) => check.key === "final-delivery"));
assert.equal(validPlan.planSchemaVersion, 3);
const migratedLegacyPlan = normalizeWorkflowPlan({ ...validPlan, finalDelivery: undefined, planSchemaVersion: 1, audit: { status: "passed", checks: [
  { key: "duplication-gaps", status: "passed", note: "无重复遗漏" },
  { key: "artifact-provenance", status: "passed", note: "上游产物来源明确" },
  { key: "parallel-write-conflicts", status: "passed", note: "无并行写入冲突" },
  { key: "final-merge", status: "passed", note: "存在最终汇合" },
  { key: "provider-allocation", status: "passed", note: "模型分配合理" }
], changes: [] } });
assert.deepEqual(migratedLegacyPlan.audit.checks.map((check) => check.key), ["duplication", "upstream-artifact-source", "parallel-write-conflict", "final-convergence", "provider-allocation"]);
assert.equal(migratedLegacyPlan.finalDelivery.required, false);
assert.match(migratedLegacyPlan.finalDelivery.reason, /历史计划兼容/);
const reviewPlan = normalizeWorkflowPlan({ ...validPlan, assumptions: ["沿用现有技术栈"], questions: ["是否允许改动数据库结构？"], risks: ["外部服务可能限流"] });
assert.deepEqual(reviewPlan.assumptions, ["沿用现有技术栈"]);
assert.deepEqual(reviewPlan.questions, ["是否允许改动数据库结构？"]);
assert.deepEqual(reviewPlan.risks, ["外部服务可能限流"]);
assert.throws(
  () => normalizeWorkflowPlan({ ...validPlan, risks: [{ title: "结构化风险" }] }),
  /文本数组只能包含字符串/,
  "规划协议不应把结构化对象静默转换为 [object Object]"
);
const revisedPrompt = plannerTurnPrompt("规划协议", "完成原始任务", { mode: "refine", reviewNote: "减少串行节点", previousPlan: validPlan });
assert.match(revisedPrompt, /完成原始任务/);
assert.match(revisedPrompt, /上一版完整计划/);
assert.match(revisedPrompt, /追加修改/);
assert.match(revisedPrompt, /减少串行节点/);
assert.match(revisedPrompt, /workflow_read_plan/);
assert.match(revisedPrompt, /workflow_commit_candidate/);
assert.match(revisedPrompt, /禁止在回复中输出机器 JSON/);
assert.match(planSystemPrompt([], [], "", 3), /最多同时运行 3 个执行 Agent/);
assert.match(planSystemPrompt([], [], "", 3), /requiredArtifacts 只填写/);
assert.match(planSystemPrompt([], [], "", 3), /强制规划自审/);
assert.match(planSystemPrompt([], [], "", 3), /并行优先、依赖正确/);
assert.match(planSystemPrompt([], [], "", 3), /dependency-minimality/);
assert.match(planSystemPrompt([], [], "", 3), /读取会被另一并行节点修改的内容也不能并行/);
assert.match(planSystemPrompt([], [], "", 3), /workflow_validate_draft/);
assert.match(planSystemPrompt([], [], "", 3), /自然语言回复不再承载计划 JSON/);
assert.match(planSystemPrompt([], [], "", 3), /首批工具调用中写入计划级字段/);
assert.match(planSystemPrompt([], [], "", 3), /禁止读取工作台源码/);
assert.match(planSystemPrompt([], [], "", 3), /不得因为自己的模型身份而默认选择相同 provider/);
assert.match(planSystemPrompt([], [], "", 3), /auto 不是运行时动态能力比较/);
assert.match(planSystemPrompt([], [], "", 3), /研究、分析、策划、总结默认 deliverables\/final.md/);
assert.match(planSystemPrompt([], [], "", 3), /final-delivery/);
assert.match(planSystemPrompt([], [], "", 3), /验证命令必须具有能力闭环/);
assert.match(planSystemPrompt([], [], "", 3, { claudeAvailable: true, codexAvailable: false }), /Claude（claude）：可用、可写；Codex（codex）：不可用、可写/);
const missingProviderReason = normalizeWorkflowPlan({ ...validPlan, nodes: [{ ...validPlan.nodes[0], providerReason: "" }] });
assert.match(validateWorkflowPlan(missingProviderReason, new Set()).join("；"), /缺少模型选择理由/);
const missingParallelAudit = normalizeWorkflowPlan({ ...validPlan, audit: { ...validPlan.audit, checks: validPlan.audit.checks.filter((check) => check.key !== "critical-path") } });
assert.match(validateWorkflowPlan(missingParallelAudit, new Set()).join("；"), /缺少 critical-path 检查/);
const redundantDependencyPlan = normalizeWorkflowPlan({ ...validPlan, nodes: [
  { ...validPlan.nodes[0], id: "research" },
  { ...validPlan.nodes[0], id: "analysis", dependsOn: ["research"] },
  { ...validPlan.nodes[1], id: "implement", dependsOn: ["research", "analysis"] }
] });
assert.match(validateWorkflowPlan(redundantDependencyPlan, new Set()).join("；"), /冗余依赖「research」/);
const transitiveArtifactPlan = normalizeWorkflowPlan({ ...validPlan, nodes: [
  { ...validPlan.nodes[0], id: "source", deliverables: ["work/source/evidence.md"] },
  { ...validPlan.nodes[0], id: "middle", dependsOn: ["source"] },
  { ...validPlan.nodes[1], id: "consumer", dependsOn: ["middle"], requiredArtifacts: ["work/source/evidence.md"] }
] });
assert.deepEqual(validateWorkflowPlan(transitiveArtifactPlan, new Set()), []);
const disconnectedArtifactPlan = normalizeWorkflowPlan({ ...transitiveArtifactPlan, nodes: transitiveArtifactPlan.nodes.map((node) => node.id === "consumer" ? { ...node, dependsOn: [], requiredArtifacts: ["work/source/evidence.md"] } : node) });
assert.match(validateWorkflowPlan(disconnectedArtifactPlan, new Set()).join("；"), /生产节点不在其依赖链上/);
const missingArtifactProducerPlan = normalizeWorkflowPlan({ ...validPlan, nodes: validPlan.nodes.map((node) => node.id === "implement" ? { ...node, requiredArtifacts: ["work/missing.md"] } : node) });
assert.match(validateWorkflowPlan(missingArtifactProducerPlan, new Set()).join("；"), /没有计划内生产节点/);
const unsupportedUpstreamCommandPlan = normalizeWorkflowPlan({ ...validPlan, nodes: [
  { ...validPlan.nodes[0], id: "test-tool", workspaceAccess: "write", writeScope: ["tests/**"], deliverables: ["tests/smoke.mjs"], acceptance: ["测试脚本存在"], verificationCommands: [] },
  { ...validPlan.nodes[1], id: "consumer", dependsOn: ["test-tool"], requiredArtifacts: ["tests/smoke.mjs"], writeScope: ["src/**"], verificationCommands: ["node tests/smoke.mjs --static"] }
] });
assert.match(validateWorkflowPlan(unsupportedUpstreamCommandPlan, new Set()).join("；"), /生产节点未声明该精确命令能力/);
const declaredUpstreamCommandPlan = normalizeWorkflowPlan({ ...unsupportedUpstreamCommandPlan, nodes: unsupportedUpstreamCommandPlan.nodes.map((node) => node.id === "test-tool" ? { ...node, acceptance: ["node tests/smoke.mjs --static 返回退出码 0"] } : node) });
assert.deepEqual(validateWorkflowPlan(declaredUpstreamCommandPlan, new Set()), []);
const repairableUpstreamCommandPlan = normalizeWorkflowPlan({ ...unsupportedUpstreamCommandPlan, nodes: unsupportedUpstreamCommandPlan.nodes.map((node) => node.id === "consumer" ? { ...node, writeScope: ["src/**", "tests/smoke.mjs"] } : node) });
assert.deepEqual(validateWorkflowPlan(repairableUpstreamCommandPlan, new Set()), []);
const researchDeliveryPlan = normalizeWorkflowPlan({
  ...validPlan,
  finalDelivery: { required: true, directory: "deliverables", primary: "deliverables/final.md", format: "markdown", additional: [], producerNodeId: "deliver-final", reason: "" },
  nodes: [
    validPlan.nodes[0],
    { ...validPlan.nodes[1], id: "deliver-final", title: "生成最终研究报告", objective: "整合研究并生成用户可阅读的 Markdown", dependsOn: ["research"], workspaceAccess: "write", writeScope: ["deliverables/**"], deliverables: ["deliverables/final.md"], acceptance: ["主文件存在且非空", "用户无需读取 .workflow 即可理解成果"], verificationCommands: [] }
  ]
});
assert.deepEqual(validateWorkflowPlan(researchDeliveryPlan, new Set()), []);
const additionalDeliveryPlan = normalizeWorkflowPlan({
  ...researchDeliveryPlan,
  finalDelivery: { ...researchDeliveryPlan.finalDelivery, additional: ["deliverables/sources.md"] },
  nodes: researchDeliveryPlan.nodes.map((node) => node.id === "deliver-final" ? { ...node, deliverables: [...node.deliverables, "deliverables/sources.md"] } : node)
});
assert.deepEqual(validateWorkflowPlan(additionalDeliveryPlan, new Set()), []);
const unregisteredAdditionalDelivery = normalizeWorkflowPlan({
  ...researchDeliveryPlan,
  finalDelivery: { ...researchDeliveryPlan.finalDelivery, additional: ["deliverables/sources.md"] }
});
assert.match(validateWorkflowPlan(unregisteredAdditionalDelivery, new Set()).join("；"), /必须在 deliverables 登记文件 deliverables\/sources.md/);
const missingFinalDelivery = normalizeWorkflowPlan({ ...validPlan, finalDelivery: { required: true, directory: "deliverables", primary: null, format: "", additional: [], producerNodeId: null, reason: "" } });
assert.match(validateWorkflowPlan(missingFinalDelivery, new Set()).join("；"), /finalDelivery.primary/);
const readOnlyDelivery = normalizeWorkflowPlan({ ...researchDeliveryPlan, nodes: researchDeliveryPlan.nodes.map((node) => node.id === "deliver-final" ? { ...node, workspaceAccess: "read", writeScope: [] } : node) });
assert.match(validateWorkflowPlan(readOnlyDelivery, new Set()).join("；"), /必须具有写权限/);
assert.match(validateWorkflowPlan(validPlan, new Set(), new Set(), { claudeAvailable: true, codexAvailable: false }).join("；"), /当前不可用的 Codex/);
assert.match(WORKFLOW_ROLE_SKILLS.executor, /输入契约/);
assert.match(WORKFLOW_ROLE_SKILLS.executor, /机器交接契约/);
assert.match(WORKFLOW_ROLE_SKILLS.executor, /workflow_commit_result/);
assert.match(WORKFLOW_ROLE_SKILLS.executor, /系统托管临时目录/);
assert.match(WORKFLOW_ROLE_SKILLS.executor, /不得放入 src、artifacts/);
assert.match(WORKFLOW_ROLE_SKILLS.planner, /隔离规划事务工具已由工作台预授权/);
assert.match(WORKFLOW_ROLE_SKILLS.planner, /不要在第一次草稿写入前做长时间资料探索/);
assert.doesNotMatch(WORKFLOW_ROLE_SKILLS.executor, /Claude|Codex/);
const structuredResult = parseWorkflowNodeResult('{"outcome":"completed","humanSummary":"完成研究","outputs":[{"id":"report","type":"document","path":"artifacts/report.md","mediaType":"text/markdown","description":"研究报告","consumableBy":["implement"]}],"changedFiles":[],"checks":[{"name":"测试","command":"npm test","status":"passed","exitCode":0,"evidence":"全部通过"}],"decisions":[],"handoff":{"facts":["研究完成"],"constraints":[],"nextAgentInstructions":["读取报告"]},"warnings":[],"unresolved":[]}');
assert.equal(structuredResult.humanSummary, "完成研究");
assert.deepEqual(workflowResultArtifactPaths(structuredResult), ["artifacts/report.md"]);
assert.equal(structuredResult.checks[0].exitCode, 0);
const legacyResult = normalizeWorkflowNodeResult({ summary: "旧结果", artifacts: ["legacy.md"], changedFiles: [], tests: [], risks: ["旧风险"] });
assert.equal(legacyResult.humanSummary, "旧结果");
assert.deepEqual(workflowResultArtifactPaths(legacyResult), ["legacy.md"]);
assert.deepEqual(legacyResult.warnings, ["旧风险"]);
assert.throws(() => parseWorkflowNodeResult("只有普通文本"), /结构化结果 JSON/);
assert.throws(() => parseWorkflowNodeResult('{"outcome":"completed","humanSummary":"缺字段"}'), /缺少数组字段/);
assert.throws(() => parseWorkflowNodeResult('{"outcome":"completed","humanSummary":"错误类型","outputs":[{"id":"bad","type":"unknown","path":null,"description":"错误","consumableBy":[]}],"changedFiles":[],"checks":[],"decisions":[],"handoff":{"facts":[],"constraints":[],"nextAgentInstructions":[]},"warnings":[],"unresolved":[]}'), /类型无效/);
assert.equal(workflowFailureCategory(new Error("HTTP 429 rate limit")), "transient");
assert.equal(workflowFailureCategory(new Error("code-mode host closed its stdout")), "transient", "Codex 宿主输出通道中断必须进入上下文恢复");
assert.equal(workflowFailureCategory(new Error("Codex Exec exited with code 4294967295")), "transient");
assert.equal(workflowFailureCategory(new Error("Thread not found")), "transient", "失效 Thread 必须允许降级到新上下文");
assert.equal(workflowRetryLimit(workflowFailureCategory(new Error("结果 JSON 无效"))), 2);
assert.equal(workflowFailureCategory(new Error("检测到越出 writeScope 的文件修改：.claude-codex/refs/manifest.json")), "scope");
assert.equal(workflowRetryLimit("scope"), 1);
assert.equal(workflowRetryLimit(workflowFailureCategory(new Error("API Key 未配置"))), 1);
assert.equal(workflowAgentRetryAllowed("claude", "retry_then_review", 1, 3), false, "Claude 工作流节点不得在原生重试失败后自动重新执行");
assert.equal(workflowAgentRetryAllowed("codex", "retry_then_review", 1, 3), true, "Codex 继续沿用节点自动重试策略");
assert.equal(workflowAgentRetryAllowed("codex", "review", 1, 3), false);
assert.deepEqual(workflowCodexContextStrategy({ engineThreadId: null, contextRecoveryCount: 0 }), { mode: "fresh", threadId: null, recoveryCount: 0 });
assert.deepEqual(workflowCodexContextStrategy({ engineThreadId: "thread-a", contextRecoveryCount: 0 }), { mode: "resumed", threadId: "thread-a", recoveryCount: 1 });
assert.deepEqual(workflowCodexContextStrategy({ engineThreadId: "thread-a", contextRecoveryCount: 1 }), { mode: "fresh", threadId: null, recoveryCount: 0 }, "同一损坏上下文只能自动恢复一次");
const scopedLogs = [];
upsertWorkflowLog(scopedLogs, workflowLogFromEngineEvent({ type: "assistant", sourceId: "item_0", text: "旧上下文回复" }, "codex:run-a", { attempt: 1, runId: "run-a", contextId: "thread-a" }));
upsertWorkflowLog(scopedLogs, workflowLogFromEngineEvent({ type: "assistant", sourceId: "item_0", text: "新上下文回复" }, "codex:run-b", { attempt: 1, runId: "run-b", contextId: "thread-b" }));
assert.equal(scopedLogs.length, 2, "不同 Codex 运行中的同名 item 不得互相覆盖");
assert.notEqual(scopedLogs[0].id, scopedLogs[1].id);
assert.deepEqual(scopedLogs.map((log) => log.contextId), ["thread-a", "thread-b"]);
const reorderedLog = workflowLog("status", "较早事件", "应该排在前面", "manual:earlier", { attempt: 1, runId: "run-a" });
reorderedLog.createdAt = "2026-01-01T00:00:00.000Z";
upsertWorkflowLog(scopedLogs, reorderedLog);
assert.equal(scopedLogs[0].id, "manual:earlier", "日志数组必须按事件时间排序，而不是按首次插入位置排序");
assert.deepEqual(tokenizeVerificationCommand('node "scripts/check file.mjs" --strict'), ["node", "scripts/check file.mjs", "--strict"]);
assert.equal(validateVerificationCommand("npm run typecheck").args[0], "run");
assert.throws(() => validateVerificationCommand("npm install left-pad"), /不允许安装/);
assert.throws(() => validateVerificationCommand("node -e \"process.exit(0)\""), /内联脚本/);
assert.throws(() => validateVerificationCommand("npm test && npm run build"), /Shell/);
const commandCheck = await runVerificationCommand("node --version", process.cwd(), new AbortController().signal, "workflow-test-command");
assert.equal(commandCheck.status, "passed");
const windowsNpmSpec = verificationSpawnSpec("npm.cmd", ["--version"], "win32", "C:\\Windows\\System32\\cmd.exe");
assert.deepEqual(windowsNpmSpec, { executable: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", "--version"] });
if (process.platform === "win32") {
  const npmCommandCheck = await runVerificationCommand("npm --version", process.cwd(), new AbortController().signal, "workflow-test-npm-command");
  assert.equal(npmCommandCheck.status, "passed", npmCommandCheck.evidence);
}
assert.equal(commandCheck.exitCode, 0);
assert.match(commandCheck.evidence, /^v\d+/);
assert.equal(snapshotEntryIgnored(".chrome-profile-mobile", true), true);
assert.equal(snapshotEntryIgnored("chrome-user-data-test", true), true);
assert.equal(snapshotEntryIgnored("SituationView.tsx", false), false);

const snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-workflow-test-"));
const taskDirectory = path.join(snapshotRoot, "task-a");
try {
  await fs.mkdir(path.join(taskDirectory, "artifacts"), { recursive: true });
  await fs.mkdir(path.join(snapshotRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(snapshotRoot, ".workflow"), { recursive: true });
  await fs.mkdir(path.join(snapshotRoot, ".claude-codex", "refs"), { recursive: true });
  await fs.mkdir(path.join(snapshotRoot, ".playwright-mcp"), { recursive: true });
  await fs.writeFile(path.join(snapshotRoot, "removed.txt"), "remove me");
  await fs.writeFile(path.join(snapshotRoot, "src", "existing.ts"), "before");
  const before = await captureWorkspaceSnapshot(snapshotRoot);
  await fs.writeFile(path.join(taskDirectory, "artifacts", "report.md"), "report");
  await fs.writeFile(path.join(snapshotRoot, "src", "existing.ts"), "after");
  await fs.writeFile(path.join(snapshotRoot, "outside.txt"), "outside");
  await fs.writeFile(path.join(snapshotRoot, ".workflow", "ignored.json"), "ignored");
  await fs.writeFile(path.join(snapshotRoot, ".claude-codex", "refs", "managed.json"), "managed evidence");
  await fs.writeFile(path.join(snapshotRoot, ".playwright-mcp", "page.yml"), "temporary browser state");
  await fs.mkdir(path.join(taskDirectory, ".chrome-profile-mobile", "Default", "Network"), { recursive: true });
  await fs.writeFile(path.join(taskDirectory, ".chrome-profile-mobile", "Default", "Network", "Cookies"), "locked runtime database");
  await fs.rm(path.join(snapshotRoot, "removed.txt"));
  const after = await captureWorkspaceSnapshot(snapshotRoot);
  const changed = changedWorkspaceFiles(before, after);
  assert.deepEqual(changed, ["outside.txt", "removed.txt", "src/existing.ts", "task-a/artifacts/report.md"]);
  assert.deepEqual(filesOutsideWriteScope(changed, ["artifacts/**", "src/**"], snapshotRoot, taskDirectory), ["outside.txt", "removed.txt"]);
  assert.deepEqual(filesOutsideWriteScope(["task-a/artifacts/report.md"], ["artifacts/**"], snapshotRoot, taskDirectory), []);
  assert.deepEqual(filesOutsideWriteScope(["outside.txt"], [], snapshotRoot, taskDirectory), ["outside.txt"]);
} finally {
  await fs.rm(snapshotRoot, { recursive: true, force: true });
}
const cyclic = normalizeWorkflowPlan({ ...validPlan, nodes: validPlan.nodes.map((node, index) => ({ ...node, dependsOn: [index ? "research" : "implement"] })) });
assert.ok(validateWorkflowPlan(cyclic, new Set()).includes("计划存在循环依赖"));

const transactionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-planner-transaction-"));
try {
  const transactionPath = path.join(transactionRoot, "transaction.json");
  createWorkflowPlanTransaction(transactionPath, { workflowId: "workflow-transaction", mode: "initial", baseRevision: 3, basePlanVersion: 0, previousPlan: null, availableSkills: [], availableMcpServers: [], providerCapabilities: { claudeAvailable: true, codexAvailable: true } });
  assert.equal(readWorkflowPlanTransaction(transactionPath).status, "editing");
  replaceWorkflowPlanDraft(transactionPath, validPlan);
  applyWorkflowPlanOperations(transactionPath, [{ type: "update_node", nodeId: "implement", fields: { acceptance: [] } }]);
  const invalidDraft = validateWorkflowPlanTransaction(transactionPath);
  assert.equal(invalidDraft.valid, false, "事务草稿允许暂时不完整，但不能提交");
  assert.match(invalidDraft.errors.join("；"), /缺少验收标准/);
  applyWorkflowPlanOperations(transactionPath, [{ type: "update_node", nodeId: "implement", fields: { acceptance: ["构建通过", "类型检查通过"] } }]);
  const committedTransaction = commitWorkflowPlanTransaction(transactionPath);
  assert.equal(committedTransaction.status, "committed");
  assert.ok(committedTransaction.digest);
  assert.deepEqual(committedTransaction.draftPlan.nodes.find((node) => node.id === "implement").acceptance, ["构建通过", "类型检查通过"]);

  const concurrentPlanPath = path.join(transactionRoot, "concurrent-plan.json");
  createWorkflowPlanTransaction(concurrentPlanPath, { workflowId: "workflow-concurrent-plan", mode: "initial", baseRevision: 1, basePlanVersion: 0, previousPlan: null, availableSkills: [], availableMcpServers: [], providerCapabilities: { claudeAvailable: true, codexAvailable: true } });
  replaceWorkflowPlanDraft(concurrentPlanPath, validPlan);
  const plannerTransactionModule = new URL("../dist-server/workflows/plannerTransactions.js", import.meta.url).href;
  await Promise.all(Array.from({ length: 12 }, (_, index) => execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { applyWorkflowPlanOperations } from ${JSON.stringify(plannerTransactionModule)}; applyWorkflowPlanOperations(process.argv[1], [{ type: "upsert_node", node: { ${Object.entries(validPlan.nodes[0]).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ")}, id: \`parallel-plan-${index}\`, title: \`并发规划节点 ${index}\`, dependsOn: [] } }]);`,
    concurrentPlanPath
  ])));
  const concurrentPlan = readWorkflowPlanTransaction(concurrentPlanPath);
  assert.equal(concurrentPlan.draftPlan.nodes.filter((node) => node.id.startsWith("parallel-plan-")).length, 12, "跨进程规划操作不得由旧事务版本覆盖新节点");
  assert.equal(concurrentPlan.operations.length, 13, "规划草稿替换和全部并发操作必须保留");

  const recoveryPath = path.join(transactionRoot, "recovery.json");
  const transactionInput = { workflowId: "workflow-recovery", mode: "initial", baseRevision: 7, basePlanVersion: 0, previousPlan: null, availableSkills: [], availableMcpServers: [], providerCapabilities: { claudeAvailable: true, codexAvailable: true }, requestKey: "request-a" };
  createWorkflowPlanTransaction(recoveryPath, transactionInput);
  applyWorkflowPlanOperations(recoveryPath, [{ type: "set_plan_fields", fields: { title: "已恢复计划", summary: "保留网络失败前的草稿" } }]);
  const reopened = openWorkflowPlanTransaction(recoveryPath, { ...transactionInput, baseRevision: 8 });
  assert.equal(reopened.resumed, true, "未提交事务应从稳定草稿恢复");
  assert.equal(reopened.transaction.draftPlan.title, "已恢复计划");
  assert.equal(reopened.transaction.operations.length, 1);
  assert.throws(() => openWorkflowPlanTransaction(recoveryPath, { ...transactionInput, basePlanVersion: 1 }), /基线版本已变化/);
  const replacedForNewRequest = openWorkflowPlanTransaction(recoveryPath, { ...transactionInput, baseRevision: 9, requestKey: "request-b" });
  assert.equal(replacedForNewRequest.resumed, false, "任务内容变化后不得复用旧草稿");
  assert.equal(replacedForNewRequest.transaction.operations.length, 0);
  applyWorkflowPlanOperations(recoveryPath, [{ type: "set_plan_fields", fields: { title: "新请求草稿" } }]);
  abortWorkflowPlanTransaction(recoveryPath, "永久契约错误");
  const replacedAfterAbort = openWorkflowPlanTransaction(recoveryPath, { ...transactionInput, baseRevision: 10, requestKey: "request-b" });
  assert.equal(replacedAfterAbort.resumed, false, "永久失败的事务不能静默复用");
  assert.equal(replacedAfterAbort.transaction.operations.length, 0);

  const noChangePath = path.join(transactionRoot, "no-change.json");
  createWorkflowPlanTransaction(noChangePath, { workflowId: "workflow-no-change", mode: "refine", baseRevision: 5, basePlanVersion: 1, previousPlan: validPlan, availableSkills: [], availableMcpServers: [], providerCapabilities: { claudeAvailable: true, codexAvailable: true } });
  const noChange = finishWorkflowPlanTransactionWithoutChange(noChangePath, "用户只是问候，没有修改计划");
  assert.equal(noChange.status, "no_change");
  assert.equal(noChange.draftPlan.nodes.length, validPlan.nodes.length);
} finally {
  await fs.rm(transactionRoot, { recursive: true, force: true });
}

const nodeResultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-node-result-transaction-"));
try {
  const resultPath = path.join(nodeResultRoot, "result-transaction.json");
  const resultContract = {
    schemaVersion: 1, workflowId: "workflow-result", planVersion: 2, nodeRecordId: "record-a", nodeId: "research",
    attemptId: "attempt-a", attempt: 1, contractDigest: "contract-digest", idempotencyKey: "workflow-result:2:research:1",
    taskContract: { task: { id: "research" } }, downstreamNodeIds: ["implement"]
  };
  createWorkflowNodeResultTransaction(resultPath, resultContract);
  setWorkflowNodeResultSummary(resultPath, { humanSummary: "完成大批量研究", decisions: [{ key: "format", value: "json", reason: "供下游消费" }], warnings: [], unresolved: [] });
  for (let batch = 0; batch < 5; batch += 1) registerWorkflowNodeOutputs(resultPath, Array.from({ length: 4 }, (_, offset) => {
    const index = batch * 4 + offset;
    return { id: `output-${index}`, type: "text", path: null, mediaType: null, description: `结果 ${index}`, consumableBy: ["implement"] };
  }));
  registerWorkflowNodeChecks(resultPath, [{ name: "结构检查", command: null, status: "passed", exitCode: 0, evidence: "20 项结果均已登记" }]);
  setWorkflowNodeHandoff(resultPath, { facts: ["结果可用"], constraints: [], nextAgentInstructions: ["按 output ID 消费"] });
  setWorkflowNodeOutcome(resultPath, "completed");
  assert.equal(validateWorkflowNodeResultTransaction(resultPath).valid, true);
  const committed = commitWorkflowNodeResultTransaction(resultPath);
  assert.equal(committed.status, "committed");
  assert.equal(committed.draftResult.outputs.length, 20, "大结果可以分批幂等登记");
  assert.equal(commitWorkflowNodeResultTransaction(resultPath).digest, committed.digest, "重复提交必须幂等");
  assert.equal(openWorkflowNodeResultTransaction(resultPath, resultContract).resumed, true, "重启后应恢复相同事务");
  assert.throws(() => openWorkflowNodeResultTransaction(resultPath, { ...resultContract, attemptId: "attempt-b" }), /身份不匹配/, "其他尝试不能复用事务");

  const concurrentPath = path.join(nodeResultRoot, "concurrent-result.json");
  createWorkflowNodeResultTransaction(concurrentPath, { ...resultContract, attemptId: "attempt-concurrent", idempotencyKey: "concurrent-key" });
  const transactionModule = new URL("../dist-server/workflows/nodeResultTransactions.js", import.meta.url).href;
  await Promise.all(Array.from({ length: 12 }, (_, index) => execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { registerWorkflowNodeOutputs } from ${JSON.stringify(transactionModule)}; registerWorkflowNodeOutputs(process.argv[1], [{ id: \`parallel-${index}\`, type: "text", path: null, mediaType: null, description: \`并发结果 ${index}\`, consumableBy: ["implement"] }]);`,
    concurrentPath
  ])));
  const concurrentResult = readWorkflowNodeResultTransaction(concurrentPath);
  assert.equal(concurrentResult.draftResult.outputs.length, 12, "跨进程并发登记不得由旧事务版本覆盖新结果");
  assert.equal(concurrentResult.operations.filter((item) => item.type === "register_outputs").length, 12, "并发写入操作必须全部保留");

  const draftPath = path.join(nodeResultRoot, "valid-draft.json");
  createWorkflowNodeResultTransaction(draftPath, { ...resultContract, attemptId: "attempt-draft", idempotencyKey: "draft-key" });
  setWorkflowNodeResultSummary(draftPath, { humanSummary: "Agent 忘记显式提交", warnings: [], unresolved: [] });
  setWorkflowNodeHandoff(draftPath, { facts: ["草稿事实"], constraints: [], nextAgentInstructions: [] });
  setWorkflowNodeOutcome(draftPath, "completed");
  assert.equal(validateWorkflowNodeResultTransaction(draftPath).valid, true, "有效草稿应能由服务端恢复提交");
  assert.equal(commitWorkflowNodeResultTransaction(draftPath).status, "committed");

  const invalidPath = path.join(nodeResultRoot, "invalid-consumer.json");
  createWorkflowNodeResultTransaction(invalidPath, { ...resultContract, attemptId: "attempt-invalid", idempotencyKey: "invalid-key" });
  setWorkflowNodeResultSummary(invalidPath, { humanSummary: "错误下游", warnings: [], unresolved: [] });
  registerWorkflowNodeOutputs(invalidPath, [{ id: "bad", type: "text", path: null, mediaType: null, description: "错误交接", consumableBy: ["unknown-node"] }]);
  setWorkflowNodeHandoff(invalidPath, { facts: [], constraints: [], nextAgentInstructions: [] });
  setWorkflowNodeOutcome(invalidPath, "completed");
  assert.match(validateWorkflowNodeResultTransaction(invalidPath).errors.join("；"), /非下游消费节点/);

  const reviewedPath = path.join(nodeResultRoot, "self-reviewed.json");
  createWorkflowNodeResultTransaction(reviewedPath, { ...resultContract, attemptId: "attempt-reviewed", idempotencyKey: "reviewed-key", requireSelfReview: true });
  setWorkflowNodeResultSummary(reviewedPath, { humanSummary: "当前节点合同已完成，后续风险交给实现节点", warnings: ["实现节点仍需验证集成风险"], unresolved: [] });
  setWorkflowNodeHandoff(reviewedPath, { facts: ["研究结论可供实现使用"], constraints: ["集成风险由下游验证"], nextAgentInstructions: ["实现节点执行集成检查"] });
  setWorkflowNodeOutcome(reviewedPath, "completed");
  assert.match(validateWorkflowNodeResultTransaction(reviewedPath).errors.join("；"), /必须完成节点结果自审/, "新节点结果不得绕过提交前自审");
  const selfReviewChecks = WORKFLOW_NODE_SELF_REVIEW_KEYS.map((key) => ({ key, status: "passed", note: `${key} 已对照当前节点合同检查` }));
  recordWorkflowNodeSelfReview(reviewedPath, { status: "passed", checks: selfReviewChecks, changes: [] });
  assert.equal(validateWorkflowNodeResultTransaction(reviewedPath).valid, true, "六项自审完成后结果应通过事务校验");
  setWorkflowNodeResultSummary(reviewedPath, { humanSummary: "自审后又修改了草稿", warnings: [], unresolved: [] });
  assert.match(validateWorkflowNodeResultTransaction(reviewedPath).errors.join("；"), /必须完成节点结果自审/, "自审后修改草稿必须使旧自审失效");
  recordWorkflowNodeSelfReview(reviewedPath, { status: "revised", checks: selfReviewChecks.map((check) => ({ ...check, status: "revised" })), changes: ["重新核对修改后的完整结果"] });
  assert.equal(commitWorkflowNodeResultTransaction(reviewedPath).status, "committed", "重新自审后应能正常封存结果");
  const beforeRepair = readWorkflowNodeResultTransaction(reviewedPath);
  const reopened = reopenWorkflowNodeResultTransaction(reviewedPath, ["服务端终态门禁要求修正声明"]);
  assert.equal(reopened.status, "editing", "已封存事务应可进入结果修复状态");
  assert.equal(reopened.selfReview, null, "结果修复必须使旧自审失效");
  assert.equal(reopened.digest, null, "结果修复必须清除旧摘要");
  assert.deepEqual(reopened.draftResult.outputs, beforeRepair.draftResult.outputs, "结果修复不得清空已有业务输出");
  assert.deepEqual(reopened.draftResult.handoff, beforeRepair.draftResult.handoff, "结果修复不得清空已有交接内容");
  recordWorkflowNodeSelfReview(reviewedPath, { status: "passed", checks: selfReviewChecks, changes: ["复核服务端门禁反馈"] });
  assert.equal(commitWorkflowNodeResultTransaction(reviewedPath).status, "committed", "修复后的同一事务应能重新封存");

  const gateWorkDirectory = path.join(nodeResultRoot, "gate-work");
  await fs.mkdir(gateWorkDirectory, { recursive: true });
  const gatePath = path.join(nodeResultRoot, "unified-gate.json");
  createWorkflowNodeResultTransaction(gatePath, {
    ...resultContract,
    attemptId: "attempt-gate",
    idempotencyKey: "gate-key",
    taskContract: { execution: { workDirectory: gateWorkDirectory }, outputs: { deliverables: [] } }
  });
  setWorkflowNodeResultSummary(gatePath, { humanSummary: "统一门禁测试", warnings: [], unresolved: [] });
  registerWorkflowNodeOutputs(gatePath, [{ id: "matrix", type: "data", path: null, mediaType: "application/json", description: "内存去重矩阵", consumableBy: ["implement"] }]);
  setWorkflowNodeHandoff(gatePath, { facts: ["矩阵已形成"], constraints: [], nextAgentInstructions: [] });
  setWorkflowNodeOutcome(gatePath, "completed");
  assert.match(validateWorkflowNodeResultTransaction(gatePath).errors.join("；"), /文件类产物缺少路径.*decision 或 text/, "文件类声明缺路径必须在 Agent 提交前失败");
  registerWorkflowNodeOutputs(gatePath, [{ id: "matrix", type: "decision", path: null, mediaType: "application/json", description: "无文件的结构化去重决策", consumableBy: ["implement"] }]);
  assert.equal(validateWorkflowNodeResultTransaction(gatePath).valid, true, "无文件结果改用 decision 后应通过统一门禁");

  const missingFilePath = path.join(nodeResultRoot, "missing-file-gate.json");
  createWorkflowNodeResultTransaction(missingFilePath, {
    ...resultContract,
    attemptId: "attempt-missing-file",
    idempotencyKey: "missing-file-key",
    taskContract: { execution: { workDirectory: gateWorkDirectory }, outputs: { deliverables: ["deliverables/final.md"] } }
  });
  setWorkflowNodeResultSummary(missingFilePath, { humanSummary: "错误文件声明", warnings: [], unresolved: [] });
  registerWorkflowNodeOutputs(missingFilePath, [{ id: "final", type: "document", path: "deliverables/final.md", mediaType: "text/markdown", description: "尚未创建的主文件", consumableBy: ["implement"] }]);
  setWorkflowNodeHandoff(missingFilePath, { facts: [], constraints: [], nextAgentInstructions: [] });
  setWorkflowNodeOutcome(missingFilePath, "completed");
  assert.match(validateWorkflowNodeResultTransaction(missingFilePath).errors.join("；"), /声明的产物不存在/, "不存在的文件必须在 Agent 提交前失败");

  const blockedPath = path.join(nodeResultRoot, "blocked-without-deliverable.json");
  createWorkflowNodeResultTransaction(blockedPath, {
    ...resultContract,
    attemptId: "attempt-blocked",
    idempotencyKey: "blocked-key",
    taskContract: { execution: { workDirectory: gateWorkDirectory }, outputs: { deliverables: ["deliverables/final.md"] } },
    downstreamNodeIds: []
  });
  setWorkflowNodeResultSummary(blockedPath, { humanSummary: "上游输入口径不兼容，未生成计划文件", unresolved: ["上游城市字段不一致"] });
  setWorkflowNodeHandoff(blockedPath, { facts: ["已核验两个上游文件"], constraints: ["城市字段必须一致"], nextAgentInstructions: [] });
  setWorkflowNodeOutcome(blockedPath, "blocked");
  assert.equal(validateWorkflowNodeResultTransaction(blockedPath).valid, true, "blocked 节点必须能在不伪造计划文件的情况下提交真实阻塞证据");
} finally {
  await fs.rm(nodeResultRoot, { recursive: true, force: true });
}

const mcpTransactionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-planner-mcp-"));
try {
  const transactionPath = path.join(mcpTransactionRoot, "transaction.json");
  createWorkflowPlanTransaction(transactionPath, { workflowId: "workflow-mcp", mode: "initial", baseRevision: 1, basePlanVersion: 0, previousPlan: null, availableSkills: [], availableMcpServers: [], providerCapabilities: { claudeAvailable: true, codexAvailable: true } });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist-server/workflows/plannerToolServer.js")],
    env: { ...env, WORKFLOW_PLANNER_TRANSACTION_PATH: transactionPath },
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const client = new McpClient({ name: "workflow-planner-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "workflow_commit_candidate"));
    assert.equal(tools.tools.find((tool) => tool.name === "workflow_read_plan")?.annotations?.readOnlyHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === "workflow_validate_draft")?.annotations?.readOnlyHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === "workflow_replace_plan")?.annotations?.readOnlyHint, true, "隔离事务工具由工作台预授权，实际并发安全由事务文件锁保证");
    assert.equal(tools.tools.find((tool) => tool.name === "workflow_apply_operations")?.annotations?.readOnlyHint, true, "Codex 无交互审批通道必须允许内部事务工具直接执行");
    assert.equal(tools.tools.find((tool) => tool.name === "workflow_commit_candidate")?.annotations?.readOnlyHint, true, "候选提交只封存工作台隔离事务");
    const replacement = await client.callTool({ name: "workflow_replace_plan", arguments: { plan: validPlan } });
    const replacementText = replacement.content.map((item) => item.type === "text" ? item.text : "").join("\n");
    assert.match(replacementText, /"nodeCount": 2/);
    assert.doesNotMatch(replacementText, /"draftPlan"/, "规划写操作不应把完整增长中的 DAG 反复送回模型");
    const validation = await client.callTool({ name: "workflow_validate_draft", arguments: {} });
    assert.match(validation.content.map((item) => item.type === "text" ? item.text : "").join("\n"), /"valid": true/);
    const committed = await client.callTool({ name: "workflow_commit_candidate", arguments: {} });
    const committedText = committed.content.map((item) => item.type === "text" ? item.text : "").join("\n");
    assert.match(committedText, /"status": "committed"/);
    assert.doesNotMatch(committedText, /"draftPlan"/, "规划提交确认不应再次返回完整 DAG");
    assert.equal(readWorkflowPlanTransaction(transactionPath).status, "committed");
  } finally {
    await client.close().catch(() => transport.close().catch(() => undefined));
  }
} finally {
  await fs.rm(mcpTransactionRoot, { recursive: true, force: true });
}

const nodeResultMcpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-node-result-mcp-"));
try {
  const transactionPath = path.join(nodeResultMcpRoot, "result-transaction.json");
  createWorkflowNodeResultTransaction(transactionPath, {
    schemaVersion: 1, workflowId: "workflow-result-mcp", planVersion: 1, nodeRecordId: "record-mcp", nodeId: "node-mcp",
    attemptId: "attempt-mcp", attempt: 1, contractDigest: "digest-mcp", idempotencyKey: "workflow-result-mcp:1:node-mcp:1",
    taskContract: { task: { id: "node-mcp" } }, downstreamNodeIds: []
  });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.resolve("dist-server/workflows/nodeResultToolServer.js")],
    env: { ...env, WORKFLOW_NODE_RESULT_TRANSACTION_PATH: transactionPath }, cwd: process.cwd(), stderr: "pipe"
  });
  const client = new McpClient({ name: "workflow-node-result-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "workflow_commit_result"));
    assert.ok(tools.tools.some((tool) => tool.name === "workflow_self_review_result"), "执行节点必须暴露提交前自审工具");
    assert.equal(tools.tools.find((tool) => tool.name === "workflow_register_outputs")?.annotations?.readOnlyHint, true, "内部结果工具由工作台预授权，事务锁负责防止并发覆盖");
    await client.callTool({ name: "workflow_set_result_summary", arguments: { humanSummary: "MCP 交接完成", warnings: [], unresolved: [] } });
    await client.callTool({ name: "workflow_set_handoff", arguments: { facts: ["MCP 可用"], constraints: [], nextAgentInstructions: [] } });
    await client.callTool({ name: "workflow_set_outcome", arguments: { outcome: "completed" } });
    const validation = await client.callTool({ name: "workflow_validate_result", arguments: {} });
    assert.match(validation.content.map((item) => item.type === "text" ? item.text : "").join("\n"), /"valid": true/);
    await client.callTool({ name: "workflow_commit_result", arguments: {} });
    assert.equal(readWorkflowNodeResultTransaction(transactionPath).status, "committed");
  } finally {
    await client.close().catch(() => transport.close().catch(() => undefined));
  }
} finally {
  await fs.rm(nodeResultMcpRoot, { recursive: true, force: true });
}

const interruptedMaintenanceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-maintenance-recovery-"));
try {
  const interruptedRepository = new WorkflowRepository(new DatabaseSync(":memory:"));
  const interruptedStateFiles = new WorkflowStateFiles();
  const draft = interruptedRepository.create({ ownerUserId: "user-recovery", workspaceId: "workspace-recovery", workDirectory: interruptedMaintenanceRoot, prompt: "验证维护中断恢复", plannerEngine: "claude" });
  interruptedRepository.setPlanning(draft.id, "user-recovery", draft.revision);
  const planned = interruptedRepository.savePlan(draft.id, "user-recovery", validPlan);
  interruptedStateFiles.sync(planned);
  const started = interruptedRepository.startMaintenance(planned.id, "user-recovery", { id: "maintenance-started", createdAt: new Date().toISOString(), kind: "status", title: "维护规划", text: "开始" }, "调整依赖");
  interruptedStateFiles.beginMaintenance(started, "调整依赖");
  assert.equal(interruptedStateFiles.maintenance(started)?.status, "planning");
  const recovered = interruptedRepository.finishMaintenanceWithoutPlan(started.id, "user-recovery", { id: "maintenance-interrupted", createdAt: new Date().toISOString(), kind: "error", title: "规划维护已中断", text: "原计划保持不变" });
  interruptedStateFiles.failMaintenance(recovered, "工作台重启导致本轮维护中断");
  interruptedStateFiles.syncResults(recovered);
  assert.equal(recovered.status, "awaiting_approval");
  assert.equal(recovered.activePlanVersion, planned.activePlanVersion);
  assert.deepEqual(recovered.plan, validPlan);
  assert.equal(interruptedStateFiles.maintenance(recovered)?.status, "failed");
  const persistedWorkflow = JSON.parse(await fs.readFile(path.join(interruptedMaintenanceRoot, ".workflow", "workflow.json"), "utf8"));
  assert.equal(persistedWorkflow.activePlanVersion, planned.activePlanVersion);
  assert.equal(persistedWorkflow.maintenanceBranch.status, "failed");
} finally {
  await fs.rm(interruptedMaintenanceRoot, { recursive: true, force: true });
}

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");
const repository = new WorkflowRepository(db);
const created = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "完成一个测试任务", plannerEngine: "claude" });
assert.equal(created.status, "draft");
assert.equal(created.originId, created.id);
assert.equal(created.branchIndex, 1);
assert.equal(created.branchLabel, "方案 1");
assert.equal(created.nodes.length, 0, "未审批不能产生执行节点");
assert.equal(created.pinned, false);
assert.equal(created.archivedAt, null);
assert.equal(created.folderId, null);
assert.equal(created.maxConcurrentAgents, null);
const secondBranch = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "采用另一套方案", plannerEngine: "codex", originId: created.originId, parentWorkflowId: created.id, branchIndex: repository.nextBranchIndex(created.originId, "user-a"), branchLabel: "方案 2" });
assert.equal(secondBranch.originId, created.id);
assert.equal(secondBranch.parentWorkflowId, created.id);
assert.equal(secondBranch.branchIndex, 2);
assert.deepEqual(repository.listBranches(created.originId, "user-a").map((item) => item.id), [created.id, secondBranch.id]);
assert.equal(repository.nextBranchIndex(created.originId, "user-a"), 3);

const editable = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "旧初始任务", plannerEngine: "claude" });
repository.setPlannerSession(editable.id, "user-a", "planner-session", "engine-session");
const plannerSessionRevision = repository.get(editable.id, "user-a").revision;
repository.setPlannerSession(editable.id, "user-a", "planner-session", "engine-session");
assert.equal(repository.get(editable.id, "user-a").revision, plannerSessionRevision, "重复 session.started 事件不应制造无意义版本递增");
repository.clearPlannerEngineSession(editable.id, "user-a");
assert.equal(repository.get(editable.id, "user-a").plannerEngineSessionId, null, "权限故障后应丢弃被污染的 Claude 引擎会话");
repository.setPlannerSession(editable.id, "user-a", "planner-session", "engine-session");
const editableWithSession = repository.get(editable.id, "user-a");
const edited = repository.updateOriginalPrompt(editable.id, "user-a", editableWithSession.revision, "更新后的初始任务");
assert.equal(edited.originalPrompt, "更新后的初始任务");
assert.equal(edited.status, "draft");
assert.equal(edited.activePlanVersion, 0);
assert.equal(edited.plannerSessionId, null);
assert.equal(edited.plannerEngineSessionId, null);

const freshSessionRun = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证全新重做会话", plannerEngine: "codex" });
repository.setPlannerSession(freshSessionRun.id, "user-a", "planner-session", "engine-session");
const freshSessionSnapshot = repository.get(freshSessionRun.id, "user-a");
repository.setPlanning(freshSessionRun.id, "user-a", freshSessionSnapshot.revision, undefined, { resetSession: true });
const freshPlanning = repository.get(freshSessionRun.id, "user-a");
assert.equal(freshPlanning.plannerSessionId, null);
assert.equal(freshPlanning.plannerEngineSessionId, null);
const organized = repository.updateMetadata(created.id, "user-a", { title: "已整理工作流", pinned: true, folderId: "folder-a" });
assert.equal(organized.title, "已整理工作流");
assert.equal(organized.pinned, true);
assert.equal(organized.folderId, "folder-a");
const plannerStarted = { id: "planner-log-1", createdAt: new Date().toISOString(), kind: "status", title: "开始规划", text: "读取任务" };
repository.setPlanning(created.id, "user-a", organized.revision, plannerStarted);
let planning = repository.get(created.id, "user-a");
assert.equal(planning.status, "planning");
assert.equal(planning.plannerLogs.length, 1);
assert.ok(planning.plannerStartedAt);
repository.appendPlannerLog(created.id, "user-a", { ...plannerStarted, id: "planner-log-2", title: "校验任务图" });
planning = repository.get(created.id, "user-a");
assert.equal(planning.plannerLogs.length, 2);
const planned = repository.savePlan(created.id, "user-a", validPlan);
assert.equal(planned.status, "awaiting_approval");
assert.ok(planned.plannerFinishedAt);
assert.throws(() => repository.failPlanning(created.id, "user-a", plannerStarted), /不能标记规划失败/);
assert.equal(repository.get(created.id, "user-a").status, "awaiting_approval", "过期规划失败不能覆盖已生成的计划");
assert.equal(planned.nodes.length, 0, "待审批计划不能产生执行节点");

const maintenanceRun = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证规划维护隔离", plannerEngine: "claude" });
repository.setPlanning(maintenanceRun.id, "user-a", maintenanceRun.revision);
const maintenancePlanned = repository.savePlan(maintenanceRun.id, "user-a", validPlan);
repository.startMaintenance(maintenanceRun.id, "user-a", plannerStarted, "只做解释，不修改");
const maintenanceNoChange = repository.finishMaintenanceWithoutPlan(maintenanceRun.id, "user-a", { ...plannerStarted, id: "maintenance-no-change", title: "计划未修改" });
assert.equal(maintenanceNoChange.status, "awaiting_approval", "维护无修改不得改变原工作流状态");
assert.equal(maintenanceNoChange.activePlanVersion, maintenancePlanned.activePlanVersion, "维护无修改不得创建计划版本");
repository.startMaintenance(maintenanceRun.id, "user-a", { ...plannerStarted, id: "maintenance-update", title: "维护规划" }, "调整摘要");
const maintainedPlan = normalizeWorkflowPlan({ ...validPlan, summary: "维护后的摘要" });
const maintenanceSaved = repository.saveMaintenancePlan(maintenanceRun.id, "user-a", maintainedPlan, "调整摘要");
assert.equal(maintenanceSaved.activePlanVersion, maintenancePlanned.activePlanVersion + 1, "成功维护应创建新的候选版本");
assert.equal(maintenanceSaved.status, "awaiting_approval");
assert.equal(maintenanceSaved.plan.summary, "维护后的摘要");
assert.throws(() => repository.approve(created.id, "user-a", planned.revision - 1), /已更新/);
const approved = repository.approve(created.id, "user-a", planned.revision);
assert.equal(approved.status, "queued");
repository.setPlanning(secondBranch.id, "user-a", secondBranch.revision);
const secondBranchPlanned = repository.savePlan(secondBranch.id, "user-a", validPlan);
const secondBranchApproved = repository.approve(secondBranch.id, "user-a", secondBranchPlanned.revision);
assert.equal(secondBranchApproved.status, "queued", "同源方案必须允许同时获批并进入各自执行队列");
assert.equal(repository.get(created.id, "user-a").status, "queued", "批准其他方案不得改变已排队方案的状态");
repository.updateRun(secondBranch.id, "needs_review");
assert.throws(() => repository.updateOriginalPrompt(created.id, "user-a", approved.revision, "不能覆盖执行历史"), /不能覆盖修改|不能覆盖/);
assert.equal(approved.nodes.length, 2);
assert.deepEqual(approved.nodes[1].dependsOn, ["research"]);
assert.deepEqual(approved.nodes[0].nonGoals, ["不修改代码"]);
assert.deepEqual(approved.nodes[1].constraints, ["保持现有接口"]);
assert.equal(approved.nodes[0].providerReason, "需要综合自然语言资料并形成判断");
assert.equal(approved.nodes[1].providerReason, "需要修改代码并通过命令验证");
assert.deepEqual(approved.nodes[1].verificationCommands, ["npm run typecheck"]);
assert.equal(approved.activePlanVersion, 1);

const pausedNode = repository.requestNodePause(approved.id, "user-a", approved.nodes[0].id);
assert.equal(pausedNode.nodes[0].status, "paused", "尚未启动的节点应可直接暂停");
const resumedNode = repository.resumeNode(approved.id, "user-a", approved.nodes[0].id);
assert.equal(resumedNode.nodes[0].status, "interrupted", "恢复后节点应进入可接管的中断状态");
resumedNode.nodes[0].engineThreadId = "thread-before-manual-restart";
resumedNode.nodes[0].contextRecoveryCount = 1;
resumedNode.nodes[0].contextRecoveryMode = "resumed";
repository.updateNode(resumedNode.nodes[0]);
const restartedNode = repository.restartNode(approved.id, "user-a", approved.nodes[0].id);
assert.equal(restartedNode.nodes[0].status, "pending", "重跑节点应回到待调度状态");
assert.equal(restartedNode.nodes[0].engineThreadId, null, "手动重跑必须丢弃旧 Codex Thread");
assert.equal(restartedNode.nodes[0].contextRecoveryCount, 0);

const controlRun = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证统一工作流控制", plannerEngine: "claude" });
repository.setPlanning(controlRun.id, "user-a", controlRun.revision);
const controlPlanned = repository.savePlan(controlRun.id, "user-a", validPlan);
const controlApproved = repository.approve(controlRun.id, "user-a", controlPlanned.revision);
controlApproved.nodes[0].status = "completed";
controlApproved.nodes[0].summary = normalizeWorkflowNodeResult({ outcome: "completed", humanSummary: "已完成且不能回退", outputs: [], changedFiles: [], checks: [], decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: [] });
controlApproved.nodes[1].status = "retry_wait";
controlApproved.nodes[1].nextRetryAt = "2099-01-01T00:00:00.000Z";
repository.updateNode(controlApproved.nodes[0]);
repository.updateNode(controlApproved.nodes[1]);
repository.updateRun(controlRun.id, "running");
const globallyPaused = repository.pause(controlRun.id, "user-a", repository.get(controlRun.id, "user-a").revision);
assert.equal(globallyPaused.status, "paused");
assert.equal(globallyPaused.pausedFromStatus, "running");
assert.equal(globallyPaused.nodes[0].status, "completed", "全局暂停不得回退已完成节点");
assert.equal(globallyPaused.nodes[1].status, "paused", "重试等待节点必须进入统一暂停状态");
const globallyResumed = repository.resume(controlRun.id, "user-a", globallyPaused.revision);
assert.equal(globallyResumed.status, "queued");
assert.equal(globallyResumed.pausedFromStatus, null);
assert.equal(globallyResumed.nodes[0].status, "completed");
assert.equal(globallyResumed.nodes[1].status, "interrupted", "恢复后只调度未完成节点");
assert.throws(() => repository.cancelNode(controlRun.id, "user-a", globallyResumed.nodes[0].id), /不能终止/, "已完成节点不能被终止");
repository.updateRun(controlRun.id, "needs_review");
const nodeCancelRun = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证节点终止与恢复", plannerEngine: "codex" });
repository.setPlanning(nodeCancelRun.id, "user-a", nodeCancelRun.revision);
const nodeCancelPlanned = repository.savePlan(nodeCancelRun.id, "user-a", validPlan);
const nodeCancelApproved = repository.approve(nodeCancelRun.id, "user-a", nodeCancelPlanned.revision);
const nodeCanceled = repository.cancelNode(nodeCancelRun.id, "user-a", nodeCancelApproved.nodes[0].id);
assert.equal(nodeCanceled.nodes[0].status, "canceled");
assert.match(failedDependencyReason(nodeCanceled.nodes[1], nodeCanceled.nodes), /canceled/, "终止必需节点必须阻塞依赖节点");
const canceledRestarted = repository.restartNode(nodeCancelRun.id, "user-a", nodeCanceled.nodes[0].id);
assert.equal(canceledRestarted.nodes[0].status, "pending", "终止节点允许重新执行");
assert.equal(canceledRestarted.nodes[1].status, "pending", "重跑终止节点时下游应恢复等待");
repository.updateRun(nodeCancelRun.id, "needs_review");

const planningPauseRun = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证规划暂停来源", plannerEngine: "claude" });
repository.setPlanning(planningPauseRun.id, "user-a", planningPauseRun.revision);
const planningPaused = repository.pause(planningPauseRun.id, "user-a", repository.get(planningPauseRun.id, "user-a").revision, { mode: "initial" });
assert.equal(planningPaused.pausedFromStatus, "planning");
assert.equal(planningPaused.pausedPlanningMode, "initial");
assert.equal(repository.resume(planningPauseRun.id, "user-a", planningPaused.revision).status, "planning");
repository.cancel(planningPauseRun.id, "user-a", repository.get(planningPauseRun.id, "user-a").revision);

const attemptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-workflow-attempts-"));
try {
  const claimed = repository.claimNodeAttempt(approved.nodes[0].recordId, "runner-a", attemptRoot, new Date(Date.now() + 60_000).toISOString());
  assert.equal(claimed.attempt, 1);
  assert.equal(claimed.phase, "claimed");
  assert.equal(claimed.resultRepairCount, 0);
  assert.equal(claimed.verificationRunCount, 0);
  assert.equal(claimed.snapshotRetryCount, 0);
  repository.checkpointNodeAttempt(claimed.id, { engineThreadId: "thread-persisted", contextRecoveryCount: 1, contextRecoveryMode: "resumed" });
  const threadPersistedNode = repository.get(created.id, "user-a").nodes[0];
  threadPersistedNode.engineThreadId = "thread-persisted";
  threadPersistedNode.contextRecoveryCount = 1;
  threadPersistedNode.contextRecoveryMode = "resumed";
  repository.updateNode(threadPersistedNode);
  assert.equal(repository.getLatestNodeAttempt(threadPersistedNode.recordId).engineThreadId, "thread-persisted");
  assert.equal(repository.get(created.id, "user-a").nodes[0].contextRecoveryMode, "resumed");
  assert.throws(() => repository.claimNodeAttempt(approved.nodes[0].recordId, "runner-b", attemptRoot, new Date(Date.now() + 60_000).toISOString()), /不能被调度|接管/);

  repository.checkpointNodeAttempt(claimed.id, { phase: "agent_output_received", status: "interrupted", rawOutput: "saved raw output", resultRepairCount: 1, verificationRunCount: 1, leaseExpiresAt: null });
  const interruptedNode = repository.get(created.id, "user-a").nodes[0];
  interruptedNode.status = "interrupted";
  interruptedNode.leaseExpiresAt = null;
  repository.updateNode(interruptedNode);
  const resumed = repository.claimNodeAttempt(interruptedNode.recordId, "runner-b", attemptRoot, new Date(Date.now() + 60_000).toISOString());
  assert.equal(resumed.id, claimed.id, "保存了 Agent 输出后应恢复同一次尝试");
  assert.equal(resumed.attempt, 1);
  assert.equal(resumed.rawOutput, "saved raw output");
  assert.equal(resumed.resultRepairCount, 1);
  assert.equal(resumed.verificationRunCount, 1);

  repository.checkpointNodeAttempt(resumed.id, { phase: "agent_running", status: "interrupted", snapshotRetryCount: 1, leaseExpiresAt: null });
  await fs.mkdir(resumed.checkpointDirectory, { recursive: true });
  await fs.writeFile(path.join(resumed.checkpointDirectory, "result-transaction.json"), JSON.stringify({ status: "editing", operations: [], draftResult: { humanSummary: "" } }));
  const agentInterruptedNode = repository.get(created.id, "user-a").nodes[0];
  agentInterruptedNode.status = "interrupted";
  repository.updateNode(agentInterruptedNode);
  const restarted = repository.claimNodeAttempt(agentInterruptedNode.recordId, "runner-c", attemptRoot, new Date(Date.now() + 60_000).toISOString());
  assert.equal(restarted.attempt, 1, "Agent 运行中断且没有有效输出时不得消耗新的尝试次数");
  assert.equal(restarted.id, resumed.id, "Agent 运行中断应在同一次尝试中安全重建进程");
  assert.equal(restarted.phase, "claimed");
  assert.equal(restarted.snapshotRetryCount, 1, "同一次尝试的快照重试计数必须保留，防止形成无限重试");
  assert.equal(await fs.stat(restarted.checkpointDirectory).then(() => true, () => false), false, "恢复 Agent 前必须清理未提交的空结果事务");
  assert.equal(repository.getLatestNodeAttempt(agentInterruptedNode.recordId).id, restarted.id);

  const completeDraftDirectory = restarted.checkpointDirectory;
  await fs.mkdir(completeDraftDirectory, { recursive: true });
  const completeDraftPath = path.join(completeDraftDirectory, "result-transaction.json");
  createWorkflowNodeResultTransaction(completeDraftPath, {
    schemaVersion: 1,
    workflowId: created.id,
    planVersion: 1,
    nodeRecordId: agentInterruptedNode.recordId,
    nodeId: agentInterruptedNode.id,
    attemptId: restarted.id,
    attempt: restarted.attempt,
    contractDigest: "recovery-contract",
    idempotencyKey: "recovery-idempotency",
    taskContract: {},
    downstreamNodeIds: []
  });
  setWorkflowNodeResultSummary(completeDraftPath, { humanSummary: "业务与机器交接均已完成" });
  setWorkflowNodeOutcome(completeDraftPath, "completed");
  repository.checkpointNodeAttempt(restarted.id, { phase: "agent_running", status: "interrupted", leaseExpiresAt: null });
  const completeDraftInterruptedNode = repository.get(created.id, "user-a").nodes[0];
  completeDraftInterruptedNode.status = "interrupted";
  repository.updateNode(completeDraftInterruptedNode);
  const recoveredCompleteDraft = repository.claimNodeAttempt(completeDraftInterruptedNode.recordId, "runner-draft", attemptRoot, new Date(Date.now() + 60_000).toISOString());
  assert.equal(recoveredCompleteDraft.id, restarted.id, "完整但未提交的机器草稿不得重新执行 Agent");
  assert.equal(recoveredCompleteDraft.phase, "agent_output_received", "完整草稿应直接进入服务器校验与提交");

  const committedRecoveryDirectory = restarted.checkpointDirectory;
  await fs.mkdir(committedRecoveryDirectory, { recursive: true });
  await fs.writeFile(path.join(committedRecoveryDirectory, "result-transaction.json"), JSON.stringify({ transactionSchemaVersion: 1, transactionId: "restart-result", workflowId: created.id, attemptId: restarted.id, status: "committed", draftResult: {} }));
  repository.checkpointNodeAttempt(restarted.id, { phase: "agent_running", status: "interrupted", leaseExpiresAt: null });
  const committedInterruptedNode = repository.get(created.id, "user-a").nodes[0];
  committedInterruptedNode.status = "interrupted";
  repository.updateNode(committedInterruptedNode);
  const recoveredCommitted = repository.claimNodeAttempt(committedInterruptedNode.recordId, "runner-d", attemptRoot, new Date(Date.now() + 60_000).toISOString());
  assert.equal(recoveredCommitted.id, restarted.id, "已提交机器事务时重启不得重新执行 Agent");
  assert.equal(recoveredCommitted.attempt, 1);
  assert.equal(recoveredCommitted.phase, "agent_output_received", "恢复后直接进入机器结果复核");

  const persistedRetryNode = repository.get(created.id, "user-a").nodes[0];
  persistedRetryNode.status = "retry_wait";
  persistedRetryNode.nextRetryAt = "2099-01-01T00:00:00.000Z";
  repository.updateNode(persistedRetryNode);
  assert.equal(repository.get(created.id, "user-a").nodes[0].nextRetryAt, "2099-01-01T00:00:00.000Z");
} finally {
  await fs.rm(attemptRoot, { recursive: true, force: true });
}

const leaseRun = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证租约接管", plannerEngine: "claude" });
repository.setPlanning(leaseRun.id, "user-a", leaseRun.revision);
const leasePlanned = repository.savePlan(leaseRun.id, "user-a", validPlan);
const leaseApproved = repository.approve(leaseRun.id, "user-a", leasePlanned.revision);
const leaseAttempt = repository.claimNodeAttempt(leaseApproved.nodes[0].recordId, "expired-runner", path.join(os.tmpdir(), "expired-workflow-attempt"), "2000-01-01T00:00:00.000Z");
assert.equal(repository.recoverExpiredLeases(new Set([`${leaseRun.id}:research`])).length, 0, "仍在本进程执行的节点即使租约瞬时过期也不能被重复接管");
assert.equal(repository.get(leaseRun.id, "user-a").nodes[0].status, "running", "活跃节点必须保持 running，避免下游或 Integrator 读取竞态终态");
assert.ok(repository.recoverExpiredLeases().some((item) => item.id === leaseRun.id));
assert.equal(repository.get(leaseRun.id, "user-a").nodes[0].status, "interrupted");
assert.equal(repository.getLatestNodeAttempt(leaseApproved.nodes[0].recordId).status, "interrupted");
assert.equal(leaseAttempt.attempt, 1);
repository.updateRun(leaseRun.id, "needs_review");
const retryRun = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证失败节点恢复", plannerEngine: "claude" });
repository.setPlanning(retryRun.id, "user-a", retryRun.revision);
const retryPlanned = repository.savePlan(retryRun.id, "user-a", validPlan);
const retryApproved = repository.approve(retryRun.id, "user-a", retryPlanned.revision);
retryApproved.nodes[0].status = "failed";
retryApproved.nodes[0].attempt = 2;
retryApproved.nodes[0].error = "执行契约未满足";
retryApproved.nodes[0].summary = normalizeWorkflowNodeResult({ outcome: "failed", humanSummary: "已有部分成果", outputs: [], changedFiles: [], checks: [], decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: ["补充验收证据"] });
retryApproved.nodes[1].status = "blocked";
retryApproved.nodes[1].error = "上游节点未成功";
repository.updateNode(retryApproved.nodes[0]);
repository.updateNode(retryApproved.nodes[1]);
repository.updateRun(retryRun.id, "needs_review");
const retried = repository.retryNodes(retryRun.id, "user-a");
assert.equal(retried.status, "queued");
assert.equal(retried.nodes[0].status, "pending");
assert.equal(retried.nodes[0].attempt, 2);
assert.equal(retried.nodes[0].summary.outcome, "failed", "重试前结果应保留给纠正提示");
assert.equal(retried.nodes[1].status, "pending", "被失败节点阻塞的下游应自动恢复");
assert.equal(retried.nodes[1].error, null);
assert.ok(retried.nodes[0].logs.some((log) => log.title === "重新排队"));
assert.ok(retried.nodes[1].logs.some((log) => log.title === "解除依赖阻塞"));
repository.updateRun(retryRun.id, "needs_review");

const dependencyPlan = normalizeWorkflowPlan({
  title: "依赖失效范围", summary: "只重跑受影响闭包", nodes: [
    { ...validPlan.nodes[0], id: "root", title: "根节点" },
    { ...validPlan.nodes[0], id: "dependent", title: "依赖节点", dependsOn: ["root"] },
    { ...validPlan.nodes[0], id: "parallel", title: "并行节点", dependsOn: [] }
  ]
});
const dependencyRun = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证依赖闭包", plannerEngine: "claude" });
repository.setPlanning(dependencyRun.id, "user-a", dependencyRun.revision);
const dependencyPlanned = repository.savePlan(dependencyRun.id, "user-a", dependencyPlan);
const dependencyApproved = repository.approve(dependencyRun.id, "user-a", dependencyPlanned.revision);
for (const node of dependencyApproved.nodes) {
  node.status = "completed";
  node.summary = normalizeWorkflowNodeResult({ outcome: "completed", humanSummary: `${node.id} 完成`, outputs: [], changedFiles: [], checks: [], decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: [] });
  node.resultDigest = `${node.id}-digest`;
  repository.updateNode(node);
}
assert.deepEqual(repository.invalidateCompletedDependents(dependencyRun.id, dependencyApproved.activePlanVersion, "root"), ["dependent"]);
const invalidatedDependencyRun = repository.get(dependencyRun.id, "user-a");
assert.equal(invalidatedDependencyRun.nodes.find((node) => node.id === "dependent").status, "pending");
assert.equal(invalidatedDependencyRun.nodes.find((node) => node.id === "parallel").status, "completed", "无关并行节点不得失效");
repository.updateRun(dependencyRun.id, "needs_review");
for (const outcome of ["completed", "partial", "blocked", "failed"]) {
  approved.nodes[0].summary = normalizeWorkflowNodeResult({ outcome, humanSummary: `${outcome} result`, outputs: [], changedFiles: [], checks: [], decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: outcome === "completed" ? [] : [outcome] });
  repository.updateNode(approved.nodes[0]);
  assert.equal(repository.get(created.id, "user-a").nodes[0].summary.outcome, outcome);
}
approved.nodes[0].status = "failed";
assert.match(failedDependencyReason(approved.nodes[1], approved.nodes), /上游节点未成功/);
approved.nodes[0].status = "completed";
approved.nodes[0].summary = normalizeWorkflowNodeResult({ summary: "研究完成", artifacts: [], changedFiles: [], tests: [], risks: [] });
approved.nodes[1].requiredArtifacts = ["research.md"];
assert.deepEqual(missingRequiredArtifacts(approved.nodes[1], approved.nodes), ["research.md"]);
approved.nodes[0].summary.outputs = [{ id: "research", type: "document", path: "artifacts/research.md", mediaType: "text/markdown", description: "研究结果", consumableBy: ["implement"] }];
assert.deepEqual(missingRequiredArtifacts(approved.nodes[1], approved.nodes), []);
const transitiveArtifactNodes = [
  { ...approved.nodes[0], id: "source", status: "completed", dependsOn: [], summary: normalizeWorkflowNodeResult({ outcome: "completed", humanSummary: "祖先产物", outputs: [{ id: "evidence", type: "document", path: "task/work/source/evidence.md", description: "证据", consumableBy: [] }], changedFiles: [], checks: [], decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: [] }) },
  { ...approved.nodes[0], id: "middle", status: "completed", dependsOn: ["source"], summary: normalizeWorkflowNodeResult({ outcome: "completed", humanSummary: "中间交接", outputs: [], changedFiles: [], checks: [], decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: [] }) },
  { ...approved.nodes[1], id: "consumer", status: "pending", dependsOn: ["middle"], requiredArtifacts: ["work/source/evidence.md"] }
];
assert.deepEqual(missingRequiredArtifacts(transitiveArtifactNodes[2], transitiveArtifactNodes), [], "已验证祖先节点登记的产物必须可供后代节点使用");
approved.nodes[0].status = "running";
approved.nodes[0].attempt = 1;
repository.updateNode(approved.nodes[0]);
repository.updateRun(created.id, "running");
const recovered = repository.recoverAfterRestart();
assert.equal(recovered.length, 1);
const afterRestart = repository.get(created.id, "user-a");
assert.equal(afterRestart.status, "queued");
assert.equal(afterRestart.nodes[0].status, "interrupted");

const canceledDuringPlanning = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证规划取消", plannerEngine: "codex" });
repository.setPlanning(canceledDuringPlanning.id, "user-a", canceledDuringPlanning.revision);
const activePlanning = repository.get(canceledDuringPlanning.id, "user-a");
const canceled = repository.cancel(canceledDuringPlanning.id, "user-a", activePlanning.revision);
assert.equal(canceled.status, "canceled");
assert.throws(() => repository.savePlan(canceled.id, "user-a", validPlan), /不能保存规划结果/);

const rejectedPlan = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证退回意见", plannerEngine: "claude" });
repository.setPlanning(rejectedPlan.id, "user-a", rejectedPlan.revision);
const awaitingReview = repository.savePlan(rejectedPlan.id, "user-a", validPlan);
const revised = repository.revise(rejectedPlan.id, "user-a", awaitingReview.revision, "减少串行节点并补充风险分析");
assert.equal(revised.status, "draft");
assert.equal(revised.reviewNote, "减少串行节点并补充风险分析");

const customConcurrency = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证自定义并行", plannerEngine: "claude", maxConcurrentAgents: 3 });
assert.equal(customConcurrency.maxConcurrentAgents, 3);
repository.replaceNodeArtifacts(customConcurrency.id, "node-a", [{ path: "artifacts/result.md", kind: "file", hash: "abc", summary: "结果" }]);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_artifacts WHERE workflow_id = ?").get(customConcurrency.id).count, 1);
repository.replaceNodeArtifacts(customConcurrency.id, "node-a", [{ path: "artifacts/result-v2.md", kind: "file", hash: "def", summary: "新结果" }], 2, "digest-v2");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_artifacts WHERE workflow_id = ?").get(customConcurrency.id).count, 2, "旧产物索引必须保留为历史");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_artifacts WHERE workflow_id = ? AND active = 1").get(customConcurrency.id).count, 1);
assert.equal(db.prepare("SELECT path FROM workflow_artifacts WHERE workflow_id = ? AND active = 1").get(customConcurrency.id).path, "artifacts/result-v2.md");

const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-workflow-state-"));
try {
  const stateRepository = new WorkflowRepository(new DatabaseSync(":memory:"));
  const stateFiles = new WorkflowStateFiles();
  const stateRun = stateRepository.create({ ownerUserId: "user-state", workspaceId: "workspace-state", workDirectory: stateRoot, prompt: "验证三文件协议与增量复用", plannerEngine: "claude" });
  stateFiles.sync(stateRun);
  stateFiles.appendEvent(stateRun, { type: "workflow.created", payload: { source: "test" } });
  assert.deepEqual((await fs.readdir(path.join(stateRoot, ".workflow"))).sort(), ["events.jsonl", "results.json", "workflow.json"]);
  assert.match(await fs.readFile(path.join(stateRoot, ".workflow", "events.jsonl"), "utf8"), /workflow\.created/);

  stateRepository.setPlanning(stateRun.id, "user-state", stateRun.revision);
  const statePlanned = stateRepository.savePlan(stateRun.id, "user-state", validPlan);
  const stateApproved = stateRepository.approve(stateRun.id, "user-state", statePlanned.revision);
  for (const node of stateApproved.nodes) {
    node.status = "completed";
    node.summary = normalizeWorkflowNodeResult({ outcome: "completed", humanSummary: `${node.id} 已验证`, outputs: [], changedFiles: [], checks: [], decisions: [], handoff: { facts: [node.id], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: [] });
    node.resultDigest = crypto.createHash("sha256").update(JSON.stringify({ outputs: node.summary.outputs, decisions: node.summary.decisions, handoff: node.summary.handoff, checks: node.summary.checks })).digest("hex");
    stateRepository.updateNode(node);
  }
  stateRepository.updateRun(stateRun.id, "needs_review");
  const completedV1 = stateRepository.get(stateRun.id, "user-state");
  stateFiles.sync(completedV1);
  const persistedResults = JSON.parse(await fs.readFile(path.join(stateRoot, ".workflow", "results.json"), "utf8"));
  assert.equal(persistedResults.nodes.research.result.humanSummary, "research 已验证");
  const tamperedResults = structuredClone(persistedResults);
  tamperedResults.nodes.research.result.handoff.facts = ["被篡改的下游事实"];
  await fs.writeFile(path.join(stateRoot, ".workflow", "results.json"), JSON.stringify(tamperedResults));
  assert.throws(() => stateFiles.syncResults(completedV1), /哈希不一致/, "同一数据库修订下不得静默覆盖被篡改的机器结果");
  await fs.writeFile(path.join(stateRoot, ".workflow", "results.json"), JSON.stringify(persistedResults));
  assert.deepEqual(calculateWorkflowPlanImpact(completedV1, validPlan), { reused: ["research", "implement"], rerun: [], added: [], removed: [], requiresIntegration: false });
  const deliveryOnlyChange = normalizeWorkflowPlan({ ...validPlan, finalDelivery: { ...validPlan.finalDelivery, reason: "更新后的控制任务交付说明" } });
  assert.deepEqual(calculateWorkflowPlanImpact(completedV1, deliveryOnlyChange), { reused: ["research", "implement"], rerun: [], added: [], removed: [], requiresIntegration: true }, "只修改最终交付合同也必须重新整合");

  stateRepository.setPlanning(stateRun.id, "user-state", completedV1.revision);
  const statePlannedV2 = stateRepository.savePlan(stateRun.id, "user-state", validPlan);
  const stateApprovedV2 = stateRepository.approve(stateRun.id, "user-state", statePlannedV2.revision);
  assert.deepEqual(stateApprovedV2.nodes.map((node) => node.status), ["completed", "completed"], "合同未变化的节点应复用已验证结果");

  stateRepository.updateRun(stateRun.id, "needs_review");
  const beforeChangedPlan = stateRepository.get(stateRun.id, "user-state");
  const changedPlan = normalizeWorkflowPlan({ ...validPlan, nodes: validPlan.nodes.map((node) => node.id === "research" ? { ...node, objective: "重新研究并补充证据" } : node) });
  const impact = calculateWorkflowPlanImpact(beforeChangedPlan, changedPlan);
  assert.deepEqual(impact.reused, []);
  assert.deepEqual(impact.rerun, ["research", "implement"]);
  stateRepository.setPlanning(stateRun.id, "user-state", beforeChangedPlan.revision);
  const changedPlanned = stateRepository.savePlan(stateRun.id, "user-state", changedPlan);
  const changedApproved = stateRepository.approve(stateRun.id, "user-state", changedPlanned.revision);
  assert.deepEqual(changedApproved.nodes.map((node) => node.status), ["pending", "pending"], "变更节点及其依赖闭包不得复用");

  const repairAttemptRoot = path.join(stateRoot, ".workflow", "nodes", "research", "attempts");
  const claimedForRepair = stateRepository.claimNodeAttempt(changedApproved.nodes[0].recordId, "repair-runner", repairAttemptRoot, new Date(Date.now() + 60_000).toISOString());
  stateRepository.checkpointNodeAttempt(claimedForRepair.id, { phase: "agent_output_received", status: "failed", rawOutput: "{ malformed result", error: "结果 JSON 无效", leaseExpiresAt: null, finishedAt: new Date().toISOString() });
  const failedForRepair = stateRepository.get(stateRun.id, "user-state").nodes[0];
  failedForRepair.status = "failed";
  failedForRepair.error = "结果 JSON 无效";
  stateRepository.updateNode(failedForRepair);
  stateRepository.updateRun(stateRun.id, "needs_review");
  const queuedRepair = stateRepository.prepareResultRepair(stateRun.id, "user-state", "research");
  assert.equal(queuedRepair.status, "queued");
  assert.equal(queuedRepair.nodes[0].status, "interrupted");
  const resumedRepair = stateRepository.claimNodeAttempt(queuedRepair.nodes[0].recordId, "repair-runner-2", repairAttemptRoot, new Date(Date.now() + 60_000).toISOString());
  assert.equal(resumedRepair.id, claimedForRepair.id, "结果修复必须复用已有 Agent 尝试");
  assert.equal(resumedRepair.phase, "agent_output_received");
  assert.equal(resumedRepair.rawOutput, "{ malformed result");

  const historicalRoot = path.join(stateRoot, "historical-result-recovery");
  await fs.mkdir(historicalRoot, { recursive: true });
  const historicalRun = stateRepository.create({ ownerUserId: "user-state", workspaceId: "workspace-state", workDirectory: historicalRoot, prompt: "验证历史已提交结果恢复", plannerEngine: "codex" });
  stateRepository.setPlanning(historicalRun.id, "user-state", historicalRun.revision);
  const historicalPlanned = stateRepository.savePlan(historicalRun.id, "user-state", validPlan);
  const historicalApproved = stateRepository.approve(historicalRun.id, "user-state", historicalPlanned.revision);
  const historicalAttemptRoot = path.join(historicalRoot, ".workflow", "nodes", "research", "attempts");
  const successfulAttempt = stateRepository.claimNodeAttempt(historicalApproved.nodes[0].recordId, "historical-runner-1", historicalAttemptRoot, new Date(Date.now() + 60_000).toISOString());
  await fs.mkdir(successfulAttempt.checkpointDirectory, { recursive: true });
  await fs.writeFile(path.join(successfulAttempt.checkpointDirectory, "before-snapshot.json"), JSON.stringify([["existing.txt", "hash-before"]]));
  const historicalResult = normalizeWorkflowNodeResult({ outcome: "completed", humanSummary: "历史业务结果完整", outputs: [], changedFiles: [], checks: [], decisions: [], handoff: { facts: ["已完成"], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: [] });
  await fs.writeFile(path.join(successfulAttempt.checkpointDirectory, "result-transaction.json"), JSON.stringify({ status: "committed", draftResult: historicalResult }));
  stateRepository.checkpointNodeAttempt(successfulAttempt.id, { phase: "result_committed", status: "failed", parsedResult: historicalResult, verifiedResult: historicalResult, error: "执行后快照失败", finishedAt: new Date().toISOString(), leaseExpiresAt: null });
  const historicalFailedNode = stateRepository.get(historicalRun.id, "user-state").nodes[0];
  historicalFailedNode.status = "failed";
  historicalFailedNode.error = "执行后快照失败";
  stateRepository.updateNode(historicalFailedNode);
  stateRepository.updateRun(historicalRun.id, "needs_review");
  const historicalRetried = stateRepository.retryNodes(historicalRun.id, "user-state", ["research"]);
  const emptyAttempt = stateRepository.claimNodeAttempt(historicalRetried.nodes[0].recordId, "historical-runner-2", historicalAttemptRoot, new Date(Date.now() + 60_000).toISOString());
  assert.equal(emptyAttempt.attempt, 2);
  stateRepository.checkpointNodeAttempt(emptyAttempt.id, { phase: "claimed", status: "failed", error: "执行前快照失败", finishedAt: new Date().toISOString(), leaseExpiresAt: null });
  const emptyFailedNode = stateRepository.get(historicalRun.id, "user-state").nodes[0];
  emptyFailedNode.status = "failed";
  emptyFailedNode.error = "执行前快照失败";
  stateRepository.updateNode(emptyFailedNode);
  stateRepository.updateRun(historicalRun.id, "needs_review");
  const historicalQueued = stateRepository.prepareResultRepair(historicalRun.id, "user-state", "research");
  assert.equal(historicalQueued.nodes[0].status, "interrupted");
  const recoveredHistoricalAttempt = stateRepository.claimNodeAttempt(historicalQueued.nodes[0].recordId, "historical-runner-3", historicalAttemptRoot, new Date(Date.now() + 60_000).toISOString());
  assert.equal(recoveredHistoricalAttempt.id, emptyAttempt.id, "空失败尝试应复用最近一次 attempt，不创建新的业务执行");
  assert.equal(recoveredHistoricalAttempt.attempt, 2);
  assert.equal(recoveredHistoricalAttempt.phase, "result_candidate_committed");
  assert.equal(recoveredHistoricalAttempt.parsedResult?.humanSummary, "历史业务结果完整");
  assert.equal(await fs.readFile(path.join(emptyAttempt.checkpointDirectory, "before-snapshot.json"), "utf8"), JSON.stringify([["existing.txt", "hash-before"]]));
} finally {
  await fs.rm(stateRoot, { recursive: true, force: true });
}
const integrationRun = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证最终整合", plannerEngine: "codex" });
repository.beginIntegration(integrationRun.id);
repository.appendIntegrationLog(integrationRun.id, { id: "integration-log-1", createdAt: new Date().toISOString(), kind: "status", title: "开始最终整合", text: "读取节点结果" });
const integrating = repository.get(integrationRun.id, "user-a");
assert.equal(integrating.status, "integrating");
assert.equal(integrating.integrationLogs.length, 1);
assert.ok(integrating.integrationStartedAt);
const finalResult = normalizeWorkflowNodeResult({ outcome: "completed", humanSummary: "最终验收通过", outputs: [], changedFiles: [], checks: [], decisions: [], handoff: { facts: [], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: [] });
repository.checkpointIntegration(integrationRun.id, "integrator_completed", { integratorResult: finalResult });
repository.prepareIntegrationRetry(integrationRun.id, "user-a");
const integratorResumed = repository.get(integrationRun.id, "user-a");
assert.equal(integratorResumed.integrationPhase, "integrator_completed");
assert.equal(integratorResumed.integratorResult.humanSummary, "最终验收通过");
repository.beginIntegration(integrationRun.id);
repository.checkpointIntegration(integrationRun.id, "validator_completed", { validatorResult: finalResult });
repository.prepareIntegrationRetry(integrationRun.id, "user-a");
const validatorResumed = repository.get(integrationRun.id, "user-a");
assert.equal(validatorResumed.integrationPhase, "validator_completed");
assert.equal(validatorResumed.validatorResult.outcome, "completed");
repository.finishIntegration(integrationRun.id, "completed", finalResult);
const integrated = repository.get(integrationRun.id, "user-a");
assert.equal(integrated.status, "completed");
assert.equal(integrated.finalResult.outcome, "completed");
assert.ok(integrated.integrationFinishedAt);
const interruptedIntegration = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证整合恢复", plannerEngine: "claude" });
repository.beginIntegration(interruptedIntegration.id);
assert.ok(repository.recoverAfterRestart().some((item) => item.id === interruptedIntegration.id));
assert.equal(repository.get(interruptedIntegration.id, "user-a").status, "queued");

const integrationPauseRun = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证整合暂停", plannerEngine: "claude" });
repository.beginIntegration(integrationPauseRun.id);
const integrationPaused = repository.pause(integrationPauseRun.id, "user-a", repository.get(integrationPauseRun.id, "user-a").revision);
assert.equal(integrationPaused.pausedFromStatus, "integrating");
const integrationResumed = repository.resume(integrationPauseRun.id, "user-a", integrationPaused.revision);
assert.equal(integrationResumed.status, "queued");
assert.ok(integrationResumed.integrationStartedAt, "恢复整合必须保留整合检查点");

const cancelRun = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证全局终止", plannerEngine: "codex" });
repository.setPlanning(cancelRun.id, "user-a", cancelRun.revision);
const cancelPlanned = repository.savePlan(cancelRun.id, "user-a", validPlan);
const cancelApproved = repository.approve(cancelRun.id, "user-a", cancelPlanned.revision);
cancelApproved.nodes[0].status = "completed";
repository.updateNode(cancelApproved.nodes[0]);
const globallyCanceled = repository.cancel(cancelRun.id, "user-a", repository.get(cancelRun.id, "user-a").revision);
assert.equal(globallyCanceled.status, "canceled");
assert.equal(globallyCanceled.nodes[0].status, "completed", "全局终止必须保留已完成节点");
assert.equal(globallyCanceled.nodes[1].status, "canceled");
assert.throws(() => repository.restartNode(cancelRun.id, "user-a", globallyCanceled.nodes[1].id), /已终止的工作流/, "全局终止不能被单节点重跑复活");

const persistenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-workflow-controls-"));
const persistenceDbPath = path.join(persistenceRoot, "controls.db");
try {
  const persistenceDb = new DatabaseSync(persistenceDbPath);
  const persistenceRepository = new WorkflowRepository(persistenceDb);
  const persistentRun = persistenceRepository.create({ ownerUserId: "persist-user", workspaceId: "persist-workspace", prompt: "验证暂停状态持久化", plannerEngine: "claude" });
  persistenceRepository.setPlanning(persistentRun.id, "persist-user", persistentRun.revision);
  const persistedPause = persistenceRepository.pause(persistentRun.id, "persist-user", persistenceRepository.get(persistentRun.id, "persist-user").revision, { mode: "fresh", maintenance: true });
  persistenceDb.close();
  const reopenedDb = new DatabaseSync(persistenceDbPath);
  const reopened = new WorkflowRepository(reopenedDb).get(persistentRun.id, "persist-user");
  assert.equal(reopened.status, "paused");
  assert.equal(reopened.pausedFromStatus, "planning");
  assert.equal(reopened.pausedPlanningMode, "fresh");
  assert.equal(reopened.pausedPlanningMaintenance, true);
  reopenedDb.close();
} finally { await fs.rm(persistenceRoot, { recursive: true, force: true }); }

const maintenancePauseRun = repository.create({ ownerUserId: "user-a", workspaceId: "workspace-a", prompt: "验证维护规划暂停", plannerEngine: "claude" });
repository.setPlanning(maintenancePauseRun.id, "user-a", maintenancePauseRun.revision);
const maintenancePausePlanned = repository.savePlan(maintenancePauseRun.id, "user-a", validPlan);
repository.startMaintenance(maintenancePauseRun.id, "user-a", { id: "maintenance-pause", createdAt: new Date().toISOString(), kind: "status", title: "维护规划", text: "调整计划" }, "调整计划");
const maintenancePaused = repository.pause(maintenancePauseRun.id, "user-a", repository.get(maintenancePauseRun.id, "user-a").revision, { mode: "refine", maintenance: true });
assert.equal(maintenancePaused.pausedFromStatus, "awaiting_approval");
const maintenanceResumed = repository.resume(maintenancePauseRun.id, "user-a", maintenancePaused.revision);
assert.equal(maintenanceResumed.status, "awaiting_approval", "维护规划恢复时必须保留原业务状态");
assert.equal(maintenancePausePlanned.activePlanVersion, maintenanceResumed.activePlanVersion);

assert.match(serverSource, /workbench-workflow-result 与 workbench-workflow-plan 是 Workbench 系统控制面/, "Validator 必须区分系统控制面 MCP 与业务 MCP");
assert.match(serverSource, /不要扫描 \.workflow\/events\.jsonl/, "Validator 不得默认重扫完整事件日志");
assert.match(serverSource, /最多执行一次合并的只读验收命令/, "Validator 必须限制重复验收命令");
assert.match(serverSource, /省略 workdir\/cwd 参数，或只使用相对目录“\.”/, "执行 Agent 不得复制超长绝对工作目录到工具调用");
assert.match(serverSource, /执行结果路径越出任务目录/, "节点产物必须由任务目录边界校验");
assert.match(serverSource, /slice\(0, 48\)\.replace\(\/\[ \.\]\+\$\/g, ""\)/, "Windows 工作流目录截断后不得保留尾随空格或点");
console.log("workflow plan validation and approval gate OK");
