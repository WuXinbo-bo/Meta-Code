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

export function providerMainAgentUnavailableReason(item: ProviderControlSnapshot | undefined) {
  if (!item) return "尚未安装或完成连接配置，请前往设置处理。";
  if (item.lifecycle.updating) return "Agent 正在安装或更新，完成后即可创建任务。";
  if (!item.lifecycle.runtimeAvailable) return item.lifecycle.message || item.connection.message || "CLI 运行时不可用，请前往设置检查安装位置。";
  if (item.connection.status !== "ready") return item.connection.message || "账号或连接尚未验证，请前往设置处理。";
  if (!item.capabilities.sessions.create) return "当前 Agent 仅支持作为子 Agent 使用，不能直接创建主任务。";
  return "当前 Agent 尚未开放主任务入口，请前往设置检查能力协商结果。";
}
