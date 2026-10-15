import crypto from "node:crypto";

export type TraceKind = "session" | "turn" | "delegation" | "workflow" | "review";
export type TraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: TraceKind;
  name: string;
  provider?: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "ok" | "error" | "cancelled";
  attributes: Record<string, string | number | boolean>;
  error?: string;
};

function id(bytes = 12) { return crypto.randomBytes(bytes).toString("hex"); }
function safeAttributes(attributes: Record<string, unknown> | undefined) {
  return Object.fromEntries(Object.entries(attributes || {}).flatMap(([key, value]) => {
    if (/key|token|secret|password|prompt|content|authorization/i.test(key)) return [];
    if (["string", "number", "boolean"].includes(typeof value)) return [[key, value as string | number | boolean]];
    return [];
  }));
}

export class TraceRecorder {
  private readonly spans = new Map<string, TraceSpan>();
  start(kind: TraceKind, name: string, input: { traceId?: string; parentSpanId?: string; provider?: string; attributes?: Record<string, unknown> } = {}) {
    const span: TraceSpan = {
      traceId: input.traceId || id(16), spanId: id(), parentSpanId: input.parentSpanId,
      kind, name: name.slice(0, 160), provider: input.provider, startedAt: new Date().toISOString(), status: "running",
      attributes: safeAttributes(input.attributes)
    };
    this.spans.set(span.spanId, span);
    return span;
  }
  finish(spanId: string, status: Exclude<TraceSpan["status"], "running"> = "ok", error?: unknown) {
    const span = this.spans.get(spanId);
    if (!span) return undefined;
    span.status = status; span.finishedAt = new Date().toISOString();
    if (error) span.error = String(error instanceof Error ? error.message : error).slice(0, 500);
    return structuredClone(span);
  }
  get(spanId: string) { const span = this.spans.get(spanId); return span ? structuredClone(span) : undefined; }
  list(traceId?: string) { return [...this.spans.values()].filter((span) => !traceId || span.traceId === traceId).map((span) => structuredClone(span)); }
  clear(traceId?: string) {
    for (const [spanId, span] of this.spans) if (!traceId || span.traceId === traceId) this.spans.delete(spanId);
  }
}

export function traceDurationMs(span: Pick<TraceSpan, "startedAt" | "finishedAt">) {
  const end = span.finishedAt ? Date.parse(span.finishedAt) : Date.now();
  const start = Date.parse(span.startedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}
