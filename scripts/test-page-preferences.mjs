import assert from "node:assert/strict";
import {
  DEFAULT_WORKBENCH_INTERFACE_SETTINGS,
  normalizeWorkbenchInterfaceSettings
} from "../server/settings/pagePreferences.ts";

assert.deepEqual(normalizeWorkbenchInterfaceSettings(undefined), DEFAULT_WORKBENCH_INTERFACE_SETTINGS);
assert.deepEqual(normalizeWorkbenchInterfaceSettings({ workspaceBrowser: {
  maxTabs: 12,
  fileOpenMode: "persistent",
  restoreTabs: false,
  tabMotion: "reduced"
}, guidance: { completedVersion: 1, contextualHelp: false } }), { workspaceBrowser: {
  maxTabs: 12,
  fileOpenMode: "persistent",
  restoreTabs: false,
  tabMotion: "reduced"
}, guidance: { completedVersion: 1, contextualHelp: false } });
assert.deepEqual(normalizeWorkbenchInterfaceSettings({ workspaceBrowser: {
  maxTabs: 999,
  fileOpenMode: "invalid",
  restoreTabs: "no",
  tabMotion: "fast"
} }), DEFAULT_WORKBENCH_INTERFACE_SETTINGS);

console.log("page preference tests passed");
