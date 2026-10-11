import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexAppServerClient, type JsonObject } from "../../codexLink/appServerClient.js";
import { codexNativeDecision, codexNativePrompt, type NativeDecision } from "../nativeInteraction.js";

/** Native App Server items normalized to the existing workbench activity model.
 * Keep unknown fields: native agent identity and future events must survive. */
export function appServerItem(item: Record<string, any>) {
  const types: Record<string, string> = { agentMessage: "agent_message", commandExecution: "command_execution", fileChange: "file_change", mcpToolCall: "mcp_tool_call", webSearch: "web_search", collabAgentToolCall: "collab_agent_tool_call", subAgentActivity: "sub_agent_activity", contextCompaction: "context_compaction", plan: "agent_message" };
  return { ...item, type: types[item.type] || item.type,
    ...(item.type === "collabAgentToolCall" ? { receiver_thread_ids: item.receiverThreadIds || [], agents_states: item.agentsStates || {}, sender_thread_id: item.senderThreadId, status: item.status === "inProgress" ? "in_progress" : item.status } : {}),
    ...(item.type === "commandExecution" ? { aggregated_output: item.aggregatedOutput || "", exit_code: item.exitCode ?? undefined, status: item.status === "inProgress" ? "in_progress" : item.status } : {}),
    ...(item.type === "fileChange" ? { changes: (item.changes || []).map((change: any) => ({ ...change, nativeKind: change.kind, kind: typeof change.kind === "object" ? change.kind.type : change.kind })), status: item.status === "inProgress" ? "in_progress" : item.status } : {}),
    ...(item.type === "reasoning" ? { text: [...(item.summary || []), ...(item.content || [])].join("\n") } : {}),
    ...(item.type === "webSearch" ? { query: item.action?.query || item.action?.queries?.join("; ") || item.query || "" } : {}) };
}

type Launch = { executable: string; home: string; cwd: string; args?: string[]; env: NodeJS.ProcessEnv; thread: JsonObject; turn: JsonObject; onRequest: (prompt: NonNullable<ReturnType<typeof codexNativePrompt>>, signal: AbortSignal) => Promise<NativeDecision> };

/** One process per active main turn, with authoritative completion and
 * bidirectional user requests. Existing native history is resumed by ID. */
export class CodexNativeSession {
  constructor(private launch: Launch, private threadId?: string | null) {}
  async runStreamed(prompt: string, options: { signal: AbortSignal }): Promise<{ events: AsyncIterable<ThreadEvent> }> {
    const queue: ThreadEvent[] = []; const items = new Map<string, Record<string, any>>();
    let wake: (() => void) | undefined, done = false, failure: Error | undefined;
    let usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
    const emit = (event: any) => {
      if (done) return;
      const last: any = queue.at(-1);
      // Streaming deltas supersede the prior pending snapshot, never the final item.
      if (event.type === "item.updated" && last?.type === "item.updated" && last.item.id === event.item.id) queue[queue.length - 1] = event;
      else if (queue.length >= 4096) { finish(new Error("Codex 活动读取过慢，请重试当前轮次")); return; }
      else queue.push(event as ThreadEvent);
      wake?.(); wake = undefined;
    };
    const finish = (error?: Error) => { if (done) return; failure = error; done = true; wake?.(); wake = undefined; };
    const lifetime = new AbortController();
    const signal = AbortSignal.any([options.signal, lifetime.signal]);
    const requests = new Map<number | string, AbortController>();
    const client = new CodexAppServerClient(this.launch.executable, this.launch.home, (event) => {
      if (event.requestId !== undefined) {
        if (requests.has(event.requestId)) return;
        const request = codexNativePrompt(event.method, event.params);
        if (!request) { client.rejectRequest(event.requestId, "Meta Code does not implement this native request"); return; }
        const pending = new AbortController(); requests.set(event.requestId, pending);
        void this.launch.onRequest(request, AbortSignal.any([signal, pending.signal])).then(answer => {
          if (!done && !signal.aborted && !pending.signal.aborted) client.respond(event.requestId!, codexNativeDecision(event.method, event.params, answer));
        }).catch(error => {
          if (!done && !signal.aborted && !pending.signal.aborted) { client.rejectRequest(event.requestId!, error instanceof Error ? error.message : "原生请求失败"); finish(error instanceof Error ? error : new Error(String(error))); }
        }).finally(() => requests.delete(event.requestId!));
        return;
      }
      const p: any = event.params;
      if (event.method === "serverRequest/resolved") { requests.get(p.requestId)?.abort(); return; }
      // Child threads have their own transcripts. Do not merge their replies
      // or completions into the main turn.
      if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
      if (event.method === "turn/started") emit({ type: "turn.started" });
      else if (["item/started", "item/completed"].includes(event.method)) {
        // The workbench already owns the submitted human message.
        if (p.item.type === "userMessage") return;
        if (event.method === "item/completed") items.delete(p.item.id); else items.set(p.item.id, p.item);
        emit({ type: event.method === "item/started" ? "item.started" : "item.completed", item: appServerItem(p.item) });
      } else if (event.method === "item/agentMessage/delta" || event.method === "item/plan/delta") {
        const item = items.get(p.itemId) || { id: p.itemId, type: event.method.includes("/plan/") ? "plan" : "agentMessage", text: "" };
        item.text += p.delta || ""; items.set(p.itemId, item); emit({ type: "item.updated", item: appServerItem(item) });
      } else if (event.method === "item/commandExecution/outputDelta") {
        const item = items.get(p.itemId); if (item) { item.aggregatedOutput = ((item.aggregatedOutput || "") + (p.delta || "")).slice(-256_000); emit({ type: "item.updated", item: appServerItem(item) }); }
      } else if (["item/reasoning/summaryTextDelta", "item/reasoning/textDelta"].includes(event.method)) {
        const item = items.get(p.itemId); if (item) { const key = event.method.includes("summary") ? "summary" : "content"; const index = p.summaryIndex ?? p.contentIndex ?? 0; item[key] ||= []; item[key][index] = (item[key][index] || "") + (p.delta || ""); emit({ type: "item.updated", item: appServerItem(item) }); }
      } else if (event.method === "thread/tokenUsage/updated") {
        const u = p.tokenUsage?.last || {}; usage = { input_tokens: Number(u.inputTokens || 0), cached_input_tokens: Number(u.cachedInputTokens || 0), output_tokens: Number(u.outputTokens || 0), reasoning_output_tokens: Number(u.reasoningOutputTokens || 0) };
      } else if (event.method === "turn/completed") {
        if (p.turn.status === "completed") emit({ type: "turn.completed", usage });
        else emit({ type: "turn.failed", error: { message: p.turn.error?.message || `原生轮次结束：${p.turn.status}` } });
        finish();
      } else if (event.method === "error") emit({ type: "error", message: p.error?.message || "Codex 原生连接异常" });
    }, { args: this.launch.args, env: this.launch.env, cwd: this.launch.cwd, experimental: true, onClose: error => finish(error) });
    const abort = () => { finish(options.signal.reason instanceof Error ? options.signal.reason : new DOMException("Codex 已中断", "AbortError")); client.close(); };
    options.signal.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal.aborted) throw options.signal.reason;
      const result: any = await client.request(this.threadId ? "thread/resume" : "thread/start", { ...this.launch.thread, ...(this.threadId ? { threadId: this.threadId, excludeTurns: true } : {}) }, 60_000);
      this.threadId = result.thread?.id;
      if (!this.threadId) throw new Error("Codex 没有返回原生线程 ID");
      emit({ type: "thread.started", thread_id: this.threadId });
      await client.request("turn/start", { ...this.launch.turn, threadId: this.threadId, input: [{ type: "text", text: prompt, text_elements: [] }] }, 60_000);
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    return { events: (async function* () {
      try {
        while (true) {
          while (queue.length) yield queue.shift()!;
          if (done) { if (failure) throw failure; return; }
          await new Promise<void>(resolve => { wake = resolve; });
        }
      } finally { lifetime.abort(); options.signal.removeEventListener("abort", abort); client.close(); }
    })() };
  }
}
