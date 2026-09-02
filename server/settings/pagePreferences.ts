export const WORKSPACE_BROWSER_TAB_LIMIT_OPTIONS = [8, 12, 16, 24, 32] as const;

export type WorkspaceBrowserPreferences = {
  maxTabs: number;
  fileOpenMode: "preview" | "persistent";
  restoreTabs: boolean;
  tabMotion: "system" | "full" | "reduced";
};

export type WorkbenchInterfaceSettings = {
  workspaceBrowser: WorkspaceBrowserPreferences;
  guidance: {
    completedVersion: number;
    contextualHelp: boolean;
  };
};

export const DEFAULT_WORKBENCH_INTERFACE_SETTINGS: WorkbenchInterfaceSettings = {
  workspaceBrowser: {
    maxTabs: 24,
    fileOpenMode: "preview",
    restoreTabs: true,
    tabMotion: "system"
  },
  guidance: { completedVersion: 0, contextualHelp: true }
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeWorkbenchInterfaceSettings(value: unknown): WorkbenchInterfaceSettings {
  const input = record(value);
  const tabs = record(input.workspaceBrowser);
  const guidance = record(input.guidance);
  const requestedLimit = Number(tabs.maxTabs);
  const maxTabs = WORKSPACE_BROWSER_TAB_LIMIT_OPTIONS.includes(requestedLimit as typeof WORKSPACE_BROWSER_TAB_LIMIT_OPTIONS[number])
    ? requestedLimit
    : DEFAULT_WORKBENCH_INTERFACE_SETTINGS.workspaceBrowser.maxTabs;
  const fileOpenMode = tabs.fileOpenMode === "persistent" || tabs.fileOpenMode === "preview"
    ? tabs.fileOpenMode
    : DEFAULT_WORKBENCH_INTERFACE_SETTINGS.workspaceBrowser.fileOpenMode;
  const tabMotion = tabs.tabMotion === "full" || tabs.tabMotion === "reduced" || tabs.tabMotion === "system"
    ? tabs.tabMotion
    : DEFAULT_WORKBENCH_INTERFACE_SETTINGS.workspaceBrowser.tabMotion;
  return {
    workspaceBrowser: {
      maxTabs,
      fileOpenMode,
      restoreTabs: typeof tabs.restoreTabs === "boolean" ? tabs.restoreTabs : DEFAULT_WORKBENCH_INTERFACE_SETTINGS.workspaceBrowser.restoreTabs,
      tabMotion
    },
    guidance: {
      completedVersion: Number.isInteger(Number(guidance.completedVersion)) && Number(guidance.completedVersion) >= 0 ? Number(guidance.completedVersion) : 0,
      contextualHelp: typeof guidance.contextualHelp === "boolean" ? guidance.contextualHelp : DEFAULT_WORKBENCH_INTERFACE_SETTINGS.guidance.contextualHelp
    }
  };
}
