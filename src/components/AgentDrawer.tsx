import { useEffect, useRef, type ReactNode } from "react";
import type { useAgentOutputFollow } from "./AgentConversation";

/** Shared shell; each caller retains its own execution state and controls. */
export function AgentDrawer({ title, header, navigation, followOutput, children, className = "", onClose }: {
  title: string;
  header: ReactNode;
  navigation?: ReactNode;
  followOutput: ReturnType<typeof useAgentOutputFollow>;
  children: ReactNode;
  className?: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <div className="agent-drawer-backdrop" onMouseDown={onClose}>
    <aside ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${title}日志`} className={`agent-drawer ${className}`} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, textarea, select, summary, [tabindex="0"]')).filter((element) => element.getClientRects().length);
      const first = targets[0];
      const last = targets.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panelRef.current)) { event.preventDefault(); first.focus(); }
    }}>
      {header}
      <div className="agent-drawer-navigation">{navigation}</div>
      <div className="agent-drawer-body" ref={followOutput.containerRef} onScroll={followOutput.onScroll}>
        <div className="agent-drawer-content" ref={followOutput.contentRef}>{children}</div>
      </div>
    </aside>
  </div>;
}

export function AgentTaskDescription({ title = "当前任务", text }: { title?: string; text: string }) {
  return <details className="agent-task-description"><summary>{title}<span>{text}</span></summary><p>{text}</p></details>;
}
