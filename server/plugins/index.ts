import type { WorkbenchPaths } from "../appPaths.js";
import { PluginHost } from "./host.js";
import { collaborationPlugin } from "./collaboration.js";
import { orchestrationPlugin } from "./orchestration.js";

export function createBuiltInPluginHost(paths: WorkbenchPaths) {
  return new PluginHost(paths, [collaborationPlugin, orchestrationPlugin]);
}

export { PluginHost } from "./host.js";
export { COLLABORATION_PLUGIN_ID, collaborationPlugin } from "./collaboration.js";
export { ORCHESTRATION_PLUGIN_ID, orchestrationPlugin } from "./orchestration.js";
export * from "./types.js";
