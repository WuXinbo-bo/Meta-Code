import { useEffect, useRef, useState } from "react";
import { CircleStop, Play, TerminalSquare, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./NativeTerminalPanel.css";

type TerminalEvent = { sequence: number; type: "data" | "exit"; data?: string; exitCode?: number };
type Snapshot = { id: string; provider: string; status: "running" | "exited"; cwd: string; events: TerminalEvent[]; truncated: boolean };
type Request = <T>(url: string, init?: RequestInit) => Promise<T>;

export default function NativeTerminalPanel({ sessionId, title, provider, request, onClose }: { sessionId: string; title: string; provider: string; request: Request; onClose: () => void }) {
  const root = `/api/sessions/${encodeURIComponent(sessionId)}/native-terminal`;
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const terminalId = useRef("");
  const sequence = useRef(0);
  const stream = useRef<EventSource | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [teams, setTeams] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const accept = useRef<(value: Snapshot) => void>(() => {});

  useEffect(() => {
    let disposed = false;
    terminalId.current = ""; sequence.current = 0;
    const priorFocus = document.activeElement as HTMLElement | null;
    const term = new Terminal({ fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', cursorBlink: true, scrollback: 3000, theme: { background: "#181b1f", foreground: "#e3e5e8" } });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(container.current!); fit.fit(); terminal.current = term;
    let inputTail = Promise.resolve();
    const post = (path: string, body: unknown) => request(root + path, { method: "POST", body: JSON.stringify(body) });
    const input = term.onData((data) => {
      const id = terminalId.current;
      if (!id || disposed) return;
      inputTail = inputTail.then(() => { if (!disposed) return post("/input", { terminalId: id, data }); }).then(() => {}).catch((cause) => { if (!disposed) setError(String(cause.message || cause)); });
    });
    const resize = term.onResize(({ cols, rows }) => { if (terminalId.current) void post("/resize", { terminalId: terminalId.current, cols, rows }).catch(() => {}); });
    const observer = new ResizeObserver(() => { if (!disposed) fit.fit(); }); observer.observe(container.current!);
    const event = (value: TerminalEvent) => {
      if (disposed || value.sequence <= sequence.current) return;
      sequence.current = value.sequence;
      if (value.type === "data") term.write(value.data || "");
      else { setSnapshot((current) => current ? { ...current, status: "exited" } : current); stream.current?.close(); setConnected(false); term.writeln(`\r\n[原生终端已结束 · ${value.exitCode ?? "unknown"}]`); }
    };
    const update = (value: Snapshot) => {
      if (disposed) return;
      if (terminalId.current !== value.id) { term.reset(); terminalId.current = value.id; sequence.current = 0; }
      if (value.truncated) term.writeln("\r\n[较早的输出已超出回放范围]");
      value.events.forEach(event); setSnapshot(value);
    };
    const connect = () => {
      stream.current?.close();
      const source = new EventSource(root + `/events?after=${sequence.current}&terminalId=${encodeURIComponent(terminalId.current)}`); stream.current = source;
      source.onopen = () => { if (!disposed) { setConnected(true); setError(""); } };
      source.onmessage = (message) => {
        if (disposed) return;
        try { const value = JSON.parse(message.data); if (value.type === "snapshot") { update(value.terminal); if (value.terminal.status === "exited") { source.close(); setConnected(false); } } else event(value); }
        catch { setError("原生终端输出解析失败，请重新打开"); }
      };
      source.onerror = () => { if (!disposed) { setConnected(false); setError("连接中断，正在重新连接；原生进程继续运行"); } };
    };
    accept.current = (value) => { update(value); if (value.status === "running") { connect(); term.focus(); } };
    void request<{ terminal: Snapshot | null }>(root).then(({ terminal: value }) => { if (value) accept.current(value); }).catch((cause) => { if (!disposed) setError(cause.message); });
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { disposed = true; accept.current = () => {}; stream.current?.close(); observer.disconnect(); resize.dispose(); input.dispose(); term.dispose(); terminal.current = null; priorFocus?.focus(); };
  }, [root, request]);

  const start = async () => {
    setBusy(true); setError("");
    try { const value = await request<{ terminal: Snapshot }>(root, { method: "POST", body: JSON.stringify({ agentTeams: teams, cols: terminal.current?.cols, rows: terminal.current?.rows }) }); accept.current(value.terminal); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true);
    try { await request(root + "/stop", { method: "POST", body: JSON.stringify({ terminalId: terminalId.current }) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="native-terminal-backdrop"><div ref={dialog} className="native-terminal-dialog" role="dialog" aria-modal="true" aria-label="原生 CLI 终端" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea')];
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <header><TerminalSquare size={18} /><div><strong>{title} · 原生终端</strong><small>官方交互式 CLI · {snapshot?.status === "running" ? connected ? "已连接" : "重连中" : snapshot?.status === "exited" ? "已结束" : "未运行"}</small></div><button type="button" aria-label="关闭原生终端视图" onClick={onClose}><X size={18} /></button></header>
    <p>在这里使用官方命令、权限审批和交互能力。关闭视图保留运行；停止后可回到普通对话。终端输出独立于工作台对话日志。</p>
    <div className="native-terminal-actions">{snapshot?.status !== "running" ? <>{provider === "claude" && <label><input type="checkbox" checked={teams} onChange={(event) => setTeams(event.target.checked)} />启用实验性 Agent Teams</label>}<button type="button" disabled={busy} onClick={() => void start()}><Play size={14} />启动官方 CLI</button></> : <button type="button" disabled={busy} onClick={() => void stop()}><CircleStop size={14} />停止原生终端</button>}<small>{snapshot?.cwd}</small></div>
    {error && <div className="native-terminal-error" role="status">{error}</div>}
    <div ref={container} className="native-terminal-surface" />
  </div></div>;
}
