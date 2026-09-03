import assert from "node:assert/strict";
import { GenerationSaveCoordinator } from "../server/persistence/generationSaveCoordinator.ts";

const releases = [];
const snapshots = [];
let stateRevision = 0;
const coordinator = new GenerationSaveCoordinator(async () => {
  const snapshot = stateRevision;
  snapshots.push(snapshot);
  await new Promise((resolve) => releases.push(resolve));
});

stateRevision = 1;
let firstSettled = false;
const first = coordinator.request().then(() => { firstSettled = true; });
await new Promise((resolve) => setImmediate(resolve));

stateRevision = 2;
let secondSettled = false;
const second = coordinator.request().then(() => { secondSettled = true; });
assert.deepEqual(snapshots, [1]);

releases.shift()();
await first;
assert.equal(firstSettled, true);
assert.equal(secondSettled, false, "a later mutation must not extend the first caller's barrier");

await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(snapshots, [1, 2]);
releases.shift()();
await second;
assert.equal(secondSettled, true);

console.log("Generation save barriers settle independently OK");
