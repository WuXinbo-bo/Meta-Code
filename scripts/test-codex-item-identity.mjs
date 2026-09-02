import assert from "node:assert/strict";
import { codexItemSourceId } from "../server/engines/codex/itemIdentity.ts";

const firstStarted = codexItemSourceId("turn-a", "item_0");
const firstCompleted = codexItemSourceId("turn-a", "item_0");
const reviewCompleted = codexItemSourceId("turn-b", "item_0");

assert.equal(firstStarted, firstCompleted, "one item must keep its identity across lifecycle updates");
assert.notEqual(firstCompleted, reviewCompleted, "Codex item ids reused by a later turn must not overwrite prior messages");
assert.throws(() => codexItemSourceId("", "item_0"), /turnId/);
assert.throws(() => codexItemSourceId("turn-a", ""), /itemId/);

const messages = new Map();
messages.set(firstStarted, { text: "first turn", order: 0 });
messages.set(firstCompleted, { text: "first turn completed", order: 0 });
messages.set(reviewCompleted, { text: "review turn", order: 1 });
assert.deepEqual([...messages.values()], [
  { text: "first turn completed", order: 0 },
  { text: "review turn", order: 1 }
]);

console.log("Codex item lifecycle identities remain stable within a turn and isolated across turns");

