import assert from "node:assert/strict";
import {
  claimPendingInput,
  normalizePendingInputs,
  promotePendingInput,
  removePendingInput,
  updatePendingInput
} from "../server/sessionInputs/queue.ts";

const legacy = normalizePendingInputs([{
  id: "one",
  text: "first",
  mode: "queue",
  createdAt: "2026-01-01T00:00:00.000Z",
  dispatchedToClaude: true
}, {
  id: "two",
  text: "second",
  mode: "steer",
  createdAt: "2026-01-01T00:01:00.000Z"
}]);
assert.equal(legacy[0].schemaVersion, 1);
assert.equal(legacy[0].status, "queued");
assert.equal("dispatchedToClaude" in legacy[0], false);
assert.equal(legacy[1].status, "steering");

const demoted = promotePendingInput(legacy, "one", "2026-01-01T00:02:00.000Z");
assert.deepEqual(demoted.queue.map((item) => [item.id, item.status]), [["one", "steering"], ["two", "queued"]]);

const editable = updatePendingInput(demoted.queue, "two", { text: "second edited", skillNames: ["alpha", "alpha"] });
assert.equal(editable.input.text, "second edited");
assert.deepEqual(editable.input.skillNames, ["alpha"]);
assert.throws(() => updatePendingInput(editable.queue, "one", { text: "locked" }), /已经开始应用/);

const claimed = claimPendingInput(editable.queue, "one");
assert.equal(claimed.input?.id, "one");
assert.deepEqual(claimed.queue.map((item) => item.id), ["two"]);

const removed = removePendingInput(claimed.queue, "two");
assert.equal(removed.queue.length, 0);
assert.throws(() => removePendingInput(removed.queue, "missing"), /不存在/);

console.log("Versioned pending input queue transitions OK");
