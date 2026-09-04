import assert from "node:assert/strict";
import { WorkbenchPerformanceMonitor } from "../server/performance.ts";

const monitor = new WorkbenchPerformanceMonitor();
try {
  assert.equal(await monitor.measure("bootstrap", "native-runtime", async () => "ready"), "ready");
  await assert.rejects(
    monitor.measure("provider-controls", "runtime-detection", async () => { throw new Error("probe failed"); }),
    /probe failed/
  );
  const snapshot = monitor.snapshot();
  assert.ok(Array.isArray(snapshot.stages));
  assert.equal(snapshot.stages.find((item) => item.stage === "bootstrap native-runtime")?.count, 1);
  assert.equal(snapshot.stages.find((item) => item.stage === "provider-controls runtime-detection")?.count, 1);
} finally {
  monitor.close();
}

console.log("performance stage diagnostics passed");
