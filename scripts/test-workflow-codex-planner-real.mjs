import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Codex } from "@openai/codex-sdk";
import { resolveWorkbenchPaths } from "../dist-server/appPaths.js";
import { SecretVault } from "../dist-server/secretVault.js";
import { createWorkflowPlanTransaction, readWorkflowPlanTransaction } from "../dist-server/workflows/plannerTransactions.js";

const root = process.cwd();
const paths = resolveWorkbenchPaths(root);
const db = new DatabaseSync(path.join(paths.dataDir, "workbench-state.db"), { readOnly: true });
const settings = JSON.parse(db.prepare("SELECT json FROM settings WHERE id = 1").get().json);
db.close();
settings.apiKey = new SecretVault(paths.secretsFile).load().codexApiKey;
assert.ok(settings.apiKey, "Codex API Key 未配置");

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-codex-planner-real-"));
const transactionPath = path.join(temp, "transaction.json");
try {
  createWorkflowPlanTransaction(transactionPath, {
    workflowId: "workflow-codex-real-test", mode: "refine", baseRevision: 1, basePlanVersion: 1,
    previousPlan: {
      planSchemaVersion: 2, title: "权限链测试", summary: "只验证工具调用", assumptions: [], questions: [], risks: [],
      audit: { status: "passed", checks: [
        { key: "dependency-minimality", status: "passed", note: "单节点没有冗余依赖" },
        { key: "critical-path", status: "passed", note: "单节点关键路径" },
        { key: "concurrency-utilization", status: "passed", note: "单节点无需并发" },
        { key: "read-write-consistency", status: "passed", note: "只读节点没有冲突" },
        { key: "provider-allocation", status: "passed", note: "语义检查使用 Claude" },
        { key: "final-delivery", status: "passed", note: "本测试仅交付已提交的规划事务" }
      ], changes: [] },
      nodes: [{
        id: "verify", title: "验证权限链", objective: "保留一个合法节点以验证事务提交", nonGoals: ["不修改文件"], constraints: ["只验证协议"],
        dependsOn: [], provider: "claude", providerReason: "只需语义确认", skills: [], mcpServers: [], mcpRequired: false,
        workspaceAccess: "read", writeScope: [], requiredArtifacts: [], deliverables: [], acceptance: ["事务提交成功"], verificationCommands: [], failurePolicy: "stop", required: true
      }]
    },
    availableSkills: [], availableMcpServers: [], providerCapabilities: { claudeAvailable: true, codexAvailable: true }
  });
  const normalizedBase = String(settings.baseUrl || "https://api.openai.com").trim().replace(/\/+$/, "").replace(/\/(?:models|responses|chat\/completions)$/i, "");
  const baseUrl = /\/v1$/i.test(normalizedBase) ? normalizedBase : `${normalizedBase}/v1`;
  const codex = new Codex({
    apiKey: settings.apiKey,
    env: { ...process.env, CODEX_API_KEY: settings.apiKey, OPENAI_API_KEY: settings.apiKey },
    config: {
      model_provider: "modelx",
      model_providers: { modelx: { name: "ModelX API", base_url: baseUrl, env_key: "OPENAI_API_KEY", wire_api: "responses", supports_websockets: false } },
      features: { multi_agent: false },
      mcp_servers: {
        "workbench-workflow-plan": {
          command: process.execPath,
          args: [path.join(root, "dist-server", "workflows", "plannerToolServer.js")],
          env: { WORKFLOW_PLANNER_TRANSACTION_PATH: transactionPath },
          enabled: true, required: true, startup_timeout_sec: 30, tool_timeout_sec: 60
        }
      }
    }
  });
  const thread = codex.startThread({ workingDirectory: temp, skipGitRepoCheck: true, model: settings.model || undefined, modelReasoningEffort: settings.reasoningEffort, sandboxMode: "workspace-write", approvalPolicy: "never", networkAccessEnabled: false });
  const { events } = await thread.runStreamed("这是内部规划写入权限链测试。必须先调用 workflow_read_plan，然后调用 workflow_apply_operations，只用 set_plan_fields 将 title 改为‘Codex 写入权限链通过’；接着调用 workflow_validate_draft，校验通过后调用 workflow_commit_candidate。不要调用其他工具。");
  const diagnostics = [];
  for await (const event of events) {
    if (event.type.startsWith("item.")) diagnostics.push({ event: event.type, type: event.item?.type, status: event.item?.status, error: event.item?.error, tool: event.item?.tool, server: event.item?.server, text: String(event.item?.text || "").slice(0, 500), result: JSON.stringify(event.item?.result || null).slice(0, 500) });
    if (event.type === "turn.failed" || event.type === "error") throw new Error(JSON.stringify(event));
  }
  const finalStatus = readWorkflowPlanTransaction(transactionPath).status;
  if (finalStatus !== "committed") console.error(JSON.stringify(diagnostics, null, 2));
  const finalTransaction = readWorkflowPlanTransaction(transactionPath);
  assert.equal(finalStatus, "committed", "Codex 没有完成规划事务写入、校验和提交链");
  assert.equal(finalTransaction.draftPlan.title, "Codex 写入权限链通过");
  console.log("Codex planner MCP write authorization chain OK");
} finally {
  await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
}
