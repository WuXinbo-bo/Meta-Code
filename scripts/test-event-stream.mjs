import assert from "node:assert/strict";
import { WorkbenchEventHub } from "../dist-server/eventHub.js";

const response = () => ({ chunks: [], ended: false, write(value) { this.chunks.push(value); return true; }, once() {}, end() { this.ended = true; } });
const hub = new WorkbenchEventHub();
const first = hub.publish("session.changed", { sessionId: "one" }, ["user-1"]);
const second = hub.publish("session.changed", { sessionId: "two" }, ["user-2"]);
assert.equal(second.id, first.id + 1);

const userOne = response();
const unsubscribe = hub.subscribe(userOne, 0, "user-1");
assert.equal(userOne.chunks.length, 1);
assert.match(userOne.chunks[0], /event: stream\.ready/);
hub.publish("agents.changed", { sessionId: "three" }, ["user-1"]);
assert.equal(userOne.chunks.length, 2);
unsubscribe();
hub.publish("agents.changed", { sessionId: "four" }, ["user-1"]);
assert.equal(userOne.chunks.length, 2);
const userTwo = response();
hub.subscribe(userTwo, 0, "user-2");
assert.equal(userTwo.chunks.length, 1);
assert.doesNotMatch(userTwo.chunks[0], /three|four/);
hub.heartbeat(userTwo);
assert.match(userTwo.chunks.at(-1), /event: stream\.heartbeat/);

const buffered = new WorkbenchEventHub();
let bufferedFirst;
for (let index = 0; index < 2_005; index += 1) buffered.publish("tick", { index });
bufferedFirst = buffered.publish("marker", { index: 2_005 });
const replay = response();
buffered.subscribe(replay, 0);
assert.equal(replay.chunks.length, 1);
assert.match(replay.chunks.at(-1), /"replayComplete":true/);
const gap = response();
buffered.subscribe(gap, bufferedFirst.id - 3_000);
assert.match(gap.chunks.at(-1), /"replayComplete":false/);
const after = response();
buffered.subscribe(after, bufferedFirst.id - 2);
assert.equal(after.chunks.length, 3);
assert.match(after.chunks.at(-1), /"replayComplete":true/);

const drainListeners = [];
const slow = {
  chunks: [], ended: false, blocked: true,
  write(value) { this.chunks.push(value); return !this.blocked; },
  once(type, listener) { if (type === "drain") drainListeners.push(listener); },
  end() { this.ended = true; }
};
const backpressure = new WorkbenchEventHub();
backpressure.subscribe(slow, 0);
backpressure.publish("tick", { index: 1 });
backpressure.publish("tick", { index: 2 });
assert.equal(drainListeners.length, 1, "a blocked client should register one drain handler");
slow.blocked = false;
drainListeners.shift()();
assert.match(slow.chunks.at(-1), /"index":2/);
assert.equal(slow.ended, false);
console.log("event stream tests passed");
