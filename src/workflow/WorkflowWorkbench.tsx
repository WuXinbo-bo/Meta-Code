import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { AlertTriangle, Bot, Brain, Check, ChevronDown, CircleAlert, CircleCheck, CircleMinus, Clock3, Copy, ExternalLink, FileCheck2, FileJson2, FileOutput, FolderOpen, GitBranch, Layers3, LayoutGrid, ListChecks, LoaderCircle, LocateFixed, Maximize2, PanelRightClose, Pause, Pencil, Play, Plus, RefreshCw, Route, Send, StopCircle, Wrench, X } from "lucide-react";
import { AgentConversation, useAgentOutputFollow } from "../components/AgentConversation";
import { agentStreamVersion } from "../components/activityModel";
import { ProviderIcon } from "../branding/ProviderIcon";
import { HelpButton } from "../help/HelpProvider";
import { realtimeCoordinator } from "../realtimeCoordinator";
import type { AgentProviderDescriptor } from "../agents/types";

type Engine = string;
type Log = { id: string; createdAt: string; kind: "status" | "message" | "reasoning" | "tool" | "error"; title: string; text: string; attempt?: number; runId?: string; contextId?: string | null };
type Result = {
  outcome: "completed" | "partial" | "blocked" | "failed";
  humanSummary: string;
  outputs: Array<{ id: string; type: string; path: string | null; mediaType: string | null; description: string; consumableBy: string[] }>;
  changedFiles: string[];
  checks: Array<{ name: string; command: string | null; status: "passed" | "failed" | "not_run"; exitCode: number | null; evidence: string }>;
  decisions: Array<{ key: string; value: string; reason: string }>;
  handoff: { facts: string[]; constraints: string[]; nextAgentInstructions: string[] };
  warnings: string[];
  unresolved: string[];
  machineResultPath: string | null;
};
type Node = { id: string; title: string; objective: string; nonGoals: string[]; constraints: string[]; dependsOn: string[]; provider: Engine | "auto"; providerReason: string; skills: string[]; mcpServers: string[]; mcpRequired: boolean; workspaceAccess: "read" | "write"; writeScope: string[]; requiredArtifacts: string[]; deliverables: string[]; acceptance: string[]; verificationCommands: string[]; status: string; attempt: number; summary: Result | null; logs: Log[]; error: string | null; resultRepairable: boolean };
type PlanNode = Omit<Node, "status" | "attempt" | "summary" | "logs" | "error" | "resultRepairable">;
type GraphEdge = { id: string; from: string; to: string; status: string };
type RenderedGraphEdge = GraphEdge & { path: string };
type Point = { x: number; y: number };
type NodeOffsets = Record<string, Point>;
type CanvasLayout = { version: 2; viewport: { x: number; y: number; zoom: number }; nodes: NodeOffsets };
type PlanAudit = { status: "passed" | "revised" | "needs_input"; checks: Array<{ key: string; status: "passed" | "revised" | "warning"; note: string }>; changes: string[] };
type FinalDelivery = { required: boolean; directory: string; primary: string | null; format: string; additional: string[]; producerNodeId: string | null; reason: string };
type Workflow = { id: string; workDirectory: string; originId: string; parentWorkflowId: string | null; branchIndex: number; branchLabel: string; title: string; originalPrompt: string; plannerEngine: Engine; maxConcurrentAgents: number | null; status: string; pausedFromStatus: string | null; pausedPlanningMode: "initial" | "refine" | "fresh" | null; pausedPlanningMaintenance: boolean; revision: number; activePlanVersion: number; reviewNote: string | null; finalResult: Result | null; plannerLogs: Log[]; plannerStartedAt: string | null; plannerFinishedAt: string | null; integrationLogs: Log[]; integrationStartedAt: string | null; integrationFinishedAt: string | null; plan: { title: string; summary: string; assumptions: string[]; questions: string[]; risks: string[]; finalDelivery: FinalDelivery; audit: PlanAudit; nodes: PlanNode[] } | null; nodes: Node[] };
type Runtime = { codex: { available: boolean }; claude: { available: boolean }; providers: Record<string, { available: boolean }> };
type PlanImpact = { reused: string[]; rerun: string[]; added: string[]; removed: string[]; requiresIntegration: boolean };
type MaintenanceBranch = { id: string; status: "idle" | "planning" | "ready" | "failed"; basePlanVersion: number; messages: Array<{ id: string; role: "user" | "assistant" | "system"; text: string; createdAt: string; planVersion?: number }>; candidatePlan: Workflow["plan"]; impact: PlanImpact | null; updatedAt: string };
type PlannerAccepted = { accepted: true; alreadyRunning: boolean; workflow: Workflow };
type ArtifactStatus = { path: string; relativePath: string | null; exists: boolean; kind: "file" | "directory" | "missing" | "invalid"; size: number | null };

async function request<T>(url: string, options: RequestInit = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const text = await response.text(); let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!response.ok) throw new Error(body?.error || `请求失败（${response.status}）`);
  return body as T;
}

const labels: Record<string, string> = { draft: "待规划", planning: "规划中", awaiting_approval: "待审批", queued: "排队中", running: "执行中", integrating: "整合中", completed: "已完成", partial: "部分完成", needs_review: "需要处理", paused: "已暂停", failed: "失败", canceled: "已取消", pending: "等待", ready: "可执行", pause_requested: "正在暂停", restart_requested: "正在重启", retry_wait: "重试等待", blocked: "被阻塞", interrupted: "可继续" };
const statusLabel = (status: string) => labels[status] || status;
const providerLabel = (provider: Engine | "auto") => provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider === "auto" ? "自动" : provider;
const defaultViewport = { x: 20, y: 28, zoom: 1 };
const workflowLayoutKey = (workflowId: string) => `workflow-layout:${workflowId}`;
const finitePoint = (value: unknown): value is Point => Boolean(value && typeof value === "object" && Number.isFinite((value as Point).x) && Number.isFinite((value as Point).y));
function readCanvasLayout(workflowId: string): CanvasLayout {
  try {
    const stored = JSON.parse(localStorage.getItem(workflowLayoutKey(workflowId)) || "{}");
    if (stored?.version === 2 && stored.viewport && stored.nodes) {
      const nodes = Object.fromEntries(Object.entries(stored.nodes as Record<string, unknown>).filter((entry): entry is [string, Point] => finitePoint(entry[1])));
      const x = Number(stored.viewport.x); const y = Number(stored.viewport.y); const zoom = Number(stored.viewport.zoom);
      return { version: 2, viewport: { x: Number.isFinite(x) ? x : defaultViewport.x, y: Number.isFinite(y) ? y : defaultViewport.y, zoom: Math.max(.4, Math.min(2, Number.isFinite(zoom) ? zoom : 1)) }, nodes };
    }
    const nodes = Object.fromEntries(Object.entries(stored as Record<string, unknown>).filter((entry): entry is [string, Point] => finitePoint(entry[1])));
    return { version: 2, viewport: defaultViewport, nodes };
  } catch { return { version: 2, viewport: defaultViewport, nodes: {} }; }
}

function WorkflowReviewCard({ workflow, nodes, reviewNote, busy, onReviewNoteChange, onRefine, onFresh, onApprove, onSelectNode, onCollapse }: { workflow: Workflow; nodes: Node[]; reviewNote: string; busy: boolean; onReviewNoteChange: (value: string) => void; onRefine: () => void; onFresh: () => void; onApprove: () => void; onSelectNode: (id: string) => void; onCollapse: () => void }) {
  const parallel = nodes.filter((node) => node.dependsOn.length === 0).length;
  const writes = nodes.filter((node) => node.workspaceAccess === "write").length;
  const dependent = nodes.filter((node) => node.dependsOn.length > 0).length;
  return <aside className="workflow-review-card">
    <header><div><span className="workflow-review-kicker"><ListChecks size={14} />计划审查</span><h3>{workflow.title}</h3></div><button type="button" className="workflow-review-log" title="查看规划 Agent 日志" onClick={() => onSelectNode("planner")}><Bot size={14} /></button><span className="workflow-review-version">v{workflow.activePlanVersion || 1}</span><button type="button" className="workflow-review-collapse" title="收起计划审查" onClick={onCollapse}><PanelRightClose size={14} /></button></header>
    <div className="workflow-review-scroll">
      <p className="workflow-review-summary">{workflow.plan?.summary || "规划 Agent 尚未提供拆分摘要"}</p>
      {!!workflow.plan?.questions.length && <div className="workflow-review-notes questions"><strong>待确认</strong>{workflow.plan.questions.map((item, index) => <p key={`question-${index}`}>{item}</p>)}</div>}
      {!!workflow.plan?.assumptions.length && <div className="workflow-review-notes"><strong>规划假设</strong>{workflow.plan.assumptions.map((item, index) => <p key={`assumption-${index}`}>{item}</p>)}</div>}
      {!!workflow.plan?.risks.length && <div className="workflow-review-notes risks"><strong>风险</strong>{workflow.plan.risks.map((item, index) => <p key={`risk-${index}`}>{item}</p>)}</div>}
      {workflow.plan?.finalDelivery && <div className="workflow-review-notes"><strong>最终交付</strong><p>{workflow.plan.finalDelivery.required ? `${workflow.plan.finalDelivery.primary} · ${workflow.plan.finalDelivery.format} · ${workflow.plan.finalDelivery.producerNodeId}` : workflow.plan.finalDelivery.reason}</p></div>}
      {workflow.plan?.audit && <div className={`workflow-review-audit ${workflow.plan.audit.status}`}><strong>规划自审 · {workflow.plan.audit.status === "revised" ? "已修正" : workflow.plan.audit.status === "needs_input" ? "需要确认" : "已通过"}</strong>{workflow.plan.audit.checks.slice(0, 5).map((item) => <p key={item.key}><i className={item.status} />{item.note}</p>)}{!!workflow.plan.audit.changes.length && <small>{workflow.plan.audit.changes.join("；")}</small>}</div>}
      <div className="workflow-review-stats"><span><Layers3 size={13} /><strong>{nodes.length}</strong> 个节点</span><span><GitBranch size={13} /><strong>{parallel}</strong> 个可先行</span><span><FileCheck2 size={13} /><strong>{dependent}</strong> 个有依赖</span><span><ShieldIcon /><strong>{writes}</strong> 个写入</span><span><Bot size={13} /><strong>{workflow.maxConcurrentAgents || 5}</strong> 并行 Agent</span></div>
      <div className="workflow-review-list">{nodes.map((node, index) => <button type="button" key={node.id} onClick={() => onSelectNode(node.id)}><span className="workflow-review-index">{index + 1}</span><span className="workflow-review-node-copy"><strong>{node.title}</strong><small>{providerLabel(node.provider)} · {node.workspaceAccess === "write" ? "可写入" : "只读"}{node.dependsOn.length ? ` · 依赖 ${node.dependsOn.length} 项` : " · 可并行"}</small>{node.providerReason && <em className="workflow-provider-reason" title={node.providerReason}>{node.providerReason}</em>}<em>{node.acceptance.length} 条验收 · {node.verificationCommands.length} 条机器检查 · {node.deliverables.length} 个产物{node.mcpServers.length ? ` · MCP ${node.mcpServers.length}${node.mcpRequired ? "（必需）" : ""}` : ""}</em></span></button>)}</div>
    </div>
    <div className="workflow-review-actions"><textarea value={reviewNote} onChange={(event) => onReviewNoteChange(event.target.value)} placeholder="认可总体方案时，可填写需要追加调整的细节" rows={2} /><div><button type="button" title="放弃当前结构并重新生成" onClick={onFresh} disabled={busy}><RefreshCw size={14} />重新生成</button><button type="button" onClick={onRefine} disabled={busy || !reviewNote.trim()}><Pencil size={14} />追加修改</button><button type="button" className="primary" onClick={onApprove} disabled={busy}><Check size={14} />批准执行</button></div></div>
  </aside>;
}

function WorkflowDeliveryPanel({ workflow, nodes, onSelectNode, onOpenFile, onCopyPath, onOpenFolder, onCollapse }: { workflow: Workflow; nodes: Node[]; onSelectNode: (id: string) => void; onOpenFile: (path: string) => void; onCopyPath: (path: string) => void; onOpenFolder: () => void; onCollapse: () => void }) {
  const [artifactStatuses, setArtifactStatuses] = useState<Record<string, ArtifactStatus>>({});
  const deliveredNodes = nodes.filter((node) => node.summary);
  const taskDirectory = workflow.workDirectory.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || "";
  const finalOutputs = [...new Map((workflow.finalResult?.outputs || []).filter((output) => output.path).map((output) => {
    const normalized = output.path!.replaceAll("\\", "/").replace(/^\.\//, "");
    const canonical = taskDirectory && normalized.startsWith(`${taskDirectory}/`) ? normalized.slice(taskDirectory.length + 1) : normalized;
    return [canonical.toLocaleLowerCase(), output] as const;
  })).values()];
  const nodeOutputs = deliveredNodes.reduce((total, node) => total + (node.summary?.outputs.length || 0), 0);
  const checks = [workflow.finalResult, ...deliveredNodes.map((node) => node.summary)].flatMap((result) => result?.checks || []);
  const passedChecks = checks.filter((check) => check.status === "passed").length;
  const failedChecks = checks.filter((check) => check.status === "failed");
  const pendingChecks = checks.filter((check) => check.status === "not_run");
  const results = [workflow.finalResult, ...deliveredNodes.map((node) => node.summary)].filter((result): result is Result => Boolean(result));
  const warnings = [...new Set(results.flatMap((result) => result.warnings).filter(Boolean))];
  const unresolvedItems = [...new Set(results.flatMap((result) => result.unresolved).filter(Boolean))];
  useEffect(() => {
    let disposed = false;
    void request<{ items: ArtifactStatus[] }>(`/api/workflows/${encodeURIComponent(workflow.id)}/artifacts`).then(({ items }) => {
      if (!disposed) setArtifactStatuses(Object.fromEntries(items.map((item) => [item.path.replaceAll("\\", "/").toLocaleLowerCase(), item])));
    }).catch(() => { if (!disposed) setArtifactStatuses({}); });
    return () => { disposed = true; };
  }, [workflow.id, workflow.revision]);
  const artifactStatus = (outputPath: string) => artifactStatuses[outputPath.replaceAll("\\", "/").toLocaleLowerCase()];
  return <aside className="workflow-delivery-panel">
    <header>
      <div><span className="workflow-delivery-kicker"><FileCheck2 size={14} />成果交付</span><h3>{workflow.title}</h3></div>
      <span className={`workflow-delivery-status ${workflow.status}`}>{statusLabel(workflow.status)}</span>
      <button type="button" className="workflow-review-collapse" title="收起成果交付" onClick={onCollapse}><PanelRightClose size={14} /></button>
    </header>
    <div className="workflow-delivery-scroll">
      <section className="workflow-delivery-hero">
        <span>最终交付</span>
        <strong>{workflow.finalResult?.humanSummary || (workflow.integrationStartedAt ? "最终成果正在整合与验收" : "执行成果正在逐步汇集")}</strong>
        <div><span><FileOutput size={12} />{finalOutputs.length} 个最终文件</span><span><FileCheck2 size={12} />{passedChecks}/{checks.length} 项检查</span>{unresolvedItems.length > 0 && <span className="warning"><AlertTriangle size={12} />{unresolvedItems.length} 项待处理</span>}</div>
      </section>
      <section className="workflow-delivery-section"><header><strong>最终文件</strong><small>{finalOutputs.length ? "点击文件预览" : "尚未登记最终文件"}</small></header><div className="workflow-delivery-files">{finalOutputs.map((output) => {
        const status = artifactStatus(output.path!); const missing = Boolean(status && !status.exists);
        return <div key={output.id} className={missing ? "missing" : ""}><button type="button" disabled={missing} title={missing ? `文件已失效：${output.path}` : `预览 ${output.path}`} onClick={() => onOpenFile(output.path!)}>{missing ? <CircleAlert size={15} /> : status?.exists ? <CircleCheck size={15} /> : <FileOutput size={15} />}<span><strong>{output.description || output.path}</strong><small>{output.path}{missing ? " · 文件不存在" : status?.kind === "directory" ? " · 目录" : ""}</small></span>{missing ? <CircleMinus size={13} /> : <ExternalLink size={13} />}</button><button type="button" className="copy" title="复制相对路径" onClick={() => onCopyPath(output.path!)}><Copy size={13} /></button></div>;
      })}{!finalOutputs.length && <p className="workflow-delivery-empty">最终整合完成后，主要交付文件会显示在这里。</p>}</div></section>
      <details className="workflow-delivery-section workflow-delivery-group" open><summary><span><strong>节点成果</strong><small>{deliveredNodes.length}/{nodes.length} 个节点 · {nodeOutputs} 项产物</small></span><ChevronDown size={14} /></summary><div className="workflow-delivery-nodes">{deliveredNodes.map((node) => {
        const result = node.summary!;
        const passed = result.checks.filter((check) => check.status === "passed").length;
        return <button type="button" key={node.id} onClick={() => onSelectNode(node.id)}><span className={`agent-status-dot ${node.status}`} /><span><strong>{node.title}</strong><small>{result.humanSummary || "已登记节点成果"}</small><em>{result.outputs.length} 项产物 · {passed}/{result.checks.length} 项检查{result.unresolved.length ? ` · ${result.unresolved.length} 项待处理` : ""}</em></span><ExternalLink size={13} /></button>;
      })}{!deliveredNodes.length && <p className="workflow-delivery-empty">子 Agent 完成后，成果和文件会在此处持续汇集。</p>}</div></details>
      <details className="workflow-delivery-section workflow-delivery-group"><summary><span><strong>验收检查</strong><small>{passedChecks} 通过 · {failedChecks.length} 失败 · {pendingChecks.length} 未运行</small></span><ChevronDown size={14} /></summary><div className="workflow-delivery-checks">{checks.map((check, index) => <div className={check.status} key={`${check.name}-${index}`}>{check.status === "passed" ? <CircleCheck size={13} /> : check.status === "failed" ? <CircleAlert size={13} /> : <CircleMinus size={13} />}<span><strong>{check.name}</strong><small>{check.evidence || check.command || "未提供检查证据"}</small></span></div>)}{!checks.length && <p className="workflow-delivery-empty">尚未登记验收检查。</p>}</div></details>
      {(warnings.length > 0 || unresolvedItems.length > 0) && <details className="workflow-delivery-section workflow-delivery-group warnings" open={unresolvedItems.length > 0}><summary><span><strong>风险与待处理</strong><small>{unresolvedItems.length} 待处理 · {warnings.length} 提醒</small></span><ChevronDown size={14} /></summary><div>{unresolvedItems.map((item) => <p className="unresolved" key={`unresolved:${item}`}><CircleAlert size={12} />{item}</p>)}{warnings.map((item) => <p key={`warning:${item}`}><AlertTriangle size={12} />{item}</p>)}</div></details>}
    </div>
    <footer><button type="button" title="打开任务成果文件夹" onClick={onOpenFolder}><FolderOpen size={14} />打开成果文件夹</button></footer>
  </aside>;
}

function ShieldIcon() { return <span className="workflow-review-shield" aria-hidden="true" />; }

function WorkflowMaintenancePanel({ branch, value, busy, onChange, onSubmit }: { branch: MaintenanceBranch | null; value: string; busy: boolean; onChange: (value: string) => void; onSubmit: () => void }) {
  return <aside className="workflow-maintenance-panel" onPointerDown={(event) => event.stopPropagation()}>
    {!!branch?.messages.length && <div className="workflow-maintenance-history">
      {branch.messages.slice(-3).map((message) => <div key={message.id} className={message.role}><span>{message.role === "user" ? "你" : message.role === "assistant" ? "Planner" : "系统"}</span><p>{message.text}</p></div>)}
    </div>}
    <footer><textarea rows={1} value={value} onChange={(event) => onChange(event.target.value)} placeholder="询问或调整当前规划" /><button type="button" className="send" title="发送" disabled={busy || branch?.status === "planning" || !value.trim()} onClick={onSubmit}>{busy || branch?.status === "planning" ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}</button></footer>
  </aside>;
}

type CardProps = { id: string; title: string; provider: Engine | "auto"; status: string; attempt?: number; logs: Log[]; skills: string[]; mcpServers: string[]; result?: Result | null; offset?: Point; dragging: boolean; icon: ReactNode; subtitle?: string; onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void; onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void; onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void; onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void; onClick: () => void; registerRef: (id: string, element: HTMLElement | null) => void; emptyText: string; className?: string };
const WorkflowAgentCard = memo(function WorkflowAgentCard({ id, title, provider, status, attempt, logs, skills, mcpServers, result, offset, dragging, icon, subtitle, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick, registerRef, emptyText, className = "" }: CardProps) {
  return <button ref={(element) => registerRef(id, element)} style={offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined} type="button" className={`workflow-agent-card ${className} ${status} ${dragging ? "dragging" : ""}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onClick={onClick}><header><span className={`workflow-agent-icon ${provider}`}>{icon}</span><span><strong>{title}</strong><small>{subtitle || `${providerLabel(provider)} · ${statusLabel(status)}`}{attempt && attempt > 1 ? ` · 第 ${attempt} 次` : ""}</small></span>{status === "running" && <LoaderCircle className="spin" size={15} />}</header><div className="workflow-card-meta"><span title="当前任务图涉及的 Skill">Skill {skills.length}</span><span title="当前任务图涉及的 MCP">MCP {mcpServers.length}</span>{result && <span>{statusLabel(result.outcome)}</span>}</div><div className="workflow-card-logs">{logs.slice(-5).map((log) => <p key={log.id} title={log.text}><span />{log.title}</p>)}{!logs.length && <p><span />{emptyText}</p>}</div></button>;
}, (a, b) => {
  const sameStrings = (left: string[], right: string[]) => left.length === right.length && left.every((value, index) => value === right[index]);
  const sameLogs = a.logs.length === b.logs.length && a.logs.every((log, index) => { const other = b.logs[index]; return log.id === other?.id && log.title === other?.title && log.text === other?.text; });
  return a.id === b.id && a.title === b.title && a.provider === b.provider && a.status === b.status && sameLogs && sameStrings(a.skills, b.skills) && sameStrings(a.mcpServers, b.mcpServers) && a.offset?.x === b.offset?.x && a.offset?.y === b.offset?.y && a.dragging === b.dragging;
});
type PlanCardProps = { id: string; workflow: Workflow; offset?: Point; dragging: boolean; onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void; onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void; onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void; onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void; onClick: () => void; registerRef: (id: string, element: HTMLElement | null) => void };
const WorkflowPlanCard = memo(function WorkflowPlanCard({ id, workflow, offset, dragging, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick, registerRef }: PlanCardProps) {
  const nodes = workflow.nodes.length ? workflow.nodes : workflow.plan?.nodes || [];
  const parallel = nodes.filter((node) => node.dependsOn.length === 0).length;
  const risks = workflow.plan?.risks.length || 0;
  const summary = workflow.plan?.summary || (workflow.status === "planning" ? "规划 Agent 正在形成完整任务结构" : "方案尚未生成规划摘要");
  return <button
    ref={(element) => registerRef(id, element)}
    style={offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
    type="button"
    className={`workflow-plan-card ${workflow.status} ${dragging ? "dragging" : ""}`}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerCancel}
    onClick={onClick}
  >
    <header>
      <span className="workflow-plan-icon"><FileJson2 size={16} /></span>
      <span className="workflow-plan-heading"><small>方案 v{workflow.activePlanVersion || 0}</small><strong>{workflow.branchLabel || workflow.title}</strong></span>
      <span className={`workflow-plan-status ${workflow.status}`}>{workflow.status === "planning" && <LoaderCircle className="spin" size={11} />}{statusLabel(workflow.status)}</span>
    </header>
    <p>{summary}</p>
    <footer>
      <span><Layers3 size={12} /><strong>{nodes.length}</strong> 节点</span>
      <span><GitBranch size={12} /><strong>{parallel}</strong> 可先行</span>
      <span className={risks ? "has-risk" : ""}><AlertTriangle size={12} /><strong>{risks}</strong> 风险</span>
      <em>{providerLabel(workflow.plannerEngine)} CIL <ExternalLink size={12} /></em>
    </footer>
  </button>;
}, (a, b) => a.id === b.id && a.workflow === b.workflow && a.offset?.x === b.offset?.x && a.offset?.y === b.offset?.y && a.dragging === b.dragging);
const WorkflowOriginCard = memo(function WorkflowOriginCard({ prompt, workDirectory, branchCount, offset, dragging, editorMode, editorPrompt, branchNote, branchEngine, runtime, providers, busy, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick, onContextMenu, onEditorModeChange, onEditorPromptChange, onBranchNoteChange, onBranchEngineChange, onCancel, onSubmit, registerRef }: { prompt: string; workDirectory: string; branchCount: number; offset?: Point; dragging: boolean; editorMode: "edit" | "branch" | null; editorPrompt: string; branchNote: string; branchEngine: Engine; runtime: Runtime; providers: AgentProviderDescriptor[]; busy: boolean; onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void; onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void; onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void; onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void; onClick: () => void; onContextMenu: (event: React.MouseEvent<HTMLElement>) => void; onEditorModeChange: (mode: "edit" | "branch") => void; onEditorPromptChange: (value: string) => void; onBranchNoteChange: (value: string) => void; onBranchEngineChange: (engine: Engine) => void; onCancel: () => void; onSubmit: () => void; registerRef: (id: string, element: HTMLElement | null) => void }) {
  const expanded = editorMode !== null;
  const interactiveTarget = (target: EventTarget) => (target as HTMLElement).closest("button, textarea, select, input, label");
  return <article
    ref={(element) => registerRef("origin", element)}
    style={offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
    className={`workflow-origin-card ${expanded ? "expanded" : ""} ${dragging ? "dragging" : ""}`}
    onPointerDown={(event) => { if (interactiveTarget(event.target)) { event.stopPropagation(); return; } onPointerDown(event); }}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerCancel}
    onClick={(event) => { if (!expanded && !interactiveTarget(event.target)) onClick(); }}
    onContextMenu={(event) => { event.preventDefault(); if (!expanded) onContextMenu(event); }}
  >
    <span className="workflow-card-kicker"><Route size={13} />初始任务 <em>{branchCount} 个方案</em>{expanded && <button type="button" title="收起编辑" onClick={onCancel}><X size={14} /></button>}</span>
    {!expanded ? <><strong>{prompt}</strong><small>{workDirectory}</small></> : <div className="workflow-origin-editor">
      <div className="workflow-origin-editor-tabs" role="tablist" aria-label="初始任务操作">
        <button type="button" className={editorMode === "edit" ? "active" : ""} onClick={() => onEditorModeChange("edit")}><Pencil size={13} />编辑任务</button>
        <button type="button" className={editorMode === "branch" ? "active" : ""} onClick={() => onEditorModeChange("branch")}><GitBranch size={13} />规划分支</button>
      </div>
      <textarea value={editorPrompt} onChange={(event) => onEditorPromptChange(event.target.value)} rows={8} autoFocus aria-label="初始任务内容" />
      {editorMode === "branch" && <div className="workflow-origin-branch-options">
        <label>规划模型<select value={branchEngine} onChange={(event) => onBranchEngineChange(event.target.value as Engine)}>{providers.filter((provider) => provider.capabilities.workflow.planner).map((provider) => <option key={provider.id} value={provider.id} disabled={!runtime.providers[provider.id]?.available}>{provider.shortName} CLI</option>)}</select></label>
        <label className="workflow-origin-branch-note">方案方向<input value={branchNote} onChange={(event) => onBranchNoteChange(event.target.value)} placeholder="可选：说明新方案采用的不同方向" /></label>
      </div>}
      <footer><span>{editorMode === "edit" ? "保存后将重置未执行的规划并重新分析" : "新方案将在独立任务目录中规划"}</span><button type="button" onClick={onCancel}>取消</button><button type="button" className="primary" disabled={busy || !editorPrompt.trim()} onClick={onSubmit}>{busy ? <LoaderCircle className="spin" size={14} /> : editorMode === "edit" ? <Pencil size={14} /> : <GitBranch size={14} />}{editorMode === "edit" ? "保存并规划" : "创建并规划"}</button></footer>
    </div>}
  </article>;
});
const WorkflowEdgeLayer = memo(function WorkflowEdgeLayer({ edges }: { edges: RenderedGraphEdge[] }) { return <svg className="workflow-graph-edges" aria-hidden="true"><defs><marker id="workflow-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" /></marker></defs>{edges.map((edge) => <path key={edge.id} className={edge.status} d={edge.path} markerEnd="url(#workflow-arrow)" />)}</svg>; });

function WorkflowAgentDrawer({ title, provider, status, task, logs, result, error, workspaceId, renderMessage, busy = false, onPause, onResume, onRestart, onCancel, onRepairResult, onCopyMachineResult, onOpenFile, onOpenFolder, onCopyPath, onClose }: { title: string; provider: Engine | "auto"; status: string; task: string; logs: Log[]; result?: Result | null; error?: string | null; workspaceId?: string; renderMessage?: (text: string) => ReactNode; busy?: boolean; onPause?: () => void; onResume?: () => void; onRestart?: () => void; onCancel?: () => void; onRepairResult?: () => void; onCopyMachineResult?: () => void; onOpenFile?: (path: string) => void; onOpenFolder?: () => void; onCopyPath?: (path: string) => void; onClose: () => void }) {
  const followOutput = useAgentOutputFollow(agentStreamVersion(logs), title);
  return <div className="agent-drawer-backdrop" onMouseDown={onClose}>
    <aside className="agent-drawer workflow-agent-drawer" onMouseDown={(event) => event.stopPropagation()}>
      <header><div className="agent-drawer-title"><span className={`subagent-mark ${provider}`}>{provider === "auto" ? <Bot size={18} /> : <ProviderIcon provider={provider} size={18} />}</span><span><strong>{title}<em className={`agent-provider-badge ${provider}`}>{providerLabel(provider)}</em></strong><small>最新活动在上 · {statusLabel(status)} · {logs.length} 条</small></span></div><div className="workflow-drawer-actions">{onCopyMachineResult && <button type="button" className="workflow-drawer-close" title="复制机器结果文件地址" onClick={onCopyMachineResult}><FileJson2 size={16} /></button>}{onRepairResult && <button type="button" className="workflow-drawer-close" title="保留 Agent 输出，仅修复机器结果" disabled={busy} onClick={onRepairResult}>{busy ? <LoaderCircle className="spin" size={16} /> : <Wrench size={16} />}</button>}{onPause && <button type="button" className="workflow-drawer-close" title="暂停当前 Agent" disabled={busy} onClick={onPause}>{busy ? <LoaderCircle className="spin" size={16} /> : <Pause size={16} />}</button>}{onResume && <button type="button" className="workflow-drawer-close" title="继续当前 Agent" disabled={busy} onClick={onResume}>{busy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}</button>}{onRestart && <button type="button" className="workflow-drawer-close" title="重新执行此节点" disabled={busy} onClick={onRestart}>{busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button>}{onCancel && <button type="button" className="workflow-drawer-close" title="终止当前 Agent" disabled={busy} onClick={onCancel}>{busy ? <LoaderCircle className="spin" size={16} /> : <StopCircle size={16} />}</button>}<button type="button" className="workflow-drawer-close" title="关闭日志" onClick={onClose}><X size={18} /></button></div></header>
      <div className="agent-drawer-body" ref={followOutput.containerRef} onScroll={followOutput.onScroll}>
        <div className="agent-drawer-content" ref={followOutput.contentRef}>
        <section className="agent-summary-line"><span className={`agent-status-dot ${status}`} /><strong>{statusLabel(status)}</strong><span>{logs.length} 条活动</span></section>
        {result && <div className="workflow-result-view">
          <section className="agent-task"><span>执行结果 · {statusLabel(result.outcome)}</span><p>{result.humanSummary}</p></section>
          {!!result.outputs.length && <section><span>交付产物</span><div className="workflow-result-list">{result.outputs.map((output) => <div key={output.id}>{output.path && onOpenFile ? <button type="button" onClick={() => onOpenFile(output.path!)}><strong>{output.description}</strong><small>{output.path}</small></button> : <><strong>{output.description}</strong><small>{output.path || `${output.type} · 无文件`}</small></>}{output.path && onCopyPath && <button type="button" title="复制路径" onClick={() => onCopyPath(output.path!)}><Copy size={12} /></button>}</div>)}</div></section>}
          {!!result.changedFiles.length && <section><span>实际文件变更</span><div className="workflow-result-list">{result.changedFiles.map((file) => <div key={file}><code>{file}</code></div>)}</div></section>}
          {!!result.checks.length && <section><span>验收检查</span><div className="workflow-result-list">{result.checks.map((check, index) => <div key={`${check.name}-${index}`}><strong><i className={`workflow-check-dot ${check.status}`} />{check.name}{check.exitCode !== null ? ` · exit ${check.exitCode}` : ""}</strong>{check.command && <small>{check.command}</small>}{check.evidence && <small>{check.evidence}</small>}</div>)}</div></section>}
          {!!result.decisions.length && <section><span>关键决策</span><div className="workflow-result-list">{result.decisions.map((decision) => <div key={decision.key}><strong>{decision.key}：{decision.value}</strong><small>{decision.reason}</small></div>)}</div></section>}
          {(result.handoff.facts.length > 0 || result.handoff.constraints.length > 0 || result.handoff.nextAgentInstructions.length > 0) && <section><span>下游交接</span><div className="workflow-result-list">{result.handoff.facts.map((fact, index) => <div key={`fact-${index}`}><strong>{fact}</strong></div>)}{result.handoff.constraints.map((constraint, index) => <div key={`constraint-${index}`}><small>{constraint}</small></div>)}{result.handoff.nextAgentInstructions.map((instruction, index) => <div key={`instruction-${index}`}><small>{instruction}</small></div>)}</div></section>}
          {(result.warnings.length > 0 || result.unresolved.length > 0) && <section><span>注意事项</span><div className="workflow-result-list warnings">{[...result.warnings, ...result.unresolved].map((item, index) => <div key={index}><small>{item}</small></div>)}</div></section>}
        </div>}
        <section className="agent-task"><span>当前任务</span><p>{task}</p></section>
        {error && <div className="workflow-error"><AlertTriangle size={14} />{error}</div>}
        <section className="agent-log-section"><AgentConversation className="agent-conversation workflow-drawer-logs" logs={logs} status={status} provider={provider === "auto" ? "agent" : provider} providerLabel={providerLabel(provider)} messageLabel={title} workspaceId={workspaceId} renderMessage={renderMessage} showProvider={false} emptyText="尚无活动日志" /></section>
        {onOpenFolder && <button type="button" className="workflow-open-result-folder" onClick={onOpenFolder}><FolderOpen size={14} />打开成果目录</button>}
        </div>
      </div>
    </aside>
  </div>;
}

export function WorkflowWorkbench({ workflowId, defaultPlannerEngine, runtime, providers, workspaceId, renderAgentMessage, onCreate, onOpenWorkflow, onOpenLocalFile, onChanged, onNotice }: { workflowId?: string; defaultPlannerEngine: Engine; runtime: Runtime; providers: AgentProviderDescriptor[]; workspaceId?: string; renderAgentMessage?: (text: string) => ReactNode; onCreate: (engine: Engine, prompt: string, maxConcurrentAgents: number | null) => Promise<unknown>; onOpenWorkflow: (id: string) => void; onOpenLocalFile?: (path: string) => void; onChanged: () => Promise<void>; onNotice: (message: string, tone?: "success" | "warning" | "error" | "info") => void }) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [branches, setBranches] = useState<Workflow[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [taskPrompt, setTaskPrompt] = useState("");
  const [plannerEngine, setPlannerEngine] = useState<Engine>(defaultPlannerEngine);
  const [concurrencyMode, setConcurrencyMode] = useState<"auto" | "custom">("auto");
  const [maxConcurrentAgents, setMaxConcurrentAgents] = useState(5);
  const [busy, setBusy] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewCollapsed, setReviewCollapsed] = useState(false);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [originMenu, setOriginMenu] = useState<{ x: number; y: number } | null>(null);
  const [originDialog, setOriginDialog] = useState<"edit" | "branch" | null>(null);
  const [originPrompt, setOriginPrompt] = useState("");
  const [branchNote, setBranchNote] = useState("");
  const [branchEngine, setBranchEngine] = useState<Engine>(defaultPlannerEngine);
  const [maintenance, setMaintenance] = useState<MaintenanceBranch | null>(null);
  const [maintenanceInput, setMaintenanceInput] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<"planner" | string>("");
  const [zoom, setZoom] = useState(defaultViewport.zoom);
  const [pan, setPan] = useState({ x: defaultViewport.x, y: defaultViewport.y });
  const [nodeOffsets, setNodeOffsets] = useState<NodeOffsets>({});
  const [draggingNodeId, setDraggingNodeId] = useState("");
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const nodeDragRef = useRef<{ id: string; x: number; y: number; origin: Point; current: Point; moved: boolean; pointerId: number; element: HTMLElement | null; raf: number | null } | null>(null);
  const nodeOffsetsRef = useRef<NodeOffsets>({});
  const suppressNodeClickRef = useRef("");
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const layoutWorkflowRef = useRef("");
  const layoutSaveTimerRef = useRef<number | null>(null);
  const workflowIdRef = useRef(workflowId || "");
  const loadRequestRef = useRef<{ generation: number; workflowId: string; controller: AbortController | null; promise: Promise<void> | null }>({ generation: 0, workflowId: "", controller: null, promise: null });
  workflowIdRef.current = workflowId || "";
  const acceptWorkflow = useCallback((candidate: Workflow, expectedId = workflowIdRef.current) => {
    if (!expectedId || candidate.id !== expectedId || workflowIdRef.current !== expectedId) return false;
    setWorkflow((current) => current?.id === expectedId && current.revision > candidate.revision ? current : candidate);
    return true;
  }, []);
  const load = useCallback(async () => {
    const expectedId = workflowIdRef.current;
    if (!expectedId) return;
    if (loadRequestRef.current.workflowId === expectedId && loadRequestRef.current.promise) return loadRequestRef.current.promise;
    loadRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const generation = loadRequestRef.current.generation + 1;
    const promise = (async () => {
      let current: Workflow;
      try { current = await request<Workflow>(`/api/workflows/${encodeURIComponent(expectedId)}`, { signal: controller.signal }); }
      catch (error) { if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return; throw error; }
      if (controller.signal.aborted || loadRequestRef.current.generation !== generation || workflowIdRef.current !== expectedId || current.id !== expectedId) return;
      acceptWorkflow(current, expectedId);
      const [maintenanceResult, branchesResult] = await Promise.allSettled([
        request<MaintenanceBranch | null>(`/api/workflows/${encodeURIComponent(expectedId)}/maintenance`, { signal: controller.signal }),
        request<unknown>(`/api/workflows/${encodeURIComponent(expectedId)}/branches`, { signal: controller.signal })
      ]);
      if (controller.signal.aborted || loadRequestRef.current.generation !== generation || workflowIdRef.current !== expectedId) return;
      setMaintenance(maintenanceResult.status === "fulfilled" ? maintenanceResult.value : null);
      const loadedBranches = branchesResult.status === "fulfilled" && Array.isArray(branchesResult.value) ? branchesResult.value as Workflow[] : [current];
      setBranches(loadedBranches.filter((branch) => branch.originId === current.originId));
    })();
    loadRequestRef.current = { generation, workflowId: expectedId, controller, promise };
    try { await promise; }
    finally {
      if (loadRequestRef.current.generation === generation) loadRequestRef.current = { generation, workflowId: expectedId, controller: null, promise: null };
    }
  }, [acceptWorkflow]);
  useEffect(() => {
    loadRequestRef.current.controller?.abort();
    loadRequestRef.current = { generation: loadRequestRef.current.generation + 1, workflowId: workflowId || "", controller: null, promise: null };
    setWorkflow(null); setBranches([]); setMaintenance(null); setMaintenanceInput(""); setSelectedAgent(""); setOriginDialog(null); setOriginMenu(null); setDeliveryOpen(false);
    if (workflowId) load().catch((error) => { if (error?.name !== "AbortError") onNotice(error.message, "error"); });
    return () => { loadRequestRef.current.controller?.abort(); };
  }, [workflowId, load]);
  useEffect(() => { setReviewCollapsed(false); }, [workflowId, workflow?.activePlanVersion]);
  useEffect(() => {
    if (!workflow || workflow.id !== workflowId || (!["planning", "queued", "running", "integrating"].includes(workflow.status) && maintenance?.status !== "planning")) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) load().catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [workflow?.id, workflow?.status, maintenance?.status, workflowId, load]);
  useEffect(() => {
    if (!workflowId) return;
    let timer: number | undefined;
    const changed = (detail: Record<string, unknown>) => {
      if (detail.workflowId !== workflowId) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load().catch(() => undefined), 80);
    };
    const unsubscribeChanged = realtimeCoordinator.subscribe("workflow.changed", changed);
    const unsubscribeReconcile = realtimeCoordinator.subscribeReconcile(() => void load().catch(() => undefined));
    return () => { if (timer) window.clearTimeout(timer); unsubscribeChanged(); unsubscribeReconcile(); };
  }, [workflowId, load]);
  useEffect(() => {
    if (!originMenu) return;
    const close = () => setOriginMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); };
  }, [originMenu]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panRef.current = pan; }, [pan]);
  useEffect(() => {
    if (!workflowId) {
      layoutWorkflowRef.current = "";
      nodeOffsetsRef.current = {};
      panRef.current = { x: defaultViewport.x, y: defaultViewport.y };
      zoomRef.current = defaultViewport.zoom;
      setNodeOffsets({}); setPan(panRef.current); setZoom(zoomRef.current);
      return;
    }
    const layout = readCanvasLayout(workflowId);
    layoutWorkflowRef.current = workflowId;
    nodeOffsetsRef.current = layout.nodes;
    panRef.current = { x: layout.viewport.x, y: layout.viewport.y };
    zoomRef.current = layout.viewport.zoom;
    setNodeOffsets(layout.nodes); setPan(panRef.current); setZoom(zoomRef.current);
    return () => {
      if (layoutSaveTimerRef.current !== null) window.clearTimeout(layoutSaveTimerRef.current);
      localStorage.setItem(workflowLayoutKey(workflowId), JSON.stringify({ version: 2, viewport: { ...panRef.current, zoom: zoomRef.current }, nodes: nodeOffsetsRef.current } satisfies CanvasLayout));
    };
  }, [workflowId]);
  useEffect(() => {
    if (!workflowId || layoutWorkflowRef.current !== workflowId) return;
    if (layoutSaveTimerRef.current !== null) window.clearTimeout(layoutSaveTimerRef.current);
    layoutSaveTimerRef.current = window.setTimeout(() => {
      localStorage.setItem(workflowLayoutKey(workflowId), JSON.stringify({ version: 2, viewport: { ...panRef.current, zoom: zoomRef.current }, nodes: nodeOffsetsRef.current } satisfies CanvasLayout));
      layoutSaveTimerRef.current = null;
    }, 180);
    return () => { if (layoutSaveTimerRef.current !== null) window.clearTimeout(layoutSaveTimerRef.current); };
  }, [workflowId, pan, zoom]);

  const displayNodes = useMemo<Node[]>(() => workflow?.nodes.length ? workflow.nodes : (workflow?.plan?.nodes || []).map((node) => ({ ...node, status: "pending", attempt: 0, summary: null, logs: [], error: null, resultRepairable: false })), [workflow?.nodes, workflow?.plan]);
  const workflowSkills = useMemo(() => [...new Set(displayNodes.flatMap((node) => node.skills))], [displayNodes]);
  const workflowMcpServers = useMemo(() => [...new Set(displayNodes.flatMap((node) => node.mcpServers))], [displayNodes]);
  const columns = useMemo(() => {
    const result: Node[][] = []; const remaining = new Set(displayNodes.map((node) => node.id)); const depth = new Map<string, number>();
    while (remaining.size) { const layer = [...remaining].filter((id) => (displayNodes.find((node) => node.id === id)?.dependsOn || []).every((dependency) => !remaining.has(dependency))); if (!layer.length) break; layer.forEach((id) => { remaining.delete(id); depth.set(id, Math.max(0, ...(displayNodes.find((node) => node.id === id)?.dependsOn || []).map((dep) => (depth.get(dep) || 0) + 1))); }); }
    for (const node of displayNodes) (result[depth.get(node.id) || 0] ||= []).push(node); return result;
  }, [displayNodes]);
  const plannerStatus = workflow?.status === "paused" && workflow.pausedPlanningMode ? "paused" : workflow?.status === "planning" || maintenance?.status === "planning" ? "running" : workflow?.plan || workflow?.plannerFinishedAt ? "completed" : workflow?.status === "draft" ? "pending" : "failed";
  const integrationStatus = !workflow?.integrationStartedAt ? "pending" : workflow.status === "paused" && workflow.pausedFromStatus === "integrating" ? "paused" : workflow.status === "integrating" ? "running" : workflow.status === "completed" ? "completed" : "failed";
  const selectedNode = selectedAgent && selectedAgent !== "planner" ? displayNodes.find((node) => node.id === selectedAgent) || null : null;
  const graphRef = useRef<HTMLDivElement | null>(null);
  const graphNodeRefs = useRef(new Map<string, HTMLElement>());
  const edgeFrameRef = useRef<number | null>(null);
  const [renderedEdges, setRenderedEdges] = useState<RenderedGraphEdge[]>([]);
  const siblingBranches = useMemo(() => (Array.isArray(branches) ? branches : []).filter((branch) => branch.id !== workflow?.id), [branches, workflow?.id]);
  const graphEdgeKey = `${workflow?.status || ""}|${workflow?.integrationStartedAt || ""}|${siblingBranches.map((branch) => `${branch.id}:${branch.status}`).join("|")}|${displayNodes.map((node) => `${node.id}:${node.status}:${node.dependsOn.join(",")}`).join("|")}`;
  const graphEdges = useMemo<GraphEdge[]>(() => {
    const edges: GraphEdge[] = [{ id: "origin:planner", from: "origin", to: "planner", status: workflow?.status === "planning" ? "active" : "completed" }];
    for (const branch of siblingBranches) edges.push({ id: `origin:branch:${branch.id}`, from: "origin", to: `branch:${branch.id}`, status: branch.status === "planning" ? "active" : branch.status === "completed" ? "completed" : "pending" });
    for (const node of displayNodes) {
      const parents = node.dependsOn.length ? node.dependsOn : ["planner"];
      for (const parent of parents) edges.push({ id: `${parent}:${node.id}`, from: parent, to: node.id, status: node.status === "running" ? "active" : node.status === "completed" ? "completed" : "pending" });
    }
    if (workflow?.integrationStartedAt) {
      const dependedOn = new Set(displayNodes.flatMap((node) => node.dependsOn));
      for (const node of displayNodes.filter((item) => !dependedOn.has(item.id))) edges.push({ id: `${node.id}:integration`, from: node.id, to: "integration", status: workflow.status === "integrating" ? "active" : workflow.status === "completed" ? "completed" : "pending" });
    }
    return edges;
  }, [graphEdgeKey, siblingBranches]);
  const registerGraphNode = useCallback((id: string, element: HTMLElement | null) => {
    if (element) graphNodeRefs.current.set(id, element);
    else graphNodeRefs.current.delete(id);
  }, []);
  const updateGraphEdges = useCallback(() => {
    const root = graphRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const scale = zoom || 1;
    const rects = new Map<string, DOMRect>();
    for (const id of new Set(graphEdges.flatMap((edge) => [edge.from, edge.to]))) { const element = graphNodeRefs.current.get(id); if (element) rects.set(id, element.getBoundingClientRect()); }
    setRenderedEdges(graphEdges.flatMap((edge) => {
      const from = graphNodeRefs.current.get(edge.from);
      const to = graphNodeRefs.current.get(edge.to);
      if (!from || !to) return [];
      const fromRect = rects.get(edge.from);
      const toRect = rects.get(edge.to);
      if (!fromRect || !toRect) return [];
      const startX = (fromRect.right - rootRect.left) / scale;
      const startY = (fromRect.top + fromRect.height / 2 - rootRect.top) / scale;
      const endX = (toRect.left - rootRect.left) / scale;
      const endY = (toRect.top + toRect.height / 2 - rootRect.top) / scale;
      const bend = Math.max(32, (endX - startX) * .5);
      return [{ ...edge, path: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}` }];
    }));
  }, [graphEdges, zoom]);
  const scheduleGraphEdgeUpdate = useCallback(() => {
    if (edgeFrameRef.current !== null) return;
    edgeFrameRef.current = window.requestAnimationFrame(() => { edgeFrameRef.current = null; updateGraphEdges(); });
  }, [updateGraphEdges]);
  useLayoutEffect(() => {
    scheduleGraphEdgeUpdate();
    const observer = new ResizeObserver(scheduleGraphEdgeUpdate);
    if (graphRef.current) observer.observe(graphRef.current);
    for (const element of graphNodeRefs.current.values()) observer.observe(element);
    return () => { if (edgeFrameRef.current !== null) window.cancelAnimationFrame(edgeFrameRef.current); edgeFrameRef.current = null; observer.disconnect(); };
  }, [scheduleGraphEdgeUpdate]);

  const create = async () => { if (!taskPrompt.trim()) return onNotice("请输入完整任务", "warning"); setBusy(true); try { await onCreate(plannerEngine, taskPrompt.trim(), concurrencyMode === "custom" ? maxConcurrentAgents : null); setTaskPrompt(""); setCreateOpen(false); } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); } };
  const plan = async (mode: "initial" | "refine" | "fresh" = "initial", note = "", source?: "maintenance") => {
    if (!workflow || workflow.id !== workflowIdRef.current || workflow.status === "planning") return;
    const targetId = workflow.id;
    setBusy(true);
    try {
      const accepted = await request<PlannerAccepted>(`/api/workflows/${targetId}/plan`, { method: "POST", body: JSON.stringify({ mode, note, source }) });
      acceptWorkflow(accepted.workflow, targetId);
      if (source === "maintenance") setMaintenanceInput("");
      await load();
      setReviewNote("");
      await onChanged();
      onNotice(accepted.alreadyRunning ? "规划任务已在运行" : source === "maintenance" ? "规划维护已受理" : "规划任务已受理", "success");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error), "error");
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => { if (!workflow || workflow.id !== workflowIdRef.current) return; const targetId = workflow.id; setBusy(true); try { const next = await request<Workflow>(`/api/workflows/${targetId}/approve`, { method: "POST", body: JSON.stringify({ revision: workflow.revision }) }); acceptWorkflow(next, targetId); await onChanged(); onNotice("计划已批准，开始按依赖调度", "success"); } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); } };
  const refinePlan = async () => { if (!reviewNote.trim()) return onNotice("请填写需要追加调整的内容", "warning"); await plan("refine", reviewNote.trim()); };
  const freshPlan = async () => { if (!workflow || !window.confirm("重新生成会创建完整的新计划版本，当前计划仍保留在历史中。继续吗？")) return; await plan("fresh", reviewNote.trim()); };
  const maintainPlan = async () => {
    if (!maintenanceInput.trim()) return onNotice("请输入规划调整内容", "warning");
    await plan("refine", maintenanceInput.trim(), "maintenance");
  };
  const openOriginDialog = (mode: "edit" | "branch") => {
    if (!workflow) return;
    if (!originDialog) {
      setOriginPrompt(workflow.originalPrompt);
      setBranchEngine(workflow.plannerEngine);
      setBranchNote("");
    }
    setOriginDialog(mode);
    setOriginMenu(null);
  };
  const saveOriginEdit = async () => {
    if (!workflow || workflow.id !== workflowIdRef.current || !originPrompt.trim()) return onNotice("初始任务不能为空", "warning");
    const targetId = workflow.id;
    setBusy(true);
    try {
      const next = await request<Workflow>(`/api/workflows/${targetId}/prompt`, { method: "PUT", body: JSON.stringify({ revision: workflow.revision, prompt: originPrompt.trim() }) });
      acceptWorkflow(next, targetId); setOriginDialog(null); await onChanged(); onNotice("初始任务已更新，正在重新规划", "success");
      void request<PlannerAccepted>(`/api/workflows/${targetId}/plan`, { method: "POST", body: JSON.stringify({ mode: "initial" }) }).then((accepted) => { acceptWorkflow(accepted.workflow, targetId); return onChanged(); }).catch((error) => { onNotice(error instanceof Error ? error.message : String(error), "error"); void load(); });
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setBusy(false); }
  };
  const createBranch = async () => {
    if (!workflow || !originPrompt.trim()) return onNotice("初始任务不能为空", "warning");
    setBusy(true);
    try {
      const branch = await request<Workflow>(`/api/workflows/${workflow.id}/branches`, { method: "POST", body: JSON.stringify({ prompt: originPrompt.trim(), plannerEngine: branchEngine, note: branchNote.trim(), maxConcurrentAgents: workflow.maxConcurrentAgents }) });
      setOriginDialog(null); await onChanged(); onNotice(`${branch.branchLabel} 已创建，规划 Agent 正在分析`, "success"); onOpenWorkflow(branch.id);
      void request<PlannerAccepted>(`/api/workflows/${branch.id}/plan`, { method: "POST", body: JSON.stringify({ mode: "initial", note: branchNote.trim() }) }).then(() => onChanged()).catch((error) => { onNotice(error instanceof Error ? error.message : String(error), "error"); void onChanged(); });
    } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setBusy(false); }
  };
  const retryIntegration = async () => { if (!workflow || workflow.id !== workflowIdRef.current) return; const targetId = workflow.id; setBusy(true); try { const next = await request<Workflow>(`/api/workflows/${targetId}/retry-integration`, { method: "POST" }); acceptWorkflow(next, targetId); onNotice("已重新启动最终整合与验收", "success"); } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); } };
  const pauseNode = async (nodeId: string) => { if (!workflow || workflow.id !== workflowIdRef.current) return; const targetId = workflow.id; setBusy(true); try { const next = await request<Workflow>(`/api/workflows/${targetId}/nodes/${encodeURIComponent(nodeId)}/pause`, { method: "POST" }); acceptWorkflow(next, targetId); onNotice("已请求暂停节点，正在保存当前检查点", "info"); } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); } };
  const resumeNode = async (nodeId: string) => { if (!workflow || workflow.id !== workflowIdRef.current) return; const targetId = workflow.id; setBusy(true); try { const next = await request<Workflow>(`/api/workflows/${targetId}/nodes/${encodeURIComponent(nodeId)}/resume`, { method: "POST" }); acceptWorkflow(next, targetId); onNotice("节点已恢复调度", "success"); } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); } };
  const restartNode = async (nodeId: string) => {
    if (!workflow || workflow.id !== workflowIdRef.current) return;
    const targetId = workflow.id;
    const node = workflow.nodes.find((item) => item.id === nodeId);
    const warning = node?.status === "completed" ? "重新执行会使依赖此节点的下游结果标记为过期，工作区文件不会自动回滚。继续吗？" : "重新执行会保留当前文件和日志，但会停止当前尝试并创建新的执行轮次。继续吗？";
    if (!window.confirm(warning)) return;
    setBusy(true);
    try { const next = await request<Workflow>(`/api/workflows/${targetId}/nodes/${encodeURIComponent(nodeId)}/restart`, { method: "POST" }); acceptWorkflow(next, targetId); onNotice("已请求重新执行节点，正在等待旧进程退出", "success"); }
    catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setBusy(false); }
  };
  const repairNodeResult = async (nodeId: string) => { if (!workflow || workflow.id !== workflowIdRef.current) return; const targetId = workflow.id; setBusy(true); try { const next = await request<Workflow>(`/api/workflows/${targetId}/nodes/${encodeURIComponent(nodeId)}/repair-result`, { method: "POST" }); acceptWorkflow(next, targetId); onNotice("已保留 Agent 原始输出，正在重新解析并验收", "success"); } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); } };
  const cancelNode = async (nodeId: string) => { if (!workflow || workflow.id !== workflowIdRef.current || !window.confirm("终止后会保留已有文件、日志和检查点，下游依赖节点将被阻塞。继续吗？")) return; const targetId = workflow.id; setBusy(true); try { const next = await request<Workflow>(`/api/workflows/${targetId}/nodes/${encodeURIComponent(nodeId)}/cancel`, { method: "POST" }); acceptWorkflow(next, targetId); onNotice("节点已终止，已有成果仍保留", "success"); } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); } };
  const retryFailedNodes = async () => { if (!workflow || workflow.id !== workflowIdRef.current) return; const targetId = workflow.id; setBusy(true); try { const next = await request<Workflow>(`/api/workflows/${targetId}/retry-failed-nodes`, { method: "POST" }); acceptWorkflow(next, targetId); onNotice("全部失败节点已重新排队，下游阻塞将随执行恢复", "success"); } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); } };
  const pauseWorkflow = async () => { if (!workflow || workflow.id !== workflowIdRef.current) return; const targetId = workflow.id; setBusy(true); try { const next = await request<Workflow>(`/api/workflows/${targetId}/pause`, { method: "POST" }); acceptWorkflow(next, targetId); onNotice("已请求暂停整个工作流，正在保存检查点", "info"); } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); } };
  const resumeWorkflow = async () => { if (!workflow || workflow.id !== workflowIdRef.current) return; const targetId = workflow.id; setBusy(true); try { const next = await request<Workflow>(`/api/workflows/${targetId}/resume`, { method: "POST" }); acceptWorkflow(next, targetId); onNotice("工作流已从检查点继续", "success"); } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); } };
  const cancel = async () => { if (!workflow || workflow.id !== workflowIdRef.current || !window.confirm("终止工作流会停止所有未完成 Agent，但不会回滚或删除已有文件和结果。继续吗？")) return; const targetId = workflow.id; setBusy(true); try { const next = await request<Workflow>(`/api/workflows/${targetId}/cancel`, { method: "POST", body: JSON.stringify({ revision: workflow.revision }) }); acceptWorkflow(next, targetId); await onChanged(); onNotice("工作流已终止，已有成果仍保留", "success"); } catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); } };
  const resetViewport = () => { setPan({ x: defaultViewport.x, y: defaultViewport.y }); setZoom(defaultViewport.zoom); };
  const persistNodeOffsets = useCallback(() => {
    if (!workflowId) return;
    localStorage.setItem(workflowLayoutKey(workflowId), JSON.stringify({ version: 2, viewport: { ...panRef.current, zoom: zoomRef.current }, nodes: nodeOffsetsRef.current } satisfies CanvasLayout));
  }, [workflowId]);
  const startNodeDrag = useCallback((id: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const origin = nodeOffsetsRef.current[id] || { x: 0, y: 0 };
    nodeDragRef.current = { id, x: event.clientX, y: event.clientY, origin, current: origin, moved: false, pointerId: event.pointerId, element: event.currentTarget, raf: null };
    setDraggingNodeId(id);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);
  const flushNodeDrag = useCallback(() => {
    const drag = nodeDragRef.current;
    if (!drag) return;
    drag.raf = null;
    if (drag.element) drag.element.style.transform = `translate(${drag.current.x}px, ${drag.current.y}px)`;
    scheduleGraphEdgeUpdate();
  }, [scheduleGraphEdgeUpdate]);
  const moveNode = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const dx = (event.clientX - drag.x) / zoomRef.current;
    const dy = (event.clientY - drag.y) / zoomRef.current;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    drag.current = { x: Math.round(drag.origin.x + dx), y: Math.round(drag.origin.y + dy) };
    if (drag.raf === null) drag.raf = window.requestAnimationFrame(flushNodeDrag);
  }, [flushNodeDrag]);
  const finishNodeDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (drag.raf !== null) { window.cancelAnimationFrame(drag.raf); drag.raf = null; }
    if (drag.moved) {
      if (drag.element) drag.element.style.transform = `translate(${drag.current.x}px, ${drag.current.y}px)`;
      const next = { ...nodeOffsetsRef.current, [drag.id]: drag.current };
      nodeOffsetsRef.current = next;
      setNodeOffsets(next);
      suppressNodeClickRef.current = drag.id;
      persistNodeOffsets();
    }
    nodeDragRef.current = null;
    setDraggingNodeId("");
    scheduleGraphEdgeUpdate();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, [persistNodeOffsets, scheduleGraphEdgeUpdate]);
  const openNode = useCallback((id: string) => {
    if (suppressNodeClickRef.current === id) { suppressNodeClickRef.current = ""; return; }
    setSelectedAgent(id);
  }, []);
  const openOrigin = useCallback(() => {
    if (suppressNodeClickRef.current === "origin") { suppressNodeClickRef.current = ""; return; }
    openOriginDialog("edit");
  }, [workflow?.id, workflow?.originalPrompt]);
  useEffect(() => {
    const shell = canvasRef.current;
    if (!shell) return;
    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest("aside, textarea, select, input")) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.ctrlKey) {
        setPan((current) => ({ x: current.x - (event.shiftKey ? event.deltaY : event.deltaX), y: current.y - (event.shiftKey ? 0 : event.deltaY) }));
        return;
      }
      const currentZoom = zoomRef.current;
      const currentPan = panRef.current;
      const rect = shell.getBoundingClientRect();
      const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const nextZoom = Math.max(.4, Math.min(2, currentZoom * Math.exp(-event.deltaY * .002)));
      const world = { x: (pointer.x - currentPan.x) / currentZoom, y: (pointer.y - currentPan.y) / currentZoom };
      const nextPan = { x: pointer.x - world.x * nextZoom, y: pointer.y - world.y * nextZoom };
      zoomRef.current = nextZoom;
      panRef.current = nextPan;
      setPan(nextPan);
      setZoom(nextZoom);
    };
    shell.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => shell.removeEventListener("wheel", onWheel, { capture: true });
  }, [workflowId]);
  const fitViewport = () => {
    const shell = canvasRef.current;
    const root = graphRef.current;
    if (!shell || !root) return resetViewport();
    const nextZoom = Math.max(.4, Math.min(1.25, Math.min((shell.clientWidth - 96) / root.offsetWidth, (shell.clientHeight - 130) / root.offsetHeight)));
    setZoom(nextZoom);
    setPan({ x: 48, y: 58 });
  };
  const resetLayout = () => {
    nodeOffsetsRef.current = {};
    setNodeOffsets({});
    resetViewport();
    if (workflowId) localStorage.setItem(workflowLayoutKey(workflowId), JSON.stringify({ version: 2, viewport: defaultViewport, nodes: {} } satisfies CanvasLayout));
  };
  const arrangeCanvas = () => {
    nodeOffsetsRef.current = {};
    setNodeOffsets({});
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => { fitViewport(); scheduleGraphEdgeUpdate(); persistNodeOffsets(); }));
  };
  const workspaceArtifactPath = useCallback((artifactPath: string) => {
    if (!workflow) return artifactPath;
    const normalized = artifactPath.replaceAll("\\", "/").replace(/^\.\//, "");
    if (/^[A-Za-z]:\//.test(normalized)) return normalized;
    const taskDirectory = workflow.workDirectory.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || "";
    if (taskDirectory && (normalized === taskDirectory || normalized.startsWith(`${taskDirectory}/`))) return normalized;
    return [taskDirectory, normalized].filter(Boolean).join("/");
  }, [workflow]);
  const openArtifact = useCallback((artifactPath: string) => onOpenLocalFile?.(workspaceArtifactPath(artifactPath)), [onOpenLocalFile, workspaceArtifactPath]);
  const copyArtifactPath = useCallback((artifactPath: string) => navigator.clipboard.writeText(artifactPath).then(() => onNotice("已复制产物路径", "success")), [onNotice]);
  const openWorkflowFolder = useCallback(async () => {
    if (!workflow) return;
    try { await request(`/api/workflows/${encodeURIComponent(workflow.id)}/open-folder`, { method: "POST" }); onNotice("已在文件管理器中打开成果目录", "success"); }
    catch (error) { onNotice(error instanceof Error ? error.message : String(error), "error"); }
  }, [workflow, onNotice]);

  return <section className="workflow-workbench">
    <div ref={canvasRef} className={`workflow-canvas-shell ${dragRef.current ? "dragging" : ""} ${draggingNodeId ? "node-dragging" : ""}`} onPointerDown={(event) => { if ((event.target as HTMLElement).closest("button, textarea, select, input, aside, .workflow-origin-card")) return; if (originDialog) setOriginDialog(null); dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { const drag = dragRef.current; if (drag) setPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y }); }} onPointerUp={(event) => { dragRef.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragRef.current = null; }}>
      <div className="workflow-canvas-hint"><Route size={15} /><span>Meta 任务编排{workflow ? ` · ${statusLabel(workflow.status)}` : " · 空画布"}</span><HelpButton topic="task-orchestration" />{workflow && <button type="button" title="刷新" onClick={() => void load()}><RefreshCw size={14} /></button>}</div>
      <div className="workflow-canvas-stage" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        {!workflowId ? <button type="button" className="workflow-start-card" onClick={() => setCreateOpen(true)}><span><Plus size={24} /></span><strong>创建初始任务</strong><small>从一个完整目标开始构建任务图</small></button> : !workflow ? <div className="workflow-loading-card"><LoaderCircle className="spin" size={18} />正在加载任务</div> : <div className="workflow-graph-root" ref={graphRef}>
          <WorkflowEdgeLayer edges={renderedEdges} />
          <WorkflowOriginCard prompt={workflow.originalPrompt} workDirectory={workflow.workDirectory} branchCount={branches.length || 1} offset={nodeOffsets.origin} dragging={draggingNodeId === "origin"} editorMode={originDialog} editorPrompt={originPrompt} branchNote={branchNote} branchEngine={branchEngine} runtime={runtime} providers={providers} busy={busy} onPointerDown={(event) => startNodeDrag("origin", event)} onPointerMove={moveNode} onPointerUp={finishNodeDrag} onPointerCancel={finishNodeDrag} onClick={openOrigin} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setOriginMenu({ x: Math.min(event.clientX, window.innerWidth - 210), y: Math.min(event.clientY, window.innerHeight - 160) }); }} onEditorModeChange={openOriginDialog} onEditorPromptChange={setOriginPrompt} onBranchNoteChange={setBranchNote} onBranchEngineChange={setBranchEngine} onCancel={() => setOriginDialog(null)} onSubmit={() => void (originDialog === "edit" ? saveOriginEdit() : createBranch())} registerRef={registerGraphNode} />
          {siblingBranches.length > 0 && <div className="workflow-branch-rail">{siblingBranches.map((branch) => <WorkflowPlanCard key={branch.id} id={`branch:${branch.id}`} workflow={branch} offset={nodeOffsets[`branch:${branch.id}`]} dragging={draggingNodeId === `branch:${branch.id}`} onPointerDown={(event) => startNodeDrag(`branch:${branch.id}`, event)} onPointerMove={moveNode} onPointerUp={finishNodeDrag} onPointerCancel={finishNodeDrag} onClick={() => { if (suppressNodeClickRef.current === `branch:${branch.id}`) { suppressNodeClickRef.current = ""; return; } onOpenWorkflow(branch.id); }} registerRef={registerGraphNode} />)}</div>}
          <div className="workflow-planner-stack">
            <WorkflowAgentCard id="planner" title="规划 Agent" provider={workflow.plannerEngine} status={plannerStatus} logs={workflow.plannerLogs} skills={workflowSkills} mcpServers={workflowMcpServers} offset={nodeOffsets.planner} dragging={draggingNodeId === "planner"} icon={<Brain size={17} />} onPointerDown={(event) => startNodeDrag("planner", event)} onPointerMove={moveNode} onPointerUp={finishNodeDrag} onPointerCancel={finishNodeDrag} onClick={() => openNode("planner")} registerRef={registerGraphNode} emptyText="等待开始规划" className="planner" />
          </div>
          {columns.length > 0 && <div className="workflow-plan-columns">{columns.map((column, index) => <div className="workflow-column" key={index}>{column.map((node) => <WorkflowAgentCard key={node.id} id={node.id} title={node.title} provider={node.provider} status={node.status} attempt={node.attempt} logs={node.logs} skills={node.skills} mcpServers={node.mcpServers} result={node.summary} offset={nodeOffsets[node.id]} dragging={draggingNodeId === node.id} icon={<Bot size={15} />} onPointerDown={(event) => startNodeDrag(node.id, event)} onPointerMove={moveNode} onPointerUp={finishNodeDrag} onPointerCancel={finishNodeDrag} onClick={() => openNode(node.id)} registerRef={registerGraphNode} emptyText={node.dependsOn.length ? `等待 ${node.dependsOn.length} 项依赖` : "等待执行"} className="workflow-node" />)}</div>)}</div>}
          {workflow.integrationStartedAt && <WorkflowAgentCard id="integration" title="最终交付" provider={workflow.plannerEngine} status={integrationStatus} logs={workflow.integrationLogs} skills={workflowSkills} mcpServers={workflowMcpServers} result={workflow.finalResult} offset={nodeOffsets.integration} dragging={draggingNodeId === "integration"} icon={<Check size={17} />} subtitle={workflow.finalResult ? `${statusLabel(workflow.finalResult.outcome)} · 点击查看全部成果` : undefined} onPointerDown={(event) => startNodeDrag("integration", event)} onPointerMove={moveNode} onPointerUp={finishNodeDrag} onPointerCancel={finishNodeDrag} onClick={() => openNode("integration")} registerRef={registerGraphNode} emptyText="等待最终整合" className="integrator delivery" />}
        </div>}
      </div>

      {createOpen && !workflowId && <div className="workflow-create-popover"><header><span><Plus size={16} /></span><strong>创建初始任务</strong><button type="button" title="关闭" onClick={() => setCreateOpen(false)}><X size={15} /></button></header><textarea value={taskPrompt} onChange={(event) => setTaskPrompt(event.target.value)} onKeyDown={(event) => { if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); void create(); } }} rows={10} placeholder="描述希望多个 Agent 共同完成的完整任务……" autoFocus /><div><label>规划模型<select value={plannerEngine} onChange={(event) => setPlannerEngine(event.target.value as Engine)}>{providers.filter((provider) => provider.capabilities.workflow.planner).map((provider) => <option key={provider.id} value={provider.id} disabled={!runtime.providers[provider.id]?.available}>{provider.shortName} CLI</option>)}</select></label><label>并行 Agent<select value={concurrencyMode} onChange={(event) => setConcurrencyMode(event.target.value as "auto" | "custom")}><option value="auto">自动（5）</option><option value="custom">自定义</option></select></label>{concurrencyMode === "custom" && <label>上限<input type="number" min={1} max={20} value={maxConcurrentAgents} onChange={(event) => setMaxConcurrentAgents(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} /></label>}<button type="button" className="primary" disabled={busy || !taskPrompt.trim()} onClick={() => void create()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}创建并规划</button></div></div>}

      {workflow?.status === "awaiting_approval" && !originDialog && !reviewCollapsed && <WorkflowReviewCard workflow={workflow} nodes={displayNodes} reviewNote={reviewNote} busy={busy} onReviewNoteChange={setReviewNote} onRefine={() => void refinePlan()} onFresh={() => void freshPlan()} onApprove={() => void approve()} onSelectNode={setSelectedAgent} onCollapse={() => setReviewCollapsed(true)} />}
      {workflow && deliveryOpen && <WorkflowDeliveryPanel workflow={workflow} nodes={displayNodes} onSelectNode={(id) => { setDeliveryOpen(false); setSelectedAgent(id); }} onOpenFile={openArtifact} onCopyPath={copyArtifactPath} onOpenFolder={() => void openWorkflowFolder()} onCollapse={() => setDeliveryOpen(false)} />}
      {workflow && ["draft", "needs_review"].includes(workflow.status) && <div className={`workflow-dock ${workflow.plan ? "with-maintenance" : ""}`}><span>{workflow.status === "needs_review" ? workflow.integrationStartedAt ? "最终验收未通过，请查看整合与验收日志" : "规划或执行遇到问题，请查看 Agent 日志" : "审批前不会启动子 Agent"}</span>{workflow.integrationStartedAt ? <button type="button" className="primary" onClick={() => void retryIntegration()} disabled={busy}><RefreshCw size={15} />重新验收</button> : workflow.nodes.some((node) => ["failed", "blocked"].includes(node.status)) ? <><button type="button" className="primary" onClick={() => void retryFailedNodes()} disabled={busy}><RefreshCw size={15} />恢复异常节点</button><button type="button" onClick={() => void plan("fresh")} disabled={busy}>重新规划</button></> : <button type="button" className="primary" onClick={() => void plan(workflow.activePlanVersion ? "fresh" : "initial")} disabled={busy}><RefreshCw size={15} />重新规划</button>}</div>}
      {workflow && ["planning", "queued", "running", "integrating", "paused"].includes(workflow.status) && <div className="workflow-dock"><span><Clock3 size={15} />{workflow.nodes.filter((node) => node.status === "completed").length} / {workflow.nodes.length} 个节点完成</span>{workflow.status === "paused" ? <button type="button" title="继续全部 Agent" disabled={busy} onClick={() => void resumeWorkflow()}><Play size={15} /></button> : <button type="button" title="暂停全部 Agent" disabled={busy} onClick={() => void pauseWorkflow()}><Pause size={15} /></button>}<button type="button" title="终止整个工作流" disabled={busy} onClick={() => void cancel()}><StopCircle size={15} /></button></div>}
      {workflow?.status === "completed" && <div className="workflow-dock with-maintenance"><span><Check size={15} />全部节点完成并已整合</span><button type="button" title="查看成果交付" onClick={() => setDeliveryOpen(true)}><FileCheck2 size={15} /></button><button type="button" title={workflow.plan?.finalDelivery?.primary ? "复制最终文件路径" : "复制成果摘要"} onClick={() => navigator.clipboard.writeText(workflow.plan?.finalDelivery?.primary || workflow.finalResult?.humanSummary || "").then(() => onNotice(workflow.plan?.finalDelivery?.primary ? "已复制最终文件路径" : "已复制最终结果", "success"))}><Copy size={15} /></button></div>}
      {workflow?.plan && !["planning", "queued", "running", "integrating"].includes(workflow.status) && <WorkflowMaintenancePanel branch={maintenance} value={maintenanceInput} busy={busy} onChange={setMaintenanceInput} onSubmit={() => void maintainPlan()} />}
      <div className="workflow-zoom">{workflow?.status === "awaiting_approval" && <button type="button" className={`workflow-review-toggle pending ${reviewCollapsed ? "" : "active"}`} title={reviewCollapsed ? "打开计划审查" : "收起计划审查"} aria-pressed={!reviewCollapsed} onClick={() => { setDeliveryOpen(false); setReviewCollapsed((value) => !value); }}><ListChecks size={14} /></button>}{workflow && (workflow.integrationStartedAt || workflow.finalResult || displayNodes.some((node) => node.summary)) && <button type="button" className={`workflow-delivery-toggle ${deliveryOpen ? "active" : ""} ${workflow.status === "completed" ? "ready" : ""}`} title={deliveryOpen ? "收起成果交付" : "查看成果交付"} aria-pressed={deliveryOpen} onClick={() => { setReviewCollapsed(true); setDeliveryOpen((value) => !value); }}><FileCheck2 size={14} /></button>}<button type="button" title="适应全部节点" onClick={fitViewport}><Maximize2 size={14} /></button><button type="button" title="整理画布" onClick={arrangeCanvas}><LayoutGrid size={14} /></button><button type="button" title="重置视图" onClick={resetLayout}><LocateFixed size={14} /></button><button type="button" title="缩小" onClick={() => setZoom((value) => Math.max(.4, value - .1))}>−</button><span>{Math.round(zoom * 100)}%</span><button type="button" title="放大" onClick={() => setZoom((value) => Math.min(2, value + .1))}>＋</button></div>
    </div>
    {originMenu && workflow && <div className="session-context-menu workflow-origin-menu" style={{ left: originMenu.x, top: originMenu.y }} onPointerDown={(event) => event.stopPropagation()}><button type="button" onClick={() => openOriginDialog("edit")}><Pencil size={14} />编辑初始任务</button><button type="button" onClick={() => openOriginDialog("branch")}><GitBranch size={14} />新建规划分支</button><button type="button" onClick={() => { navigator.clipboard.writeText(workflow.originalPrompt); setOriginMenu(null); onNotice("已复制初始任务", "success"); }}><Copy size={14} />复制任务内容</button></div>}
    {workflow && selectedAgent === "planner" && <WorkflowAgentDrawer title="规划 Agent" provider={workflow.plannerEngine} status={plannerStatus} task={workflow.originalPrompt} logs={workflow.plannerLogs} error={workflow.status === "needs_review" && !workflow.integrationStartedAt ? workflow.reviewNote || "规划未完成" : null} workspaceId={workspaceId} renderMessage={renderAgentMessage} onClose={() => setSelectedAgent("")} />}
    {workflow && selectedAgent === "integration" && <WorkflowAgentDrawer title="最终交付与验收" provider={workflow.plannerEngine} status={integrationStatus} task={workflow.originalPrompt} logs={workflow.integrationLogs} result={workflow.finalResult} error={workflow.status === "needs_review" ? workflow.finalResult?.unresolved.join("；") || "最终验收未通过" : null} workspaceId={workspaceId} renderMessage={renderAgentMessage} onOpenFile={openArtifact} onOpenFolder={() => void openWorkflowFolder()} onCopyPath={copyArtifactPath} onClose={() => setSelectedAgent("")} />}
    {selectedNode && <WorkflowAgentDrawer title={selectedNode.title} provider={selectedNode.provider} status={selectedNode.status} task={selectedNode.objective} logs={selectedNode.logs} result={selectedNode.summary} error={selectedNode.error} workspaceId={workspaceId} renderMessage={renderAgentMessage} busy={busy} onOpenFile={openArtifact} onOpenFolder={() => void openWorkflowFolder()} onCopyPath={copyArtifactPath} onCopyMachineResult={selectedNode.summary?.machineResultPath ? () => navigator.clipboard.writeText(selectedNode.summary!.machineResultPath!).then(() => onNotice("已复制机器结果地址", "success")) : undefined} onRepairResult={selectedNode.resultRepairable && ["failed", "blocked"].includes(selectedNode.status) ? () => void repairNodeResult(selectedNode.id) : undefined} onPause={workflow?.status !== "canceled" && ["running", "queued", "pending", "ready", "retry_wait", "interrupted"].includes(selectedNode.status) ? () => void pauseNode(selectedNode.id) : undefined} onResume={workflow?.status !== "canceled" && selectedNode.status === "paused" ? () => void resumeNode(selectedNode.id) : undefined} onRestart={workflow?.status !== "canceled" && ["running", "paused", "retry_wait", "interrupted", "failed", "blocked", "canceled", "completed"].includes(selectedNode.status) ? () => void restartNode(selectedNode.id) : undefined} onCancel={workflow?.status !== "canceled" && ["running", "queued", "pending", "ready", "pause_requested", "paused", "restart_requested", "retry_wait", "interrupted", "failed", "blocked"].includes(selectedNode.status) ? () => void cancelNode(selectedNode.id) : undefined} onClose={() => setSelectedAgent("")} />}
  </section>;
}
