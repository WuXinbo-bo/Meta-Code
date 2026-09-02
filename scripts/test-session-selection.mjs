import assert from "node:assert/strict";
import { retainAvailableSelection, updateRangeSelection } from "../src/session-management/selection.ts";

const orderedIds = ["a", "b", "c", "d", "e"];
let result = updateRangeSelection({ orderedIds, selectedIds: new Set(), clickedId: "b", anchorId: null, toggle: false, range: false });
assert.deepEqual([...result.selectedIds], ["b"]);

result = updateRangeSelection({ orderedIds, selectedIds: result.selectedIds, clickedId: "d", anchorId: result.anchorId, toggle: true, range: false });
assert.deepEqual([...result.selectedIds], ["b", "d"]);

result = updateRangeSelection({ orderedIds, selectedIds: result.selectedIds, clickedId: "e", anchorId: "b", toggle: false, range: true });
assert.deepEqual([...result.selectedIds], ["b", "c", "d", "e"]);

result = updateRangeSelection({ orderedIds, selectedIds: new Set(["a"]), clickedId: "d", anchorId: "b", toggle: true, range: true });
assert.deepEqual([...result.selectedIds], ["a", "b", "c", "d"]);
assert.deepEqual([...retainAvailableSelection(new Set(["a", "missing"]), new Set(["a", "b"]))], ["a"]);
console.log("session selection tests passed");
