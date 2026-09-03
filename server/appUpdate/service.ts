import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { EnvHttpProxyAgent } from "undici";
import { loadAppUpdateConfig } from "./config.js";
import { parseAppUpdateManifest, refreshReleaseCompatibility, releaseFromManifest } from "./manifest.js";
import type { AppUpdateChannel, AppUpdateCheckState, AppUpdateConfig, AppUpdatePersistedState, AppUpdateRelease, AppUpdateSourceState, AppUpdateStatus } from "./types.js";

type ServiceOptions = {
  projectRoot: string;
  stateFile: string;
  fetch?: typeof globalThis.fetch;
  onChanged?: (status: AppUpdateStatus) => void;
  now?: () => Date;
  requestTimeoutMs?: number;
  getDataSchemaVersion?: () => number;
  retryDelaysMs?: number[];
};

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_UPDATE_RESPONSE_BYTES = 1_000_000;
const DEFAULT_RETRY_DELAYS_MS = [0, 250, 1_000];

function cleanVersion(value: string) {
  const cleaned = semver.clean(value.trim().replace(/^v/i, ""));
  if (!cleaned) throw new Error(`版本号无效：${value}`);
  return cleaned;
}

function defaultState(config: AppUpdateConfig): AppUpdatePersistedState {
  return {
    schemaVersion: 3,
    revision: 1,
    preferences: { autoCheck: true, channel: config.defaultChannel, skippedVersion: "", remindAfter: null },
    lastCheckedAt: null,
    lastSuccessfulCheckAt: null,
    lastError: "",
    release: null,
    checkedByVersion: "",
    checkedByBuildId: "",
    lastSuccessfulSourceState: "unconfigured",
    lastSuccessfulSourceLabel: ""
  };
}

function normalizeState(input: unknown, config: AppUpdateConfig): AppUpdatePersistedState {
  const fallback = defaultState(config);
  if (!input || typeof input !== "object") return fallback;
  const source = input as Partial<AppUpdatePersistedState>;
  const preferences = source.preferences || fallback.preferences;
  const channel = preferences.channel === "beta" ? "beta" : "stable";
  return {
    schemaVersion: 3,
    revision: Number.isInteger(source.revision) && Number(source.revision) > 0 ? Number(source.revision) : 1,
    preferences: {
      autoCheck: preferences.autoCheck !== false,
      channel,
      skippedVersion: typeof preferences.skippedVersion === "string" ? preferences.skippedVersion : "",
      remindAfter: typeof preferences.remindAfter === "string" && Number.isFinite(Date.parse(preferences.remindAfter)) ? preferences.remindAfter : null
    },
    lastCheckedAt: typeof source.lastCheckedAt === "string" ? source.lastCheckedAt : null,
    lastSuccessfulCheckAt: typeof source.lastSuccessfulCheckAt === "string" ? source.lastSuccessfulCheckAt : null,
    lastError: typeof source.lastError === "string" ? source.lastError : "",
    release: source.release && typeof source.release === "object" ? source.release as AppUpdateRelease : null,
    checkedByVersion: typeof source.checkedByVersion === "string" ? source.checkedByVersion : "",
    checkedByBuildId: typeof source.checkedByBuildId === "string" ? source.checkedByBuildId : "",
    lastSuccessfulSourceState: ["manifest", "github", "unconfigured"].includes(String(source.lastSuccessfulSourceState)) ? source.lastSuccessfulSourceState as Exclude<AppUpdateSourceState, "error"> : "unconfigured",
    lastSuccessfulSourceLabel: typeof source.lastSuccessfulSourceLabel === "string" ? source.lastSuccessfulSourceLabel : ""
  };
}

export class AppUpdateService {
  readonly config: AppUpdateConfig;
  private readonly stateFile: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly onChanged?: (status: AppUpdateStatus) => void;
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;
  private readonly getDataSchemaVersion: () => number;
  private readonly retryDelaysMs: number[];
  private readonly proxyAgent: EnvHttpProxyAgent | null;
  private state: AppUpdatePersistedState;
  private checkState: AppUpdateCheckState = "idle";
  private sourceState: AppUpdateSourceState = "unconfigured";
  private sourceLabel = "更新源未配置";
  private checkPromise: Promise<AppUpdateStatus> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: ServiceOptions) {
    this.config = loadAppUpdateConfig(options.projectRoot);
    this.stateFile = options.stateFile;
    this.proxyAgent = options.fetch ? null : new EnvHttpProxyAgent();
    this.fetchImpl = options.fetch || ((input, init) => globalThis.fetch(input, { ...init, dispatcher: this.proxyAgent } as RequestInit));
    this.onChanged = options.onChanged;
    this.now = options.now || (() => new Date());
    this.requestTimeoutMs = options.requestTimeoutMs || REQUEST_TIMEOUT_MS;
    this.getDataSchemaVersion = options.getDataSchemaVersion || (() => this.config.dataSchemaVersion);
    this.retryDelaysMs = options.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
    this.state = this.readState();
    if (this.state.release) this.state.release = refreshReleaseCompatibility(this.state.release, this.config, this.getDataSchemaVersion());
    this.refreshSourceState();
  }

  status(): AppUpdateStatus {
    const releaseVersion = this.state.release ? semver.clean(this.state.release.version) : null;
    const currentVersion = semver.clean(this.config.currentVersion);
    const skippedVersion = semver.clean(this.state.preferences.skippedVersion || "");
    const newerVersion = Boolean(releaseVersion && currentVersion && semver.gt(releaseVersion, currentVersion));
    const replacedBuild = Boolean(releaseVersion && currentVersion && releaseVersion === currentVersion
      && this.config.currentBuildId !== "development" && this.state.release?.buildId && this.state.release.buildId !== this.config.currentBuildId);
    const updateAvailable = newerVersion || replacedBuild;
    const reminded = !this.state.preferences.remindAfter || Date.parse(this.state.preferences.remindAfter) <= this.now().getTime();
    const skipped = Boolean(releaseVersion && skippedVersion && releaseVersion === skippedVersion);
    return {
      schemaVersion: 1,
      revision: this.state.revision,
      product: { id: this.config.productId, name: this.config.productName, currentVersion: this.config.currentVersion, currentBuildId: this.config.currentBuildId },
      capabilities: { check: true, download: false, apply: false, launcher: false },
      source: {
        state: this.sourceState,
        label: this.sourceLabel,
        githubRepository: this.config.githubRepository,
        manifestConfigured: Boolean(this.manifestUrl(this.state.preferences.channel)),
        usingCachedRelease: this.sourceState === "error" && Boolean(this.state.release),
        lastSuccessfulState: this.state.lastSuccessfulSourceState,
        lastSuccessfulLabel: this.state.lastSuccessfulSourceLabel
      },
      checkState: this.checkState,
      preferences: { ...this.state.preferences },
      lastCheckedAt: this.state.lastCheckedAt,
      lastSuccessfulCheckAt: this.state.lastSuccessfulCheckAt,
      lastError: this.state.lastError,
      release: this.state.release ? refreshReleaseCompatibility(structuredClone(this.state.release), this.config, this.getDataSchemaVersion()) : null,
      updateAvailable,
      announcementVisible: updateAvailable && !skipped && reminded
    };
  }

  async check(force = false): Promise<AppUpdateStatus> {
    if (this.checkPromise) return this.checkPromise;
    if (!force && !this.shouldAutoCheck()) return this.status();
    this.checkPromise = this.performCheck().finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  async updatePreferences(input: { autoCheck?: unknown; channel?: unknown; expectedRevision?: unknown }) {
    this.assertRevision(input.expectedRevision);
    if (typeof input.autoCheck === "boolean") this.state.preferences.autoCheck = input.autoCheck;
    if (input.channel === "stable" || input.channel === "beta") {
      if (this.state.preferences.channel !== input.channel) {
        this.state.preferences.channel = input.channel;
        this.state.preferences.skippedVersion = "";
        this.state.preferences.remindAfter = null;
        this.state.release = null;
      }
    }
    await this.commit();
    this.refreshSourceState();
    this.emitChanged();
    return this.status();
  }

  async skip(version?: string, expectedRevision?: unknown) {
    this.assertRevision(expectedRevision);
    const target = version || this.state.release?.version || "";
    this.state.preferences.skippedVersion = target ? cleanVersion(target) : "";
    this.state.preferences.remindAfter = null;
    await this.commit();
    this.emitChanged();
    return this.status();
  }

  async remind(afterHours = 24, expectedRevision?: unknown) {
    this.assertRevision(expectedRevision);
    const hours = Number(afterHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) throw new Error("提醒时间必须在 1 小时到 30 天之间");
    this.state.preferences.remindAfter = new Date(this.now().getTime() + hours * 60 * 60 * 1000).toISOString();
    await this.commit();
    this.emitChanged();
    return this.status();
  }

  start() {
    if (this.timer) return;
    void this.check(false).catch((error) => console.error("Meta Code update check failed", error));
    const interval = this.config.defaultCheckIntervalHours * 60 * 60 * 1000;
    this.timer = setInterval(() => { void this.check(false).catch((error) => console.error("Meta Code update check failed", error)); }, interval);
    this.timer.unref();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.proxyAgent?.close();
  }

  private async performCheck() {
    this.checkState = "checking";
    this.emitChanged();
    this.state.lastCheckedAt = this.now().toISOString();
    try {
      const channel = this.state.preferences.channel;
      const manifestUrl = this.manifestUrl(channel);
      let release: AppUpdateRelease;
      if (manifestUrl) {
        const payload = await this.fetchJson(manifestUrl, {});
        const manifest = parseAppUpdateManifest(payload, this.config);
        if (manifest.channel !== channel) throw new Error(`更新清单频道不匹配：${manifest.channel}`);
        release = releaseFromManifest(manifest, this.config, this.getDataSchemaVersion());
        this.sourceState = "manifest";
        this.sourceLabel = "发布清单";
      } else if (this.config.githubRepository) {
        release = await this.checkGithub(channel);
        this.sourceState = "github";
        this.sourceLabel = "GitHub Releases 公告";
      } else {
        this.sourceState = "unconfigured";
        this.sourceLabel = "更新源未配置";
        throw new Error("尚未配置 Meta Code 官方更新源");
      }
      cleanVersion(release.version);
      this.state.release = release;
      this.state.lastSuccessfulCheckAt = this.now().toISOString();
      this.state.checkedByVersion = this.config.currentVersion;
      this.state.checkedByBuildId = this.config.currentBuildId;
      this.state.lastSuccessfulSourceState = this.sourceState;
      this.state.lastSuccessfulSourceLabel = this.sourceLabel;
      this.state.lastError = "";
      this.checkState = "completed";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.lastError = message;
      this.checkState = this.sourceState === "unconfigured" ? "completed" : "error";
      if (this.sourceState !== "unconfigured") {
        this.sourceState = "error";
        this.sourceLabel = "更新检查失败";
      }
    }
    await this.commit();
    this.emitChanged();
    return this.status();
  }

  private async checkGithub(channel: AppUpdateChannel): Promise<AppUpdateRelease> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(this.config.githubRepository)) throw new Error("GitHub 更新仓库格式无效");
    const releases = await this.fetchJson(`https://api.github.com/repos/${this.config.githubRepository}/releases?per_page=20`, {
      accept: "application/vnd.github+json",
      "user-agent": "Meta-Code-Workbench"
    });
    if (!Array.isArray(releases)) throw new Error("GitHub Releases 返回格式无效");
    const candidate = releases.find((item) => item && typeof item === "object" && !(item as any).draft
      && (channel === "beta" ? Boolean((item as any).prerelease) : !(item as any).prerelease));
    if (!candidate) throw new Error(`没有找到${channel === "stable" ? "稳定版" : "测试版"}发布记录`);
    const release = candidate as Record<string, unknown>;
    return {
      version: cleanVersion(String(release.tag_name || "")),
      buildId: String(release.target_commitish || release.node_id || release.tag_name || "github-release"),
      manifestDigest: "",
      channel: release.prerelease ? "beta" : "stable",
      publishedAt: String(release.published_at || release.created_at || this.now().toISOString()),
      releaseNotes: String(release.body || ""),
      releaseUrl: String(release.html_url || `https://github.com/${this.config.githubRepository}/releases`),
      source: "github",
      compatible: true,
      installable: false,
      incompatibilityReason: "GitHub 公告不包含受签名发布清单，当前仅可查看",
      assets: []
    };
  }

  private async fetchJson(url: string, headers: Record<string, string>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.retryDelaysMs.length; attempt += 1) {
      if (this.retryDelaysMs[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, this.retryDelaysMs[attempt]));
      try { return await this.fetchJsonOnce(url, headers); }
      catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const retryable = /超时|HTTP (408|429|5\d\d)|fetch failed|network|socket|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message);
        if (!retryable) throw error;
      }
    }
    throw lastError;
  }

  private async fetchJsonOnce(url: string, headers: Record<string, string>) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("更新源地址无效"); }
    if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") throw new Error("更新源必须使用 HTTPS");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(parsed, { headers, signal: controller.signal, redirect: "follow" });
      if (!response.ok) throw new Error(`更新源请求失败（HTTP ${response.status}）`);
      const finalUrl = new URL(response.url || parsed.toString());
      if (finalUrl.protocol !== "https:" && finalUrl.hostname !== "127.0.0.1" && finalUrl.hostname !== "localhost") throw new Error("更新源重定向到了不安全地址");
      const announcedSize = Number(response.headers.get("content-length") || 0);
      if (announcedSize > MAX_UPDATE_RESPONSE_BYTES) throw new Error("更新源响应过大");
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > MAX_UPDATE_RESPONSE_BYTES) throw new Error("更新源响应过大");
      try { return JSON.parse(body); }
      catch { throw new Error("更新源返回的 JSON 无效"); }
    } catch (error) {
      if (controller.signal.aborted) throw new Error("更新检查超时");
      throw error;
    } finally { clearTimeout(timer); }
  }

  private shouldAutoCheck() {
    if (!this.state.preferences.autoCheck) return false;
    if (this.state.checkedByVersion !== this.config.currentVersion) return true;
    if (this.state.checkedByBuildId !== this.config.currentBuildId) return true;
    if (!this.state.lastCheckedAt) return true;
    const interval = this.config.defaultCheckIntervalHours * 60 * 60 * 1000;
    return this.now().getTime() - Date.parse(this.state.lastCheckedAt) >= interval;
  }

  private manifestUrl(channel: AppUpdateChannel) { return this.config.manifestUrls[channel]?.trim() || ""; }

  private refreshSourceState() {
    if (this.manifestUrl(this.state.preferences.channel)) {
      this.sourceState = "manifest";
      this.sourceLabel = "发布清单";
    } else if (this.config.githubRepository) {
      this.sourceState = "github";
      this.sourceLabel = "GitHub Releases 公告";
    } else {
      this.sourceState = "unconfigured";
      this.sourceLabel = "更新源未配置";
    }
  }

  private readState() {
    try { return normalizeState(JSON.parse(fs.readFileSync(this.stateFile, "utf8")), this.config); }
    catch { return defaultState(this.config); }
  }

  private assertRevision(value: unknown) {
    if (value === undefined || value === null) return;
    if (Number(value) !== this.state.revision) throw new Error("更新设置已在其他窗口变化，请刷新后重试");
  }

  private async commit() {
    this.state.revision += 1;
    await fsp.mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, this.stateFile);
  }

  private emitChanged() { this.onChanged?.(this.status()); }
}
