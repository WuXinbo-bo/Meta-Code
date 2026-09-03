import assert from "node:assert/strict";
import { sessionManagementFacets } from "../server/sessionManagement/facets.ts";

const item = (provider, source = "workbench") => ({ provider, source });
const facets = sessionManagementFacets(
  [item("gemini"), item("codex"), item("gemini"), item("claude", "claude-native")],
  (provider) => ({ gemini: "Gemini", codex: "Codex", claude: "Claude" })[provider] || provider,
  (source) => source === "workbench" ? "工作台" : "原生历史"
);

assert.deepEqual(facets.providers, [
  { id: "gemini", label: "Gemini", count: 2 },
  { id: "claude", label: "Claude", count: 1 },
  { id: "codex", label: "Codex", count: 1 }
]);
assert.deepEqual(facets.sources, [
  { id: "workbench", label: "工作台", count: 3 },
  { id: "claude-native", label: "原生历史", count: 1 }
]);
console.log("session Provider and source facets are derived from the actual inventory");
