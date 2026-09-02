export const DEFAULT_TASK_TIMEOUT_MINUTES = 120;
export const MIN_TASK_TIMEOUT_MINUTES = 1;
export const MAX_TASK_TIMEOUT_MINUTES = 24 * 60;
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60_000;

export class WorkbenchTimeoutError extends Error {
  readonly code = "WORKBENCH_TIMEOUT";
  constructor(readonly scope: "main" | "delegated" | "inactivity", message: string) {
    super(message);
    this.name = "WorkbenchTimeoutError";
  }
}

export function timeoutMinutes(value: unknown, fallback = DEFAULT_TASK_TIMEOUT_MINUTES) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_TASK_TIMEOUT_MINUTES, Math.max(MIN_TASK_TIMEOUT_MINUTES, Math.round(parsed)));
}

export function deadlineFromMinutes(minutes: number, now = Date.now()) {
  return new Date(now + timeoutMinutes(minutes) * 60_000).toISOString();
}

export function remainingDeadlineMs(deadlineAt: string | undefined, now = Date.now()) {
  if (!deadlineAt) return Number.POSITIVE_INFINITY;
  const deadline = Date.parse(deadlineAt);
  return Number.isFinite(deadline) ? Math.max(0, deadline - now) : 0;
}

export function armDeadline(
  controller: AbortController,
  deadlineAt: string,
  scope: "main" | "delegated",
  label: string
) {
  const remaining = remainingDeadlineMs(deadlineAt);
  if (remaining <= 0) {
    controller.abort(new WorkbenchTimeoutError(scope, `${label}已达到执行时限`));
    return undefined;
  }
  const timer = setTimeout(() => {
    controller.abort(new WorkbenchTimeoutError(scope, `${label}已达到执行时限`));
  }, Math.min(remaining, 2_147_483_647));
  timer.unref();
  return timer;
}

export function timeoutReason(signal: AbortSignal) {
  return signal.reason instanceof WorkbenchTimeoutError ? signal.reason : null;
}
