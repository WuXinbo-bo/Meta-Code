import { Component, useCallback, useEffect, useLayoutEffect, useRef, type ErrorInfo, type ReactNode, type UIEvent } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { ActivityTimeline } from "./ActivityTimeline";
import { agentStreamVersion } from "./activityModel";

type Props = {
  logs?: readonly unknown[] | null;
  status: string;
  provider: string;
  providerLabel?: string;
  providerIcon?: string;
  providerAccent?: string;
  messageLabel?: string;
  renderMessage?: (text: string) => ReactNode;
  workspaceId?: string;
  showProvider?: boolean;
  emptyText?: string;
  className?: string;
};

export function useAgentOutputFollow(version: string, identity = "") {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    if (!followingRef.current) return;
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [version, scrollToBottom]);

  useEffect(() => {
    followingRef.current = true;
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [identity, scrollToBottom]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!followingRef.current) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(scrollToBottom);
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [scrollToBottom]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    followingRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
  }, []);
  return { containerRef, contentRef, onScroll };
}

class AgentConversationBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Agent conversation render failure", error, info.componentStack);
  }
  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: "" });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="agent-conversation-fallback" role="alert">
      <AlertTriangle size={15} />
      <span><strong>部分活动暂时无法显示</strong><small>{this.state.error}</small></span>
      <button type="button" title="重新渲染活动" onClick={() => this.setState({ error: "" })}><RefreshCw size={13} /></button>
    </div>;
  }
}

export function AgentConversation({ logs, status, provider, providerLabel, providerIcon, providerAccent, messageLabel, renderMessage, workspaceId, showProvider = true, emptyText = "尚无活动日志", className = "" }: Props) {
  const safeLogs = Array.isArray(logs) ? logs : [];
  const version = agentStreamVersion(safeLogs);
  return <div className={`agent-conversation-stream ${className}`.trim()}>
    <AgentConversationBoundary resetKey={version}>
      {safeLogs.length
        ? <ActivityTimeline logs={safeLogs} status={status} provider={provider} providerLabel={providerLabel} providerIcon={providerIcon} providerAccent={providerAccent} messageLabel={messageLabel} renderMessage={renderMessage} workspaceId={workspaceId} showProvider={showProvider} />
        : <p className="agent-conversation-empty">{emptyText}</p>}
    </AgentConversationBoundary>
  </div>;
}
