export type RealtimeConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "degraded";
export type RealtimeEventDetail = Record<string, unknown>;
export type ReconcileReason = "connected" | "reconnected" | "visibility" | "gap" | "watchdog" | "error";

type EventListener = (detail: RealtimeEventDetail, event: MessageEvent) => void;
type StatusListener = (state: RealtimeConnectionState) => void;
type ReconcileListener = (reason: ReconcileReason) => void;

const EVENT_TYPES = [
  "session.changed",
  "sessions.changed",
  "session.deleted",
  "agents.changed",
  "workflow.changed",
  "workspaces.changed",
  "settings.changed",
  "mcp.changed",
  "skills.changed",
  "runtime.changed",
  "runtime.install",
  "agent-market.changed",
  "agent-market.install",
  "provider-control.changed",
  "app-update.changed",
  "stream.ready",
  "stream.heartbeat"
] as const;

const LAST_EVENT_ID_KEY = "modelx.lastEventId";
const WATCHDOG_INTERVAL_MS = 5_000;
const STALE_CONNECTION_MS = 40_000;

class RealtimeCoordinator {
  private source: EventSource | null = null;
  private listeners = new Map<string, Set<EventListener>>();
  private statusListeners = new Set<StatusListener>();
  private reconcileListeners = new Set<ReconcileListener>();
  private state: RealtimeConnectionState = "idle";
  private lastActivityAt = 0;
  private watchdog: number | undefined;
  private reconnectTimer: number | undefined;
  private started = false;
  private hasConnected = false;
  private lastReconcileAt = 0;

  start() {
    if (this.started) return;
    this.started = true;
    document.addEventListener("visibilitychange", this.handleVisibility);
    this.connect();
    this.watchdog = window.setInterval(() => this.checkHealth(), WATCHDOG_INTERVAL_MS);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    document.removeEventListener("visibilitychange", this.handleVisibility);
    if (this.watchdog) window.clearInterval(this.watchdog);
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.watchdog = undefined;
    this.reconnectTimer = undefined;
    this.source?.close();
    this.source = null;
    this.setState("idle");
  }

  subscribe(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) || new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(type);
    };
  }

  subscribeStatus(listener: StatusListener) {
    this.statusListeners.add(listener);
    listener(this.state);
    return () => this.statusListeners.delete(listener);
  }

  subscribeReconcile(listener: ReconcileListener) {
    this.reconcileListeners.add(listener);
    return () => this.reconcileListeners.delete(listener);
  }

  connectionState() { return this.state; }

  private connect() {
    if (!this.started || this.source) return;
    this.setState(this.hasConnected ? "reconnecting" : "connecting");
    const after = Number(sessionStorage.getItem(LAST_EVENT_ID_KEY) || 0) || 0;
    const source = new EventSource(`/api/events?after=${after}`);
    this.source = source;
    this.lastActivityAt = Date.now();
    source.onopen = () => {
      this.lastActivityAt = Date.now();
      this.setState("connected");
    };
    source.onerror = () => {
      if (this.source !== source) return;
      this.setState("reconnecting");
      this.emitReconcile("error");
    };
    for (const type of EVENT_TYPES) source.addEventListener(type, this.handleEvent as EventListenerOrEventListenerObject);
  }

  private handleEvent = (rawEvent: Event) => {
    const event = rawEvent as MessageEvent;
    this.lastActivityAt = Date.now();
    if (event.lastEventId) sessionStorage.setItem(LAST_EVENT_ID_KEY, event.lastEventId);
    let detail: RealtimeEventDetail = {};
    try { detail = JSON.parse(event.data || "{}") as RealtimeEventDetail; }
    catch { /* Invalid event data is ignored without breaking the stream. */ }
    if (event.type === "stream.heartbeat") {
      if (this.state !== "connected") this.setState("connected");
      return;
    }
    if (event.type === "stream.ready") {
      const reconnected = this.hasConnected;
      this.hasConnected = true;
      this.setState("connected");
      this.emitReconcile(detail.replayComplete === false ? "gap" : reconnected ? "reconnected" : "connected");
      return;
    }
    for (const listener of this.listeners.get(event.type) || []) listener(detail, event);
  };

  private handleVisibility = () => {
    if (document.hidden) return;
    if (!this.source) this.scheduleReconnect(0);
    this.emitReconcile("visibility");
  };

  private checkHealth() {
    if (!this.started || document.hidden || Date.now() - this.lastActivityAt <= STALE_CONNECTION_MS) return;
    this.setState("degraded");
    this.emitReconcile("watchdog");
    this.source?.close();
    this.source = null;
    this.scheduleReconnect(500);
  }

  private scheduleReconnect(delay: number) {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private setState(state: RealtimeConnectionState) {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.statusListeners) listener(state);
  }

  private emitReconcile(reason: ReconcileReason) {
    const now = Date.now();
    if ((reason === "error" || reason === "watchdog") && now - this.lastReconcileAt < 1_000) return;
    this.lastReconcileAt = now;
    for (const listener of this.reconcileListeners) listener(reason);
  }
}

export const realtimeCoordinator = new RealtimeCoordinator();
