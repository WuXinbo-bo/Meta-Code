import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PERSONAL_BACKUP_RETENTION } from "./persistence/backupPolicy.js";

export type BackupGroup = {
  stamp: string;
  stateFile: string;
  authFile: string;
};

export const PERSONAL_DATA_BACKUP_SCHEMA_VERSION = 1;
export const PERSONAL_DATA_ENTRIES = [
  "credentials", "skills", "profiles", "providers", "agent-market", "mcp", "sessions",
  "recovery", "transactions", "artifacts", "workflow-node-runtime", "skill-releases",
  "data-location.json", "auth-encryption.key"
] as const;
export const PERSONAL_DATA_DATABASES = ["workbench-state.db", "auth.db", "codex-link.db", "session-management.db"] as const;

export type PersonalDataBackupManifest = {
  schemaVersion: 1;
  productId: "meta-code";
  createdAt: string;
  appVersion: string;
  dataSchemaVersion: number;
  componentSchemas: Record<string, number>;
  files: Array<{ path: string; size: number; sha256: string }>;
  totalBytes: number;
  trigger?: "manual" | "automatic";
};

export type PersonalDataBackupVerification = {
  schemaVersion: 1;
  level: "restore-rehearsal";
  verifiedAt: string;
  manifestSha256: string;
  files: number;
  totalBytes: number;
};

export type PersonalDataRestoreResult = {
  name: string;
  dataDir: string;
  backupDir: string;
  recoveryDir: string;
  restored: string[];
  manifest: PersonalDataBackupManifest;
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

function safeRelativePath(value: string) {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error(`备份清单路径无效：${value}`);
  return normalized;
}

async function backupFiles(root: string) {
  const files: PersonalDataBackupManifest["files"] = [];
  async function visit(directory: string) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const content = await fsp.readFile(absolute);
        files.push({
          path: path.relative(root, absolute).replace(/\\/g, "/"),
          size: content.byteLength,
          sha256: crypto.createHash("sha256").update(content).digest("hex")
        });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function backupManifest(directory: string) {
  const file = path.join(directory, "manifest.json");
  if (!fs.existsSync(file)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as PersonalDataBackupManifest;
    return manifest.schemaVersion === PERSONAL_DATA_BACKUP_SCHEMA_VERSION && manifest.productId === "meta-code" ? manifest : null;
  } catch { return null; }
}

function manifestDigest(directory: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, "manifest.json"))).digest("hex");
}

function backupVerification(directory: string, manifest: PersonalDataBackupManifest) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, "verification.json"), "utf8")) as PersonalDataBackupVerification;
    return value.schemaVersion === 1
      && value.level === "restore-rehearsal"
      && value.manifestSha256 === manifestDigest(directory)
      && value.files === manifest.files.length
      && value.totalBytes === manifest.totalBytes
      ? value
      : null;
  } catch {
    return null;
  }
}

export function listPersonalDataBackups(backupDir: string) {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("personal-"))
    .flatMap((entry) => {
      const directory = path.join(backupDir, entry.name);
      const manifest = backupManifest(directory);
      return manifest ? [{ name: entry.name, directory, manifest, verification: backupVerification(directory, manifest) }] : [];
    })
    .sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt));
}

export async function createPersonalDataBackup(input: {
  dataDir: string;
  backupDir?: string;
  appVersion: string;
  dataSchemaVersion: number;
  componentSchemas: Record<string, number>;
  databases: Array<{ name: typeof PERSONAL_DATA_DATABASES[number]; db: DatabaseSync }>;
  retain?: number;
  maxTotalBytes?: number;
  trigger?: "manual" | "automatic";
}) {
  const dataDir = path.resolve(input.dataDir);
  const backupDir = path.resolve(input.backupDir || path.join(dataDir, "backups"));
  await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `personal-${stamp}`;
  const temporary = path.join(backupDir, `.${name}.${process.pid}.tmp`);
  const destination = path.join(backupDir, name);
  const payload = path.join(temporary, "data");
  await fsp.mkdir(payload, { recursive: true, mode: 0o700 });
  try {
    for (const database of input.databases) {
      const target = path.join(payload, database.name);
      database.db.prepare("VACUUM INTO ?").run(target);
      verifySqliteDatabase(target);
    }
    for (const entry of PERSONAL_DATA_ENTRIES) {
      const source = path.join(dataDir, entry);
      if (!fs.existsSync(source)) continue;
      await fsp.cp(source, path.join(payload, entry), {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: (candidate) => !fs.lstatSync(candidate).isSymbolicLink()
      });
    }
    const files = await backupFiles(payload);
    const manifest: PersonalDataBackupManifest = {
      schemaVersion: PERSONAL_DATA_BACKUP_SCHEMA_VERSION,
      productId: "meta-code",
      createdAt: new Date().toISOString(),
      appVersion: input.appVersion,
      dataSchemaVersion: input.dataSchemaVersion,
      componentSchemas: { ...input.componentSchemas },
      files,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      trigger: input.trigger || "manual"
    };
    await fsp.writeFile(path.join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    certifyPersonalDataBackup(temporary);
    await fsp.rename(temporary, destination);

    const retain = Math.max(1, input.retain ?? PERSONAL_BACKUP_RETENTION);
    const maxTotalBytes = Math.max(256 * 1024 * 1024, input.maxTotalBytes ?? 8 * 1024 * 1024 * 1024);
    const snapshots = listPersonalDataBackups(backupDir);
    let retainedBytes = 0;
    for (const [index, snapshot] of snapshots.entries()) {
      retainedBytes += snapshot.manifest.totalBytes;
      if (index >= retain || (index > 0 && retainedBytes > maxTotalBytes)) await fsp.rm(snapshot.directory, { recursive: true, force: true });
    }
    return { name, createdAt: manifest.createdAt, files: files.length, totalBytes: manifest.totalBytes, manifest };
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function verifyPersonalDataBackup(directory: string) {
  const root = path.resolve(directory);
  const manifest = backupManifest(root);
  if (!manifest) throw new Error("个人数据备份清单缺失或版本不受支持");
  const payloadRoot = path.resolve(root, "data");
  const pending = [payloadRoot];
  const actualFiles = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`备份中不允许符号链接：${path.relative(root, target)}`);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) actualFiles.add(path.relative(payloadRoot, target).replace(/\\/g, "/"));
    }
  }
  const declaredFiles = new Set(manifest.files.map((item) => safeRelativePath(item.path)));
  if (declaredFiles.size !== manifest.files.length) throw new Error("备份清单包含重复文件");
  for (const file of actualFiles) if (!declaredFiles.has(file)) throw new Error(`备份包含未登记文件：${file}`);
  for (const file of declaredFiles) if (!actualFiles.has(file)) throw new Error(`备份缺少文件：${file}`);
  for (const item of manifest.files) {
    const relative = safeRelativePath(item.path);
    const file = path.resolve(root, "data", relative);
    if (path.relative(payloadRoot, file).startsWith("..")) throw new Error(`备份文件越界：${relative}`);
    const content = fs.readFileSync(file);
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== item.size || digest !== item.sha256) throw new Error(`备份文件校验失败：${relative}`);
  }
  for (const name of PERSONAL_DATA_DATABASES) {
    const file = path.join(root, "data", name);
    if (fs.existsSync(file)) verifySqliteDatabase(file);
  }
  return manifest;
}

export function rehearsePersonalDataBackupRestore(directory: string) {
  const manifest = verifyPersonalDataBackup(directory);
  const rehearsalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "metacode-restore-rehearsal-"));
  try {
    const stagedData = path.join(rehearsalRoot, "data");
    fs.cpSync(path.join(directory, "data"), stagedData, { recursive: true, force: false, errorOnExist: true });
    for (const name of PERSONAL_DATA_DATABASES) {
      const file = path.join(stagedData, name);
      if (fs.existsSync(file)) verifySqliteDatabase(file);
    }
    const stagedFiles = backupFilesSync(stagedData);
    if (stagedFiles.length !== manifest.files.length) throw new Error("隔离恢复后的文件数量与备份清单不一致");
    for (const item of stagedFiles) {
      const expected = manifest.files.find((candidate) => candidate.path === item.path);
      if (!expected || expected.size !== item.size || expected.sha256 !== item.sha256) throw new Error(`隔离恢复校验失败：${item.path}`);
    }
    return manifest;
  } finally {
    fs.rmSync(rehearsalRoot, { recursive: true, force: true });
  }
}

function backupFilesSync(root: string) {
  const files: PersonalDataBackupManifest["files"] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) {
        const content = fs.readFileSync(absolute);
        files.push({ path: path.relative(root, absolute).replace(/\\/g, "/"), size: content.byteLength, sha256: crypto.createHash("sha256").update(content).digest("hex") });
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function certifyPersonalDataBackup(directory: string) {
  const manifest = rehearsePersonalDataBackupRestore(directory);
  const verification: PersonalDataBackupVerification = {
    schemaVersion: 1,
    level: "restore-rehearsal",
    verifiedAt: new Date().toISOString(),
    manifestSha256: manifestDigest(directory),
    files: manifest.files.length,
    totalBytes: manifest.totalBytes
  };
  const file = path.join(directory, "verification.json");
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(verification, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
  return { manifest, verification };
}

export function restorePersonalDataBackup(input: { dataDir: string; backupDir?: string; name?: string }) {
  const dataDir = path.resolve(input.dataDir);
  const backupDir = path.resolve(input.backupDir || path.join(dataDir, "backups"));
  const snapshot = input.name
    ? listPersonalDataBackups(backupDir).find((item) => item.name === input.name)
    : listPersonalDataBackups(backupDir)[0];
  if (!snapshot) throw new Error(input.name ? `个人数据备份不存在：${input.name}` : "没有完整的个人数据备份");
  const manifest = rehearsePersonalDataBackupRestore(snapshot.directory);
  const restoreId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const recoveryDir = path.join(backupDir, `pre-restore-${restoreId}`);
  const stagingDir = path.join(path.dirname(dataDir), `.metacode-restore-${restoreId}`);
  fs.mkdirSync(recoveryDir, { recursive: false, mode: 0o700 });
  fs.cpSync(path.join(snapshot.directory, "data"), stagingDir, { recursive: true, force: false, errorOnExist: true });
  const names = [...PERSONAL_DATA_DATABASES, ...PERSONAL_DATA_ENTRIES];
  const moved: Array<{ from: string; to: string }> = [];
  const installed: string[] = [];
  try {
    for (const name of names) {
      const live = path.join(dataDir, name);
      if (!fs.existsSync(live)) continue;
      const recovery = path.join(recoveryDir, name);
      fs.mkdirSync(path.dirname(recovery), { recursive: true });
      fs.renameSync(live, recovery);
      moved.push({ from: recovery, to: live });
    }
    for (const name of names) {
      const staged = path.join(stagingDir, name);
      if (!fs.existsSync(staged)) continue;
      const live = path.join(dataDir, name);
      fs.mkdirSync(path.dirname(live), { recursive: true });
      fs.renameSync(staged, live);
      installed.push(live);
    }
    for (const name of PERSONAL_DATA_DATABASES) {
      const file = path.join(dataDir, name);
      if (fs.existsSync(file)) verifySqliteDatabase(file);
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { name: snapshot.name, dataDir, backupDir, restored: installed, recoveryDir, manifest } satisfies PersonalDataRestoreResult;
  } catch (error) {
    for (const target of installed.reverse()) fs.rmSync(target, { recursive: true, force: true });
    for (const item of moved.reverse()) {
      fs.mkdirSync(path.dirname(item.to), { recursive: true });
      fs.renameSync(item.from, item.to);
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(recoveryDir, { recursive: true, force: true });
    throw new Error(`个人数据恢复失败，原数据已回滚：${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateRestoreRecoveryDirectory(result: PersonalDataRestoreResult) {
  const dataDir = path.resolve(result.dataDir);
  const backupDir = path.resolve(result.backupDir);
  const recoveryDir = path.resolve(result.recoveryDir);
  const relative = path.relative(backupDir, recoveryDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep) || !path.basename(recoveryDir).startsWith("pre-restore-")) {
    throw new Error("恢复回滚目录无效");
  }
  return { dataDir, recoveryDir };
}

export function rollbackPersonalDataRestore(result: PersonalDataRestoreResult) {
  const { dataDir, recoveryDir } = validateRestoreRecoveryDirectory(result);
  if (!fs.existsSync(recoveryDir)) throw new Error("恢复回滚数据不存在");
  const names = [...PERSONAL_DATA_DATABASES, ...PERSONAL_DATA_ENTRIES];
  for (const name of names) {
    const live = path.join(dataDir, name);
    fs.rmSync(live, { recursive: true, force: true });
    const recovery = path.join(recoveryDir, name);
    if (!fs.existsSync(recovery)) continue;
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.renameSync(recovery, live);
  }
  for (const name of PERSONAL_DATA_DATABASES) {
    const file = path.join(dataDir, name);
    if (fs.existsSync(file)) verifySqliteDatabase(file);
  }
  fs.rmSync(recoveryDir, { recursive: true, force: true });
}

export function finalizePersonalDataRestore(result: PersonalDataRestoreResult) {
  const { recoveryDir } = validateRestoreRecoveryDirectory(result);
  fs.rmSync(recoveryDir, { recursive: true, force: true });
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
