import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CompactWorkflowProgress, TaskModeBar } from "/src/workflow/TaskModeBar";
import { WorkflowDefinitionPicker } from "/src/workflow/WorkflowExtensions";
import "/src/styles.css";
import "/src/design/tokens.css";
import "/src/design/shell.css";
import "/src/design/conversation.css";
import "/src/design/features.css";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") || "bar";
const manual = params.has("manual");
let failLookup = params.has("failure");
let redrawFixture = () => {};
const calls: Array<{ path: string; body: unknown }> = [];
const conversations: string[] = [];
const errors: string[] = [];
const pending = new Map<string, (body: unknown, status?: number) => void>();
const workflow = (id: string) => ({ id: `async-${id}`, title: `Task ${id.toUpperCase()}`, status: "running", plannerEngine: "codex", plan: {}, nodes: [{ status: "running" }] });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!url.pathname.startsWith("/api/")) return nativeFetch(input, options);
  const path = url.pathname;
  const body = options.body ? JSON.parse(String(options.body)) : null;
  calls.push({ path, body });
  queueMicrotask(() => redrawFixture());
  if (options.method === "POST") return new Promise<Response>((resolve) => pending.set(path, (value, status) => resolve(response(value, status))));
  if (path === "/api/workflow-definitions") return response({ items: [{ id: "async-definition", revision: 1, name: "Review definition", description: "Review existing project", parameters: [] }] });
  if (path === "/api/task-contexts/lookup") {
    if (failLookup) { failLookup = false; return response({ error: "Fixture lookup unavailable" }, 503); }
    const source = url.searchParams.get("sessionId") || url.searchParams.get("workflowId") || "";
    const id = source.split("-").at(-1) || "a";
    return response({ id: `context-${id}`, title: `Task ${id.toUpperCase()}`, executions: [{ kind: "session", id: `session-${id}` }, { kind: "workflow", id: `async-${id}` }] });
  }
  if (path.endsWith("/maintenance")) {
    if (mode === "compact-answer") return new Promise<Response>((resolve) => pending.set(path, (value, status) => resolve(response(value, status))));
    return response({ messages: [] });
  }
  if (path.startsWith("/api/workflows/")) return response(workflow(path.split("-").at(-1) || "a"));
  return response({ error: "Unknown test request" }, 404);
};
(window as any).__taskAsync = { calls, conversations, errors, workflow, resolve: (path: string, body: unknown, status?: number) => {
  const complete = pending.get(path);
  if (!complete) throw new Error(`No pending request: ${path}`);
  pending.delete(path);
  complete(body, status);
} };

function Fixture() {
  const [, redraw] = useState(0);
  redrawFixture = () => redraw((value) => value + 1);
  const [task, setTask] = useState("a");
  const [engine, setEngine] = useState("codex");
  const [visible, setVisible] = useState(true);
  const [notice, setNotice] = useState("");
  return <main style={{ width: "min(640px, calc(100% - 32px))", margin: "24px auto" }}>
    <div style={{ display: "flex", gap: 8, marginBottom: 20 }}><button onClick={() => setTask("a")}>Select A</button><button onClick={() => setTask("b")}>Select B</button><button onClick={() => setEngine((value) => value === "codex" ? "claude" : "codex")}>Change model</button><button onClick={() => setVisible(false)}>Hide panel</button></div>
    <output aria-label="Selected task">{task}</output>
    {visible && (mode === "definition" ? <WorkflowDefinitionPicker workspaceId={`workspace-${task}`} target="workspace" onCreated={(id) => { conversations.push(id); setTask(id.split("-").at(-1) || "a"); }} onNotice={setNotice} /> : mode.startsWith("compact") ? <CompactWorkflowProgress workflowId={`async-${task}`} onOpen={() => setNotice(`Opened ${task}`)} /> : <TaskModeBar sessionId={mode === "create" ? `session-${task}` : undefined} workflowId={mode === "bar" ? `async-${task}` : undefined} engine={engine} enabled defaultGoal={`Goal ${task}`} onConversation={(id) => { conversations.push(id); setTask(id.split("-").at(-1) || "a"); }} onWorkflow={(id) => setTask(id.split("-").at(-1) || "a")} onCreateWorkflow={async (taskContextId, goal) => {
      const result = await fetch(`/api/task-contexts/${taskContextId}/create`, { method: "POST", body: JSON.stringify({ goal }) });
      if (!result.ok) throw new Error((await result.json()).error);
    }} onError={(message) => { errors.push(message); setNotice(message); }} />)}
    {notice && <output role="status">{notice}</output>}
    {manual && <section aria-label="Manual response controls" style={{ marginTop: 24 }}>
      {[...pending.keys()].map((path) => <div key={path}><code>{path}</code><button onClick={() => { (window as any).__taskAsync.resolve(path, path.endsWith("/conversation") ? { id: "session-a" } : path.endsWith("/plan") ? { workflow: workflow("a"), queuedUntilCheckpoint: true } : { ok: true }); redrawFixture(); }}>Resolve {path}</button><button onClick={() => { (window as any).__taskAsync.resolve(path, { error: "Old A error" }, 409); redrawFixture(); }}>Reject {path}</button></div>)}
      <output aria-label="Conversation callbacks">{conversations.length}</output>
    </section>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
