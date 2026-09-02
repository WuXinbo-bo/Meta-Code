export const CLAUDE_PROCESS_RECONNECT_ATTEMPTS = 3;
export const CLAUDE_STALE_PROCESS_RETRY_THRESHOLD = 2;

export type ClaudeFailureKind = "permanent" | "transient" | "protocol" | "context" | "unknown";
export type ClaudeRuntimeMode = "normal" | "planner" | "worker" | "validator";
export type ClaudeRetryPolicy = { maxRecoveries: number; reconnectOnTransientOnly?: boolean };

export const CLAUDE_DEFAULT_RETRY_POLICY: ClaudeRetryPolicy = { maxRecoveries: 2, reconnectOnTransientOnly: true };

export function claudeRetryAllowed(value: unknown, status?: unknown, policy = CLAUDE_DEFAULT_RETRY_POLICY) {
  return policy.maxRecoveries > 0 && classifyClaudeFailure(value, status) === "transient";
}

export type ClaudeConnectionSettings = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
};

export class ClaudeTransportError extends Error {
  readonly retryable = true;

  constructor(message: string, readonly sessionId?: string) {
    super(message);
    this.name = "ClaudeTransportError";
  }
}

/** Classify provider failures before any reconnect or session recovery. */
export function classifyClaudeFailure(value: unknown, status?: unknown): ClaudeFailureKind {
  const text = String(value instanceof Error ? value.message : value || "").toLowerCase();
  const code = Number(status || 0);
  if ([401, 403].includes(code) || /insufficient balance|invalid api key|invalid x-api-key|authentication failed|failed to authenticate|forbidden|unauthori[sz]ed|model .*not available|account .*?(?:inactive|disabled|suspended)/i.test(text)) return "permanent";
  if (/tool|mcp|schema|invalid (?:argument|parameter)|validation|permission/i.test(text)) return "protocol";
  if (/session|context|resume|compact/i.test(text)) return "context";
  if ([408, 425, 429, 500, 502, 503, 504, 524].includes(code) || /timeout|timed out|connection reset|connection refused|socket hang up|fetch failed|econnreset|econnrefused|eai_again|service unavailable|bad gateway|gateway timeout|rate limit|too many requests|stream disconnected/i.test(text)) return "transient";
  return "unknown";
}

export function isClaudePermanentFailure(value: unknown, status?: unknown) {
  return classifyClaudeFailure(value, status) === "permanent";
}

export function isClaudeTransportError(error: unknown): error is ClaudeTransportError {
  return error instanceof ClaudeTransportError || (error instanceof Error && error.name === "ClaudeTransportError");
}

export function claudeApiRetryExhaustsProcess(item: any) {
  const attempt = Number(item?.attempt || 0);
  return attempt >= CLAUDE_STALE_PROCESS_RETRY_THRESHOLD;
}
