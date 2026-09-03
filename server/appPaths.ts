import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const METACODE_HOME_ENV = "METACODE_HOME";
export const WORKBENCH_DATA_DIR_ENV = "WORKBENCH_DATA_DIR";
export const LEGACY_RUNTIME_DIR_ENV = "WORKBENCH_RUNTIME_DIR";
export const METACODE_PROFILE_ENV = "METACODE_PROFILE";

export type WorkbenchPaths = {
  projectRoot: string;
  dataDir: string;
  legacyRuntimeDir: string;
  logsDir: string;
  backupsDir: string;
  activityArtifactsDir: string;
  codexHome: string;
  claudeHome: string;
  runtimesDir: string;
  codexRuntimeDir: string;
  claudeRuntimeDir: string;
  mcpConfigDir: string;
  managedSkillsDir: string;
  standaloneSessionsDir: string;
  workflowTransactionsDir: string;
  appUpdateStateFile: string;
  secretsFile: string;
};

export function defaultWorkbenchDataDir() {
  return path.join(os.homedir(), ".metacode");
}

function defaultProcessDataDir() {
  const profile = String(process.env[METACODE_PROFILE_ENV] || "").trim();
  if (!profile) return defaultWorkbenchDataDir();
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(profile)) throw new Error("METACODE_PROFILE 格式无效");
  return path.join(os.homedir(), `.metacode-${profile}`);
}

export function resolveWorkbenchPaths(projectRoot: string): WorkbenchPaths {
  // WORKBENCH_RUNTIME_DIR remains a compatibility alias for existing tests and
  // managed deployments. New installations should use WORKBENCH_DATA_DIR.
  const configured = process.env[METACODE_HOME_ENV] || process.env[WORKBENCH_DATA_DIR_ENV] || process.env[LEGACY_RUNTIME_DIR_ENV];
  const dataDir = path.resolve(configured || defaultProcessDataDir());
  const legacyRuntimeDir = path.join(projectRoot, ".runtime");
  const runtimesDir = path.join(dataDir, "runtimes");
  return {
    projectRoot,
    dataDir,
    legacyRuntimeDir,
    logsDir: path.join(dataDir, "logs"),
    backupsDir: path.join(dataDir, "backups"),
    activityArtifactsDir: path.join(dataDir, "artifacts", "activity"),
    codexHome: path.join(dataDir, "profiles", "codex"),
    claudeHome: path.join(dataDir, "profiles", "claude"),
    runtimesDir,
    codexRuntimeDir: path.join(runtimesDir, "codex"),
    claudeRuntimeDir: path.join(runtimesDir, "claude"),
    mcpConfigDir: path.join(dataDir, "mcp"),
    managedSkillsDir: path.join(dataDir, "skills"),
    standaloneSessionsDir: path.join(dataDir, "sessions", "standalone"),
    workflowTransactionsDir: path.join(dataDir, "transactions", "workflow-plans"),
    appUpdateStateFile: path.join(dataDir, "updates", "state.json"),
    secretsFile: path.join(dataDir, "credentials", "secrets.dat")
  };
}

export function remapLegacyRuntimePath(input: string, paths: WorkbenchPaths) {
  if (!input) return input;
  const mappings: Array<[string, string]> = [
    [path.join(paths.legacyRuntimeDir, "codex-cli"), paths.codexRuntimeDir],
    [path.join(paths.legacyRuntimeDir, "claude-cli"), paths.claudeRuntimeDir],
    [path.join(paths.legacyRuntimeDir, "codex-home"), paths.codexHome],
    [path.join(paths.legacyRuntimeDir, "claude-home"), paths.claudeHome]
  ];
  const resolved = path.resolve(input);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  for (const [legacyRoot, currentRoot] of mappings) {
    const legacy = path.resolve(legacyRoot);
    const comparable = process.platform === "win32" ? legacy.toLowerCase() : legacy;
    const comparableRelative = path.relative(comparable, normalized);
    if (!comparableRelative.startsWith("..") && !path.isAbsolute(comparableRelative)) return path.join(currentRoot, path.relative(legacy, resolved));
  }
  return input;
}

function hasWorkbenchData(directory: string) {
  return ["workbench-state.db", "state.json", "auth.db"].some((name) => fs.existsSync(path.join(directory, name)));
}

function writeMigrationMarker(paths: WorkbenchPaths, migrated: boolean) {
  const marker = {
    schemaVersion: 1,
    migrated,
    source: migrated ? paths.legacyRuntimeDir : null,
    legacyArchive: migrated ? path.join(paths.dataDir, "migration-backups", "repository-runtime-original") : null,
    destination: paths.dataDir,
    completedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(paths.dataDir, "data-location.json"), `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function adoptLegacyLayout(staging: string) {
  const moves: Array<[string, string]> = [
    ["codex-home", path.join("profiles", "codex")],
    ["claude-home", path.join("profiles", "claude")],
    ["codex-cli", path.join("runtimes", "codex")],
    ["claude-cli", path.join("runtimes", "claude")],
    ["mcp-configs", "mcp"],
    ["managed-skills", "skills"],
    ["standalone-sessions", path.join("sessions", "standalone")],
    ["workflow-plan-transactions", path.join("transactions", "workflow-plans")]
  ];
  for (const [legacy, current] of moves) {
    const source = path.join(staging, legacy);
    const destination = path.join(staging, current);
    if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
  }
}

export function prepareWorkbenchDataDir(paths: WorkbenchPaths) {
  const explicitlyConfigured = Boolean(process.env[METACODE_HOME_ENV] || process.env[WORKBENCH_DATA_DIR_ENV] || process.env[LEGACY_RUNTIME_DIR_ENV]);
  const migrationMarker = path.join(paths.dataDir, "data-location.json");
  const shouldMigrate = !explicitlyConfigured && (!hasWorkbenchData(paths.dataDir) || !fs.existsSync(migrationMarker)) && hasWorkbenchData(paths.legacyRuntimeDir);
  if (!shouldMigrate) {
    fs.mkdirSync(paths.dataDir, { recursive: true });
    if (!fs.existsSync(path.join(paths.dataDir, "data-location.json"))) writeMigrationMarker(paths, false);
    return { migrated: false, source: null, destination: paths.dataDir };
  }

  const parent = path.dirname(paths.dataDir);
  const staging = path.join(parent, `.workbench-migration-${process.pid}-${Date.now()}`);
  const preexistingEntries = fs.existsSync(paths.dataDir) ? new Set(fs.readdirSync(paths.dataDir)) : new Set<string>();
  fs.mkdirSync(parent, { recursive: true });
  try {
    fs.cpSync(paths.legacyRuntimeDir, staging, { recursive: true, errorOnExist: true, force: false });
    if (!hasWorkbenchData(staging)) throw new Error("迁移副本缺少工作台数据库");
    const recoveryCopy = path.join(staging, "migration-backups", "repository-runtime-original");
    fs.mkdirSync(path.dirname(recoveryCopy), { recursive: true });
    fs.cpSync(paths.legacyRuntimeDir, recoveryCopy, { recursive: true, errorOnExist: true, force: false });
    adoptLegacyLayout(staging);
    // state.json was the pre-SQLite store and may contain legacy plaintext
    // credentials. Keep it only in the recovery copy once the database exists.
    if (fs.existsSync(path.join(staging, "workbench-state.db"))) fs.rmSync(path.join(staging, "state.json"), { force: true });
    writeMigrationMarker({ ...paths, dataDir: staging }, true);
    if (fs.existsSync(paths.dataDir)) {
      // The launcher creates logs/ before the backend starts. Preserve those
      // open files and import every other staged entry into the data root.
      fs.rmSync(path.join(staging, "logs"), { recursive: true, force: true });
      fs.cpSync(staging, paths.dataDir, { recursive: true, force: false, errorOnExist: true });
      fs.rmSync(staging, { recursive: true, force: true });
    } else fs.renameSync(staging, paths.dataDir);
    if (!hasWorkbenchData(paths.dataDir) || !fs.existsSync(migrationMarker)) throw new Error("迁移目标验证失败");
    fs.rmSync(paths.legacyRuntimeDir, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (fs.existsSync(paths.dataDir)) {
      for (const entry of fs.readdirSync(paths.dataDir)) {
        if (!preexistingEntries.has(entry)) fs.rmSync(path.join(paths.dataDir, entry), { recursive: true, force: true });
      }
    }
    throw new Error(`无法将个人数据迁移到 ${paths.dataDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { migrated: true, source: paths.legacyRuntimeDir, destination: paths.dataDir };
}
