import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ProviderIcon } from "./ProviderIcon";
import { providerShowcaseItems, providerStatusLabel } from "../providers/display";
import type { ProviderControlSnapshot } from "../providers/types";

export function ConnectedProviderShowcase({ items, activeProvider, onSelect }: {
  items: ProviderControlSnapshot[];
  activeProvider?: string;
  onSelect(providerId: string): void;
}) {
  const { displayed, overflow } = providerShowcaseItems(items, activeProvider, 5);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!overflowOpen) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOverflowOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOverflowOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [overflowOpen]);
  if (!displayed.length) return null;
  return <div ref={rootRef} className="connected-provider-showcase" aria-label="已安装并可用的 AI Agent">
    <div className="connected-provider-icons">
      {displayed.map((item) => {
        const statusLabel = providerStatusLabel(item.connection.status);
        return <button
          type="button"
          key={item.providerId}
          className={`connected-provider-item ${item.connection.status} ${item.providerId === activeProvider ? "active" : ""}`}
          onClick={() => onSelect(item.providerId)}
          title={`${item.identity.displayName} · ${statusLabel}${item.lifecycle.version ? ` · ${item.lifecycle.version}` : ""}\n${item.connection.message}`}
          aria-label={`${item.identity.displayName}，${statusLabel}`}
        >
          <ProviderIcon provider={item.providerId} icon={item.identity.icon} accent={item.identity.accent} size={20} />
          <i aria-hidden="true" />
        </button>;
      })}
      {overflow.length > 0 && <button
        type="button"
        className="connected-provider-overflow"
        onClick={() => setOverflowOpen((value) => !value)}
        title={overflow.map((item) => `${item.identity.displayName} · ${providerStatusLabel(item.connection.status)}`).join("\n")}
        aria-label={`还有 ${overflow.length} 个 Agent`}
        aria-expanded={overflowOpen}
      ><MoreHorizontal size={18} /><small>+{overflow.length}</small></button>}
    </div>
    {overflowOpen && <div className="connected-provider-overflow-menu" role="menu">
      {overflow.map((item) => <button type="button" role="menuitem" key={item.providerId} onClick={() => { setOverflowOpen(false); onSelect(item.providerId); }}><ProviderIcon provider={item.providerId} icon={item.identity.icon} accent={item.identity.accent} size={18} /><span><strong>{item.identity.shortName}</strong><small>{providerStatusLabel(item.connection.status)}</small></span></button>)}
    </div>}
  </div>;
}
