import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmationProvider } from "/src/components/ConfirmationProvider";
import { HelpProvider } from "/src/help/HelpProvider";
import { WorkflowWorkbench } from "/src/workflow/WorkflowWorkbench";
import { CompactWorkflowProgress, TaskModeBar } from "/src/workflow/TaskModeBar";
import type { AgentProviderDescriptor } from "/src/agents/types";
import "/src/styles.css";
import "/src/design/tokens.css";
import "/src/design/shell.css";
import "/src/design/conversation.css";
import "/src/design/features.css";
import "/src/design/workflow.css";

const scenario = new URLSearchParams(location.search).get("scenario") || "running";
const isWorktree = scenario.startsWith("worktree");
const now = "2026-10-08T12:00:00.000Z";
const workspaceId = "visual-workspace";
const providers = ["codex", "claude"].map((id, index) => ({
  id, adapterId: id, runtimeId: id, displayName: id === "codex" ? "Codex" : "Claude", shortName: id === "codex" ? "Codex" : "Claude",
  description: "", displayOrder: index, branding: { icon: id, accent: "#35654b" },
  skillProjection: { strategy: "native", invocationPrefix: "" },
  capabilities: {
    sessions: { create: true, resume: true, fork: true }, execution: { stream: true, cancel: true, steer: true },
    workspace: { read: true, write: true }, tools: { shell: true, web: true, mcp: true },
    delegation: { worker: true, nativeSubagents: true }, workflow: { planner: true, worker: true },
    configuration: { models: true, reasoningEffort: true, reasoningEffortValues: [], permissionProfile: true }
  }
})) satisfies AgentProviderDescriptor[];
const runtime = { codex: { available: true }, claude: { available: true }, providers: { codex: { available: true }, claude: { available: true } } };
const result = {
  outcome: "completed", humanSummary: "研究已完成，接口实现与回归检查通过。", outputs: [], changedFiles: ["src/api.ts"],
  checks: [{ name: "回归测试", command: "npm test", status: "passed", exitCode: 0, evidence: "12 tests passed" }],
  decisions: [], handoff: { facts: ["沿用现有 API 合同"], constraints: [], nextAgentInstructions: [] }, warnings: [], unresolved: [], machineResultPath: null
};
const planNodes = [
  { id: "research", title: "项目结构研究", objective: "检查 payments 的现有接口与错误处理", nonGoals: [], constraints: [], dependsOn: [], provider: "claude", providerReason: "梳理现有业务与兼容约束", skills: [], mcpServers: [], mcpRequired: false, workspaceAccess: "read", writeScope: [], requiredArtifacts: [], deliverables: ["研究摘要"], acceptance: ["明确接口边界"], verificationCommands: [] },
  { id: "implement", title: "实现与回归验证", objective: "更新 payments 接口并验证兼容性", nonGoals: [], constraints: [], dependsOn: ["research"], provider: "codex", providerReason: "实现代码并运行回归验证", skills: [], mcpServers: [], mcpRequired: false, workspaceAccess: "write", writeScope: ["src/payments/**", "tests/payments/**"], requiredArtifacts: [], deliverables: ["兼容接口"], acceptance: ["现有测试通过"], verificationCommands: ["npm test"] }
];
const plan = {
  title: "支付接口维护", summary: "保留现有接口合同，先检查现有实现，再进行代码与测试更新。", assumptions: [], questions: [], risks: [],
  finalDelivery: { required: false, directory: "", primary: null, format: "", additional: [], producerNodeId: null, reason: "直接修改现有项目" },
  audit: { status: "passed", checks: [{ key: "write-scope", status: "passed", note: "写入范围已限制在支付模块和对应测试" }], changes: [] }, nodes: planNodes
};
const workflow: any = {
  id: `visual-${scenario}`, workDirectory: "/project", executionRoot: "/project", workspaceRoot: "/project", executionTarget: isWorktree ? "worktree" : "workspace",
  worktreeId: isWorktree ? "visual-worktree" : null, originId: "visual-origin", parentWorkflowId: null, branchIndex: 0, branchLabel: "方案 A",
  title: "支付接口维护", originalPrompt: "维护 payments 接口，保留现有合同并补充回归测试。", plannerEngine: "codex", maxConcurrentAgents: 3,
  status: scenario === "candidate" ? "awaiting_approval" : isWorktree ? "completed" : "running",
  pausedFromStatus: null, pausedPlanningMode: null, pausedPlanningMaintenance: false, pauseMode: null, pendingMaintenance: null,
  revision: 8, activePlanVersion: scenario === "candidate" ? 2 : 1, reviewNote: null,
  plannerLogs: [{ id: "planner-log", createdAt: now, kind: "message", title: "计划已生成", text: "先保留研究，再维护接口与对应回归测试。" }],
  plannerStartedAt: now, plannerFinishedAt: now,
  integrationLogs: isWorktree ? [{ id: "delivery-log", createdAt: now, kind: "message", title: "验收完成", text: "代码修改和回归测试已完成。" }] : [],
  integrationStartedAt: isWorktree ? now : null, integrationFinishedAt: isWorktree ? now : null,
  finalResult: isWorktree ? result : null, plan,
  nodes: planNodes.map((node, index) => ({ ...node, status: isWorktree || index === 0 ? "completed" : "running", attempt: 1, summary: isWorktree || index === 0 ? result : null,
    logs: [{ id: `${node.id}-log`, createdAt: now, kind: index === 0 ? "message" : "tool", title: index === 0 ? "研究摘要" : "执行回归测试", text: index === 0 ? "兼容接口和调用点已经确认。" : "npm test", phase: index === 0 ? "completed" : "running", category: index === 0 ? "message" : "command" }], error: null, resultRepairable: false }))
};
let maintenance: any = {
  id: "visual-maintenance", status: scenario === "candidate" ? "ready" : "idle", basePlanVersion: 1, updatedAt: now,
  messages: [{ id: "maintenance-initial", role: "assistant", text: "可以保留已完成研究，在检查点更新剩余实现范围。", createdAt: now }],
  candidatePlan: scenario === "candidate" ? plan : null,
  impact: scenario === "candidate" ? { reused: ["research"], rerun: ["implement"], added: [], removed: [], requiresIntegration: true } : null
};
let comparison = {
  workflowRevision: 8, previewDigest: "visual-preview", sourceDirty: true, targetDirty: scenario === "worktree-dirty", status: scenario === "worktree-dirty" ? "blocked" : scenario === "worktree-conflict" ? "conflicts" : "ready", conflicts: scenario === "worktree-conflict" ? ["src/payments/api.ts"] : [],
  message: scenario === "worktree-conflict" ? "方案与项目存在冲突" : "方案可整合", changedFiles: ["src/payments/api.ts", "tests/payments/api.test.ts"], untrackedFiles: ["docs/payments.md"],
  committedDiff: "diff --git a/src/payments/api.ts b/src/payments/api.ts\n+export const compatibility = true;",
  workingDiff: "diff --git a/tests/payments/api.test.ts b/tests/payments/api.test.ts\n+test('retains existing contract', () => {});",
  binding: { revision: 1, branch: "metacode/payments-a", integratedAt: null as string | null }
};
let definitions: any[] = [{ id: "visual-definition", revision: 1, name: "模块接口维护", description: "按模块研究、实现并验证现有接口。", parameters: [{ name: "module", label: "模块名称", kind: "text", required: true, defaultValue: "payments" }, { name: "scope", label: "模块路径", kind: "path", required: true, defaultValue: "src/payments" }] }];
const calls: Array<{ path: string; method: string; body: unknown }> = [];
const noticeMessages: string[] = [];
(window as any).__workflowVisual = { calls, noticeMessages, workflow, checkpoint: () => { workflow.status = "paused"; } };
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!url.pathname.startsWith("/api/")) return nativeFetch(input, options);
  const method = options.method || "GET";
  const body: any = options.body ? JSON.parse(String(options.body)) : null;
  const path = url.pathname;
  calls.push({ path, method, body });
  const response = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
  if (path === "/api/task-contexts/lookup") return response({ id: "visual-task", title: workflow.title, executions: [{ kind: "session", id: "visual-session" }, { kind: "workflow", id: workflow.id }] });
  if (path === "/api/task-contexts/visual-task/conversation") return response({ id: "visual-session" });
  if (path === "/api/workflow-definitions" && method === "GET") return response({ items: definitions });
  if (path === "/api/workflow-definitions" && method === "POST") { const saved = { id: "visual-saved", revision: 1, ...body }; definitions = [...definitions, saved]; return response(saved); }
  if (path === "/api/workflow-definitions/visual-definition/instantiate") return response({ id: "visual-instantiated" });
  if (path === `/api/workflows/${workflow.id}`) return response(workflow);
  if (path === `/api/workflows/${workflow.id}/maintenance`) return response(maintenance);
  if (path === `/api/workflows/${workflow.id}/branches`) return response([workflow]);
  if (path === `/api/workflows/${workflow.id}/artifacts`) return response({ items: [] });
  if (path === `/api/workflows/${workflow.id}/plan`) {
    if (body.source === "maintenance") {
      if (scenario !== "conversation") {
        workflow.pendingMaintenance = { note: body.note, intent: body.intent, plannerEngine: body.plannerEngine, requestedAt: now, resumeAfter: true };
        workflow.pauseMode = "checkpoint";
      }
      workflow.revision++;
      maintenance = { ...maintenance, messages: [...maintenance.messages, { id: "maintenance-user", role: "user", text: body.note, createdAt: now }] };
      return response({ accepted: true, alreadyRunning: false, queuedUntilCheckpoint: true, workflow });
    }
    return response({ accepted: true, alreadyRunning: false, workflow });
  }
  if (path === `/api/workflows/${workflow.id}/approve`) { workflow.status = "running"; workflow.revision++; return response(workflow); }
  if (path === `/api/workflows/${workflow.id}/pause`) { workflow.pauseMode = "checkpoint"; workflow.status = "paused"; workflow.revision++; return response(workflow); }
  if (path === `/api/workflows/${workflow.id}/resume`) { workflow.status = "running"; workflow.revision++; return response(workflow); }
  if (path === `/api/workflows/${workflow.id}/worktree/compare`) return response(comparison);
  if (path === `/api/workflows/${workflow.id}/worktree/integrate`) {
    if (scenario === "worktree-stale") return response({ error: "方案或项目已变化，请重新比较后整合。" }, 409);
    comparison = { ...comparison, sourceDirty: false, status: "already_up_to_date", message: "项目已包含方案成果", binding: { ...comparison.binding, revision: 2, integratedAt: now } }; return response(comparison);
  }
  return response({ error: `Unexpected fixture endpoint: ${method} ${path}` }, 404);
};

function Fixture() {
  const [workflowId, setWorkflowId] = useState(scenario === "create" ? undefined : workflow.id);
  const [conversation, setConversation] = useState(scenario === "conversation");
  const [notice, setNotice] = useState("");
  const showNotice = (message: string) => { noticeMessages.push(message); setNotice(message); };
  return <ConfirmationProvider><HelpProvider><div className="workflow-visual-shell" style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <header style={{ height: 44, display: "flex", alignItems: "center", padding: "0 14px", flexShrink: 0, borderBottom: "1px solid var(--mc-line)" }}>
      <TaskModeBar sessionId={conversation ? "visual-session" : undefined} workflowId={!conversation ? workflowId : undefined} engine="codex" enabled onConversation={() => setConversation(true)} onWorkflow={(id) => { setWorkflowId(id); setConversation(false); }} onCreateWorkflow={async (taskContextId, goal) => { calls.push({ path: "/fixture/create", method: "POST", body: { taskContextId, goal, executionTarget: "workspace" } }); }} onError={showNotice} />
    </header>
    {conversation ? <main style={{ width: "min(640px, calc(100% - 32px))", margin: "32px auto" }}><CompactWorkflowProgress workflowId={workflow.id} onOpen={() => setConversation(false)} /></main> : <div style={{ display: "flex", flex: 1, minHeight: 0 }}><WorkflowWorkbench workflowId={workflowId} workspaceId={workspaceId} defaultPlannerEngine="codex" runtime={runtime} providers={providers} onCreate={async (engine, prompt, maxConcurrentAgents, options) => { calls.push({ path: "/fixture/create", method: "POST", body: { engine, prompt, maxConcurrentAgents, ...options } }); return { id: workflow.id }; }} onOpenWorkflow={setWorkflowId} onChanged={async () => {}} onNotice={showNotice} /></div>}
    {notice && <output role="status" style={{ position: "fixed", top: 8, right: 14, maxWidth: "calc(100% - 30px)", padding: "8px 12px", border: "1px solid var(--mc-line)", borderRadius: 6, fontSize: 12, color: "var(--mc-text)", background: "var(--mc-surface)", zIndex: 30 }}>{notice}</output>}
  </div></HelpProvider></ConfirmationProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
