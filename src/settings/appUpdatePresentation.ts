import type { AppUpdateStatus } from "./appUpdate";

export type AppUpdateResultKind = "current" | "available" | "incompatible" | "failed";

export function appUpdateResult(status: AppUpdateStatus) {
  if (status.checkState === "error" || status.source.state === "error") return {
    kind: "failed" as const,
    title: "暂时无法检查更新",
    message: "未能连接更新服务，请检查网络后重试。"
  };
  if (status.updateAvailable && status.release && !status.release.compatible) return {
    kind: "incompatible" as const,
    title: `发现 Meta Code ${status.release.version}`,
    message: "此版本需要先处理数据兼容问题，请查看更新说明后再操作。"
  };
  if (status.updateAvailable && status.release) return {
    kind: "available" as const,
    title: `发现 Meta Code ${status.release.version}`,
    message: `当前版本 ${status.product.currentVersion}，新版本已经可以使用。`
  };
  return {
    kind: "current" as const,
    title: "已是最新版本",
    message: `Meta Code ${status.product.currentVersion} 已是当前频道的最新版本。`
  };
}
