import type { MetaCodePlugin } from "./types.js";

export const COLLABORATION_PLUGIN_ID = "collaboration";

export const collaborationPlugin: MetaCodePlugin = {
  manifest: {
    id: COLLABORATION_PLUGIN_ID,
    version: "1.0.0",
    apiVersion: 1,
    displayName: "协作委派",
    description: "提供主脑与子 Agent 之间的委派、恢复、验收和活动日志能力。",
    capabilities: ["agent.delegation", "agent.activity", "agent.drawer", "execution.collaborative"],
    requires: { core: ">=1" }
  }
};
