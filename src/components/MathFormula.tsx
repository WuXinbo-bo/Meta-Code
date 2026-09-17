import { useEffect, useRef, useState } from "react";
import { renderFormula } from "../markdown/mathRenderer";
import { DeferredContent } from "./DeferredContent";

export function PagedSource({ text }: { text: string }) {
  const size = 12_000;
  const count = Math.max(1, Math.ceil(text.length / size));
  return <span className="paged-source">
    <span className="source-scroll">{Array.from({ length: count }, (_, index) => <DeferredContent inline key={index} initial={index === 0} estimate={600}><code>{text.slice(index * size, (index + 1) * size)}</code></DeferredContent>)}</span>
    <button onClick={() => void navigator.clipboard.writeText(text)}>复制完整源码</button>
  </span>;
}

export function MathFormula({ source, display = false }: { source: string; display?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ source: string; html?: string; error?: string }>();
  const [showSource, setShowSource] = useState(false);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "400px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setResult(undefined);
    void renderFormula(source, display, controller.signal).then(html => { if (!controller.signal.aborted) setResult({ source, html }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ source, error: String(error.message || error) }); });
    return () => controller.abort();
  }, [source, display, visible, attempt]);
  const current = result?.source === source ? result : undefined;
  return <span ref={ref} className={`math-formula ${display ? "math-formula-display" : ""}`}>
    {current?.html ? <span dangerouslySetInnerHTML={{ __html: current.html }} /> : <span role="status">{current?.error || "公式排版中…"}</span>}
    {current?.error && <><button onClick={() => setShowSource(!showSource)}>{showSource ? "收起源码" : "查看公式源码"}</button><button onClick={() => setAttempt(attempt + 1)}>重试公式</button>{showSource && <PagedSource text={source} />}</>}
  </span>;
}
