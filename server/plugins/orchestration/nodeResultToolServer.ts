#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  commitWorkflowNodeResultTransaction,
  readWorkflowNodeResultTransaction,
  recordWorkflowNodeSelfReview,
  registerWorkflowNodeChecks,
  registerWorkflowNodeOutputs,
  reportWorkflowNodeBlocked,
  setWorkflowNodeHandoff,
  setWorkflowNodeOutcome,
  setWorkflowNodeResultSummary,
  validateWorkflowNodeResultTransaction,
  WORKFLOW_NODE_SELF_REVIEW_KEYS
} from "./nodeResultTransactions.js";

const transactionPath = process.env.WORKFLOW_NODE_RESULT_TRANSACTION_PATH || "";
if (!transactionPath) throw new Error("WORKFLOW_NODE_RESULT_TRANSACTION_PATH 未配置");

const server = new McpServer({ name: "workbench-workflow-result", version: "1.0.0" });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const strings = z.array(z.string());

server.registerTool("workflow_read_node_contract", {
  description: "读取当前节点任务合同、事务身份、已有结果草稿和校验状态。开始工作和恢复工作时必须调用。",
  inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async () => result(readWorkflowNodeResultTransaction(transactionPath)));

server.registerTool("workflow_read_result_draft", {
  description: "重新读取当前机器结果草稿。工具调用失败、恢复或提交前应调用，避免覆盖已经登记的内容。",
  inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async () => result(readWorkflowNodeResultTransaction(transactionPath)));

server.registerTool("workflow_set_result_summary", {
  description: "登记面向用户的摘要、决策、警告和未解决事项。可重复调用，后一次替换这些字段。",
  inputSchema: {
    humanSummary: z.string().min(1),
    decisions: z.array(z.object({ key: z.string().min(1), value: z.string().min(1), reason: z.string().min(1) })).optional(),
    warnings: strings.optional(), unresolved: strings.optional()
  }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async (input) => result(setWorkflowNodeResultSummary(transactionPath, input)));

server.registerTool("workflow_register_outputs", {
  description: "按稳定 ID 分批登记真实输出。相同 ID 会更新，建议每次登记 1 至 4 项，禁止登记尚未创建的文件。",
  inputSchema: { outputs: z.array(z.object({
    id: z.string().min(1), type: z.enum(["file", "directory", "document", "data", "code", "text", "decision", "other"]),
    path: z.string().nullable(), mediaType: z.string().nullable(), description: z.string().min(1), consumableBy: strings
  })).min(1) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async ({ outputs }) => result(registerWorkflowNodeOutputs(transactionPath, outputs)));

server.registerTool("workflow_register_checks", {
  description: "分批登记实际执行的检查及证据。相同检查名称会更新；未执行不得声称 passed。",
  inputSchema: { checks: z.array(z.object({
    name: z.string().min(1), command: z.string().nullable(), status: z.enum(["passed", "failed", "not_run"]), exitCode: z.number().int().nullable(), evidence: z.string()
  })).min(1) }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async ({ checks }) => result(registerWorkflowNodeChecks(transactionPath, checks)));

server.registerTool("workflow_set_handoff", {
  description: "登记供下游 Agent 消费的事实、约束和使用说明。只登记已证实内容。",
  inputSchema: { facts: strings, constraints: strings, nextAgentInstructions: strings },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async (handoff) => result(setWorkflowNodeHandoff(transactionPath, handoff)));

server.registerTool("workflow_set_outcome", {
  description: "设置执行 Agent 建议的结果状态。正式状态仍由 Workbench 根据文件与系统验收决定。",
  inputSchema: { outcome: z.enum(["completed", "partial", "blocked", "failed"]) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async ({ outcome }) => result(setWorkflowNodeOutcome(transactionPath, outcome)));

server.registerTool("workflow_report_blocked", {
  description: "缺少输入、权限、Skill、MCP 或必需产物时登记 blocked，不要猜测或伪造结果。",
  inputSchema: { humanSummary: z.string().min(1), reasons: z.array(z.string().min(1)).min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async (input) => result(reportWorkflowNodeBlocked(transactionPath, input)));

server.registerTool("workflow_self_review_result", {
  description: "提交前以独立审查者视角审查最新版结果草稿。必须覆盖目标、边界、真实产物、验收证据、下游职责和终态一致性；发现问题先修正完整草稿，再重新调用本工具。",
  inputSchema: {
    status: z.enum(["passed", "revised"]),
    checks: z.array(z.object({
      key: z.enum(WORKFLOW_NODE_SELF_REVIEW_KEYS),
      status: z.enum(["passed", "revised"]),
      note: z.string().min(1)
    })).length(WORKFLOW_NODE_SELF_REVIEW_KEYS.length),
    changes: strings.optional()
  }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async (input) => result(recordWorkflowNodeSelfReview(transactionPath, input)));

server.registerTool("workflow_validate_result", {
  description: "校验完整机器结果草稿、节点自审、输出 ID、下游消费者和状态一致性。自审后必须立即校验；若草稿又有修改，需重新自审。",
  inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async () => result(validateWorkflowNodeResultTransaction(transactionPath)));

server.registerTool("workflow_commit_result", {
  description: "封存已校验的候选结果。正式节点结果仍由 Workbench 服务端复核文件、范围和验收后提交。",
  inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async () => result(commitWorkflowNodeResultTransaction(transactionPath)));

await server.connect(new StdioServerTransport());
