#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  applyWorkflowPlanOperations,
  commitWorkflowPlanTransaction,
  finishWorkflowPlanTransactionWithoutChange,
  readWorkflowPlanTransaction,
  replaceWorkflowPlanDraft,
  validateWorkflowPlanTransaction,
  type WorkflowPlanEditOperation
} from "./plannerTransactions.js";

const transactionPath = process.env.WORKFLOW_PLANNER_TRANSACTION_PATH || "";
if (!transactionPath) throw new Error("WORKFLOW_PLANNER_TRANSACTION_PATH 未配置");

const server = new McpServer({ name: "workbench-workflow-planner", version: "1.0.0" });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const mutationResult = (transaction: ReturnType<typeof readWorkflowPlanTransaction>, appliedOperations?: number) => result({
  ok: true,
  status: transaction.status,
  revision: transaction.operations.length,
  appliedOperations,
  nodeCount: transaction.draftPlan.nodes.length,
  validationErrors: transaction.validationErrors
});
const validationResult = (validation: ReturnType<typeof validateWorkflowPlanTransaction>) => result({
  valid: validation.valid,
  errors: validation.errors,
  digest: validation.digest,
  nodeCount: validation.plan.nodes.length
});
// Keep the MCP schema explicit. An unconstrained `record<string, unknown>` is
// advertised as an object with no usable properties by the Claude CLI, which
// makes it prone to serializing the whole value as a JSON string.
const stringList = z.array(z.string());
const providerSchema = z.string().regex(/^(?:auto|[a-z][a-z0-9._-]{0,63})$/);
const auditCheckSchema = z.object({
  key: z.string(),
  status: z.enum(["passed", "revised", "warning"]),
  note: z.string()
});
const auditSchema = z.object({
  status: z.enum(["passed", "revised", "needs_input"]),
  checks: z.array(auditCheckSchema),
  changes: stringList
});
const finalDeliverySchema = z.object({
  required: z.boolean(),
  directory: z.string(),
  primary: z.string().nullable(),
  format: z.string(),
  additional: stringList,
  producerNodeId: z.string().nullable(),
  reason: z.string()
});
const nodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string(),
  nonGoals: stringList,
  constraints: stringList,
  dependsOn: stringList,
  provider: providerSchema,
  providerReason: z.string(),
  skills: stringList,
  mcpServers: stringList,
  mcpRequired: z.boolean(),
  workspaceAccess: z.enum(["read", "write"]),
  writeScope: stringList,
  requiredArtifacts: stringList,
  deliverables: stringList,
  acceptance: stringList,
  verificationCommands: stringList,
  failurePolicy: z.enum(["retry_then_review", "review"]),
  required: z.boolean()
});
const planSchema = z.object({
  planSchemaVersion: z.number().int(),
  title: z.string(),
  summary: z.string(),
  assumptions: stringList,
  questions: stringList,
  risks: stringList,
  finalDelivery: finalDeliverySchema,
  audit: auditSchema,
  nodes: z.array(nodeSchema)
});
const planFieldSchema = z.object({
  planSchemaVersion: z.number().int().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  assumptions: stringList.optional(),
  questions: stringList.optional(),
  risks: stringList.optional(),
  finalDelivery: finalDeliverySchema.optional(),
  audit: auditSchema.optional()
});
const nodeFieldSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  objective: z.string().optional(),
  nonGoals: stringList.optional(),
  constraints: stringList.optional(),
  dependsOn: stringList.optional(),
  provider: providerSchema.optional(),
  providerReason: z.string().optional(),
  skills: stringList.optional(),
  mcpServers: stringList.optional(),
  mcpRequired: z.boolean().optional(),
  workspaceAccess: z.enum(["read", "write"]).optional(),
  writeScope: stringList.optional(),
  requiredArtifacts: stringList.optional(),
  deliverables: stringList.optional(),
  acceptance: stringList.optional(),
  verificationCommands: stringList.optional(),
  failurePolicy: z.enum(["retry_then_review", "review"]).optional(),
  required: z.boolean().optional()
});
const operationFieldsSchema = z.object({
  planSchemaVersion: z.number().int().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  assumptions: stringList.optional(),
  questions: stringList.optional(),
  risks: stringList.optional(),
  finalDelivery: finalDeliverySchema.optional(),
  audit: auditSchema.optional(),
  id: z.string().optional(),
  objective: z.string().optional(),
  nonGoals: stringList.optional(),
  constraints: stringList.optional(),
  dependsOn: stringList.optional(),
  provider: providerSchema.optional(),
  providerReason: z.string().optional(),
  skills: stringList.optional(),
  mcpServers: stringList.optional(),
  mcpRequired: z.boolean().optional(),
  workspaceAccess: z.enum(["read", "write"]).optional(),
  writeScope: stringList.optional(),
  requiredArtifacts: stringList.optional(),
  deliverables: stringList.optional(),
  acceptance: stringList.optional(),
  verificationCommands: stringList.optional(),
  failurePolicy: z.enum(["retry_then_review", "review"]).optional(),
  required: z.boolean().optional()
});

server.registerTool("workflow_read_plan", {
  description: "读取当前规划事务中的完整草稿、版本和校验状态。修改前必须调用。",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async () => result(readWorkflowPlanTransaction(transactionPath)));

server.registerTool("workflow_replace_plan", {
  description: "由工作台预授权，用一份完整计划替换隔离事务草稿。只适合小型计划的首次规划、全新重做或大范围结构调整；大型计划必须改用 workflow_apply_operations 每批写入 2 至 4 个节点，避免参数截断。不会修改正式计划或工作区业务文件。",
  inputSchema: { plan: planSchema },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async ({ plan }) => mutationResult(replaceWorkflowPlanDraft(transactionPath, plan)));

server.registerTool("workflow_apply_operations", {
  description: "由工作台预授权，通过稳定节点 ID 分批修改隔离事务草稿。大型计划每次建议写入 2 至 4 个节点；调用失败后先读取现有草稿再续写。不会修改正式计划或工作区业务文件。",
  inputSchema: {
    operations: z.array(z.object({
      type: z.enum(["set_plan_fields", "upsert_node", "update_node", "remove_node", "set_dependencies"]),
      nodeId: z.string().optional(),
      fields: operationFieldsSchema.optional(),
      node: nodeSchema.optional(),
      dependsOn: z.array(z.string()).optional()
    })).min(1)
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false }
}, async ({ operations }) => mutationResult(applyWorkflowPlanOperations(transactionPath, operations as WorkflowPlanEditOperation[]), operations.length));

server.registerTool("workflow_validate_draft", {
  description: "对完整草稿执行依赖闭包、循环、模型、Skill、MCP、写入范围和验收契约校验。提交前必须通过。",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async () => validationResult(validateWorkflowPlanTransaction(transactionPath)));

server.registerTool("workflow_commit_candidate", {
  description: "由工作台预授权，校验并提交隔离事务中的候选计划。这里只封存候选草稿；正式计划仍由工作台服务端复核后原子保存。",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async () => mutationResult(commitWorkflowPlanTransaction(transactionPath)));

server.registerTool("workflow_no_change", {
  description: "用户只是问候、询问或没有提出明确规划修改时调用。不会生成新计划版本。",
  inputSchema: { reason: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async ({ reason }) => mutationResult(finishWorkflowPlanTransactionWithoutChange(transactionPath, reason)));

const transport = new StdioServerTransport();
await server.connect(transport);
