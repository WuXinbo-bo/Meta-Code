import assert from "node:assert/strict";
import { safeArchiveEntryPath } from "../server/runtime/archive.ts";

assert.equal(safeArchiveEntryPath("bin/agent.exe"), "bin/agent.exe");
assert.equal(safeArchiveEntryPath("folder\\agent"), "folder/agent");
for (const value of ["../escape", "folder/../../escape", "/absolute", "C:\\absolute", "safe/../..", "bad\0name"]) {
  assert.throws(() => safeArchiveEntryPath(value), /非法路径|路径越界/);
}
console.log("Runtime archive path traversal validation tests passed");
