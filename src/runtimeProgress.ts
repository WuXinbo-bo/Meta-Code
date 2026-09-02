export type RuntimeProgressClock = {
  startedAt: string;
  updatedAt: string;
  active: boolean;
};

export function runtimeProgressElapsedMs(progress: RuntimeProgressClock, now = Date.now()) {
  const startedAt = Date.parse(progress.startedAt);
  const terminalAt = Date.parse(progress.updatedAt);
  if (!Number.isFinite(startedAt)) return 0;
  const endedAt = progress.active ? now : terminalAt;
  if (!Number.isFinite(endedAt)) return 0;
  return Math.max(0, endedAt - startedAt);
}

export function formatRuntimeProgressDuration(milliseconds: number) {
  const elapsedSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return elapsedSeconds >= 60
    ? `${Math.floor(elapsedSeconds / 60)} 分 ${elapsedSeconds % 60} 秒`
    : `${elapsedSeconds} 秒`;
}
