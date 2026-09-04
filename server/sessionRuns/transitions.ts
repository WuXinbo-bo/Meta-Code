export type RunAbortIntent = "pause" | "stop" | "steer" | "shutdown" | "timeout";
export type RunControlAction = "pause" | "stop";

const INTENT_LABELS: Record<RunAbortIntent, string> = {
  pause: "暂停",
  stop: "停止",
  steer: "应用引导",
  shutdown: "关闭工作台",
  timeout: "清理超时任务"
};

/** Repeated requests wait for one transition; only a different action conflicts. */
export function runTransitionConflict(intent: RunAbortIntent | undefined, requested: RunControlAction) {
  if (intent === requested) return null;
  const label = intent ? INTENT_LABELS[intent] : "切换运行状态";
  return `任务正在${label}，请等待当前状态切换完成后再${INTENT_LABELS[requested]}`;
}
