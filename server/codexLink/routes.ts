import os from "node:os";
import path from "node:path";
import express from "express";
import { CodexAppServerClient } from "./appServerClient.js";
import { CodexLinkRepository } from "./repository.js";
import type { CodexLinkBinding } from "./types.js";

type WorkspaceRef = { id: string; ownerUserId: string; root: string };
type SessionRef = { id: string; ownerUserId: string; workspaceId: string; engine: string; codexThreadId?: string | null; status?: string };

type CodexLinkDependencies = {
  repository: CodexLinkRepository;
  getCodexExecutable: () => Promise<string>;
  getWorkspace: (workspaceId: string, ownerUserId: string) => WorkspaceRef | undefined;
  getSession: (sessionId: string, ownerUserId: string) => SessionRef | undefined;
  activateBinding?: (binding: CodexLinkBinding) => Promise<void> | void;
  deactivateBinding?: (binding: CodexLinkBinding) => Promise<void> | void;
  onThreadChanged?: (threadId: string, action: string, ownerUserId: string) => Promise<void> | void;
  officialHome?: string;
};

export function createCodexLinkRouter(dependencies: CodexLinkDependencies) {
  const router = express.Router();
  const officialHome = path.resolve(dependencies.officialHome || process.env.META_CODEX_LINK_HOME || path.join(os.homedir(), ".codex"));
  let client: CodexAppServerClient | null = null;
  let clientExecutable = "";

  const appServer = async () => {
    const executable = await dependencies.getCodexExecutable();
    if (!executable) throw new Error("未找到 Codex CLI，无法连接官方会话");
    if (!client || clientExecutable !== executable) {
      client?.close();
      client = new CodexAppServerClient(executable, officialHome);
      clientExecutable = executable;
    }
    return client;
  };

  const workspaceForRequest = (workspaceId: string, ownerUserId: string) => {
    const workspace = dependencies.getWorkspace(workspaceId, ownerUserId);
    if (!workspace) throw new Error("工作区不存在");
    return workspace;
  };

  const assertThreadInWorkspace = (threadCwd: string, workspace: WorkspaceRef) => {
    if (!threadCwd) throw new Error("官方线程缺少工作目录，无法确认其归属");
    if (path.resolve(threadCwd).toLowerCase() !== path.resolve(workspace.root).toLowerCase()) {
      throw new Error("该线程不属于当前工作区");
    }
  };

  const publicHome = "用户级 Codex 目录";
  const assertCanManageOfficialThreads = (role: string) => {
    if (role !== "owner" && role !== "admin") throw new Error("只有工作台所有者或管理员可以修改官方 Codex 线程");
  };

  router.get("/status", async (req, res) => {
    try {
      const executable = await dependencies.getCodexExecutable();
      if (!executable) return res.json({ available: false, officialHome: publicHome, executableAvailable: false, message: "未找到 Codex CLI" });
      await (await appServer()).health();
      res.json({ available: true, officialHome: publicHome, executableAvailable: true, message: "已连接官方 Codex 会话存储" });
    } catch (error) {
      res.json({ available: false, officialHome: publicHome, executableAvailable: Boolean(clientExecutable), message: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/threads", async (req, res) => {
    try {
      const ownerUserId = req.authUser!.id;
      const workspace = workspaceForRequest(String(req.query.workspaceId || ""), ownerUserId);
      const result = await (await appServer()).listThreads(workspace.root, req.query.cursor ? String(req.query.cursor) : null);
      const bindings = dependencies.repository.list(ownerUserId, workspace.id).map((binding) => {
        const thread = result.threads.find((item) => item.id === binding.threadId);
        if (!thread || binding.threadName || binding.threadPreview) return binding;
        return dependencies.repository.bind({
          ...binding,
          threadName: thread.name,
          threadPreview: thread.preview
        });
      });
      res.json({ ...result, bindings });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/threads/:threadId", async (req, res) => {
    try {
      const ownerUserId = req.authUser!.id;
      const workspace = workspaceForRequest(String(req.query.workspaceId || ""), ownerUserId);
      const result = await (await appServer()).readThread(req.params.threadId, true);
      assertThreadInWorkspace(result.thread.cwd, workspace);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch("/threads/:threadId/metadata", async (req, res) => {
    try {
      assertCanManageOfficialThreads(req.authUser!.role);
      const name = String(req.body?.name || "").trim();
      if (!name) throw new Error("线程名称不能为空");
      await (await appServer()).setThreadName(req.params.threadId, name.slice(0, 120));
      await dependencies.onThreadChanged?.(req.params.threadId, "rename", req.authUser!.id);
      res.json({ ok: true, name: name.slice(0, 120) });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  router.post("/threads/:threadId/archive", async (req, res) => {
    try {
      assertCanManageOfficialThreads(req.authUser!.role);
      const source = await (await appServer()).readThread(req.params.threadId, false);
      if (source.thread.status.type === "active") return res.status(409).json({ error: "官方线程仍在执行，不能归档" });
      await (await appServer()).archiveThread(req.params.threadId);
      await dependencies.onThreadChanged?.(req.params.threadId, "archive", req.authUser!.id);
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  router.post("/threads/:threadId/unarchive", async (req, res) => {
    try {
      assertCanManageOfficialThreads(req.authUser!.role);
      const thread = await (await appServer()).unarchiveThread(req.params.threadId);
      await dependencies.onThreadChanged?.(req.params.threadId, "unarchive", req.authUser!.id);
      res.json({ thread });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  router.delete("/threads/:threadId", async (req, res) => {
    try {
      assertCanManageOfficialThreads(req.authUser!.role);
      if (req.body?.confirmDescendants !== true) return res.status(400).json({ error: "必须确认永久删除线程及其派生线程" });
      const source = await (await appServer()).readThread(req.params.threadId, false);
      if (source.thread.status.type === "active") return res.status(409).json({ error: "官方线程仍在执行，不能删除" });
      await (await appServer()).deleteThread(req.params.threadId);
      await dependencies.onThreadChanged?.(req.params.threadId, "delete", req.authUser!.id);
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  router.post("/threads/:threadId/fork", async (req, res) => {
    try {
      const ownerUserId = req.authUser!.id;
      const source = await (await appServer()).readThread(req.params.threadId, false);
      const workspaceId = String(req.body.workspaceId || "");
      if (workspaceId) assertThreadInWorkspace(source.thread.cwd, workspaceForRequest(workspaceId, ownerUserId));
      else assertCanManageOfficialThreads(req.authUser!.role);
      if (!source.thread.resumable) return res.status(409).json({ error: source.compatibilityMessage || "该官方线程当前只支持只读查看，不能创建支线" });
      const thread = await (await appServer()).forkThread(req.params.threadId, req.body.lastTurnId ? String(req.body.lastTurnId) : undefined);
      await dependencies.onThreadChanged?.(thread.id, "fork", req.authUser!.id);
      res.status(201).json({ thread });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/bindings", async (req, res) => {
    try {
      const ownerUserId = req.authUser!.id;
      const workspace = workspaceForRequest(String(req.body.workspaceId || ""), ownerUserId);
      const session = dependencies.getSession(String(req.body.sessionId || ""), ownerUserId);
      if (!session || session.workspaceId !== workspace.id) throw new Error("工作台任务不存在或不属于当前工作区");
      if (session.engine !== "codex") throw new Error("只能将 Codex 普通任务与官方 Codex 线程关联");
      const thread = await (await appServer()).readThread(String(req.body.threadId || ""), false);
      assertThreadInWorkspace(thread.thread.cwd, workspace);
      const accessMode = thread.thread.resumable ? "resume" : "readOnly";
      if (accessMode === "resume" && session.status === "running") throw new Error("当前任务正在执行，请等待本轮完成后再接管官方对话");
      const binding = dependencies.repository.bind({
        ownerUserId,
        workspaceId: workspace.id,
        sessionId: session.id,
        threadId: thread.thread.id,
        accessMode,
        threadName: thread.thread.name,
        threadPreview: thread.thread.preview,
        previousThreadId: session.codexThreadId || null,
        compatibilityMessage: accessMode === "readOnly" ? (thread.compatibilityMessage || "该官方线程当前只支持只读关联") : null
      });
      await dependencies.activateBinding?.(binding);
      res.status(201).json({ binding });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/bindings/session/:sessionId", (req, res) => {
    const binding = dependencies.repository.findBySession(req.authUser!.id, req.params.sessionId);
    res.json({ binding });
  });

  router.delete("/bindings/:bindingId", async (req, res) => {
    const binding = dependencies.repository.get(req.authUser!.id, req.params.bindingId);
    if (!binding) return res.status(404).json({ error: "联动关系不存在" });
    const session = dependencies.getSession(binding.sessionId, req.authUser!.id);
    if (binding.accessMode === "resume" && session?.status === "running") return res.status(409).json({ error: "当前任务正在执行，请等待本轮完成后再解除接管" });
    await dependencies.deactivateBinding?.(binding);
    dependencies.repository.unbind(req.authUser!.id, req.params.bindingId);
    res.json({ ok: true, binding });
  });

  router.post("/leases", async (req, res) => {
    try {
      const ownerUserId = req.authUser!.id;
      const workspace = workspaceForRequest(String(req.body.workspaceId || ""), ownerUserId);
      const session = dependencies.getSession(String(req.body.sessionId || ""), ownerUserId);
      if (!session || session.workspaceId !== workspace.id || session.engine !== "codex") throw new Error("只能由当前工作区的 Codex 普通任务接管线程");
      const result = await (await appServer()).readThread(String(req.body.threadId || ""), false);
      assertThreadInWorkspace(result.thread.cwd, workspace);
      if (result.thread.status.type === "active") return res.status(409).json({ error: "官方线程正在其他客户端执行，当前只能查看" });
      const holder = `workbench-session:${session.id}`;
      const ttlMs = Math.max(30_000, Math.min(300_000, Number(req.body.ttlMs || 120_000)));
      const lease = dependencies.repository.acquireLease({ ownerUserId, workspaceId: workspace.id, sessionId: session.id, threadId: result.thread.id, holder, ttlMs });
      if (!lease) return res.status(409).json({ error: "该线程已被另一个工作台任务接管" });
      res.status(201).json({ lease });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete("/leases/:threadId", (req, res) => {
    const sessionId = String(req.body.sessionId || "");
    const removed = dependencies.repository.releaseLease(req.authUser!.id, req.params.threadId, `workbench-session:${sessionId}`);
    if (!removed) return res.status(404).json({ error: "线程租约不存在" });
    res.json({ ok: true });
  });

  return {
    router,
    officialHome,
    prepareLinkedRun: async (binding: CodexLinkBinding) => {
      if (binding.accessMode !== "resume") throw new Error(binding.compatibilityMessage || "该官方线程为只读关联，不能在工作台中续接");
      const result = await (await appServer()).readThread(binding.threadId, false);
      if (!result.thread.resumable) throw new Error(result.compatibilityMessage || "该官方线程当前不能续接");
      if (result.thread.status.type === "active") throw new Error("官方线程正在其他客户端执行，请等待完成后再从工作台继续");
      const holder = `workbench-session:${binding.sessionId}`;
      const lease = dependencies.repository.acquireLease({
        ownerUserId: binding.ownerUserId,
        workspaceId: binding.workspaceId,
        sessionId: binding.sessionId,
        threadId: binding.threadId,
        holder,
        ttlMs: 300_000
      });
      if (!lease) throw new Error("该官方线程已被另一个工作台任务接管");
      return {
        release: () => dependencies.repository.releaseLease(binding.ownerUserId, binding.threadId, holder)
      };
    },
    close: () => client?.close(),
    listOfficialThreads: async () => (await appServer()).listAllThreads(2),
    readOfficialThread: async (threadId: string) => (await appServer()).readThread(threadId, false)
  };
}
