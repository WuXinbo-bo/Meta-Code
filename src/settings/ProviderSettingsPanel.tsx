import { useEffect, useState, type ReactNode } from "react";
import { ProviderIcon } from "../branding/ProviderIcon";
import type { ProviderControlSnapshot } from "../providers/types";
import { HelpButton } from "../help/HelpProvider";
import { ChevronDown } from "lucide-react";

function statusLabel(control: ProviderControlSnapshot) {
  if (control.lifecycle.stage === "updating") return "处理中";
  if (control.connection.status === "ready") return "已连接";
  if (control.connection.status === "checking") return "检测中";
  if (control.lifecycle.stage === "missing") return "未安装";
  return "待配置";
}

export function ProviderSettingsPanel({
  control,
  focused = false,
  subtitle,
  onFocus,
  children
}: {
  control: ProviderControlSnapshot;
  focused?: boolean;
  subtitle?: string;
  onFocus?: () => void;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(focused);
  useEffect(() => { if (focused) setExpanded(true); }, [focused]);
  return <section
    className={`settings-provider-panel unified-provider-panel ${focused ? "focused" : ""} ${expanded ? "expanded" : "collapsed"}`}
    onFocus={onFocus}
    data-provider={control.providerId}
  >
    <header onClick={() => { setExpanded((value) => !value); onFocus?.(); }}>
      <ProviderIcon provider={control.providerId} icon={control.identity.icon} accent={control.identity.accent} size={20} />
      <span>
        <strong>{control.identity.shortName}</strong>
        <small>{subtitle || control.identity.description}</small>
      </span>
      <HelpButton topic="provider-connections" />
      <div className="provider-panel-state">
        <i className={control.connection.status === "ready" ? "ready" : control.connection.status}>{statusLabel(control)}</i>
        <small>{control.identity.transport === "native" ? "原生增强" : "ACP"}</small>
      </div>
      <button type="button" className="provider-panel-toggle" aria-expanded={expanded} aria-label={expanded ? "收起配置" : "展开配置"} onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); onFocus?.(); }}><ChevronDown size={15} /></button>
    </header>
    {expanded && <div className="provider-panel-content">{children}</div>}
  </section>;
}
