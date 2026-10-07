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
  const deadline = Date.now() + 15_000;
  let descriptor: number | null = null;
  while (descriptor === null) {
    try {
      descriptor = fs.openSync(lockPath, "wx");
      fs.writeFileSync(descriptor, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch { /* Preserve the original lock error. */ }
        descriptor = null;
        try { fs.rmSync(lockPath, { force: true }); } catch { /* A later retry can reclaim it. */ }
      }
      if (!retryableCodes.has(errorCode(error))) throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 10_000) fs.rmSync(lockPath, { force: true });
      } catch { /* The lock may have been released between checks. */ }
      if (Date.now() >= deadline) throw new Error(`等待事务文件锁超时：${path.basename(target)}`);
      wait(20);
    }
  }
  try {
    return operation();
  } finally {
    try { fs.closeSync(descriptor); } catch { /* Best effort cleanup. */ }
    try { fs.rmSync(lockPath, { force: true }); } catch { /* A stale lock is reclaimed on the next call. */ }
  }
}
