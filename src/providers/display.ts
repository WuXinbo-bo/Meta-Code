import type { ProviderControlSnapshot } from "./types";

export function providerShowcaseItems(items: ProviderControlSnapshot[], activeProvider = "", limit = 5) {
  const visible = items
    .filter((item) => item.lifecycle.installed && (item.lifecycle.runtimeAvailable || item.lifecycle.updating))
    .sort((left, right) => {
      const activeOrder = Number(right.providerId === activeProvider) - Number(left.providerId === activeProvider);
      if (activeOrder) return activeOrder;
      const readyOrder = Number(right.connection.status === "ready") - Number(left.connection.status === "ready");
      return readyOrder || left.identity.displayName.localeCompare(right.identity.displayName);
    });
  return { displayed: visible.slice(0, Math.max(1, limit)), overflow: visible.slice(Math.max(1, limit)) };
}

export function providerStatusLabel(status: ProviderControlSnapshot["connection"]["status"]) {
  if (status === "ready") return "已连接";
  if (status === "checking") return "检测中";
  if (status === "attention") return "需要配置";
  return "不可用";
}
