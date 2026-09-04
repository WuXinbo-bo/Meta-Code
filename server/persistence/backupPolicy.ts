import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const PERSONAL_BACKUP_RETENTION = 2;
export const PERSONAL_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type BackupPolicy = {
  schemaVersion: 1;
  automaticEnabled: boolean;
  intervalMs: number;
  retentionCount: number;
};

export const DEFAULT_BACKUP_POLICY: BackupPolicy = {
  schemaVersion: 1,
  automaticEnabled: true,
  intervalMs: PERSONAL_BACKUP_INTERVAL_MS,
  retentionCount: PERSONAL_BACKUP_RETENTION
};

export function loadBackupPolicy(file: string): BackupPolicy {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BackupPolicy>;
    return {
      ...DEFAULT_BACKUP_POLICY,
      automaticEnabled: value.automaticEnabled !== false
    };
  } catch {
    return { ...DEFAULT_BACKUP_POLICY };
  }
}

export async function saveBackupPolicy(file: string, policy: BackupPolicy) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(policy, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temporary, file);
}
