import fsp from "node:fs/promises";
import path from "node:path";
import type { SessionRecoverySnapshot } from "./types.js";

function snapshotFile(root: string, ownerUserId: string, sessionId: string) {
  const safeOwner = ownerUserId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(root, safeOwner, `${safeSession}.json`);
}

export async function writeSessionRecoverySnapshot(root: string, ownerUserId: string, sessionId: string, snapshot: SessionRecoverySnapshot) {
  const target = snapshotFile(root, ownerUserId, sessionId);
  const temporary = `${target}.${process.pid}.tmp`;
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fsp.writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temporary, target);
  return target;
}

export async function readSessionRecoverySnapshot(file: string) {
  const value = JSON.parse(await fsp.readFile(file, "utf8")) as SessionRecoverySnapshot;
  if (value.schemaVersion !== 1 || !value.session || typeof value.session !== "object") throw new Error("会话恢复快照格式无效");
  return value;
}

export async function deleteSessionRecoverySnapshot(file: string) {
  await fsp.rm(file, { force: true });
}
