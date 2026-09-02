import type { ProviderControlSnapshot } from "../providers/types";
import { ProviderConnectionControl } from "./ProviderConnectionControl";
import { ProviderSettingsPanel } from "./ProviderSettingsPanel";

export function InstalledProviderConnections({ controls, focusedProvider, onProviderChange }: { controls: ProviderControlSnapshot[]; focusedProvider: string; onProviderChange: (providerId: string) => void }) {
  return <>{controls.filter((control) => control.identity.transport === "acp").map((control) => <ProviderSettingsPanel
    key={control.providerId}
    control={control}
    focused={focusedProvider === control.providerId}
    subtitle={control.operations.dynamicSessionConfig ? "ACP 标准连接 · 模型与模式由 Agent 动态提供" : "ACP 标准连接"}
    onFocus={() => onProviderChange(control.providerId)}
  >
    <ProviderConnectionControl providerId={control.providerId} control={control} title="账号与连接" />
  </ProviderSettingsPanel>)}</>;
}
