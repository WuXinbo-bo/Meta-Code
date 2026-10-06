import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, guide, helpCenter, main, templates] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/onboarding/FirstRunGuide.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/help/HelpCenter.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/onboarding/taskTemplates.ts", import.meta.url), "utf8")
]);

assert.match(app, /completedVersion < CURRENT_GUIDE_VERSION/);
assert.match(app, /PATCH/);
assert.match(app, /metacode:open-guide/);
assert.match(guide, /CURRENT_GUIDE_VERSION = 1/);
assert.match(guide, /onOpenAgentSettings/);
assert.match(guide, /onAddWorkspace/);
assert.match(helpCenter, /metacode:open-guide/);
assert.doesNotMatch(main, /OnboardingGate|AdminApp|VITE_SKIP_AUTH/);
for (const id of ["code-review", "bug-fix", "test-coverage", "dependency-upgrade"]) {
  assert.match(templates, new RegExp(`id: "${id}"`), `missing first-run task template: ${id}`);
}
assert.match(app, /TASK_TEMPLATES\.map/);
assert.match(app, /task-launch-subtitle/);

console.log("first-run guide contract tests passed");
