import crypto from "node:crypto";

/**
 * Provider-neutral lifecycle hooks. Hooks are deliberately kept outside of
 * provider adapters so native sessions, managed delegation and orchestration
 * can share the same observability and policy extension points.
 */
export const HOOK_KINDS = ["session", "tool", "permission", "subagent", "compact"] as const;
export type HookKind = (typeof HOOK_KINDS)[number];
/** Compatibility aliases used by integrations that call these lifecycle phases "types". */
export type HookType = HookKind;
export const HOOK_TYPES = HOOK_KINDS;

export type HookContext = {
  kind: HookKind;
  event: string;
  providerId?: string;
  sessionId?: string;
  taskId?: string;
  payload?: unknown;
  signal: AbortSignal;
  metadata?: Readonly<Record<string, unknown>>;
};

export type HookMatcher = {
  event?: string | readonly string[];
  providerId?: string | readonly string[];
  sessionId?: string | readonly string[];
  taskId?: string | readonly string[];
  /** A predicate is useful for tool names and permission scopes. */
  where?: (context: HookContext) => boolean | Promise<boolean>;
};

export type HookHandlerResult = unknown;
export type HookHandler = (context: HookContext) => HookHandlerResult | Promise<HookHandlerResult>;

export type HookRegistration = {
  id?: string;
  kind: HookKind;
  event?: string | readonly string[];
  matcher?: HookMatcher;
  priority?: number;
  timeoutMs?: number;
  handler: HookHandler;
  /** Optional label shown in diagnostics; never included in agent prompts. */
  label?: string;
};

export type RegisteredHook = Omit<HookRegistration, "handler"> & { id: string };
export type HookExecutionStatus = "completed" | "failed" | "timeout" | "skipped";
export type HookExecution = {
  id: string;
  kind: HookKind;
  event: string;
  status: HookExecutionStatus;
  durationMs: number;
  value?: unknown;
  error?: string;
};

export type HookDispatchResult = {
  kind: HookKind;
  event: string;
  executions: HookExecution[];
  /** True when one or more handlers failed or timed out. */
  degraded: boolean;
};

export type HookRegistryOptions = {
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  onError?: (error: { hook: RegisteredHook; context: HookContext; error: unknown; status: "failed" | "timeout" }) => void;
};

type StoredHook = RegisteredHook & { handler: HookHandler; order: number };

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function valuesMatch(actual: string | undefined, expected: string | readonly string[] | undefined) {
  if (expected === undefined) return true;
  if (actual === undefined) return false;
  return (Array.isArray(expected) ? expected : [expected]).some((value) => value === actual);
}

function isMatch(hook: StoredHook, context: HookContext) {
  if (hook.kind !== context.kind) return false;
  const matcher = hook.matcher || {};
  const event = hook.event ?? matcher.event;
  return valuesMatch(context.event, event)
    && valuesMatch(context.providerId, matcher.providerId)
    && valuesMatch(context.sessionId, matcher.sessionId)
    && valuesMatch(context.taskId, matcher.taskId);
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parentSignal?: AbortSignal) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new HookTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref();
  });
  const parentAbort = parentSignal ? new Promise<never>((_, reject) => {
    onAbort = () => { controller.abort(); reject(new Error("Hook 已被调用方取消")); };
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener("abort", onAbort, { once: true });
  }) : undefined;
  try {
    return await Promise.race([run(controller.signal), timeout, ...(parentAbort ? [parentAbort] : [])]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && parentSignal) parentSignal.removeEventListener("abort", onAbort);
  }
}

export class HookTimeoutError extends Error {
  readonly code = "HOOK_TIMEOUT";
  constructor(readonly timeoutMs: number) {
    super(`Hook 执行超时（${timeoutMs}ms）`);
    this.name = "HookTimeoutError";
  }
}

/** A small in-process registry. Every handler is isolated from the next one. */
export class HookRegistry {
  private readonly hooks = new Map<string, StoredHook>();
  private order = 0;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly onError?: HookRegistryOptions["onError"];

  constructor(options: HookRegistryOptions = {}) {
    this.defaultTimeoutMs = Math.max(1, Math.floor(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.maxTimeoutMs = Math.max(this.defaultTimeoutMs, Math.floor(options.maxTimeoutMs ?? MAX_TIMEOUT_MS));
    this.onError = options.onError;
  }

  register(input: HookRegistration): RegisteredHook {
    if (!HOOK_KINDS.includes(input.kind)) throw new Error(`未知 Hook 类型：${String(input.kind)}`);
    if (typeof input.handler !== "function") throw new TypeError("Hook handler 必须是函数");
    const id = input.id?.trim() || `hook-${crypto.randomUUID()}`;
    if (this.hooks.has(id)) throw new Error(`Hook 已注册：${id}`);
    const timeoutMs = input.timeoutMs === undefined ? undefined : Math.min(this.maxTimeoutMs, Math.max(1, Math.floor(input.timeoutMs)));
    const stored: StoredHook = { ...input, id, timeoutMs, order: this.order++, handler: input.handler };
    this.hooks.set(id, stored);
    return this.publicHook(stored);
  }

  add(input: HookRegistration) { return this.register(input); }

  unregister(id: string) { return this.hooks.delete(id); }
  remove(id: string) { return this.unregister(id); }

  clear(kind?: HookKind) {
    for (const [id, hook] of this.hooks) if (!kind || hook.kind === kind) this.hooks.delete(id);
  }

  list(kind?: HookKind): RegisteredHook[] {
    return [...this.hooks.values()]
      .filter((hook) => !kind || hook.kind === kind)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.order - b.order)
      .map((hook) => this.publicHook(hook));
  }

  async dispatch(input: Omit<HookContext, "signal"> & { signal?: AbortSignal }): Promise<HookDispatchResult> {
    const base: HookContext = { ...input, signal: input.signal || new AbortController().signal };
    const candidates = [...this.hooks.values()]
      .filter((hook) => isMatch(hook, base))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.order - b.order);
    const executions: HookExecution[] = [];
    for (const hook of candidates) {
      let matches = true;
      let matcherFailed = false;
      try { matches = hook.matcher?.where ? await hook.matcher.where(base) : true; }
      catch (error) {
        matches = false;
        matcherFailed = true;
        const execution: HookExecution = { id: hook.id, kind: hook.kind, event: base.event, status: "failed", durationMs: 0, error: asErrorMessage(error) };
        executions.push(execution);
        this.onError?.({ hook: this.publicHook(hook), context: base, error, status: "failed" });
      }
      if (!matches && !matcherFailed) {
        executions.push({ id: hook.id, kind: hook.kind, event: base.event, status: "skipped", durationMs: 0 });
        continue;
      }
      const started = Date.now();
      const context = { ...base, signal: base.signal };
      try {
        const timeoutMs = Math.min(this.maxTimeoutMs, Math.max(1, Math.floor(hook.timeoutMs ?? this.defaultTimeoutMs)));
        const value = await withTimeout((signal) => Promise.resolve(hook.handler({ ...context, signal })), timeoutMs, base.signal);
        executions.push({ id: hook.id, kind: hook.kind, event: base.event, status: "completed", durationMs: Date.now() - started, value });
      } catch (error) {
        const status = error instanceof HookTimeoutError ? "timeout" : "failed";
        executions.push({ id: hook.id, kind: hook.kind, event: base.event, status, durationMs: Date.now() - started, error: asErrorMessage(error) });
        this.onError?.({ hook: this.publicHook(hook), context: base, error, status });
      }
    }
    return { kind: base.kind, event: base.event, executions, degraded: executions.some((item) => item.status === "failed" || item.status === "timeout") };
  }

  run(input: Omit<HookContext, "signal"> & { signal?: AbortSignal }) { return this.dispatch(input); }

  private publicHook(hook: StoredHook): RegisteredHook {
    const { handler: _handler, order: _order, ...publicValue } = hook;
    return { ...publicValue };
  }
}

export function createHookRegistry(options?: HookRegistryOptions) { return new HookRegistry(options); }

export const HookManager = HookRegistry;
