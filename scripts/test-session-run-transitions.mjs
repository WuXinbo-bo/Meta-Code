import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runTransitionConflict } from "../server/sessionRuns/transitions.ts";

assert.equal(runTransitionConflict("pause", "pause"), null);
assert.equal(runTransitionConflict("stop", "stop"), null);
assert.match(runTransitionConflict("steer", "pause"), /正在应用引导/);
assert.match(runTransitionConflict("stop", "pause"), /正在停止/);
assert.match(runTransitionConflict("pause", "stop"), /正在暂停/);
assert.doesNotMatch(runTransitionConflict("timeout", "pause"), /引导/);

const server = await readFile(new URL("../server/index.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(server, /runTransitionConflict\(activeRun\.abortIntent, "pause"\)/);
assert.match(server, /runTransitionConflict\(activeRun\.abortIntent, "stop"\)/);
assert.doesNotMatch(server, /任务正在应用引导或结束当前轮次/);
assert.match(app, /runControlAction === "pause"/);
assert.match(app, /runControlAction === "stop"/);

console.log("Session run controls are idempotent and intent-aware");
