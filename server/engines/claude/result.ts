import type { EngineUsage } from "../types.js";

export type ClaudeTurnActivity = {
  assistantText: string;
  toolStarted: number;
  toolCompleted: number;
  permissionError?: string;
};

export type ClaudeResultValidation = {
  valid: boolean;
  retryable: boolean;
  reason?: string;
};

function usageTotal(usage: EngineUsage) {
  return usage.input_tokens + usage.cached_input_tokens + usage.output_tokens + usage.reasoning_output_tokens;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return [source.text, source.message, source.error, source.content].map(contentText).filter(Boolean).join("\n");
  }
  return "";
}

export function claudeToolPermissionError(value: unknown) {
  const text = contentText(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return /requested permissions? to use .*haven't granted|permission (?:isn't|wasn't|hasn't been|not) granted|requires approval|permission denied|not authorized|unauthori[sz]ed/i.test(text)
    ? text
    : "";
}

function isProgressOnly(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 600) return false;
  if (/已完成|完成了|结论|结果如下|分析如下|修改摘要|测试结果|无法完成|执行失败/.test(normalized)) return false;
  return /^(收到|明白|好的|现在|我将|让我|接下来)/.test(normalized)
    && /(现在|将|开始|接下来|准备).{0,32}(执行|处理|检查|审查|生成|读取|分析|修改|完成)/.test(normalized);
}

export function validateClaudeResult(item: any, usage: EngineUsage, activity: ClaudeTurnActivity): ClaudeResultValidation {
  if (activity.permissionError) {
    return { valid: false, retryable: false, reason: `Claude 工具权限未授权：${activity.permissionError}` };
  }
  if (item?.is_error || String(item?.subtype || "").includes("error")) {
    return { valid: false, retryable: false, reason: String(item?.result || item?.error || "Claude CLI 运行失败") };
  }

  const modelUsage = item?.modelUsage && typeof item.modelUsage === "object" ? Object.keys(item.modelUsage) : [];
  if (usageTotal(usage) === 0 && modelUsage.length === 0) {
    return { valid: false, retryable: true, reason: "Claude 通道返回了零 Token 的空成功包，任务实际未执行" };
  }

  if (String(item?.stop_reason || "") === "tool_use") {
    return { valid: false, retryable: true, reason: "Claude 返回停在工具调用阶段，工具链尚未形成最终结果" };
  }
  if (String(item?.stop_reason || "") === "max_tokens") {
    return { valid: false, retryable: true, reason: "Claude 输出达到本轮 Token 上限，任务尚未形成完整结果" };
  }

  const resultText = String(item?.result || activity.assistantText || "").trim();
  if (activity.toolStarted > activity.toolCompleted) {
    return { valid: false, retryable: true, reason: `Claude 仍有 ${activity.toolStarted - activity.toolCompleted} 个工具调用没有结束` };
  }
  if (isProgressOnly(resultText)) {
    return { valid: false, retryable: true, reason: "Claude 只返回了开始执行的说明，没有交付实际结果" };
  }

  return { valid: true, retryable: false };
}
