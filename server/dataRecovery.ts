import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type BackupGroup = {
  stamp: string;
  stateFile: string;
  authFile: string;
};

const BACKUP_FILE = /^(workbench-state|auth)-([\w.-]+)\.db$/;

export function completeBackupGroups(backupDir: string): BackupGroup[] {
  if (!fs.existsSync(backupDir)) return [];
  const groups = new Map<string, Partial<BackupGroup>>();
  for (const name of fs.readdirSync(backupDir)) {
    const match = BACKUP_FILE.exec(name);
    if (!match) continue;
    const [, kind, stamp] = match;
    const group = groups.get(stamp) || { stamp };
    if (kind === "workbench-state") group.stateFile = path.join(backupDir, name);
    else group.authFile = path.join(backupDir, name);
    groups.set(stamp, group);
  }
  return [...groups.values()]
    .filter((group): group is BackupGroup => Boolean(group.stamp && group.stateFile && group.authFile))
    .sort((left, right) => right.stamp.localeCompare(left.stamp));
}

export function verifySqliteDatabase(file: string) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`数据库不存在或为空：${file}`);
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const result = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (result?.integrity_check !== "ok") throw new Error(`SQLite 完整性检查失败：${file}`);
  } finally {
    database.close();
  }
}

function durableCopy(source: string, destination: string) {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  const handle = fs.openSync(destination, "r+");
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

function moveIfPresent(source: string, destination: string) {
  if (fs.existsSync(source)) fs.renameSync(source, destination);
}

export function restoreWorkbenchBackup(input: { dataDir: string; backupDir?: string; stamp?: string }) {
  const dataDir = path.resolve(input.dataDir);
  const backupDir = path.resolve(input.backupDir || path.join(dataDir, "backups"));
  const group = input.stamp
    ? completeBackupGroups(backupDir).find((candidate) => candidate.stamp === input.stamp)
    : completeBackupGroups(backupDir)[0];
  if (!group) throw new Error(input.stamp ? `备份组不存在或不完整：${input.stamp}` : "没有完整的数据库备份组");
  verifySqliteDatabase(group.stateFile);
  verifySqliteDatabase(group.authFile);

  fs.mkdirSync(dataDir, { recursive: true });
  const live = {
    state: path.join(dataDir, "workbench-state.db"),
    auth: path.join(dataDir, "auth.db")
  };
  const restoreId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const recoveryDir = path.join(backupDir, `pre-restore-${restoreId}`);
  const stagingDir = path.join(dataDir, `.restore-${restoreId}`);
  fs.mkdirSync(recoveryDir, { recursive: false, mode: 0o700 });
  fs.mkdirSync(stagingDir, { recursive: false, mode: 0o700 });

  const moved: Array<{ from: string; to: string }> = [];
  const replaced = new Set<string>();
  try {
    for (const [name, target] of Object.entries(live)) {
      for (const suffix of ["", "-wal", "-shm"]) {
        const source = `${target}${suffix}`;
        if (fs.existsSync(source)) durableCopy(source, path.join(recoveryDir, `${name}.db${suffix}`));
      }
    }
    const stagedState = path.join(stagingDir, "workbench-state.db");
    const stagedAuth = path.join(stagingDir, "auth.db");
    durableCopy(group.stateFile, stagedState);
    durableCopy(group.authFile, stagedAuth);
    verifySqliteDatabase(stagedState);
    verifySqliteDatabase(stagedAuth);

    for (const target of Object.values(live)) {
      for (const suffix of ["-wal", "-shm", ""]) {
        const source = `${target}${suffix}`;
        if (!fs.existsSync(source)) continue;
        const destination = path.join(stagingDir, `old-${path.basename(source)}`);
        moveIfPresent(source, destination);
        moved.push({ from: destination, to: source });
      }
    }
    fs.renameSync(stagedState, live.state);
    replaced.add(live.state);
    fs.renameSync(stagedAuth, live.auth);
    replaced.add(live.auth);
    verifySqliteDatabase(live.state);
    verifySqliteDatabase(live.auth);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { stamp: group.stamp, restored: [live.state, live.auth], recoveryDir };
  } catch (error) {
    for (const target of replaced) fs.rmSync(target, { force: true });
    for (const item of moved.reverse()) moveIfPresent(item.from, item.to);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw new Error(`数据恢复失败，原数据库已回滚：${error instanceof Error ? error.message : String(error)}`);
  }
}
