import { useEffect, useRef, useState } from "react";

export function useHoverPanel(scope: string, pinned: boolean) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragging = useRef(false);
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => {
    setOpen(false);
    return clearTimer;
  }, [scope, pinned]);
  const close = (restoreFocus = false) => {
    clearTimer();
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const scheduleClose = () => {
    clearTimer();
    timer.current = setTimeout(() => {
      if (!dragging.current && !panelRef.current?.contains(document.activeElement) && document.activeElement !== triggerRef.current) setOpen(false);
    }, 300);
  };
  useEffect(() => {
    if (!open || pinned) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, pinned]);
  return {
    open, triggerRef, panelRef, close,
    triggerProps: {
      onMouseEnter: () => {
        if (pinned || !window.matchMedia("(hover: hover)").matches) return;
        clearTimer();
        timer.current = setTimeout(() => setOpen(true), 200);
      },
      onMouseLeave: scheduleClose,
      onClick: () => { clearTimer(); setOpen((current) => !current); },
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === "Escape") close(true);
        if (event.key === "ArrowDown") { event.preventDefault(); clearTimer(); setOpen(true); requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus()); }
      }
    },
    panelProps: {
      onMouseEnter: clearTimer,
      onMouseLeave: scheduleClose,
      onFocusCapture: clearTimer,
      onBlurCapture: scheduleClose,
      onDragStart: () => { dragging.current = true; clearTimer(); },
      onDragEnd: () => { dragging.current = false; scheduleClose(); },
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === "Escape" && !pinned) { event.preventDefault(); event.stopPropagation(); close(true); }
      }
    }
  };
}
