import { randomUUID } from "node:crypto";

export type NativeConversationOptions = { mode: "execute" | "plan"; approvals: "inherit" | "ask"; customAgent: string | null };
export const DEFAULT_NATIVE_OPTIONS: NativeConversationOptions = { mode: "execute", approvals: "inherit", customAgent: null };
export function normalizeNativeOptions(value: unknown): NativeConversationOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("无效的原生会话设置");
  const v = value as Record<string, unknown>;
  if (!["execute", "plan"].includes(String(v.mode)) || !["inherit", "ask"].includes(String(v.approvals))) throw new Error("不支持的原生模式或审批策略");
  if (v.customAgent != null && (typeof v.customAgent !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(v.customAgent))) throw new Error("无效的自定义 Agent 名称");
  return { mode: v.mode as NativeConversationOptions["mode"], approvals: v.approvals as NativeConversationOptions["approvals"], customAgent: v.customAgent as string | null || null };
}

export type NativeQuestion = { id: string; header?: string; question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean; secret?: boolean };
export type NativePrompt = { id: string; sessionId: string; provider: string; kind: "approval" | "question"; title: string; detail: string; questions?: NativeQuestion[]; canAccept?: boolean; createdAt: string };
export type NativeDecision = { decision?: "accept" | "decline"; answers?: Record<string, string[]> };
type Pending = { prompt: NativePrompt; owner: string; settle: (answer: NativeDecision | Error) => void };

/** Requests belong to a live process, never to a restored or replacement run.
 * No automatic approval, durable callbacks, or user-controlled protocol IDs. */
export class NativeInteractionBroker {
  private pending = new Map<string, Pending>();
  constructor(private changed: (sessionId: string, owner: string, prompt: NativePrompt, status: "pending" | "resolved" | "cancelled") => void) {}
  list(sessionId: string, owner: string) { return [...this.pending.values()].filter(p => p.owner === owner && p.prompt.sessionId === sessionId).map(p => p.prompt); }
  request(sessionId: string, owner: string, provider: string, input: Omit<NativePrompt, "id" | "sessionId" | "provider" | "createdAt">, signal: AbortSignal): Promise<NativeDecision> {
    if (signal.aborted) return Promise.reject(signal.reason || new Error("任务已停止"));
    if (input.kind === "question" && (!input.questions?.length || input.questions.length > 20 || input.questions.some(q => !q.id || !q.question) || new Set(input.questions.map(q => q.id)).size !== input.questions.length)) return Promise.reject(new Error("原生问题格式无效"));
    if (this.list(sessionId, owner).length >= 16) return Promise.reject(new Error("待处理原生请求过多"));
    const prompt: NativePrompt = { ...input, id: randomUUID(), sessionId, provider, createdAt: new Date().toISOString() };
    return new Promise((resolve, reject) => {
      const abort = () => settle(signal.reason instanceof Error ? signal.reason : new Error("任务已停止"));
      const settle = (value: NativeDecision | Error) => {
        if (!this.pending.delete(prompt.id)) return;
        signal.removeEventListener("abort", abort);
        this.changed(sessionId, owner, prompt, value instanceof Error ? "cancelled" : "resolved");
        if (value instanceof Error) reject(value); else resolve(value);
      };
      this.pending.set(prompt.id, { prompt, owner, settle });
      signal.addEventListener("abort", abort, { once: true });
      this.changed(sessionId, owner, prompt, "pending");
      if (signal.aborted) abort();
    });
  }
  answer(sessionId: string, owner: string, id: string, value: NativeDecision) {
    const entry = this.pending.get(id);
    if (!entry || entry.owner !== owner || entry.prompt.sessionId !== sessionId) throw new Error("此请求已结束或不属于当前任务，请刷新");
    if (entry.prompt.kind === "approval") {
      if (!["accept", "decline"].includes(value?.decision || "")) throw new Error("请选择批准或拒绝");
      if (value.decision === "accept" && entry.prompt.canAccept === false) throw new Error("此请求不支持单次批准");
      entry.settle({ decision: value.decision });
    } else {
      const answers: Record<string, string[]> = {};
      for (const question of entry.prompt.questions || []) {
        const supplied = value?.answers?.[question.id];
        if (!Array.isArray(supplied) || !supplied.length || supplied.length > (question.multiSelect ? 20 : 1) || supplied.some(s => typeof s !== "string" || !s.trim() || s.length > 8_000)) throw new Error("请填写每个问题的有效回答");
        answers[question.id] = supplied;
      }
      entry.settle({ answers });
    }
  }
  cancel(sessionId: string, owner: string) {
    for (const entry of [...this.pending.values()]) if (entry.owner === owner && entry.prompt.sessionId === sessionId) entry.settle(new Error("原生进程已结束"));
  }
}

export function codexNativePrompt(method: string, params: Record<string, any>): Omit<NativePrompt, "id" | "sessionId" | "provider" | "createdAt"> | null {
  if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") return { kind: "question", title: "Codex 需要你的决定", detail: "回答后将继续当前原生轮次", questions: (params.questions || []).map((q: any) => ({ id: q.id, header: q.header, question: q.question, options: q.options || [], secret: q.isSecret })) };
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(method)) return {
    kind: "approval", title: method.includes("commandExecution") ? "批准执行命令" : method.includes("fileChange") ? "批准文件修改" : "批准本轮权限申请",
    canAccept: !Array.isArray(params.availableDecisions) || params.availableDecisions.includes("accept"),
    detail: [params.reason, params.command, params.cwd, params.grantRoot, params.permissions ? JSON.stringify(params.permissions, null, 2) : "", params.additionalPermissions ? JSON.stringify(params.additionalPermissions, null, 2) : ""].filter(Boolean).join("\n").slice(0, 24_000)
  };
  return null;
}
export function codexNativeDecision(method: string, params: Record<string, any>, answer: NativeDecision) {
  if (method.includes("requestUserInput")) return { answers: Object.fromEntries(Object.entries(answer.answers || {}).map(([id, answers]) => [id, { answers }])) };
  if (method === "item/permissions/requestApproval") return { permissions: answer.decision === "accept" ? params.permissions || {} : {}, scope: "turn" };
  const decision = answer.decision === "accept" ? "accept" : Array.isArray(params.availableDecisions) && !params.availableDecisions.includes("decline") && params.availableDecisions.includes("cancel") ? "cancel" : "decline";
  if (Array.isArray(params.availableDecisions) && !params.availableDecisions.includes(decision)) throw new Error("官方请求不允许此审批决定");
  return { decision };
}
