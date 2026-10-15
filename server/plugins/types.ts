import semver from "semver";
import type { WorkbenchPaths } from "../appPaths.js";

export const PLUGIN_API_VERSION = 1;

export type PluginCapability =
  | "agent.delegation"
  | "agent.activity"
  | "agent.drawer"
  | "execution.collaborative"
  | "workflow.planning"
  | "workflow.execution"
  | "workflow.maintenance"
  | "workflow.activity";

export type PluginManifest = {
  id: string;
  version: string;
  apiVersion: number;
  displayName: string;
  description: string;
  capabilities: PluginCapability[];
  requires?: Record<string, string>;
};

export type PluginHealth = "healthy" | "disabled" | "degraded";
export type PluginHealthReport = { health: PluginHealth; message: string; checkedAt?: string; busy?: boolean };

export type PluginSnapshot = PluginManifest & {
  enabled: boolean;
  health: PluginHealth;
  diagnostics: { message: string; checkedAt: string | null; activeRequests: number; busy: boolean };
  dataDirectory: string;
  runtimeDirectory: string;
};

export type PluginContext = {
  paths: WorkbenchPaths;
  dataDirectory: string;
  runtimeDirectory: string;
};

export type MetaCodePlugin = {
  manifest: PluginManifest;
  beforeDisable?: () => void;
  activate?: (context: PluginContext) => void | (() => void);
  healthCheck?: (context: PluginContext) => PluginHealth | PluginHealthReport;
};

export function assertPluginManifest(manifest: PluginManifest) {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(manifest.id)) throw new Error(`插件 ID 无效：${manifest.id}`);
  if (!manifest.displayName.trim()) throw new Error(`插件 ${manifest.id} 缺少显示名`);
  if (!manifest.description.trim()) throw new Error(`插件 ${manifest.id} 缺少描述`);
  if (manifest.apiVersion !== PLUGIN_API_VERSION) throw new Error(`插件 ${manifest.id} 使用了不兼容的 API 版本`);
  if (!semver.valid(manifest.version)) throw new Error(`插件 ${manifest.id} 缺少版本`);
  if (!manifest.capabilities.length) throw new Error(`插件 ${manifest.id} 至少需要声明一个能力`);
}
