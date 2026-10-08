import type { Express, RequestHandler } from "express";
import type { WorkflowDefinitionEnvironment, WorkflowDefinitionParameter, WorkflowTeamDefinition } from "./definitions.js";
import { instantiateWorkflowDefinition, WorkflowDefinitionStore } from "./definitions.js";
import type { PrepareWorkflowTargetInput, WorkflowTargetService } from "./targets.js";
import type { WorkflowPlan, WorkflowRecord } from "./types.js";

export type OrchestrationExtensionPorts = {
  acquireRequest: () => () => void;
  definitions: WorkflowDefinitionStore;
  targets: WorkflowTargetService;
  workflowById: (id: string, ownerUserId: string) => WorkflowRecord | null | undefined;
  definitionEnvironment: (workspaceId: string, ownerUserId: string) => Promise<WorkflowDefinitionEnvironment>;
  createDefinitionWorkflow: (input: {
    ownerUserId: string; workspaceId: string; prompt: string; plannerEngine: string; plan: WorkflowPlan;
    definitionId: string; definitionRevision: number; inputs: Record<string, string>;
    executionTarget?: PrepareWorkflowTargetInput["executionTarget"];
  }) => Promise<WorkflowRecord>;
  workflowRuntimeActive: (workflowId: string) => boolean;
  withWorkspaceWriteLock: <T>(workspaceId: string, ownerUserId: string, operation: () => Promise<T>) => Promise<T>;
  onWorkflowIntegrated: (workflow: WorkflowRecord) => void | Promise<void>;
};

export function registerOrchestrationExtensionRoutes(app: Express, ports: OrchestrationExtensionPorts) {
  function admitted(handler: RequestHandler): RequestHandler {
    return async (req, res, next) => {
      let release: () => void;
      try { release = ports.acquireRequest(); }
      catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error), code: "orchestration-plugin-disabled" }); return; }
      try { await handler(req, res, next); } finally { release(); }
    };
  }
  const failure = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) });
  const definitionWithoutOwner = (definition: ReturnType<WorkflowDefinitionStore["save"]>) => {
    const { ownerUserId: _, ...publicDefinition } = definition;
    return publicDefinition;
  };
  app.get("/api/workflow-definitions", (req, res) => {
    try { res.setHeader("Cache-Control", "no-store"); res.json({ items: ports.definitions.list(req.authUser!.id).map(definitionWithoutOwner) }); }
    catch (error) { res.status(400).json(failure(error)); }
  });
  app.post("/api/workflow-definitions", admitted(async (req, res) => {
    try {
      const workflow = req.body?.workflowId ? ports.workflowById(String(req.body.workflowId), req.authUser!.id) : null;
      if (req.body?.workflowId && !workflow?.plan) throw new Error("可保存的任务计划不存在");
      const workspaceId = workflow?.workspaceId || String(req.body?.workspaceId || "");
      const environment = await ports.definitionEnvironment(workspaceId, req.authUser!.id);
      const definition = ports.definitions.save({
        id: req.body?.id ? String(req.body.id) : undefined,
        expectedRevision: req.body?.expectedRevision,
        ownerUserId: req.authUser!.id,
        name: String(req.body?.name || workflow?.title || ""), description: String(req.body?.description || ""),
        goalTemplate: String(req.body?.goalTemplate || workflow?.originalPrompt || ""),
        parameters: (req.body?.parameters || []) as WorkflowDefinitionParameter[],
        planTemplate: req.body?.planTemplate || workflow?.plan,
        team: (req.body?.team || { plannerEngine: workflow?.plannerEngine, nodeProviders: {} }) as WorkflowTeamDefinition
      }, environment);
      res.status(201).json(definitionWithoutOwner(definition));
    } catch (error) { res.status(400).json(failure(error)); }
  }));
  app.delete("/api/workflow-definitions/:id", admitted((req, res) => {
    try { ports.definitions.remove(String(req.params.id), req.authUser!.id, Number(req.body?.expectedRevision)); res.json({ ok: true }); }
    catch (error) { res.status(409).json(failure(error)); }
  }));
  app.post("/api/workflow-definitions/:id/instantiate", admitted(async (req, res) => {
    try {
      const definition = ports.definitions.get(String(req.params.id), req.authUser!.id);
      if (!definition) return void res.status(404).json({ error: "工作定义不存在" });
      if (Number(req.body?.expectedRevision) !== definition.revision) throw new Error("工作定义已更新，请刷新后重试");
      const workspaceId = String(req.body?.workspaceId || "");
      const environment = await ports.definitionEnvironment(workspaceId, req.authUser!.id);
      const instantiated = instantiateWorkflowDefinition(definition, req.body?.inputs || {}, environment);
      const workflow = await ports.createDefinitionWorkflow({ ...instantiated, ownerUserId: req.authUser!.id, workspaceId, executionTarget: req.body?.executionTarget });
      res.status(201).json(workflow);
    } catch (error) { res.status(409).json(failure(error)); }
  }));
  app.get("/api/workflows/:id/worktree/compare", async (req, res) => {
    try {
      const workflow = ports.workflowById(String(req.params.id), req.authUser!.id);
      if (!workflow) return void res.status(404).json({ error: "工作流不存在" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ workflowRevision: workflow.revision, ...(await ports.targets.compare(workflow.worktreeId || workflow.id, req.authUser!.id)) });
    } catch (error) { res.status(400).json(failure(error)); }
  });
  app.post("/api/workflows/:id/worktree/integrate", admitted(async (req, res) => {
    try {
      const workflow = ports.workflowById(String(req.params.id), req.authUser!.id);
      if (!workflow) return void res.status(404).json({ error: "工作流不存在" });
      const result = await ports.withWorkspaceWriteLock(workflow.workspaceId, req.authUser!.id, async () => {
        const current = ports.workflowById(workflow.id, req.authUser!.id);
        if (!current || current.revision !== Number(req.body?.workflowRevision)) throw new Error("任务已更新，请刷新方案对比后重新确认");
        if (current.status !== "completed" || ports.workflowRuntimeActive(current.id)) throw new Error("方案完成并通过验收后才能整合到原项目");
        const integrated = await ports.targets.integrate(current.worktreeId || current.id, req.authUser!.id, {
          expectedRevision: Number(req.body?.expectedRevision), previewDigest: String(req.body?.previewDigest || ""), snapshotChanges: req.body?.snapshotChanges === true
        });
        await ports.onWorkflowIntegrated(current);
        return integrated;
      });
      res.json(result);
    } catch (error) { res.status(409).json(failure(error)); }
  }));
}
