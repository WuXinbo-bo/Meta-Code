import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BackendRecoveryPolicy } = require("../desktop/backend-recovery.cjs");
let now = 1_000;
const policy = new BackendRecoveryPolicy({ maxAutomaticRestarts: 2, windowMs: 100, now: () => now });

assert.equal(policy.remaining(), 2);
assert.equal(policy.recordAttempt(), true);
assert.equal(policy.remaining(), 1);
assert.equal(policy.recordAttempt(), true);
assert.equal(policy.remaining(), 0);
assert.equal(policy.recordAttempt(), false, "automatic restart loops must stop at the configured bound");

now += 101;
assert.equal(policy.remaining(), 2, "restart budget returns after the rolling window expires");
assert.equal(policy.recordAttempt(), true);
policy.reset();
assert.equal(policy.remaining(), 2, "an explicit user retry starts one fresh bounded recovery series");

console.log("desktop backend restart budget, rolling window, and manual reset passed");
