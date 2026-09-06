import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activeDataOwner, WorkbenchDataOwnerLease } from "../server/dataOwnerLease.ts";
import { isWorkbenchDataDirActive } from "../server/dataProcessGuard.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "metacode-owner-"));
try {
  const first = WorkbenchDataOwnerLease.acquire(root, { role: "development", port: 4338 });
  assert.equal(activeDataOwner(root)?.instanceId, first.record.instanceId);
  assert.throws(
    () => WorkbenchDataOwnerLease.acquire(root, { role: "desktop", port: 54321 }),
    /另一个 Meta Code 后端占用/
  );
  first.release();
  assert.equal(activeDataOwner(root), null);

  const staleFile = path.join(root, "owner.json");
  fs.writeFileSync(staleFile, JSON.stringify({
    schemaVersion: 1,
    instanceId: "stale-instance",
    pid: 999_999_999,
    role: "desktop",
    port: 50000,
    startedAt: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z"
  }));
  const recovered = WorkbenchDataOwnerLease.acquire(root, { role: "server", port: 4338 });
  assert.notEqual(recovered.record.instanceId, "stale-instance");
  recovered.release();

  // Regression: Windows may reuse a dead process PID. A stale heartbeat must
  // not be treated as an active owner just because the PID currently exists.
  fs.writeFileSync(staleFile, JSON.stringify({
    schemaVersion: 1,
    instanceId: "reused-pid-instance",
    pid: process.pid,
    role: "development",
    port: 4338,
    startedAt: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z"
  }));
  assert.equal(activeDataOwner(root), null, "stale heartbeat must not block a reused PID");
  const recoveredFromReusedPid = WorkbenchDataOwnerLease.acquire(root, { role: "server", port: 4338 });
  assert.notEqual(recoveredFromReusedPid.record.instanceId, "reused-pid-instance");
  recoveredFromReusedPid.release();
  fs.mkdirSync(path.join(root, "desktop"), { recursive: true });
  fs.writeFileSync(path.join(root, "desktop", "runtime.json"), JSON.stringify({ port: 57078 }));
  const probed = [];
  assert.equal(await isWorkbenchDataDirActive(root, async (url) => {
    probed.push(String(url));
    return new Response(JSON.stringify({ productId: String(url).includes("57078") ? "meta-code" : "other" }), { status: 200 });
  }), true);
  assert.ok(probed.some((url) => url.includes("57078")), "restore guard must probe the desktop dynamic port");
  console.log("exclusive data owner lease and stale-owner recovery passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
