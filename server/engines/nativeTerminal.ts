import { prepareNativePty } from "./nativePtyRuntime.js";
import crypto from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import type { IPty } from "node-pty";

export type NativeTerminalEvent = { sequence: number; type: "data" | "exit"; data?: string; exitCode?: number };
type TerminalProcess = Pick<IPty, "pid" | "write" | "resize" | "kill" | "onData" | "onExit">;
export type NativeTerminalOptions = {
  sessionId: string; ownerId: string; provider: string; cwd: string;
  executable: string; args: string[]; env: Record<string, string>;
  cols?: number; rows?: number; release: () => void;
};
type TerminalEntry = {
  id: string; sessionId: string; ownerId: string; provider: string; cwd: string;
  process: TerminalProcess; status: "running" | "exited"; sequence: number;
  events: NativeTerminalEvent[]; bytes: number; createdAt: string;
  listeners: Set<(event: NativeTerminalEvent) => void>;
};
type PtyFactory = (options: NativeTerminalOptions) => Promise<TerminalProcess>;
const MAX_REPLAY_BYTES = 256_000;
const MAX_RETAINED_TERMINALS = 32;

export function terminalSize(cols: unknown, rows: unknown) {
  return { cols: Math.max(20, Math.min(300, Math.floor(Number(cols) || 100))), rows: Math.max(8, Math.min(100, Math.floor(Number(rows) || 30))) };
}

async function createPty(options: NativeTerminalOptions) {
  prepareNativePty();
  const pty = await import("node-pty");
  return pty.spawn(options.executable, options.args, { cwd: options.cwd, env: options.env, name: "xterm-256color", ...terminalSize(options.cols, options.rows), useConpty: true, useConptyDll: false });
}

/** Runs only host-resolved official CLIs. No executable/env comes from HTTP. */
export class NativeTerminalManager {
  private readonly terminals = new Map<string, TerminalEntry>();
  private readonly starting = new Set<string>();
  private stopping = false;
  constructor(private readonly factory: PtyFactory = createPty) {}

  get(sessionId: string, ownerId: string) {
    const entry = this.terminals.get(sessionId);
    return entry?.ownerId === ownerId ? entry : null;
  }

  snapshot(sessionId: string, ownerId: string, after = 0) {
    const entry = this.get(sessionId, ownerId);
    if (!entry) return null;
    return { id: entry.id, sessionId, provider: entry.provider, cwd: entry.cwd, status: entry.status, sequence: entry.sequence, createdAt: entry.createdAt,
      truncated: after > 0 && after < (entry.events[0]?.sequence || 0) - 1,
      events: entry.events.filter((event) => event.sequence > after) };
  }

  async start(options: NativeTerminalOptions) {
    if (this.stopping) { options.release(); throw new Error("工作台正在关闭，无法启动原生终端"); }
    const previous = this.get(options.sessionId, options.ownerId);
    if (previous?.status === "running") { options.release(); return this.snapshot(options.sessionId, options.ownerId)!; }
    if (this.starting.has(options.sessionId)) { options.release(); throw new Error("原生终端正在启动"); }
    if (this.starting.size + [...this.terminals.values()].filter((entry) => entry.status === "running").length >= 4) { options.release(); throw new Error("最多同时运行 4 个原生终端"); }
    this.starting.add(options.sessionId);
    let released = false;
    const release = () => { if (!released) { released = true; options.release(); } };
    try {
      const process = await this.factory(options);
      const entry: TerminalEntry = { id: crypto.randomUUID(), sessionId: options.sessionId, ownerId: options.ownerId, provider: options.provider, cwd: options.cwd, process, status: "running", sequence: 0, events: [], bytes: 0, createdAt: new Date().toISOString(), listeners: new Set() };
      this.terminals.set(options.sessionId, entry);
      for (const [key, old] of this.terminals) {
        if (this.terminals.size <= MAX_RETAINED_TERMINALS) break;
        if (old.status === "exited") this.terminals.delete(key);
      }
      const emit = (event: Omit<NativeTerminalEvent, "sequence">) => {
        const next = { ...event, sequence: ++entry.sequence };
        entry.events.push(next); entry.bytes += next.data?.length || 0;
        while ((entry.bytes > MAX_REPLAY_BYTES || entry.events.length > 2048) && entry.events.length > 1) entry.bytes -= entry.events.shift()!.data?.length || 0;
        for (const listener of entry.listeners) { try { listener(next); } catch { entry.listeners.delete(listener); } }
      };
      process.onData((data) => emit({ type: "data", data: data.slice(-MAX_REPLAY_BYTES) }));
      process.onExit(({ exitCode }) => { if (entry.status === "exited") return; entry.status = "exited"; release(); emit({ type: "exit", exitCode }); entry.listeners.clear(); });
      if (this.stopping) this.stop(entry.sessionId, entry.ownerId, entry.id);
      return this.snapshot(options.sessionId, options.ownerId)!;
    } catch (error) { release(); throw error; }
    finally { this.starting.delete(options.sessionId); }
  }

  input(sessionId: string, ownerId: string, terminalId: string, data: string) {
    const entry = this.get(sessionId, ownerId);
    if (!entry || entry.id !== terminalId || entry.status !== "running") throw new Error("原生终端已结束或已更换，请重新连接");
    if (!data || data.length > 16_384) throw new Error("终端输入长度无效");
    entry.process.write(data);
  }

  resize(sessionId: string, ownerId: string, terminalId: string, cols: unknown, rows: unknown) {
    const entry = this.get(sessionId, ownerId);
    if (entry?.id === terminalId && entry.status === "running") { const size = terminalSize(cols, rows); entry.process.resize(size.cols, size.rows); }
  }

  subscribe(sessionId: string, ownerId: string, listener: (event: NativeTerminalEvent) => void) {
    const entry = this.get(sessionId, ownerId);
    if (!entry) throw new Error("原生终端不存在");
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  stop(sessionId: string, ownerId: string, terminalId?: string) {
    const entry = this.get(sessionId, ownerId);
    if (!entry || entry.status !== "running" || (terminalId && terminalId !== entry.id)) return;
    if (process.platform === "win32") {
      const killer = spawnProcess("taskkill.exe", ["/PID", String(entry.process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => entry.process.kill());
      killer.once("exit", (code) => { if (code !== 0 && entry.status === "running") entry.process.kill(); });
    } else {
      try { process.kill(-entry.process.pid, "SIGTERM"); } catch { entry.process.kill(); }
      const timer = setTimeout(() => { if (entry.status === "running") { try { process.kill(-entry.process.pid, "SIGKILL"); } catch { entry.process.kill(); } } }, 2000);
      timer.unref();
    }
  }

  stopAll() { this.stopping = true; for (const entry of this.terminals.values()) this.stop(entry.sessionId, entry.ownerId); }
}
