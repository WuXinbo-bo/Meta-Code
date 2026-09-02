import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { HELP_TOPICS } from "../src/help/topics.ts";

assert.ok(HELP_TOPICS.length >= 8, "the help center should cover the primary product concepts");
assert.equal(new Set(HELP_TOPICS.map((topic) => topic.id)).size, HELP_TOPICS.length, "help topic ids must be unique");
for (const topic of HELP_TOPICS) {
  assert.ok(topic.title.trim());
  assert.ok(topic.summary.trim());
  assert.ok(topic.sections.length > 0);
  assert.ok(topic.sections.every((section) => section.title.trim() && section.body.trim()));
}

const sources = await Promise.all([
  "../src/App.tsx",
  "../src/chat/ComposerRuntimeControl.tsx",
  "../src/chat/CapabilityProfileControl.tsx",
  "../src/settings/DataSettings.tsx",
  "../src/settings/AppUpdateSettings.tsx",
  "../src/settings/ProviderSettingsPanel.tsx",
  "../src/workflow/WorkflowWorkbench.tsx"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));
const referenced = new Set(sources.join("\n").match(/topic="([a-z-]+)"/g)?.map((value) => value.slice(7, -1)) || []);
for (const topic of ["delegation-protocol", "task-orchestration", "capability-profiles", "provider-connections", "cli-runtime", "execution-permissions", "mcp", "data-and-backups"]) {
  assert.ok(referenced.has(topic), `expected contextual help entry for ${topic}`);
}

const themeStyles = await Promise.all([
  "../src/help/help.css",
  "../src/onboarding/firstRunGuide.css"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));
for (const styles of themeStyles) {
  assert.doesNotMatch(styles, /--mc-(?:border|border-subtle|border-strong|text-primary|surface-hover)/, "help and onboarding must use the active design token names");
}

console.log("help topic registry and contextual entry coverage passed");
