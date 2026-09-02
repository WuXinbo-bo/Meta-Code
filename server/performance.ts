import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";

type RouteSample = { route: string; method: string; durationMs: number; status: number; at: number };
type EventLoopSample = { meanMs: number; p95Ms: number; p99Ms: number; maxMs: number; at: number };

const MAX_ROUTE_SAMPLES = 600;
const MAX_LOOP_SAMPLES = 120;

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function round(value: number) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

function normalizedRoute(req: Request) {
  const route = req.route?.path;
  if (typeof route === "string") return `${req.baseUrl || ""}${route}` || req.path;
  return req.path
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
    .replace(/\b(?:task|ws|workflow|folder|mcp)_[\w-]+\b/gi, ":id");
}

export class WorkbenchPerformanceMonitor {
  private readonly delay = monitorEventLoopDelay({ resolution: 20 });
  private readonly routes: RouteSample[] = [];
  private readonly loops: EventLoopSample[] = [];
  private readonly sampleTimer: NodeJS.Timeout;

  constructor() {
    this.delay.enable();
    this.sampleTimer = setInterval(() => this.captureEventLoop(), 5_000);
    this.sampleTimer.unref();
  }

  middleware = (req: Request, res: Response, next: NextFunction) => {
    const started = performance.now();
    res.once("finish", () => {
      const durationMs = performance.now() - started;
      this.routes.push({ route: normalizedRoute(req), method: req.method, durationMs, status: res.statusCode, at: Date.now() });
      if (this.routes.length > MAX_ROUTE_SAMPLES) this.routes.splice(0, this.routes.length - MAX_ROUTE_SAMPLES);
      if (!res.headersSent) return;
      if (durationMs >= 1_000) console.warn(`[performance] ${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(durationMs)}ms`);
    });
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = ((...args: Parameters<Response["writeHead"]>) => {
      if (!res.hasHeader("Server-Timing")) res.setHeader("Server-Timing", `app;dur=${round(performance.now() - started)}`);
      return originalWriteHead(...args);
    }) as Response["writeHead"];
    next();
  };

  snapshot() {
    const recentRoutes = this.routes.filter((sample) => sample.at >= Date.now() - 5 * 60_000);
    const grouped = new Map<string, RouteSample[]>();
    for (const sample of recentRoutes) {
      const key = `${sample.method} ${sample.route}`;
      grouped.set(key, [...(grouped.get(key) || []), sample]);
    }
    const routes = [...grouped.entries()].map(([route, samples]) => {
      const durations = samples.map((sample) => sample.durationMs);
      return {
        route,
        count: samples.length,
        p50Ms: round(percentile(durations, 0.5)),
        p95Ms: round(percentile(durations, 0.95)),
        maxMs: round(Math.max(...durations)),
        errors: samples.filter((sample) => sample.status >= 500).length
      };
    }).sort((left, right) => right.p95Ms - left.p95Ms);
    const latestLoop = this.loops.at(-1) || { meanMs: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, at: Date.now() };
    return {
      eventLoop: latestLoop,
      eventLoopHistory: this.loops.slice(-24),
      longRequests: recentRoutes.filter((sample) => sample.durationMs >= 200).length,
      routes
    };
  }

  close() {
    clearInterval(this.sampleTimer);
    this.delay.disable();
  }

  private captureEventLoop() {
    const milliseconds = (nanoseconds: number) => round(nanoseconds / 1_000_000);
    this.loops.push({
      meanMs: milliseconds(this.delay.mean),
      p95Ms: milliseconds(this.delay.percentile(95)),
      p99Ms: milliseconds(this.delay.percentile(99)),
      maxMs: milliseconds(this.delay.max),
      at: Date.now()
    });
    if (this.loops.length > MAX_LOOP_SAMPLES) this.loops.splice(0, this.loops.length - MAX_LOOP_SAMPLES);
    this.delay.reset();
  }
}

export function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
