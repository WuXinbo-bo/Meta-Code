export type NativeFeatureDiagnostic = {
  id: string;
  label: string;
  status: "unverified" | "disabled" | "unavailable";
  message: string;
  action: string;
};

/** Local configuration is evidence of intent, never of endpoint support. */
export function nativeFeatureDiagnostics(input: {
  providerId: string;
  available: boolean;
  baseUrl?: string;
  webSearch?: string;
  platform?: NodeJS.Platform;
}): NativeFeatureDiagnostic[] {
  if (!["codex", "claude"].includes(input.providerId)) return [];
  let officialEndpoint = !input.baseUrl;
  try {
    if (input.baseUrl) {
      const endpoint = new URL(input.baseUrl);
      officialEndpoint = endpoint.protocol === "https:" && endpoint.hostname === (input.providerId === "codex" ? "api.openai.com" : "api.anthropic.com");
    }
  } catch { officialEndpoint = false; }
  const items: NativeFeatureDiagnostic[] = input.providerId === "codex" ? [{
    id: "native.web-search", label: "原生联网搜索",
    status: input.webSearch === "disabled" ? "disabled" : "unverified",
    message: input.webSearch === "disabled" ? "搜索策略已关闭。" : officialEndpoint
      ? "已请求原生搜索；仍需在当前模型会话中验证实际搜索工具及结果。"
      : "兼容接口的聊天连接成功不代表提供原生搜索；需验证端点、模型和运行时。",
    action: input.webSearch === "disabled" ? "在执行设置中启用搜索后实测。" : "检查真实搜索工具事件；缺失时使用支持该能力的连接，或配置独立 MCP 搜索。"
  }] : [{
    id: "native.agent-teams", label: "Agent Teams（实验性）", status: "unverified",
    message: "需要官方交互 CLI、实验开关和成功的启动初始化；启动 403 不能据此认定为 Teams 权限问题。",
    action: "在原生终端启用 Teams；先解决实际失败域名的网络或认证错误，再验证团队创建、通信及结束。"
  }];
  items.push({
    id: "native.interactive-commands", label: "官方交互命令", status: "unverified",
    message: "终端入口与 CLI 参数声明不代表每条命令均已验证。",
    action: "在原生终端逐项验证 fork、计划与权限审批；需要官方远程服务的命令单独记录。"
  });
  if ((input.platform || process.platform) === "win32") items.push({
    id: "native.conpty", label: "Windows ConPTY", status: "unverified",
    message: "需在 Windows 运行真实 PTY、输入、缩放及进程结束测试。",
    action: "运行 npm run test:native-terminal；再验证安装包中的官方 CLI。"
  });
  if (!input.available) return items.map((item) => ({ ...item, status: "unavailable", message: "运行时不可用，暂时无法验证该能力。", action: "先准备官方 CLI 运行环境。" }));
  return items;
}
