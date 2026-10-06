import assert from "node:assert/strict";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

class FakeEventSource {
  static instances = [];
  listeners = new Map();
  onopen = null;
  onerror = null;
  closed = false;
  constructor(url) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  close() { this.closed = true; }
  emit(type, data = {}, lastEventId = "") {
    this.listeners.get(type)?.({ type, data: JSON.stringify(data), lastEventId });
  }
}

const documentTarget = new EventTarget();
Object.defineProperty(documentTarget, "hidden", { value: false, writable: true });
globalThis.document = documentTarget;
globalThis.window = globalThis;
globalThis.sessionStorage = new MemoryStorage();
globalThis.EventSource = FakeEventSource;

const { realtimeCoordinator } = await import("../src/realtimeCoordinator.ts");
const states = [];
const reconciles = [];
const events = [];
const unsubscribeStatus = realtimeCoordinator.subscribeStatus((state) => states.push(state));
const unsubscribeReconcile = realtimeCoordinator.subscribeReconcile((reason) => reconciles.push(reason));
const unsubscribeEvent = realtimeCoordinator.subscribe("session.changed", (detail) => events.push(detail));

try {
  realtimeCoordinator.start();
  const source = FakeEventSource.instances[0];
  assert.ok(source);
  assert.equal(source.url, "/api/events?after=0");
  source.onopen?.();
  source.emit("stream.ready", { replayComplete: true });
  source.emit("session.changed", { sessionId: "task-1", revision: 8 }, "41");
  assert.deepEqual(events, [{ sessionId: "task-1", revision: 8 }]);
  assert.equal(sessionStorage.getItem("modelx.lastEventId"), "41");
  assert.ok(states.includes("connected"));
  assert.ok(reconciles.includes("connected"));
  source.emit("session.changed", { sessionId: "task-1", revision: 7 }, "40");
  source.emit("session.changed", { sessionId: "task-1", revision: 8 }, "41");
  assert.equal(events.length, 1, "stale or duplicate SSE frames must not trigger another refresh");

  source.emit("stream.ready", { replayComplete: false });
  assert.ok(reconciles.includes("gap"), "an incomplete replay must force snapshot reconciliation");
  realtimeCoordinator.lastReconcileAt = 0;
  source.onerror?.();
  assert.equal(realtimeCoordinator.connectionState(), "reconnecting");
  assert.ok(reconciles.includes("error"));
  source.emit("stream.ready", { replayComplete: false, latestEventId: 10 });
  assert.equal(sessionStorage.getItem("modelx.lastEventId"), "10", "a server replay gap resets a stale browser cursor");
  source.emit("session.changed", { sessionId: "task-1", revision: 9 }, "11");
  assert.equal(events.length, 2);
  sessionStorage.setItem = () => { throw new Error("storage disabled"); };
  source.emit("session.changed", { sessionId: "task-1", revision: 10 }, "12");
  assert.equal(events.length, 3, "disabled browser storage must not break live updates");
} finally {
  realtimeCoordinator.stop();
  unsubscribeStatus();
  unsubscribeReconcile();
  unsubscribeEvent();
}

assert.equal(FakeEventSource.instances[0].closed, true);
assert.equal(realtimeCoordinator.connectionState(), "idle");
console.log("Realtime client event, gap reconciliation, and error state passed");
