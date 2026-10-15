import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bot, ChevronDown, Copy, FileCheck2, FolderOpen, Pause, Play, RefreshCw, StopCircle, Wrench, X } from "lucide-react";
import { AgentDrawer, AgentTaskDescription } from "../components/AgentDrawer";
import { AgentConversation, useAgentOutputFollow } from "../components/AgentConversation";
import { agentStreamVersion, type SharedAgentLog } from "../components/activityModel";
import { ProviderIcon } from "../branding/ProviderIcon";
import { publicWorkflowActivity } from "./publicActivity";
import "./WorkflowAgentDrawer.css";
import { workflowAgentPresentation, workflowFolderLabel, type WorkflowAgentResult } from "./agentPresentation";

type Props = {
  executionId: string; title: string; provider: string; status: string; task: string; logs: SharedAgentLog[];
  attempt?: number; summary?: string; executionTarget?: string; result?: WorkflowAgentResult | null; error?: string | null; workspaceId?: string;
  renderMessage?: (text: string) => ReactNode; busy?: boolean;
  onPause?: () => void; onResume?: () => void; onRestart?: () => void; onCancel?: () => void; onRepairResult?: () => void;
  onCopyMachineResult?: () => void; onOpenFile?: (path: string) => void; onOpenFolder?: () => void; onCopyPath?: (path: string) => void; onClose: () => void;
};
type View = "overview" | "activity" | "result";

export function WorkflowAgentDrawer(props: Props) {
  const { executionId, title, provider, status, task, result, error, workspaceId, renderMessage, busy = false, onPause, onResume, onRestart, onCancel, onRepairResult, onCopyMachineResult, onOpenFile, onOpenFolder, onCopyPath, onClose } = props;
  const logs = useMemo(() => publicWorkflowActivity(props.logs), [props.logs]);
  const defaultView = (): View => error ? "overview" : result ? "result" : props.summary && ["completed", "awaiting_approval"].includes(status) ? "overview" : "activity";
  const [view, setView] = useState<View>(defaultView);
  useEffect(() => { setView(defaultView()); }, [executionId, props.attempt]);
  const activeView = view === "result" && !result ? "overview" : view;
  const followOutput = useAgentOutputFollow(agentStreamVersion(logs), `${executionId}:${props.attempt || 0}:${activeView}`, activeView === "activity");
  const presentation = useMemo(() => workflowAgentPresentation({ status, provider, logs, objective: props.summary || task, result }), [status, provider, logs, task, props.summary, result]);
  const providerName = provider === "auto" ? "Agent" : provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : provider;
  const choices: Array<{ id: View; label: string }> = [{ id: "overview", label: "概览" }, { id: "activity", label: "活动" }, ...(result ? [{ id: "result" as const, label: "成果" }] : [])];
  const navigation = <div className="workflow-inspector-tabs" role="tablist" aria-label="Agent 详情视图">
    {choices.map((choice) => <button type="button" key={choice.id} id={`${executionId}-${choice.id}-tab`} role="tab" aria-controls={`${executionId}-panel`} aria-selected={activeView === choice.id} tabIndex={activeView === choice.id ? 0 : -1} onClick={() => setView(choice.id)} onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = choices.findIndex((item) => item.id === choice.id);
      const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + choices.length) % choices.length;
      setView(choices[next].id);
      (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
    }}>{choice.label}{choice.id === "result" && <span>{result?.outputs.length || result?.changedFiles.length || ""}</span>}</button>)}
  </div>;
  return <AgentDrawer title={title} contentLabel={`${title}${activeView === "activity" ? "活动日志" : activeView === "result" ? "成果" : "概览"}`} className="workflow-agent-drawer workflow-agent-inspector" onClose={onClose} followOutput={followOutput} navigation={navigation} header={<header>
    <div className="agent-drawer-title"><span className={`subagent-mark ${provider}`}>{provider === "auto" ? <Bot size={18} /> : <ProviderIcon provider={provider} size={18} />}</span><span><strong>{title}</strong><small>{providerName} · {presentation.stage}{presentation.duration && ` · ${presentation.duration}`}{props.attempt && props.attempt > 1 ? ` · 第 ${props.attempt} 次` : ""}</small></span></div>
    <div className="workflow-drawer-actions">
      {onPause && <button type="button" title="暂停当前 Agent" disabled={busy} onClick={onPause}><Pause size={15} /></button>}
      {onResume && <button type="button" title="继续当前 Agent" disabled={busy} onClick={onResume}><Play size={15} /></button>}
      {onRepairResult && <button type="button" title="保留输出并修复结果" disabled={busy} onClick={onRepairResult}><Wrench size={15} /></button>}
      {(onRestart || onCancel || onCopyMachineResult) && <details className="workflow-inspector-more" onKeyDown={(event) => {
        if (event.key !== "Escape" || !event.currentTarget.open) return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }} onClick={(event) => {
        if ((event.target as Element).closest("button")) event.currentTarget.open = false;
      }}><summary aria-label="Agent 更多操作"><ChevronDown size={15} /></summary><div>
        {onRestart && <button type="button" aria-label="重新执行此节点" disabled={busy} onClick={onRestart}><RefreshCw size={14} />重新执行此节点</button>}
        {onCancel && <button type="button" aria-label="终止当前 Agent" disabled={busy} onClick={onCancel}><StopCircle size={14} />终止当前 Agent</button>}
        {onCopyMachineResult && <button type="button" aria-label="复制诊断结果路径" onClick={onCopyMachineResult}><Copy size={14} />复制诊断结果路径</button>}
      </div></details>}
      <button type="button" title="关闭日志" onClick={onClose}><X size={18} /></button>
    </div>
  </header>}>
    <div id={`${executionId}-panel`} role="tabpanel" aria-labelledby={`${executionId}-${activeView}-tab`} className={`workflow-inspector-panel view-${activeView}`}>
      {activeView === "overview" && <>
        <div className="workflow-inspector-summary"><small>{presentation.stage}</small><p>{presentation.summary}</p></div>
        {error && <div className="workflow-inspector-issue" role="status"><strong>需要处理</strong><p>{error}</p><small>{onRepairResult ? "可以保留已有输出并修复结果。" : onResume ? "可以从检查点继续执行。" : onRestart ? "检查原因后可重新执行此节点。" : "已有日志和成果仍可查看。"}</small></div>}
        <AgentTaskDescription title="任务目标" text={task} />
        <div className="workflow-inspector-facts"><span>{logs.length} 条活动</span>{presentation.progress && <span>{presentation.progress.completed}/{presentation.progress.total} 项工作</span>}{presentation.files > 0 && <span>{presentation.files} 个变更文件</span>}{presentation.checks && <span>{presentation.checks}</span>}</div>
      </>}
      {activeView === "activity" && <>
        <AgentTaskDescription text={task} />
        {error && <p className="workflow-inspector-issue" role="status">{error}</p>}
        <AgentConversation key={executionId} scrollRef={followOutput.containerRef} className="agent-conversation workflow-drawer-logs" logs={logs} status={status} provider={provider === "auto" ? "agent" : provider} providerLabel={providerName} messageLabel={title} workspaceId={workspaceId} renderMessage={renderMessage} showProvider={false} showFilters={false} hiddenCategories={["search"]} emptyText="尚无活动日志" />
      </>}
      {activeView === "result" && result && <WorkflowAgentResults result={result} onOpenFile={onOpenFile} onCopyPath={onCopyPath} />}
      {activeView !== "activity" && onOpenFolder && <button type="button" className="workflow-open-result-folder" onClick={onOpenFolder}><FolderOpen size={14} />{workflowFolderLabel(props.executionTarget)}</button>}
    </div>
  </AgentDrawer>;
}

function WorkflowAgentResults({ result, onOpenFile, onCopyPath }: { result: WorkflowAgentResult; onOpenFile?: (path: string) => void; onCopyPath?: (path: string) => void }) {
  return <div className="workflow-result-view">
    <section className="workflow-inspector-summary"><small>执行成果</small><p>{result.humanSummary}</p></section>
    {!!result.outputs.length && <section><h4>交付产物</h4><div className="workflow-result-list">{result.outputs.map((output) => <div key={output.id}>{output.path && onOpenFile ? <button type="button" onClick={() => onOpenFile(output.path!)}><strong>{output.description}</strong><small>{output.path}</small></button> : <><strong>{output.description}</strong><small>{output.path || "文本成果"}</small></>}{output.path && onCopyPath && <button type="button" title="复制路径" onClick={() => onCopyPath(output.path!)}><Copy size={12} /></button>}</div>)}</div></section>}
    {!!result.changedFiles.length && <details className="workflow-inspector-section"><summary>文件变更 <span>{result.changedFiles.length}</span></summary><div className="workflow-result-list">{result.changedFiles.map((file) => <div key={file}><code>{file}</code></div>)}</div></details>}
    {!!result.checks.length && <section><h4><FileCheck2 size={13} />验收 <span>{result.checks.filter((check) => check.status === "passed").length}/{result.checks.length} 通过</span></h4>{result.checks.map((check, index) => <details className="workflow-inspector-check" key={`${check.name}-${index}`}><summary><i className={`workflow-check-dot ${check.status}`} /><strong>{check.name}</strong><span>{check.status === "passed" ? "通过" : check.status === "failed" ? "未通过" : "未执行"}</span></summary>{check.command && <code>{check.command}</code>}{check.exitCode !== null && <small>退出码 {check.exitCode}</small>}{check.evidence && <pre>{check.evidence}</pre>}</details>)}</section>}
    {!!result.decisions.length && <details className="workflow-inspector-section"><summary>关键决策 <span>{result.decisions.length}</span></summary><div className="workflow-result-list">{result.decisions.map((decision) => <div key={decision.key}><strong>{decision.key}：{decision.value}</strong><small>{decision.reason}</small></div>)}</div></details>}
    {(result.handoff.facts.length > 0 || result.handoff.constraints.length > 0 || result.handoff.nextAgentInstructions.length > 0) && <details className="workflow-inspector-section"><summary>下游交接</summary><div className="workflow-result-list">{[...result.handoff.facts, ...result.handoff.constraints, ...result.handoff.nextAgentInstructions].map((text, index) => <div key={index}><small>{text}</small></div>)}</div></details>}
    {(result.warnings.length > 0 || result.unresolved.length > 0) && <section className="workflow-inspector-issue"><h4>待处理事项</h4>{[...new Set([...result.warnings, ...result.unresolved])].map((text) => <p key={text}>{text}</p>)}</section>}
  </div>;
}
