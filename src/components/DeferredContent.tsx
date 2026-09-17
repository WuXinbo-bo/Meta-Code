import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";

/** Continuous document shell: retain measured space, mount expensive content only
 * near the viewport. Native scrolling works for both drawers and file previews. */
export function DeferredContent({ children, estimate = 400, initial = false, anchor, inline = false }: {
  children: ReactNode; estimate?: number; initial?: boolean; anchor?: string; inline?: boolean;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState(initial);
  const height = useRef(estimate);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") { setActive(true); return; }
    const observer = new IntersectionObserver(entries => {
      const entry = entries[0];
      // Preserve keyboard focus and text selection while the user interacts.
      const focused = node.contains(document.activeElement) || (window.getSelection()?.anchorNode && node.contains(window.getSelection()!.anchorNode));
      setActive(entry.isIntersecting || Boolean(focused));
    }, { rootMargin: "900px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!active || !ref.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => { const next = entries[0]?.borderBoxSize?.[0]?.blockSize || ref.current?.getBoundingClientRect().height; if (next) height.current = next; });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [active]);
  const Tag = inline ? "span" : "div";
  return <Tag ref={node => { ref.current = node; }} id={anchor} className="deferred-content" data-content-active={active} style={{ display: "block", minHeight: active ? undefined : height.current, "--deferred-height": `${height.current}px` } as CSSProperties}>
    {active ? children : null}
  </Tag>;
}
