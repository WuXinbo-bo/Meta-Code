/** Bound stream-driven reads and retain a trailing update while a request is in flight. */
export function coalescedWorkflowRefresh(refresh: () => Promise<unknown>, delayMs = 250) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let running = false;
  let disposed = false;
  const schedule = () => {
    if (disposed) return;
    pending = true;
    if (timer || running) return;
    timer = setTimeout(() => {
      timer = undefined;
      pending = false;
      running = true;
      void refresh().catch(() => undefined).finally(() => {
        running = false;
        if (pending) schedule();
      });
    }, delayMs);
  };
  return { schedule, dispose() { disposed = true; clearTimeout(timer); } };
}
