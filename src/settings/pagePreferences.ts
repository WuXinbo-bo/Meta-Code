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

export function normalizeWorkbenchInterfaceSettings(value?: Partial<WorkbenchInterfaceSettings> | null): WorkbenchInterfaceSettings {
  const tabs = value?.workspaceBrowser;
  const guidance = value?.guidance;
  const maxTabs = WORKSPACE_BROWSER_TAB_LIMIT_OPTIONS.includes(Number(tabs?.maxTabs) as typeof WORKSPACE_BROWSER_TAB_LIMIT_OPTIONS[number])
    ? Number(tabs?.maxTabs)
    : DEFAULT_WORKBENCH_INTERFACE_SETTINGS.workspaceBrowser.maxTabs;
  return {
    workspaceBrowser: {
      maxTabs,
      fileOpenMode: tabs?.fileOpenMode === "persistent" ? "persistent" : "preview",
      restoreTabs: tabs?.restoreTabs !== false,
      tabMotion: tabs?.tabMotion === "full" || tabs?.tabMotion === "reduced" ? tabs.tabMotion : "system"
    },
    guidance: {
      completedVersion: Number.isInteger(Number(guidance?.completedVersion)) && Number(guidance?.completedVersion) >= 0 ? Number(guidance?.completedVersion) : 0,
      contextualHelp: guidance?.contextualHelp !== false
    }
  };
}
