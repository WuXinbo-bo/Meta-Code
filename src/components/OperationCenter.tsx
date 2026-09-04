import { Check, ChevronDown, CircleAlert, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { realtimeCoordinator } from "../realtimeCoordinator";

type Operation = { id: string; title: string; message: string; active: boolean; failed: boolean; updatedAt: string };

function operationFrom(detail: Record<string, unknown>, kind: string): Operation {
  const id = String(detail.runtimeId || detail.providerId || kind);
  const phase = String(detail.phase || detail.status || "");
  const active = detail.active === true || ["queued", "resolving", "downloading", "extracting", "installing", "activating", "checking"].includes(phase);
  return {
    id: `${kind}:${id}`,
    title: kind === "runtime" ? `${id} CLI` : kind === "market" ? `${id} Agent` : "软件更新",
    message: String(detail.message || (active ? "正在处理" : phase === "failed" ? "操作失败" : "操作已完成")),
    active,
    failed: phase === "failed" || detail.ok === false,
    updatedAt: String(detail.updatedAt || new Date().toISOString())
  };
}

export function OperationCenter() {
  const [open, setOpen] = useState(false);
  const [operations, setOperations] = useState<Operation[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const record = (kind: string) => (detail: Record<string, unknown>) => setOperations((current) => {
      const operation = operationFrom(detail, kind);
      return [operation, ...current.filter((item) => item.id !== operation.id)].slice(0, 12);
    });
    const unsubscribers = [
      realtimeCoordinator.subscribe("runtime.install", record("runtime")),
      realtimeCoordinator.subscribe("agent-market.install", record("market")),
      realtimeCoordinator.subscribe("app-update.changed", record("update"))
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const activeCount = useMemo(() => operations.filter((item) => item.active).length, [operations]);
  if (!operations.length) return null;
  return <div ref={rootRef} className="operation-center">
    <button type="button" className="operation-center-trigger" aria-expanded={open} title="后台操作" onClick={() => setOpen((value) => !value)}>{activeCount ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}<span>{activeCount ? `${activeCount} 项处理中` : "操作完成"}</span><ChevronDown size={12} /></button>
    {open && <section className="operation-center-panel" role="status" aria-live="polite"><header><strong>后台操作</strong><button type="button" aria-label="关闭" onClick={() => setOpen(false)}><X size={14} /></button></header>{operations.map((item) => <div key={item.id} className={item.failed ? "failed" : item.active ? "active" : "done"}>{item.failed ? <CircleAlert size={15} /> : item.active ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}<span><strong>{item.title}</strong><small>{item.message}</small></span><time>{new Date(item.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>)}</section>}
  </div>;
}
