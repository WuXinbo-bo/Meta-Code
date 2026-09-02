import type { ReactNode } from "react";
import { ProviderIcon } from "../branding/ProviderIcon";
import type { ProviderControlSnapshot } from "../providers/types";
import { HelpButton } from "../help/HelpProvider";

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
  return <section
    className={`settings-provider-panel unified-provider-panel ${focused ? "focused" : ""}`}
    onFocus={onFocus}
    data-provider={control.providerId}
  >
    <header>
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
    </header>
    {children}
  </section>;
}
