import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const retryableCodes = new Set(["EACCES", "EBUSY", "EEXIST", "EPERM"]);

function wait(milliseconds: number) {
  Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code || "") : "";
}

export function writeJsonAtomically(target: string, value: unknown) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temporary, target);
        break;
      } catch (error) {
        if (!retryableCodes.has(errorCode(error)) || attempt >= 7) throw error;
        wait(Math.min(20 * (attempt + 1), 120));
      }
    }
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

export function withTransactionFileLock<T>(target: string, operation: () => T): T {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lockPath = `${target}.lock`;
  // Synchronous host callbacks must not freeze HTTP/UI processing for seconds.
  const deadline = Date.now() + 250;
  const token = crypto.randomUUID();
  const contenderPath = `${lockPath}.${token}.owner`;
  const owner = JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() });
  let acquired = false;
  fs.writeFileSync(contenderPath, owner, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    while (!acquired) {
      try {
        // Publish complete ownership atomically; no empty lock can be mistaken
        // for an abandoned process between open and metadata write.
        fs.linkSync(contenderPath, lockPath);
        acquired = true;
      } catch (error) {
        if (!retryableCodes.has(errorCode(error))) throw error;
        reclaimDeadTransactionLock(lockPath);
        if (Date.now() >= deadline) throw new Error(`等待事务文件锁超时，请重试：${path.basename(target)}`);
        wait(10);
      }
    }
    return operation();
  } finally {
    // A callback must never release a replacement owner's lock.
    if (acquired) try { if (fs.readFileSync(lockPath, "utf8") === owner) fs.unlinkSync(lockPath); } catch { /* The lock may already be gone. */ }
    try { fs.unlinkSync(contenderPath); } catch { /* Best effort temporary cleanup. */ }
  }
}

function reclaimDeadTransactionLock(lockPath: string) {
  try {
    const observed = fs.readFileSync(lockPath, "utf8");
    let pid: number;
    let token = "";
    try { const owner = JSON.parse(observed) as { pid?: unknown; token?: unknown }; pid = Number(owner.pid); token = String(owner.token || ""); }
    catch { pid = Number(observed.split("\n")[0]); } // Existing v1 locks.
    if (!Number.isSafeInteger(pid) || pid <= 0) return; // Unknown owner: fail closed.
    try { process.kill(pid, 0); return; }
    catch (error) { if (errorCode(error) !== "ESRCH") return; }
    const identity = crypto.createHash("sha256").update(observed).digest("hex");
    const reclaimPath = `${lockPath}.${identity}.reclaim`;
    // Only one reclaimer may remove this particular dead owner's lock. Without
    // this claim two contenders could delete a newly acquired replacement.
    let claim: number;
    try { claim = fs.openSync(reclaimPath, "wx", 0o600); }
    catch { return; }
    try {
      if (fs.readFileSync(lockPath, "utf8") === observed) {
        fs.unlinkSync(lockPath);
        if (/^[0-9a-f-]{36}$/.test(token)) try { fs.unlinkSync(`${lockPath}.${token}.owner`); } catch { /* Optional stale contender link. */ }
      }
    } finally {
      fs.closeSync(claim);
      fs.unlinkSync(reclaimPath);
    }
  } catch { /* A live/replaced/unreadable lock is never taken over by age alone. */ }
}
