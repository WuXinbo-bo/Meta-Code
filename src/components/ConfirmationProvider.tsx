import { AlertTriangle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type ConfirmationRequest = {
  title?: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  resolve: (accepted: boolean) => void;
};

let presentConfirmation: ((request: ConfirmationRequest) => void) | null = null;

export function confirmAction(message: string, options: Omit<ConfirmationRequest, "message" | "resolve"> = {}) {
  if (!presentConfirmation) return Promise.resolve(window.confirm(message));
  return new Promise<boolean>((resolve) => presentConfirmation?.({ message, resolve, ...options }));
}

export function ConfirmationProvider({ children }: { children: React.ReactNode }) {
  const [requests, setRequests] = useState<ConfirmationRequest[]>([]);
  const request = requests[0] || null;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    presentConfirmation = (next) => setRequests((current) => [...current, next]);
    return () => { presentConfirmation = null; };
  }, []);

  useEffect(() => {
    if (!request) return;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])") || [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [request]);

  const finish = (accepted: boolean) => {
    request?.resolve(accepted);
    setRequests((current) => current.slice(1));
  };

  return <>
    {children}
    {request && <div className="confirmation-layer" role="presentation">
      <button type="button" className="confirmation-backdrop" aria-label="取消" onClick={() => finish(false)} />
      <section ref={dialogRef} className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-message">
        <header><AlertTriangle size={18} /><strong id="confirmation-title">{request.title || (request.destructive ? "确认删除" : "确认操作")}</strong><button type="button" aria-label="关闭" onClick={() => finish(false)}><X size={16} /></button></header>
        <p id="confirmation-message">{request.message}</p>
        <footer><button ref={cancelRef} type="button" onClick={() => finish(false)}>取消</button><button type="button" className={request.destructive ? "danger" : "primary"} onClick={() => finish(true)}>{request.confirmLabel || (request.destructive ? "确认删除" : "继续")}</button></footer>
      </section>
    </div>}
  </>;
}
