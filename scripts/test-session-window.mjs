import assert from "node:assert/strict";
import { boundedInteger, safeMessageText, sliceMessageWindow } from "../dist-server/sessionWindow.js";

const messages = Array.from({ length: 250 }, (_, index) => ({ id: `message-${index}` }));
const latest = sliceMessageWindow(messages, undefined, 80);
assert.deepEqual(latest.window, { start: 170, end: 250, total: 250, hasMore: true });
assert.equal(latest.messages[0].id, "message-170");
assert.equal(latest.messages.at(-1).id, "message-249");

const earlier = sliceMessageWindow(messages, latest.window.start, 100, 100);
assert.deepEqual(earlier.window, { start: 70, end: 170, total: 250, hasMore: true });
assert.equal(earlier.messages.length, 100);

const first = sliceMessageWindow(messages, earlier.window.start, 100, 100);
assert.deepEqual(first.window, { start: 0, end: 70, total: 250, hasMore: false });
assert.equal(first.messages.length, 70);
assert.equal(boundedInteger("invalid", 80, 1, 500), 80);
assert.equal(boundedInteger(10_000, 80, 1, 500), 500);
assert.equal(safeMessageText(undefined), "");
assert.equal(safeMessageText(null), "");
assert.equal(safeMessageText(42), "42");

console.log("session window tests passed");
