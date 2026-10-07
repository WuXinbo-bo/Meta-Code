import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import type { WorkbenchPaths } from "../appPaths.js";
import { assertPluginManifest, type MetaCodePlugin, type PluginContext, type PluginHealth, type PluginSnapshot } from "./types.js";

type Registry = { schemaVersion: 1; enabled: Record<string, boolean> };
export type PluginLifecycle = Pick<MetaCodePlugin, "activate" | "healthCheck" | "beforeDisable">;

export class PluginHost {
  private readonly plugins = new Map<string, MetaCodePlugin>();
  private readonly enabled = new Map<string, boolean>();
  private readonly cleanup = new Map<string, () => void>();
  private readonly registryFile: string;
  private started = false;
  private readonly bound = new Set<string>();
  private readonly admissions = new Map<string, number>();

  constructor(private readonly paths: WorkbenchPaths, plugins: MetaCodePlugin[] = []) {
    this.registryFile = path.join(paths.pluginsDir, "registry.json");
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: MetaCodePlugin) {
    if (this.started) throw new Error("注册插件需要在宿主启动之前完成");
    assertPluginManifest(plugin.manifest);
    if (this.plugins.has(plugin.manifest.id)) throw new Error(`插件 ID 重复：${plugin.manifest.id}`);
    this.plugins.set(plugin.manifest.id, { ...plugin, manifest: structuredClone(plugin.manifest) });
  }

  /** Bind application ports without making the plugin import the composition root. */
  bind(id: string, lifecycle: PluginLifecycle) {
    const plugin = this.require(id);
    if (this.bound.has(id)) throw new Error(`插件 ${id} 已绑定运行实例`);
    if (plugin.activate || this.cleanup.has(id)) throw new Error(`插件 ${id} 已有运行实例，不能替换生命周期`);
    const previous = { ...plugin };
    Object.assign(plugin, lifecycle);
    this.bound.add(id);
    try { if (this.isEnabled(id)) this.activate(id); }
    catch (error) { this.plugins.set(id, previous); this.bound.delete(id); throw error; }
  }

  private require(id: string) {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`插件不存在：${id}`);
    return plugin;
  }

  private readRegistry(): Registry {
    let text: string;
    try { text = fs.readFileSync(this.registryFile, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, enabled: {} };
      throw error;
    }
    let value: Registry;
    try { value = JSON.parse(text) as Registry; }
    catch { throw new Error("插件启停配置损坏，已保留原文件，请恢复配置后重试"); }
    if (!value) throw new Error("插件启停配置损坏，已保留原文件，请恢复配置后重试");
    if (value.schemaVersion !== 1 || !value.enabled || Array.isArray(value.enabled) || typeof value.enabled !== "object" || Object.values(value.enabled).some((item) => typeof item !== "boolean")) {
      throw new Error("插件启停配置损坏，已保留原文件，请恢复配置后重试");
    }
    return value;
  }

  private persist(enabled: Map<string, boolean>) {
    fs.mkdirSync(path.dirname(this.registryFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.registryFile}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, enabled: Object.fromEntries(enabled) }, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.registryFile);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  private checkDependencies(id: string, enabled = this.enabled) {
    for (const [dependency, range] of Object.entries(this.require(id).manifest.requires || {})) {
      const version = dependency === "core" ? "1.0.0" : this.require(dependency).manifest.version;
      if ((dependency !== "core" && !enabled.get(dependency)) || !semver.satisfies(version, range)) throw new Error(`插件 ${id} 需要 ${dependency} ${range}`);
    }
  }

  private activate(id: string) {
    const context = this.context(id);
    fs.mkdirSync(context.dataDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(context.runtimeDirectory, { recursive: true, mode: 0o700 });
    const cleanup = this.require(id).activate?.(context);
    if (cleanup) this.cleanup.set(id, cleanup);
  }

  start() {
    if (this.started) return;
    const registry = this.readRegistry();
    for (const [id] of this.plugins) this.enabled.set(id, registry.enabled[id] !== false);
    try {
      for (const [id, enabled] of this.enabled) if (enabled) this.checkDependencies(id);
      if (!fs.existsSync(this.registryFile)) this.persist(this.enabled);
      this.started = true;
      const activated = new Set<string>();
      const visiting = new Set<string>();
      const activate = (id: string) => {
        if (activated.has(id)) return;
        if (visiting.has(id)) throw new Error(`插件依赖循环：${id}`);
        visiting.add(id);
        for (const dependency of Object.keys(this.require(id).manifest.requires || {})) if (dependency !== "core") activate(dependency);
        this.activate(id);
        visiting.delete(id);
        activated.add(id);
      };
      for (const [id, enabled] of this.enabled) if (enabled) activate(id);
    } catch (error) { this.stop(); throw error; }
  }

  stop() {
    this.started = false;
    const errors: unknown[] = [];
    for (const cleanup of [...this.cleanup.values()].reverse()) { try { cleanup(); } catch (error) { errors.push(error); } }
    this.cleanup.clear(); this.started = false;
    if (errors.length) throw new AggregateError(errors, "插件停止失败");
  }

  has(id: string) { return this.plugins.has(id); }
  /** Hold admission across awaits until a host request has settled. */
  acquire(id: string) {
    this.require(id);
    if (!this.isEnabled(id)) throw new Error(`插件 ${id} 当前已停用`);
    this.admissions.set(id, (this.admissions.get(id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.admissions.get(id) || 1) - 1;
      if (remaining) this.admissions.set(id, remaining); else this.admissions.delete(id);
    };
  }
  isEnabled(id: string) { return this.started && this.enabled.get(id) === true; }
  manifest(id: string) { return this.plugins.has(id) ? structuredClone(this.require(id).manifest) : null; }

  context(id: string): PluginContext {
    this.require(id);
    return { paths: this.paths, dataDirectory: path.join(this.paths.pluginsDir, id), runtimeDirectory: path.join(this.paths.pluginRuntimeDir, id) };
  }

  setEnabled(id: string, enabled: boolean) {
    const plugin = this.require(id);
    if (!this.started) throw new Error("插件宿主尚未启动");
    if (this.isEnabled(id) === enabled) return this.snapshot(id);
    const next = new Map(this.enabled).set(id, enabled);
    for (const [candidate, active] of next) if (active) this.checkDependencies(candidate, next);
    if (!enabled) {
      if (this.admissions.get(id)) throw new Error("插件请求仍在处理中，请稍后再停用");
      plugin.beforeDisable?.();
    }
    // Admission is synchronous. No request can observe a partial transition.
    if (enabled) this.activate(id);
    try { this.persist(next); }
    catch (error) {
      if (enabled) { this.cleanup.get(id)?.(); this.cleanup.delete(id); }
      throw error;
    }
    this.enabled.set(id, enabled);
    if (!enabled) {
      const cleanup = this.cleanup.get(id);
      this.cleanup.delete(id);
      // The durable state is already disabled; do not report a failed toggle
      // that leaves clients believing the plugin is still enabled.
      try { cleanup?.(); } catch (error) { console.error(`Plugin ${id} cleanup failed`, error); }
    }
    return this.snapshot(id);
  }

  health(id: string): PluginHealth {
    if (!this.isEnabled(id)) return "disabled";
    try { return this.require(id).healthCheck?.(this.context(id)) || "healthy"; }
    catch { return "degraded"; }
  }

  snapshot(id: string): PluginSnapshot {
    return { ...structuredClone(this.require(id).manifest), enabled: this.isEnabled(id), health: this.health(id), dataDirectory: this.context(id).dataDirectory, runtimeDirectory: this.context(id).runtimeDirectory };
  }
  list(): PluginSnapshot[] { return [...this.plugins.keys()].map((id) => this.snapshot(id)); }
  publicList() { return this.list().map(({ dataDirectory: _data, runtimeDirectory: _runtime, ...plugin }) => plugin); }
  hasCapability(capability: string) { return this.list().some((plugin) => plugin.enabled && plugin.capabilities.some((item) => item === capability)); }
}
