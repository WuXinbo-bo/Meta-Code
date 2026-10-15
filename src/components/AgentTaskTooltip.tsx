import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Keep task summaries outside scroll/containment boundaries in logs and drawers. */
export function AgentTaskTooltip({ name, provider, status, summary, children, className = "" }: {
  name: string;
  provider: string;
  status: string;
  summary?: string;
  children: (descriptionId: string | undefined) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const tooltip = tooltipRef.current?.getBoundingClientRect();
      if (!trigger || !tooltip) return;
      const fitsLeft = trigger.left - tooltip.width - 8 >= 8;
      const left = fitsLeft ? trigger.left - tooltip.width - 8 : trigger.right + 8;
      setPosition({
        left: Math.max(8, Math.min(left, window.innerWidth - tooltip.width - 8)),
        top: Math.max(8, Math.min(trigger.top + trigger.height / 2 - tooltip.height / 2, window.innerHeight - tooltip.height - 8))
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (tooltipRef.current) observer.observe(tooltipRef.current);
    if (triggerRef.current) observer.observe(triggerRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  return <span ref={triggerRef} className={`agent-task-tooltip-trigger ${className}`.trim()}
    onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
    onFocusCapture={() => setOpen(true)} onBlurCapture={() => setOpen(false)}
    onClickCapture={() => setOpen(false)} onKeyDown={(event) => {
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    }}>
    {children(open ? id : undefined)}
    {open && createPortal(<div id={id} ref={tooltipRef} role="tooltip" className="agent-task-tooltip" style={position}>
      <strong>{name}</strong>
      <small>{provider} · {status}</small>
      <p>{summary?.trim() || "点击查看委派任务与活动日志"}</p>
    </div>, document.body)}
  </span>;
}
