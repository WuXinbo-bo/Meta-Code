// One active worker bounds CPU use. A stuck expression is terminated independently.
type Job = { source: string; display: boolean; signal: AbortSignal; resolve: (html: string) => void; reject: (error: Error) => void };
const queue: Job[] = [];
const cache = new Map<string, string>();
let cacheBytes = 0;
let busy = false;
let worker: Worker | undefined;
const keyFor = (source: string, display: boolean) => `${display}:${source}`;
function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  if (job.signal.aborted) { job.reject(new DOMException("Cancelled", "AbortError")); pump(); return; }
  const key = keyFor(job.source, job.display);
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); job.resolve(cached); pump(); return; }
  busy = true;
  let timer: ReturnType<typeof setTimeout>;
  const finish = (html?: string, error?: Error) => {
    clearTimeout(timer);
    job.signal.removeEventListener("abort", abort);
    if (error) { worker?.terminate(); worker = undefined; job.reject(error); }
    else {
      if (html && (html.length + key.length) * 2 <= 2_000_000) {
        cache.set(key, html); cacheBytes += (html.length + key.length) * 2;
        while (cacheBytes > 4_000_000 || cache.size > 256) {
          const oldest = cache.entries().next().value!;
          cacheBytes -= (oldest[0].length + oldest[1].length) * 2; cache.delete(oldest[0]);
        }
      }
      job.resolve(html || "");
    }
    busy = false; pump();
  };
  const abort = () => finish(undefined, new DOMException("Cancelled", "AbortError"));
  try {
    worker ||= new Worker(new URL("./math.worker.ts", import.meta.url), { type: "module", name: "formula-renderer" });
    worker.onmessage = e => e.data.error ? finish(undefined, new Error(e.data.error)) : finish(e.data.html);
    worker.onerror = e => { e.preventDefault(); finish(undefined, new Error("公式渲染不可用，可查看源码或重试。")); };
    worker.onmessageerror = () => finish(undefined, new Error("公式渲染结果无法读取"));
    timer = setTimeout(() => finish(undefined, new Error("此公式排版耗时较长，已保留完整源码，可重试。")), 5000);
    job.signal.addEventListener("abort", abort, { once: true });
    worker.postMessage({ source: job.source, display: job.display });
  } catch { finish(undefined, new Error("公式渲染不可用，可查看完整源码。")); }
}
export function renderFormula(source: string, display: boolean, signal: AbortSignal): Promise<string> {
  if (source.length > 2_000_000) return Promise.reject(new Error("此单一公式较大，可分段阅读完整源码。"));
  return new Promise((resolve, reject) => { queue.push({ source, display, signal, resolve, reject }); pump(); });
}
