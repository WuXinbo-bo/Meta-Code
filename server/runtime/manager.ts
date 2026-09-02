import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import semver from "semver";
import { DEFAULT_RUNTIME_CONFIGURATION, normalizeRuntimeConfiguration, runtimeChildEnvironment, type RuntimeConfiguration, type RuntimeUseMode } from "./config.js";
import { extractTarSafely, extractZipSafely, inferredArchiveKind } from "./archive.js";
import { downloadArtifact } from "./downloader.js";
import { CLI_REGISTRY, runtimePlatform } from "./registry.js";
import { resolveNpmArtifacts } from "./source.js";
import { RuntimeTaskStore } from "./taskStore.js";
import type { CliDefinition, CliRuntimeId, RuntimeInstallProgress, RuntimeSource, RuntimeStatus, RuntimeUpdateStatus } from "./types.js";

const execFileAsync = promisify(execFile);
const NPM_LOCAL_INSTALL_TIMEOUT_MS = 10 * 60_000;
const PUBLISH_RETRY_DELAYS_MS = [80, 160, 320, 640, 1_280, 2_560, 4_000];

function isTransientWindowsRenameError(error: unknown) {
  if (process.platform !== "win32" || !error || typeof error !== "object") return false;
  return ["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"].includes(String((error as NodeJS.ErrnoException).code || ""));
}

async function publishDirectory(staging: string, destination: string) {
  for (let attempt = 0; ; attempt += 1) {
    if (fs.existsSync(destination)) {
      await fsp.rm(staging, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
      return;
    }
    try {
      await fsp.rename(staging, destination);
      return;
    } catch (error) {
      if (fs.existsSync(destination)) {
        await fsp.rm(staging, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
        return;
      }
      if (!isTransientWindowsRenameError(error) || attempt >= PUBLISH_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_DELAYS_MS[attempt]));
    }
  }
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath || "",
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

function safeVersion(value: string) {
  const normalized = value.trim().replace(/^v/i, "");
  if (!/^(?:latest|\d[0-9A-Za-z.+-]*)$/.test(normalized)) throw new Error("CLI 版本格式无效");
  return normalized;
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}

type Candidate = { source: RuntimeSource; path: string; managedVersion?: string };

export function runtimeUpdateDecision(mode: RuntimeUseMode, currentVersion: string, latestVersion: string): Pick<RuntimeUpdateStatus, "state" | "action"> {
  if (mode !== "managed") return { state: "external", action: "install-managed" };
  if (!currentVersion) return { state: "not-installed", action: "install" };
  const comparison = semver.valid(currentVersion) && semver.valid(latestVersion) ? semver.compare(currentVersion, latestVersion) : currentVersion.localeCompare(latestVersion, undefined, { numeric: true });
  if (comparison < 0) return { state: "available", action: "update" };
  if (comparison > 0) return { state: "newer-local", action: "none" };
  return { state: "latest", action: "none" };
}

export class CliRuntimeManager {
  private readonly installs = new Map<CliRuntimeId, Promise<RuntimeStatus>>();
  private readonly installProgress = new Map<CliRuntimeId, RuntimeInstallProgress>();
  private readonly taskStore: RuntimeTaskStore;
  private configuration: RuntimeConfiguration = structuredClone(DEFAULT_RUNTIME_CONFIGURATION);

  constructor(
    private readonly projectRoot: string,
    private readonly runtimesRoot: string,
    private readonly onProgress?: (event: RuntimeInstallProgress) => void
  ) {
    this.taskStore = new RuntimeTaskStore(runtimesRoot);
    for (const id of this.ids()) {
      const progress = this.taskStore.get(id);
      if (progress) this.installProgress.set(id, progress);
    }
  }

  configure(input: unknown) {
    this.configuration = normalizeRuntimeConfiguration(input);
    return this.config();
  }

  config() {
    return structuredClone(this.configuration);
  }

  ids() { return Object.keys(CLI_REGISTRY); }
  registerDefinition(definition: CliDefinition) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/i.test(definition.id)) throw new Error("CLI 运行时 ID 无效");
    CLI_REGISTRY[definition.id] = definition;
    return this;
  }
  catalog() {
    return this.ids().map((id) => {
      const definition = this.definition(id);
      return { id, providerId: definition.providerId, adapterId: definition.adapterId, label: definition.label, displayOrder: definition.displayOrder ?? 100, capabilities: { managedInstall: true, updateCheck: true, sourceProbe: definition.distribution.kind === "npm" } };
    }).sort((left, right) => left.displayOrder - right.displayOrder || left.label.localeCompare(right.label));
  }
  definition(id: CliRuntimeId) {
    const definition = CLI_REGISTRY[id];
    if (!definition) throw new Error(`未知 CLI 运行时：${id}`);
    return definition;
  }
  private selection(id: CliRuntimeId) { return this.configuration.selections[id] || { mode: "system" as const, systemPath: "", customPath: "" }; }
  runtimeRoot(id: CliRuntimeId) { return path.join(this.runtimesRoot, id); }
  private currentFile(id: CliRuntimeId) { return path.join(this.runtimeRoot(id), "current.json"); }

  activeVersion(id: CliRuntimeId) {
    return readJson<{ version?: string }>(this.currentFile(id))?.version || "";
  }

  installedVersions(id: CliRuntimeId) {
    const root = path.join(this.runtimeRoot(id), "versions");
    try { return fs.readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory() && !item.name.startsWith(".")).map((item) => item.name).sort((left, right) => semver.valid(left) && semver.valid(right) ? semver.rcompare(left, right) : right.localeCompare(left, undefined, { numeric: true })); }
    catch { return []; }
  }

  progress(id: CliRuntimeId) { return this.installProgress.get(id) || null; }

  private report(event: Omit<RuntimeInstallProgress, "updatedAt" | "operationId" | "sequence">) {
    const previous = this.installProgress.get(event.runtimeId);
    const sameOperation = previous?.startedAt === event.startedAt;
    const progress = {
      ...(sameOperation ? previous : {}),
      ...event,
      operationId: sameOperation && previous?.operationId ? previous.operationId : `${event.runtimeId}:${event.startedAt}`,
      sequence: sameOperation ? (previous?.sequence || 0) + 1 : 1,
      updatedAt: new Date().toISOString()
    } as RuntimeInstallProgress;
    this.installProgress.set(event.runtimeId, progress);
    this.taskStore.set(progress);
    this.onProgress?.(progress);
  }

  private async removeStaleStaging(id: CliRuntimeId) {
    const root = this.runtimeRoot(id);
    let entries: fs.Dirent[] = [];
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(".staging-")).map((entry) => fsp.rm(path.join(root, entry.name), { recursive: true, force: true })));
  }

  private managedRoots(id: CliRuntimeId) {
    const root = this.runtimeRoot(id);
    const active = this.activeVersion(id);
    return [...new Set([active ? path.join(root, "versions", active) : "", ...this.installedVersions(id).map((version) => path.join(root, "versions", version)), root].filter(Boolean))];
  }

  private async candidateGroups(id: CliRuntimeId, configuredPath: string) {
    const definition = this.definition(id);
    const selection = this.selection(id);
    const grouped: Record<"configured" | "runtime" | "bundled" | "system", Candidate[]> = { configured: [], runtime: [], bundled: [], system: [] };
    const customPath = selection.customPath || configuredPath;
    if (customPath) grouped.configured.push({ source: "configured", path: customPath });
    for (const root of this.managedRoots(id)) {
      const managedVersion = path.basename(root) === id ? undefined : path.basename(root);
      for (const candidate of definition.executableCandidates(root)) grouped.runtime.push({ source: "runtime", path: candidate, managedVersion });
    }
    for (const root of definition.bundledRoots(this.projectRoot)) for (const candidate of definition.executableCandidates(root)) grouped.bundled.push({ source: "bundled", path: candidate });
    const systemCandidates = await definition.systemCandidates();
    for (const candidate of [selection.systemPath, ...systemCandidates].filter(Boolean)) grouped.system.push({ source: "system", path: candidate });
    return grouped;
  }

  async detect(id: CliRuntimeId, configuredPath = "", forcedMode?: RuntimeUseMode, ignoreSelectedSystemPath = false): Promise<RuntimeStatus> {
    const definition = this.definition(id);
    const npmAvailable = Boolean(npmCliPath());
    const selection = this.selection(id);
    const mode = forcedMode || selection.mode;
    const grouped = await this.candidateGroups(id, configuredPath);
    const order = mode === "system" ? ["system"] : mode === "custom" ? ["configured"] : ["runtime"];
    const candidates = ["configured", "runtime", "bundled", "system"].flatMap((source) => grouped[source as keyof typeof grouped]);
    const versionByPath = new Map<string, string>();
    const emittedCandidates = new Set<string>();
    const resolvedCandidates: NonNullable<RuntimeStatus["candidates"]> = [];
    let selected: Omit<RuntimeStatus, "selectionMode" | "managed" | "candidates"> | null = null;
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate.path);
      const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      let candidateVersion = versionByPath.get(key);
      if (candidateVersion === undefined) {
        candidateVersion = await definition.probe(resolved);
        versionByPath.set(key, candidateVersion);
      }
      if (!candidateVersion) continue;
      const label = candidate.source === "configured" ? "已指定" : candidate.source === "bundled" ? "产品内置" : candidate.source === "runtime" ? "工作台托管" : "系统";
      const candidateKey = `${candidate.source}:${key}`;
      if (!emittedCandidates.has(candidateKey)) {
        resolvedCandidates.push({ source: candidate.source, path: resolved, version: candidateVersion, label });
        emittedCandidates.add(candidateKey);
      }
      const selectedSystemPath = !ignoreSelectedSystemPath && selection.systemPath ? path.resolve(selection.systemPath) : "";
      const matchesSelectedSystemPath = mode !== "system" || !selectedSystemPath || (process.platform === "win32" ? resolved.toLowerCase() === selectedSystemPath.toLowerCase() : resolved === selectedSystemPath);
      if (!selected && order.includes(candidate.source) && matchesSelectedSystemPath) selected = { id, available: true, source: candidate.source, path: resolved, version: candidateVersion, npmAvailable, networkRequired: false, message: `${label} ${definition.label} 可用`, managedVersion: candidate.managedVersion };
    }
    const activeManagedVersion = this.activeVersion(id);
    const managed = { installed: Boolean(activeManagedVersion || selected?.source === "runtime"), activeVersion: activeManagedVersion, installedVersions: this.installedVersions(id) };
    if (selected) return { ...selected, selectionMode: mode, candidates: resolvedCandidates, managed };
    const modeHint = mode === "system" ? "未找到系统安装" : mode === "custom" ? "指定路径不可用" : mode === "managed" ? "尚未安装托管副本" : `未找到 ${definition.label}`;
    return { id, available: false, source: "missing", path: "", version: "", npmAvailable, networkRequired: true, selectionMode: mode, candidates: resolvedCandidates, managed, message: npmAvailable ? `${modeHint}，可安装到工作台专用目录` : `${modeHint}，且当前环境缺少 npm` };
  }

  async discoverSystem(id: CliRuntimeId) {
    return this.detect(id, "", "system", true);
  }

  async checkUpdate(id: CliRuntimeId): Promise<RuntimeUpdateStatus> {
    const distribution = this.definition(id).distribution;
    const status = await this.detect(id);
    const mode = this.selection(id).mode;
    const currentVersion = mode === "managed" ? this.activeVersion(id) || semver.coerce(status.version)?.version || "" : semver.coerce(status.version)?.version || "";
    const source = distribution.kind === "npm" ? await resolveNpmArtifacts(distribution.packageName, distribution.defaultVersion, this.configuration.network) : null;
    const availableVersion = distribution.kind === "npm" ? source!.version : distribution.version;
    const latestVersion = semver.valid(availableVersion) || semver.coerce(availableVersion)?.version || availableVersion;
    const { state, action } = runtimeUpdateDecision(mode, currentVersion, latestVersion);
    return { runtimeId: id, mode, currentVersion, latestVersion, state, action, selectedRegistry: source?.selected || "", probes: source?.probes || [] };
  }

  async install(id: CliRuntimeId, requestedVersion?: string) {
    const running = this.installs.get(id);
    if (running) return running;
    const operation = this.installUnlocked(id, requestedVersion).finally(() => this.installs.delete(id));
    this.installs.set(id, operation);
    return operation;
  }

  private async installNpmDistribution(id: CliRuntimeId, definition: CliDefinition, packageName: string, version: string, staging: string, startedAt: string, configuration: RuntimeConfiguration) {
    const npmCli = npmCliPath();
    if (!npmCli) throw new Error("当前环境没有可用的 npm，请先安装 Node.js");
    this.report({ runtimeId: id, phase: "probing", version, message: "正在检测可用下载源", startedAt, active: true, resumable: true });
    const source = await resolveNpmArtifacts(packageName, version, configuration.network);
    this.report({ runtimeId: id, phase: "probing", version: source.version, message: `已选择 ${new URL(source.selected).host}`, registry: source.selected, sourceProbes: source.probes, startedAt, active: true, resumable: true });
    const archives: Array<{ artifact: (typeof source.artifacts)[number]; file: string }> = [];
    for (const artifact of source.artifacts) {
      const archive = await downloadArtifact(artifact, path.join(this.runtimeRoot(id), "cache"), configuration.network, (progress) => {
        const totalLabel = progress.totalBytes ? ` / ${(progress.totalBytes / 1024 / 1024).toFixed(1)} MB` : "";
        this.report({ runtimeId: id, phase: "downloading", version: source.version, message: `正在下载 ${progress.artifact} ${(progress.downloadedBytes / 1024 / 1024).toFixed(1)} MB${totalLabel}`, registry: source.selected, sourceProbes: source.probes, artifact: progress.artifact, downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes, bytesPerSecond: progress.bytesPerSecond, startedAt, active: true, resumable: true });
      });
      archives.push({ artifact, file: archive });
    }
    this.report({ runtimeId: id, phase: "installing", version: source.version, message: "下载完成，正在安装本地已校验的软件包", registry: source.selected, sourceProbes: source.probes, startedAt, active: true, resumable: false });
    const env = runtimeChildEnvironment(configuration.network);
    const dnsOption = "--dns-result-order=ipv4first";
    env.NODE_OPTIONS = env.NODE_OPTIONS?.includes(dnsOption) ? env.NODE_OPTIONS : [env.NODE_OPTIONS, dnsOption].filter(Boolean).join(" ");
    const installArchive = async (prefix: string, archive: string) => execFileAsync(process.execPath, [npmCli, "install", "--prefix", prefix, archive, "--omit=optional", "--omit=dev", "--no-audit", "--no-fund", `--registry=${source.selected}`, "--prefer-offline", `--fetch-timeout=${configuration.network.inactivityTimeoutSeconds * 1000}`, "--fetch-retries=2"], { encoding: "utf8", timeout: NPM_LOCAL_INSTALL_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env });
    try {
      await installArchive(staging, archives[0].file);
      for (const [index, item] of archives.slice(1).entries()) {
        const platformRoot = path.join(staging, `.platform-${index}`);
        await installArchive(platformRoot, item.file);
        const sourcePackage = path.join(platformRoot, "node_modules", ...item.artifact.packageName.split("/"));
        const targetPackage = path.join(staging, "node_modules", ...item.artifact.installName.split("/"));
        if (!fs.existsSync(sourcePackage)) throw new Error(`本地安装缺少 ${item.artifact.packageName}`);
        await fsp.mkdir(path.dirname(targetPackage), { recursive: true });
        await fsp.cp(sourcePackage, targetPackage, { recursive: true, force: true });
        await fsp.rm(platformRoot, { recursive: true, force: true });
      }
      await definition.finalizeInstallation?.(staging);
    } catch (error) {
      const failure = error as Error & { killed?: boolean; signal?: string; stderr?: string };
      if (failure.killed || failure.signal === "SIGTERM") throw new Error(`${definition.label} 本地安装超过 10 分钟，已安全终止`);
      const stderr = String(failure.stderr || "").replace(/\s+/g, " ").trim();
      throw new Error(`${definition.label} 安装失败：${(stderr || "本地软件包安装进程被中断").slice(0, 500)}`);
    }
    const packageFile = path.join(staging, "node_modules", ...packageName.split("/"), "package.json");
    return readJson<{ version?: string }>(packageFile)?.version || source.version;
  }

  private async installUnlocked(id: CliRuntimeId, requestedVersion?: string): Promise<RuntimeStatus> {
    const definition = this.definition(id);
    const distribution = definition.distribution;
    const configuration = this.config();
    const version = safeVersion(requestedVersion || (distribution.kind === "npm" ? distribution.defaultVersion : distribution.version));
    const startedAt = new Date().toISOString();
    this.report({ runtimeId: id, phase: "started", version, message: `准备安装 ${definition.label}`, startedAt, active: true, resumable: false });
    try {
      const runtimeRoot = this.runtimeRoot(id);
      await this.removeStaleStaging(id);
      const staging = path.join(runtimeRoot, `.staging-${crypto.randomUUID()}`);
      await fsp.mkdir(staging, { recursive: true });
      try {
        let installedVersion = version;
        if (distribution.kind === "npm") installedVersion = await this.installNpmDistribution(id, definition, distribution.packageName, version, staging, startedAt, configuration);
        else {
          const asset = distribution.platforms[runtimePlatform()];
          if (!asset) throw new Error(`${definition.label} 不支持当前平台 ${runtimePlatform()}`);
          const url = new URL(asset.url);
          if (url.protocol !== "https:") throw new Error("CLI 下载地址必须使用 HTTPS");
          if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) throw new Error("CLI 下载条目缺少有效 SHA-256");
          const archive = await downloadArtifact({
            packageName: id,
            installName: id,
            version,
            url: asset.url,
            integrity: `sha256-${Buffer.from(asset.sha256, "hex").toString("base64")}`
          }, path.join(this.runtimeRoot(id), "cache"), configuration.network, (progress) => {
            const totalLabel = progress.totalBytes ? ` / ${(progress.totalBytes / 1024 / 1024).toFixed(1)} MB` : "";
            this.report({ runtimeId: id, phase: "downloading", version, message: `正在下载 ${definition.label} ${(progress.downloadedBytes / 1024 / 1024).toFixed(1)} MB${totalLabel}`, artifact: progress.artifact, downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes, bytesPerSecond: progress.bytesPerSecond, startedAt, active: true, resumable: true });
          });
          this.report({ runtimeId: id, phase: "installing", version, message: "下载完成，正在安全解压", startedAt, active: true, resumable: false });
          const executable = path.resolve(staging, asset.executable);
          if (!executable.startsWith(`${path.resolve(staging)}${path.sep}`)) throw new Error("CLI 可执行文件路径越界");
          const archiveKind = asset.archive || inferredArchiveKind(asset.url);
          if (archiveKind === "zip") await extractZipSafely(archive, staging);
          else if (archiveKind === "tar.gz") await extractTarSafely(archive, staging);
          else {
            await fsp.mkdir(path.dirname(executable), { recursive: true });
            await fsp.copyFile(archive, executable);
          }
          if (!fs.existsSync(executable)) throw new Error(`CLI 压缩包缺少可执行文件：${asset.executable}`);
          if (process.platform !== "win32") await fsp.chmod(executable, 0o755);
        }
        const finalRoot = path.join(runtimeRoot, "versions", installedVersion);
        this.report({ runtimeId: id, phase: "verifying", version: installedVersion, message: "正在校验 CLI 可执行文件", startedAt, active: true, resumable: false });
        if (!await this.firstWorkingCandidate(definition, staging)) throw new Error(`${definition.label} 已下载，但可执行文件校验失败`);
        await fsp.mkdir(path.dirname(finalRoot), { recursive: true });
        await publishDirectory(staging, finalRoot);
        await this.activate(id, installedVersion);
        const status = await this.detect(id, "", "managed");
        if (!status.available || status.source !== "runtime") throw new Error(`${definition.label} 已安装，但无法从托管目录启动`);
        this.report({ runtimeId: id, phase: "activated", version: installedVersion, message: `${definition.label} ${installedVersion} 已启用`, startedAt, active: false, resumable: false });
        return status;
      } catch (error) {
        await fsp.rm(staging, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      this.report({ runtimeId: id, phase: "failed", version, message: error instanceof Error ? error.message : String(error), startedAt, active: false, resumable: true });
      throw error;
    }
  }

  private async firstWorkingCandidate(definition: CliDefinition, root: string) {
    for (const candidate of definition.executableCandidates(root)) if (await definition.probe(candidate)) return candidate;
    return "";
  }

  async activate(id: CliRuntimeId, version: string) {
    const normalized = safeVersion(version);
    const target = path.join(this.runtimeRoot(id), "versions", normalized);
    if (!fs.existsSync(target)) throw new Error(`未安装 ${id} ${normalized}`);
    const file = this.currentFile(id);
    const temporary = `${file}.${process.pid}.tmp`;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(temporary, `${JSON.stringify({ version: normalized, platform: runtimePlatform(), activatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, file);
  }

  async rollback(id: CliRuntimeId) {
    const active = this.activeVersion(id);
    const previous = this.installedVersions(id).find((version) => version !== active);
    if (!previous) throw new Error(`${id} 没有可回退版本`);
    await this.activate(id, previous);
    return this.detect(id, "", "managed");
  }

  async diagnostics(id: CliRuntimeId, configuredPath = "") {
    const status = await this.detect(id, configuredPath);
    return { status, configuration: this.config(), activeVersion: this.activeVersion(id), installedVersions: this.installedVersions(id), runtimeRoot: this.runtimeRoot(id), npmPath: npmCliPath(), platform: runtimePlatform() };
  }

  async sourceDiagnostics(id: CliRuntimeId, requestedVersion = "latest") {
    const distribution = this.definition(id).distribution;
    if (distribution.kind !== "npm") throw new Error("当前运行时不使用 npm 下载源");
    const result = await resolveNpmArtifacts(distribution.packageName, safeVersion(requestedVersion || distribution.defaultVersion), this.configuration.network);
    return {
      selected: result.selected,
      version: result.version,
      probes: result.probes,
      artifacts: result.artifacts.map((artifact) => ({ packageName: artifact.installName, version: artifact.version }))
    };
  }
}
