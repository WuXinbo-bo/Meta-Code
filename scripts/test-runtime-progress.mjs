import assert from "node:assert/strict";
import { formatRuntimeProgressDuration, runtimeProgressElapsedMs } from "../src/runtimeProgress.ts";

const startedAt = "2026-08-31T10:00:00.000Z";
const updatedAt = "2026-08-31T10:01:05.000Z";
const now = Date.parse("2026-08-31T12:00:00.000Z");

assert.equal(runtimeProgressElapsedMs({ startedAt, updatedAt, active: false }, now), 65_000);
assert.equal(runtimeProgressElapsedMs({ startedAt, updatedAt, active: true }, now), 7_200_000);
assert.equal(runtimeProgressElapsedMs({ startedAt: "invalid", updatedAt, active: false }, now), 0);
assert.equal(runtimeProgressElapsedMs({ startedAt, updatedAt: "invalid", active: false }, now), 0);
assert.equal(formatRuntimeProgressDuration(65_999), "1 分 5 秒");
assert.equal(formatRuntimeProgressDuration(-1), "0 秒");

console.log("runtime progress durations freeze at terminal updates");
