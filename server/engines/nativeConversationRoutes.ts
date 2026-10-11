import type { Express } from "express";
import { DEFAULT_NATIVE_OPTIONS, normalizeNativeOptions, type NativeConversationOptions, type NativeInteractionBroker } from "./nativeInteraction.js";

type Session = { id: string; engine: string; status: string; engineSessionId: string | null; nativeForkSourceId?: string; nativeOptions?: NativeConversationOptions };
export function registerNativeConversationRoutes(app: Express, host: {
  broker: NativeInteractionBroker;
  session: (id: string, owner: string) => Session | undefined;
  busy: (id: string) => boolean;
  agents: (id: string, owner: string) => Promise<{ name: string; displayName: string; description?: string }[]>;
  save: (id: string, owner: string, options: NativeConversationOptions) => Promise<void>;
  fork: (id: string, owner: string) => Promise<unknown>;
}) {
  const root = "/api/sessions/:id/native";
  app.use(root, (req, res, next) => {
    const session = host.session(String(req.params.id), req.authUser!.id);
    if (!session || !["codex", "claude"].includes(session.engine)) return res.status(404).json({ error: "任务不存在或不是原生 Provider" });
    next();
  });
  app.get(root, async (req, res) => {
    try {
      const session = host.session(String(req.params.id), req.authUser!.id)!;
      res.setHeader("Cache-Control", "no-store");
      const agents = await host.agents(session.id, req.authUser!.id);
      res.json({ options: session.nativeOptions || DEFAULT_NATIVE_OPTIONS, agents, canFork: Boolean(session.engineSessionId) && !session.nativeForkSourceId && !host.busy(session.id), busy: host.busy(session.id) });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.patch(root, async (req, res) => {
    try {
      const id = String(req.params.id), owner = req.authUser!.id;
      if (host.busy(id)) return res.status(409).json({ error: "请等待当前原生执行结束后调整模式" });
      const options = normalizeNativeOptions(req.body);
      if (options.customAgent && !(await host.agents(id, owner)).some(agent => agent.name === options.customAgent)) throw new Error("此自定义 Agent 不在当前项目或原生配置中");
      if (host.busy(id)) return res.status(409).json({ error: "任务已开始执行，请结束后调整模式" });
      await host.save(id, owner, options);
      res.json({ options });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get(root + "/requests", (req, res) => { res.setHeader("Cache-Control", "no-store"); res.json({ requests: host.broker.list(String(req.params.id), req.authUser!.id) }); });
  app.post(root + "/requests/:requestId", (req, res) => {
    try { host.broker.answer(String(req.params.id), req.authUser!.id, String(req.params.requestId), req.body); res.json({ ok: true }); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post(root + "/fork", async (req, res) => {
    try {
      if (host.busy(String(req.params.id))) return res.status(409).json({ error: "请先结束当前执行，再创建原生分支" });
      res.status(201).json(await host.fork(String(req.params.id), req.authUser!.id));
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
