import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode, type UIEvent } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { ActivityTimeline } from "./ActivityTimeline";
import { AgentWorkProgress, agentWorkProgressLabel } from "./AgentWorkProgress";
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
  showFilters?: boolean;
  hiddenCategories?: readonly import("./activityModel").ActivityCategory[];
  emptyText?: string;
  className?: string;
  loading?: boolean;
  error?: string;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  showProgress?: boolean;
};

export function useAgentOutputFollow(version: string, identity = "") {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const scrollIntentRef = useRef(0);
  const [following, setFollowing] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    if (!followingRef.current) {
      setPendingCount((count) => count + 1);
      return;
    }
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [version, scrollToBottom]);

  useEffect(() => {
    followingRef.current = true;
    setFollowing(true);
    setPendingCount(0);
    scrollIntentRef.current = 0;
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [identity, scrollToBottom]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const markIntent = () => { scrollIntentRef.current = performance.now(); };
    const onWheel = (event: WheelEvent) => {
      markIntent();
      if (event.deltaY < 0) {
        followingRef.current = false;
        setFollowing(false);
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target === container || event.pointerType === "touch") markIntent();
      // Expanding details is reading history, not a request to jump to the end.
      if ((event.target as Element).closest?.("summary")) {
        followingRef.current = false;
        setFollowing(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (["Enter", " "].includes(event.key) && (event.target as Element).closest?.("summary")) {
        followingRef.current = false;
        setFollowing(false);
      }
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) markIntent();
    };
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("pointerdown", onPointer);
    container.addEventListener("keydown", onKey);
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("pointerdown", onPointer);
      container.removeEventListener("keydown", onKey);
    };
  }, []);

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
    // Virtual measurement, tab changes and viewport resize also emit scroll.
    // Only user navigation may disable following; layout must not do so.
    if (!scrollIntentRef.current || performance.now() - scrollIntentRef.current > 1_500) return;
    const target = event.currentTarget;
    const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
    followingRef.current = nearBottom;
    setFollowing(nearBottom);
    if (nearBottom) setPendingCount(0);
  }, []);
  const jumpToLatest = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
    setPendingCount(0);
    scrollToBottom();
  }, [scrollToBottom]);
  return { containerRef, contentRef, onScroll, following, pendingCount, jumpToLatest };
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

export function AgentConversation({ logs, status, provider, providerLabel, providerIcon, providerAccent, messageLabel, renderMessage, workspaceId, showProvider = true, showFilters = true, hiddenCategories = [], emptyText = "尚无活动日志", className = "", loading = false, error = "", scrollRef, showProgress = true }: Props) {
  const safeLogs = Array.isArray(logs) ? logs : [];
  const version = agentStreamVersion(safeLogs);
  const progressVisible = showProgress && Boolean(agentWorkProgressLabel(status, loading && !safeLogs.length));
  return <div className={`agent-conversation-stream ${className}`.trim()}>
    {error && <p className="agent-conversation-notice" role="status">{error}，正在自动重试。{safeLogs.length > 0 ? "已有日志仍可查看。" : ""}</p>}
    <AgentConversationBoundary resetKey={version}>
      {safeLogs.length
        ? <ActivityTimeline logs={safeLogs} status={status} provider={provider} providerLabel={providerLabel} providerIcon={providerIcon} providerAccent={providerAccent} messageLabel={messageLabel} renderMessage={renderMessage} workspaceId={workspaceId} showProvider={showProvider} showFilters={showFilters} hiddenCategories={hiddenCategories} scrollRef={scrollRef} />
        : !error && !progressVisible && <p className="agent-conversation-empty" role="status">{loading ? "正在读取活动日志…" : emptyText}</p>}
    </AgentConversationBoundary>
    {progressVisible && <AgentWorkProgress status={status} loading={loading && !safeLogs.length} />}
  </div>;
}
