import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activeDataOwner, WorkbenchDataOwnerLease } from "../server/dataOwnerLease.ts";

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
  console.log("exclusive data owner lease and stale-owner recovery passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
