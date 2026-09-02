import { Activity, Brain, Check, ChevronRight, Eye, FileCode2, PlugZap, Search, TerminalSquare, Wrench, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { ProviderIcon } from "../branding/ProviderIcon";
import { activityVisualTier, type SharedAgentLog } from "./activityModel";

export type { SharedAgentLog } from "./activityModel";

type FileDiffPreview = { path: string; available: boolean; reason: string; additions: number; deletions: number; lines: string[]; truncated: boolean; binary: boolean; scope?: "event" | "turn" | "workspace"; artifactId?: string };
type CommandPreviewData = { command: string; cwd: string; output: string; exitCode: number | null; durationMs: number | null; status: string };

const COMMAND_OUTPUT_CHAR_LIMIT = 12_000;
const COMMAND_OUTPUT_LINE_LIMIT = 220;

function objectValue(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function firstText(...values: unknown[]) {
  return values.find((value) => typeof value === "string" && value.trim()) as string | undefined || "";
}

function firstNumber(...values: unknown[]) {
  const value = values.find((item) => typeof item === "number" && Number.isFinite(item));
  return typeof value === "number" ? value : null;
}

function commandPreviewData(log: SharedAgentLog): CommandPreviewData {
  const detail = objectValue(log.detail);
  const input = objectValue(detail.input);
  const command = firstText(detail.command, input.command, input.cmd, input.script);
  const explicitOutput = firstText(detail.output, detail.aggregated_output, detail.stdout, detail.stderr);
  const textAsOutput = log.phase === "completed" || log.phase === "failed" ? log.text : "";
  const output = firstText(explicitOutput, textAsOutput === command ? "" : textAsOutput).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  return {
    command: command || (log.phase === "started" || log.phase === "running" ? log.text : ""),
    cwd: firstText(detail.cwd, detail.workdir, input.cwd, input.workdir),
    output,
    exitCode: firstNumber(detail.exitCode, detail.exit_code),
    durationMs: firstNumber(detail.durationMs, detail.duration_ms),
    status: firstText(detail.status) || log.phase || "started"
  };
}

export function commandActivitySummary(log: SharedAgentLog) {
  return commandPreviewData(log).command || log.text || "命令内容未提供";
}

function boundedCommandOutput(output: string) {
  const lines = output.split(/\r?\n/);
  const hiddenLines = Math.max(0, lines.length - COMMAND_OUTPUT_LINE_LIMIT);
  let text = lines.slice(-COMMAND_OUTPUT_LINE_LIMIT).join("\n");
  const hiddenCharacters = Math.max(0, text.length - COMMAND_OUTPUT_CHAR_LIMIT);
  if (hiddenCharacters) text = text.slice(-COMMAND_OUTPUT_CHAR_LIMIT);
  return { text, hiddenLines, hiddenCharacters };
}

function formatCommandDuration(durationMs: number) {
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}

function CommandExecutionPreview({ log }: { log: SharedAgentLog }) {
  const preview = commandPreviewData(log);
  const output = boundedCommandOutput(preview.output);
  const statusLabel = log.phase === "failed" || preview.status === "failed" ? "执行失败"
    : log.phase === "completed" || preview.status === "completed" ? "执行完成"
    : "执行中";
  return <div className="command-execution-preview">
    <div className="command-preview-line"><span aria-hidden="true">›</span><code>{preview.command || "命令内容未提供"}</code></div>
    <div className="command-preview-meta">
      <span className={log.phase === "failed" ? "failed" : log.phase === "completed" ? "completed" : "running"}>{statusLabel}</span>
      {preview.exitCode !== null && <span>exit {preview.exitCode}</span>}
      {preview.durationMs !== null && <span>{formatCommandDuration(preview.durationMs)}</span>}
      {preview.cwd && <code title={preview.cwd}>{preview.cwd}</code>}
    </div>
    {output.text
      ? <div className="command-output-preview">
          {(output.hiddenLines > 0 || output.hiddenCharacters > 0) && <small>终端输出较长，已显示末尾片段（最多 {COMMAND_OUTPUT_LINE_LIMIT} 行 / {COMMAND_OUTPUT_CHAR_LIMIT.toLocaleString()} 字符）</small>}
          <pre>{output.text}</pre>
        </div>
      : <p className="command-output-empty">暂无终端输出</p>}
  </div>;
}

function fileChangePaths(detail: unknown) {
  if (!detail || typeof detail !== "object") return [];
  const record = detail as Record<string, unknown>;
  const changes = Array.isArray(record.changes) ? record.changes : [];
  const paths = changes.map((change) => change && typeof change === "object" ? String((change as Record<string, unknown>).path || "") : "");
  const input = record.input && typeof record.input === "object" ? record.input as Record<string, unknown> : {};
  paths.push(String(input.file_path || input.path || input.notebook_path || ""));
  return [...new Set(paths.map((value) => value.trim()).filter(Boolean))];
}

function FileChangePreview({ workspaceId, paths, eventDiffs }: { workspaceId: string; paths: string[]; eventDiffs?: Record<string, Omit<FileDiffPreview, "path">> }) {
  const [previews, setPreviews] = useState<FileDiffPreview[] | null>(null);
  const [error, setError] = useState("");
  const [artifactLoading, setArtifactLoading] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    Promise.all(paths.map(async (filePath) => {
      const eventDiff = eventDiffs?.[filePath];
      if (eventDiff) return { path: filePath, ...eventDiff, available: eventDiff.available !== false, reason: eventDiff.reason || "" } satisfies FileDiffPreview;
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/file-diff?path=${encodeURIComponent(filePath)}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || `无法读取 ${filePath} 的变更`);
      return body as FileDiffPreview;
    })).then(setPreviews).catch((reason) => {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => controller.abort();
  }, [paths.join("\n"), workspaceId, eventDiffs]);
  const loadArtifact = async (preview: FileDiffPreview) => {
    if (!preview.artifactId || artifactLoading) return;
    setArtifactLoading(preview.artifactId);
    setError("");
    try {
      const response = await fetch(`/api/activity-artifacts/${encodeURIComponent(preview.artifactId)}`, { credentials: "same-origin", cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || "无法读取完整事件差异");
      const lines = String(body?.content || "").trimEnd().split(/\r?\n/);
      setPreviews((current) => current?.map((item) => item.path === preview.path ? { ...item, lines, truncated: false } : item) || current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setArtifactLoading("");
    }
  };
  if (error) return <p className="file-diff-state error">{error}</p>;
  if (!previews) return <p className="file-diff-state">正在读取轻量变更...</p>;
  return <div className="file-diff-previews">
    {previews.map((preview) => <section className="file-diff-preview" key={preview.path}>
      <header><code>{preview.path}</code>{preview.available && <span><i>+{preview.additions}</i><b>-{preview.deletions}</b></span>}</header>
      {preview.available
        ? <pre>{preview.lines.map((line, index) => <span className={line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : "context"} key={`${index}:${line}`}><code>{line || " "}</code></span>)}</pre>
        : <p>{preview.reason}</p>}
      {preview.truncated && <small>仅显示前 {preview.lines.length} 行。{preview.artifactId && <button type="button" disabled={artifactLoading === preview.artifactId} onClick={() => void loadArtifact(preview)}>{artifactLoading === preview.artifactId ? "正在加载..." : "加载完整事件差异"}</button>}</small>}
    </section>)}
  </div>;
}

export function AgentReplyContent({ text, renderMessage }: { text: unknown; renderMessage?: (text: string) => ReactNode }) {
  const messageText = typeof text === "string" && text ? text : "已更新任务进度";
  if (renderMessage) return <>{renderMessage(messageText)}</>;
  return messageText.length > 120_000
    ? <div className="agent-markdown-message safe-plain"><p>回复内容较大，已切换为纯文本安全预览。</p><pre>{messageText.slice(0, 180_000)}</pre></div>
    : <div className="agent-markdown-message"><ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{messageText}</ReactMarkdown></div>;
}

export function AgentActivityEntry({
  log,
  status,
  provider,
  providerLabel,
  providerIcon,
  providerAccent,
  messageLabel,
  renderMessage,
  workspaceId,
  expanded = false
}: {
  log: SharedAgentLog;
  status: string;
  provider: string;
  providerLabel?: string;
  providerIcon?: string;
  providerAccent?: string;
  messageLabel?: string;
  renderMessage?: (text: string) => ReactNode;
  workspaceId?: string;
  expanded?: boolean;
}) {
  const [open, setOpen] = useState(expanded);
  const time = new Date(log.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (log.transient) {
    return <div className="agent-thinking-line" role="status">
      <Brain size={13} />
      <span>{log.title || "Thinking"}</span>
      <i aria-hidden="true"><b /><b /><b /></i>
    </div>;
  }
  if (log.kind === "reasoning" || log.category === "reasoning") {
    return <div className="agent-thinking-line settled"><Brain size={13} /><span>思考</span></div>;
  }
  if (log.kind === "message") {
    return <article className="agent-chat-message">
      <span className={`agent-chat-avatar ${provider}`}><ProviderIcon provider={provider} icon={providerIcon} accent={providerAccent} size={18} /></span>
      <div>
        <header><strong>{log.title === "最终回复" ? "最终回复" : messageLabel || log.title || "Agent"}<em className={`agent-provider-badge ${provider}`}>{providerLabel || provider}</em></strong><time>{time}</time></header>
        <AgentReplyContent text={log.text} renderMessage={renderMessage} />
      </div>
    </article>;
  }
  const isError = log.kind === "error";
  const isStatus = log.kind === "status";
  const phase = (log as SharedAgentLog & { phase?: string }).phase || "started";
  // A timeline can contain mixed outcomes. Use this entry's phase rather than
  // the parent group status so one failed command cannot color every row red.
  const entryStatus = isError || phase === "failed"
    ? "failed"
    : phase === "completed"
      ? "completed"
      : phase === "running"
        ? "running"
        : status;
  const icon = isError ? <X size={13} />
    : log.category === "command" ? <TerminalSquare size={13} />
        : log.category === "file" ? <FileCode2 size={13} />
          : log.category === "read" ? <Eye size={13} />
            : log.category === "search" ? <Search size={13} />
              : log.category === "mcp" ? <PlugZap size={13} />
                : log.category === "tool" ? <Wrench size={13} />
                  : isStatus ? (log.title.includes("完成") ? <Check size={13} /> : <Activity size={13} />) : <Check size={13} />;
  const command = log.category === "command";
  const summary = (command ? commandActivitySummary(log) : log.text || "状态已更新").replace(/\s+/g, " ").trim();
  const visualTier = activityVisualTier((log.category || "status") as Parameters<typeof activityVisualTier>[0]);
  const changedPaths = log.category === "file" ? fileChangePaths(log.detail) : [];
  const eventDiffs = log.detail && typeof log.detail === "object" && !Array.isArray(log.detail)
    ? (log.detail as Record<string, unknown>).eventDiffs as Record<string, Omit<FileDiffPreview, "path">> | undefined
    : undefined;
  return <details className={`agent-stream-event activity-visual-${visualTier} ${log.kind} category-${log.category || "status"} phase-${phase}`} open={expanded || undefined} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <span className={`agent-event-icon ${entryStatus}`}>{icon}</span>
      <span><strong>{log.title}</strong><small>{summary.length > 160 ? `${summary.slice(0, 160)}...` : summary}</small></span>
      <time>{time}</time><span className="agent-stream-group-count" aria-hidden="true" /><ChevronRight className="agent-event-chevron" size={14} />
    </summary>
    {open && <div className="agent-event-detail">
      {command
        ? <CommandExecutionPreview log={log} />
        : <p>{log.text || "状态已更新"}</p>}
      {workspaceId && changedPaths.length > 0 && <FileChangePreview workspaceId={workspaceId} paths={changedPaths} eventDiffs={eventDiffs} />}
      {!command && log.detail !== undefined && <details><summary>技术详情</summary><pre>{JSON.stringify(log.detail, null, 2)}</pre></details>}
    </div>}
  </details>;
}
