import type { Express } from "express";
import { NativeTerminalManager, type NativeTerminalOptions } from "./nativeTerminal.js";

export function registerNativeTerminalRoutes(app: Express, host: {
  manager: NativeTerminalManager;
  authorize: (sessionId: string, ownerId: string) => boolean;
  prepare: (sessionId: string, ownerId: string, input: Record<string, unknown>) => Promise<NativeTerminalOptions>;
  context?: (sessionId: string, ownerId: string) => { canFork: boolean };
}) {
  const root = "/api/sessions/:id/native-terminal";
  app.use(root, (req, res, next) => host.authorize(String(req.params.id), req.authUser!.id) ? next() : res.status(404).json({ error: "任务不存在或不支持原生终端" }));
  app.get(root, (req, res) => res.json({ terminal: host.manager.snapshot(String(req.params.id), req.authUser!.id, Number(req.query.after) || 0), context: host.context?.(String(req.params.id), req.authUser!.id) || { canFork: false } }));
  app.post(root, async (req, res) => {
    try {
      const current = host.manager.snapshot(String(req.params.id), req.authUser!.id);
      if (current?.status === "running") return res.json({ terminal: current });
      const options = await host.prepare(String(req.params.id), req.authUser!.id, req.body || {});
      return res.status(201).json({ terminal: await host.manager.start(options) });
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "原生终端启动失败" }); }
  });
  app.post(root + "/input", (req, res) => {
    try { host.manager.input(String(req.params.id), req.authUser!.id, String(req.body?.terminalId || ""), typeof req.body?.data === "string" ? req.body.data : ""); res.json({ ok: true }); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "终端输入失败" }); }
  });
  app.post(root + "/resize", (req, res) => {
    try { host.manager.resize(String(req.params.id), req.authUser!.id, String(req.body?.terminalId || ""), req.body?.cols, req.body?.rows); res.json({ ok: true }); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "终端尺寸更新失败" }); }
  });
  app.post(root + "/stop", (req, res) => { host.manager.stop(String(req.params.id), req.authUser!.id, String(req.body?.terminalId || "")); res.json({ ok: true }); });
  app.get(root + "/events", (req, res) => {
    const id = String(req.params.id), owner = req.authUser!.id;
    const latest = host.manager.snapshot(id, owner);
    const after = req.query.terminalId && req.query.terminalId !== latest?.id ? 0 : Number(req.get("Last-Event-ID") || req.query.after) || 0;
    const current = host.manager.snapshot(id, owner, after);
    if (!current) return res.status(404).json({ error: "原生终端不存在" });
    res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache"); res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    // A slow tab must not accumulate an unbounded HTTP output queue. Reconnect
    // through the bounded snapshot/replay instead of retaining every PTY write.
    const send = (event: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.writableLength > 512_000) { res.destroy(); return; }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      (res as typeof res & { flush?: () => void }).flush?.();
    };
    send({ type: "snapshot", terminal: current });
    const unsubscribe = host.manager.subscribe(id, owner, send);
    const timer = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(": heartbeat\n\n"); }, 15_000);
    req.once("close", () => { clearInterval(timer); unsubscribe(); });
  });
}
