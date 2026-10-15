import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

export function ActionMenu({ label, children, className = "", ownerId }: { label: string; children: ReactNode; className?: string; ownerId?: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const visibleChoices = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || [])
    .filter((button) => button.getClientRects().length > 0);
  const close = (restore = false) => { setOpen(false); if (restore) triggerRef.current?.focus(); };
  const closeAfterAction = () => {
    close();
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) triggerRef.current?.focus();
    });
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const menu = menuRef.current?.getBoundingClientRect();
      if (trigger && menu) setPosition({ left: Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8)), top: Math.max(8, Math.min(trigger.bottom + 6, window.innerHeight - menu.height - 8)) });
    };
    place();
    visibleChoices()[0]?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) close();
    };
    const observe = new ResizeObserver(place);
    if (menuRef.current) observe.observe(menuRef.current);
    if (triggerRef.current) observe.observe(triggerRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", dismiss);
    return () => { observe.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); document.removeEventListener("pointerdown", dismiss); };
  }, [open]);
  return <>
    <button ref={triggerRef} type="button" className={`action-menu-trigger ${className}`} title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((current) => !current)}><MoreHorizontal size={16} /></button>
    {open && createPortal(<div ref={menuRef} className={`action-menu-popup ${className}`} role="menu" aria-label={label} data-panel-owner={ownerId} style={{ left: position.left, top: position.top }} onBlur={(event) => {
      const target = event.relatedTarget;
      if (target instanceof Node && !menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    }} onClickCapture={(event) => {
      // A dialog opened by an action must remember a stable return target;
      // the clicked menu item disappears when this Portal closes.
      if (event.target instanceof Element && event.target.closest("button") && !event.target.closest(".task-usage-details")) triggerRef.current?.focus();
    }} onClick={(event) => { if (event.target instanceof Element && event.target.closest("button") && !event.target.closest(".task-usage-details")) closeAfterAction(); }} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
      const choices = visibleChoices();
      const index = choices.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); choices[(index + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length]?.focus(); }
      if (event.key === "Tab") {
        // The menu lives at the end of body in a Portal. Continue keyboard
        // navigation from its trigger, rather than tabbing into hidden items
        // or losing focus when the popup is removed.
        event.preventDefault();
        const outside = Array.from(document.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]"))
          .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest("[inert], [aria-hidden='true']") && !menuRef.current?.contains(element));
        const triggerIndex = outside.indexOf(triggerRef.current!);
        const next = outside[(triggerIndex + (event.shiftKey ? -1 : 1) + outside.length) % outside.length];
        close();
        (next || triggerRef.current)?.focus();
      }
    }}>{children}</div>, document.body)}
  </>;
}
