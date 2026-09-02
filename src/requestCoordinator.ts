export type RequestCoordinationMode = "coalesce" | "replace";

export interface CoordinatedRequestOptions {
  /** Existing callers keep the original coalescing behavior by default. */
  mode?: RequestCoordinationMode;
  /** Bind the request to a generation returned by beginGeneration(). */
  generation?: number;
}

type RequestFactory<T> = (signal: AbortSignal) => Promise<T>;

interface PendingRequest {
  promise: Promise<unknown>;
  controller: AbortController;
  generation?: number;
}

function abortError(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string" && reason
      ? reason
      : fallback;
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function makeAbortable<T>(source: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void source.catch(() => undefined);
    return Promise.reject(abortError(signal.reason, "Request cancelled"));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError(signal.reason, "Request cancelled")));

    signal.addEventListener("abort", onAbort, { once: true });
    source.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

/**
 * Coordinates resource reads by key.
 *
 * run() remains backward-compatible and coalesces concurrent reads. New
 * navigation code can use beginGeneration() and runLatest() to prevent an old
 * response from winning after the user has moved to another resource.
 */
export class RequestCoordinator {
  private readonly pending = new Map<string, PendingRequest>();
  private activeGeneration = 0;

  get currentGeneration() {
    return this.activeGeneration;
  }

  get pendingCount() {
    return this.pending.size;
  }

  /** Starts a new navigation generation and cancels generation-bound older work. */
  beginGeneration() {
    this.activeGeneration += 1;
    for (const [key, entry] of this.pending) {
      if (entry.generation !== undefined && entry.generation < this.activeGeneration) {
        this.abortEntry(key, entry, "Superseded by a newer navigation");
      }
    }
    return this.activeGeneration;
  }

  /** Semantic alias for call sites that coordinate page/workspace navigation. */
  beginNavigation() {
    return this.beginGeneration();
  }

  isCurrentGeneration(generation: number) {
    return generation === this.activeGeneration;
  }

  run<T>(
    key: string,
    request: RequestFactory<T>,
    options: CoordinatedRequestOptions = {}
  ): Promise<T> {
    const generation = options.generation;
    if (generation !== undefined && !this.isCurrentGeneration(generation)) {
      return Promise.reject(abortError(undefined, "Stale navigation generation"));
    }

    const existing = this.pending.get(key);
    if (existing) {
      const backgroundMayJoinNavigation = generation === undefined && existing.generation !== undefined;
      if (options.mode !== "replace" && (existing.generation === generation || backgroundMayJoinNavigation)) {
        return existing.promise as Promise<T>;
      }
      this.abortEntry(key, existing, "Superseded by a newer request");
    }

    const controller = new AbortController();
    let source: Promise<T>;
    try {
      source = Promise.resolve(request(controller.signal));
    } catch (error) {
      source = Promise.reject(error);
    }
    const promise = makeAbortable(source, controller.signal);
    const entry: PendingRequest = { promise, controller, generation };
    this.pending.set(key, entry);
    void promise.finally(() => {
      if (this.pending.get(key) === entry) this.pending.delete(key);
    }).catch(() => undefined);
    return promise;
  }

  runLatest<T>(
    key: string,
    request: RequestFactory<T>,
    options: Omit<CoordinatedRequestOptions, "mode"> = {}
  ) {
    return this.run(key, request, { ...options, mode: "replace" });
  }

  cancel(key: string, reason = "Request cancelled") {
    const entry = this.pending.get(key);
    if (!entry) return false;
    this.abortEntry(key, entry, reason);
    return true;
  }

  cancelGeneration(generation: number, reason = "Navigation cancelled") {
    let cancelled = 0;
    for (const [key, entry] of this.pending) {
      if (entry.generation === generation) {
        this.abortEntry(key, entry, reason);
        cancelled += 1;
      }
    }
    return cancelled;
  }

  cancelAll(reason = "All requests cancelled") {
    const cancelled = this.pending.size;
    for (const [key, entry] of this.pending) this.abortEntry(key, entry, reason);
    return cancelled;
  }

  private abortEntry(key: string, entry: PendingRequest, reason: string) {
    if (this.pending.get(key) === entry) this.pending.delete(key);
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(abortError(undefined, reason));
    }
  }
}
