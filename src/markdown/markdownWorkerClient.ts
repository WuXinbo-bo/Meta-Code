import { MARKDOWN_RICH_CHAR_BUDGET, markdownRenderPlan, type MarkdownRenderPlan } from "./markdownPlan";
import { isMarkdownWorkerResponse, type MarkdownWorkerRequest } from "./markdownWorkerProtocol";

export type MarkdownPlanOptions = {
  signal?: AbortSignal;
};

export type MarkdownWorkerClientOptions = {
  workerFactory?: () => Worker;
  fallback?: (source: string) => MarkdownRenderPlan;
};

type Subscriber = {
  resolve: (plan: MarkdownRenderPlan) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
};

type PendingPlan = {
  id: number;
  source: string;
  dispatched: boolean;
  fallbackQueued: boolean;
  subscribers: Map<number, Subscriber>;
};

function createAbortError() {
  if (typeof DOMException === "function") return new DOMException("Markdown planning was cancelled", "AbortError");
  const error = new Error("Markdown planning was cancelled");
  error.name = "AbortError";
  return error;
}

function defaultWorkerFactory() {
  return new Worker(new URL("./markdown.worker.ts", import.meta.url), {
    type: "module",
    name: "markdown-render-planner"
  });
}

export class MarkdownWorkerClient {
  private readonly workerFactory: () => Worker;
  private readonly fallback: (source: string) => MarkdownRenderPlan;
  private readonly pendingById = new Map<number, PendingPlan>();
  private readonly pendingBySource = new Map<string, PendingPlan>();
  private worker: Worker | null = null;
  private workerUnavailable = false;
  private disposed = false;
  private nextRequestId = 1;
  private nextSubscriberId = 1;

  constructor(options: MarkdownWorkerClientOptions = {}) {
    this.workerFactory = options.workerFactory || defaultWorkerFactory;
    this.fallback = options.fallback || markdownRenderPlan;
  }

  plan(source: string, options: MarkdownPlanOptions = {}): Promise<MarkdownRenderPlan> {
    if (this.disposed) return Promise.reject(new Error("Markdown worker client has been disposed"));
    if (options.signal?.aborted) return Promise.reject(createAbortError());
    if (source.length > MARKDOWN_RICH_CHAR_BUDGET) {
      try {
        return Promise.resolve(this.fallback(source));
      } catch (error) {
        return Promise.reject(error);
      }
    }

    let pending = this.pendingBySource.get(source);
    let shouldDispatch = false;
    if (!pending) {
      pending = {
        id: this.nextRequestId++,
        source,
        dispatched: false,
        fallbackQueued: false,
        subscribers: new Map()
      };
      this.pendingById.set(pending.id, pending);
      this.pendingBySource.set(source, pending);
      shouldDispatch = true;
    }

    const target = pending;
    const subscriberId = this.nextSubscriberId++;
    const result = new Promise<MarkdownRenderPlan>((resolve, reject) => {
      const subscriber: Subscriber = { resolve, reject, signal: options.signal };
      if (options.signal) {
        subscriber.abortListener = () => this.cancelSubscriber(target, subscriberId);
        options.signal.addEventListener("abort", subscriber.abortListener, { once: true });
      }
      target.subscribers.set(subscriberId, subscriber);
    });

    if (shouldDispatch) queueMicrotask(() => this.dispatch(target));
    return result;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error("Markdown worker client has been disposed");
    for (const pending of [...this.pendingById.values()]) this.rejectPending(pending, error);
    this.detachWorker();
  }

  private dispatch(pending: PendingPlan) {
    if (!this.isPending(pending) || pending.subscribers.size === 0 || pending.fallbackQueued) return;
    const worker = this.ensureWorker();
    if (!worker) {
      this.queueFallback(pending);
      return;
    }

    pending.dispatched = true;
    try {
      const request: MarkdownWorkerRequest = { type: "plan", id: pending.id, source: pending.source };
      worker.postMessage(request);
    } catch (error) {
      this.handleWorkerFailure(error);
    }
  }

  private ensureWorker() {
    if (this.workerUnavailable || this.disposed) return null;
    if (this.worker) return this.worker;
    let candidate: Worker | null = null;
    try {
      candidate = this.workerFactory();
      candidate.addEventListener("message", this.handleMessage);
      candidate.addEventListener("error", this.handleError);
      candidate.addEventListener("messageerror", this.handleMessageError);
      this.worker = candidate;
      return candidate;
    } catch {
      candidate?.terminate();
      this.workerUnavailable = true;
      return null;
    }
  }

  private readonly handleMessage = (event: MessageEvent<unknown>) => {
    if (!isMarkdownWorkerResponse(event.data)) return;
    const pending = this.pendingById.get(event.data.id);
    if (!pending) return;
    if (event.data.type === "planned") this.resolvePending(pending, event.data.plan);
    else this.queueFallback(pending);
  };

  private readonly handleError = (event: ErrorEvent) => {
    event.preventDefault();
    this.handleWorkerFailure(event.error || new Error(event.message || "Markdown worker failed"));
  };

  private readonly handleMessageError = () => {
    this.handleWorkerFailure(new Error("Markdown worker returned an unreadable response"));
  };

  private handleWorkerFailure(_error: unknown) {
    this.workerUnavailable = true;
    this.detachWorker();
    for (const pending of [...this.pendingById.values()]) this.queueFallback(pending);
  }

  private queueFallback(pending: PendingPlan) {
    if (!this.isPending(pending) || pending.fallbackQueued) return;
    pending.fallbackQueued = true;
    queueMicrotask(() => {
      if (!this.isPending(pending) || pending.subscribers.size === 0) return;
      try {
        this.resolvePending(pending, this.fallback(pending.source));
      } catch (error) {
        this.rejectPending(pending, error);
      }
    });
  }

  private cancelSubscriber(pending: PendingPlan, subscriberId: number) {
    const subscriber = pending.subscribers.get(subscriberId);
    if (!subscriber) return;
    pending.subscribers.delete(subscriberId);
    this.cleanupSubscriber(subscriber);
    subscriber.reject(createAbortError());
    if (pending.subscribers.size > 0) return;

    this.removePending(pending);
    if (pending.dispatched && this.worker) {
      const request: MarkdownWorkerRequest = { type: "cancel", id: pending.id };
      try {
        this.worker.postMessage(request);
      } catch {
        this.handleWorkerFailure(new Error("Unable to cancel Markdown worker request"));
      }
    }
  }

  private resolvePending(pending: PendingPlan, plan: MarkdownRenderPlan) {
    if (!this.isPending(pending)) return;
    this.removePending(pending);
    for (const subscriber of pending.subscribers.values()) {
      this.cleanupSubscriber(subscriber);
      subscriber.resolve(plan);
    }
    pending.subscribers.clear();
  }

  private rejectPending(pending: PendingPlan, reason: unknown) {
    if (!this.isPending(pending)) return;
    this.removePending(pending);
    for (const subscriber of pending.subscribers.values()) {
      this.cleanupSubscriber(subscriber);
      subscriber.reject(reason);
    }
    pending.subscribers.clear();
  }

  private removePending(pending: PendingPlan) {
    this.pendingById.delete(pending.id);
    if (this.pendingBySource.get(pending.source) === pending) this.pendingBySource.delete(pending.source);
  }

  private isPending(pending: PendingPlan) {
    return this.pendingById.get(pending.id) === pending;
  }

  private cleanupSubscriber(subscriber: Subscriber) {
    if (subscriber.signal && subscriber.abortListener) {
      subscriber.signal.removeEventListener("abort", subscriber.abortListener);
    }
  }

  private detachWorker() {
    if (!this.worker) return;
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleError);
    this.worker.removeEventListener("messageerror", this.handleMessageError);
    this.worker.terminate();
    this.worker = null;
  }
}

const defaultMarkdownWorkerClient = new MarkdownWorkerClient();

export function planMarkdownRender(source: string, options?: MarkdownPlanOptions) {
  return defaultMarkdownWorkerClient.plan(source, options);
}

export function disposeMarkdownWorker() {
  defaultMarkdownWorkerClient.dispose();
}
